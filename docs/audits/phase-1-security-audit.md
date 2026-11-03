# Phase 1 Security & Abuse Audit — PaidSure

**Scope:** order API, hosted checkout/status, ingest + parser + matcher, admin bootstrap, refs, webhook, config, schema, frontend, dependencies, CI.
**Method:** source review + live tests against a local build on port 4000 (SQLite dev DB), plus `npm audit`.
**Date:** 2026-11-03
**Verdict:** ⚠️ **The money-matching core is sound, but the trust boundary around ingest is not.** A paired device token plus a client-declared "bank SMS" is enough to mark any open order PAID. Several cheaper attacks (sender-agnostic SMS, debit/credit ambiguity, ref enumeration, no rate limits) work without any credential.

> **Plain-English summary.** PaidSure does not verify money in a bank account. It verifies *what the merchant's phone says it saw*. That is a reasonable design for a ₹0 product, but it means the phone (and its token) is the crown jewel. Today the server believes everything the phone sends, including the sender name, the message text, and the timestamp. Anyone who can influence those values can confirm an order without paying.

---

## 1. What is actually solid

| Area | Status |
|---|---|
| Amount uniqueness per merchant | ✅ Partial unique index + transactional allocation + retry |
| Double-confirmation race | ✅ Conditional `updateMany` claim (`matcher.ts:117`) |
| Token storage | ✅ Only SHA-256 hashes stored (`schema.prisma:47`, `auth.ts`) |
| SQL injection | ✅ Prisma parameterised queries only; one safe `SELECT 1` |
| XSS sinks | ✅ No `dangerouslySetInnerHTML`/`innerHTML`; React escaping; intent URL built server-side |
| CORS | ✅ Deny-by-default allowlist; evil origin gets no `Access-Control-Allow-Origin` |
| Security headers | ✅ `nosniff`, `DENY`, `no-referrer`, `Permissions-Policy` |
| Production dependencies | ✅ `npm audit --omit=dev` → **0 vulnerabilities** |
| Secrets in git | ✅ `.env`, `dev.db`, keys are ignored; none in tracked files |
| Double-charge / screenshot fraud | ✅ Screenshots are never trusted; only parsed credit evidence |

Dev-only audit noise: **11 moderate** findings in eslint/minimatch/typescript-eslint. Not shipped to production; fix opportunistically.

---

## 2. Cheating scenarios (ranked by realism × impact)

### C1 — 🔴 CRITICAL: Forge a credit SMS with a device token
**Files:** `routes/ingest.ts:23-26`, `services/matcher.ts:49-70`, `services/parser.ts:91-97`
**Live proof:** created an order for ₹499.69, then posted a hand-written SMS with the merchant's device token:

```
POST /api/ingest   Authorization: Bearer psd_…
{"messages":[{"source":"SMS","sender":"VM-HDFCBK",
 "body":"Rs.499.69 credited to a/c XX1234 ... UTR 999888777666"}]}
→ {"outcome":"matched","orderRef":"PS-691310"}
GET /api/orders/PS-691310 → status "PAID", utr "999888777666"
```

The server trusts `source`, `sender`, `body` and `receivedAt` from the client. There is no attestation that the message came from the OS SMS inbox, from a bank sender, or at the claimed time. **A leaked/screenshot/logged pairing token = free goods until the token is revoked** (and there is no revoke endpoint — see H3).

**Fix:** treat ingest as untrusted telemetry, not proof.
1. Add `POST /api/devices/:id/revoke` and token expiry; rotate on re-pair.
2. Server-side sender allowlist per lane; reject unknown senders outright.
3. Require the Android app to attest the capture lane (Play Integrity / hardware-backed key) and send a signed payload; verify server-side.
4. For high-value orders, require a second independent signal (bank statement/email poll or merchant one-tap approval) before PAID.
5. Log device, IP, and rule for every confirmation; alert on bursts.

### C2 — 🔴 CRITICAL: Any SMS sender can confirm (no sender allowlist)
**Files:** `services/parser.ts:91-97` (`senders: []`), `parser.ts:174-180` (fallback ignores `ruleApplies`)
**Live proof:** order ₹777.34, sender `RANDOM-999`, body `"Your a/c credited by Rs 777.34 UTR 123123123123"` → `matched` via `generic-sms-credit-v1`.

The generic rule is selected as a fallback even when its empty `senders` list does not match. So **any SMS body containing "credited" + an amount is accepted**, regardless of who sent it. If the Android SMS receiver does not filter sender IDs (the app is still a Phase 0 placeholder), a customer can simply text the merchant's phone: `"Rs 499.69 credited"`.

**Fix:** delete the generic SMS fallback or require an explicit bank/app sender allowlist. Put unknown senders into `REVIEW`, never auto-PAID. Enforce the same allowlist in the Android receiver.

### C3 — 🔴 CRITICAL: A debit message that also says "credited" confirms
**Files:** `services/parser.ts:184-203`
**Live proof:** order ₹666.41, body `"Rs 666.41 debited from a/c and Rs 666.41 credited to a/c UTR 777"` → `matched` (`hdfc-credit-v1`).

`debitWord` is computed but never used to veto. The comment at `parser.ts:201` says ambiguous bodies are skipped, but only `BODY_NOISE_RE` runs — and it does not contain "debited". A real debit SMS that mentions a credit anywhere ("reward points credited", "cashback credited") can mark an order PAID.

**Fix:** `if (creditWord && debitWord) return null;` (or route to REVIEW). Add a regression test for every rule.

> **Related parser risks**
> - `extractAmountPaise` takes the **first** amount (`parser.ts:139`). A promo/balance amount before the real credit causes a wrong match or a false confirm when the first amount equals an order.
> - `EMAIL` is mapped to the PUSH lane: `source === "SMS" ? "SMS" : "PUSH"` (`parser.ts:166`). Docs call email authoritative, but the code never parses it as email.
> - `strictMode` defaults to `false` (`schema.prisma:25`), so PUSH auto-confirms. Any app can post a notification; the generic push rule ignores the package name.

### H1 — 🟠 HIGH: No rate limiting anywhere
**Files:** `index.ts` (no limiter), all routes
**Live proof:**
- 10 wrong admin passwords → `403` ×10, no `429`, no delay, no lockout.
- 200 public status lookups in **137 ms** (~1,460 req/s from one client).
- 40 concurrent SSE streams all stayed open for the test duration.

Impact:
- **Admin brute force** against a static, shared password.
- **Ref enumeration:** 6-digit refs = 1,000,000 space; at 1,460 req/s a full scan is ~11 minutes. Each hit leaks store name, amount, `intentUrl` (merchant VPA), `paidAt`, **UTR**, and `confirmedSource`.
- **SSE exhaustion:** each stream holds a DB poll every 2 s; unbounded connections = memory/DB DoS.
- **Ingest flooding:** a leaked device token can write 20 rows per request with no cap.

**Fix:** per-IP and per-token limits (e.g. 60/min public, 10/min admin, 5 concurrent SSE per IP), exponential backoff + lockout on admin, and a global concurrency cap on SSE. Cloudflare's free tier can absorb the edge load.

### H2 — 🟠 HIGH: Static admin password, no lockout, no MFA, no audit log
**Files:** `routes/admin.ts:28-35`, `config.ts`
One `ADMIN_PASSWORD` can create merchants (and receive the API key + webhook secret) and pair devices for **any** merchant. Comparison is a plain `!==` (not timing-safe). No rotation, no per-admin identity, no record of who did what.

**Fix:** per-admin accounts with scrypt/argon2 hashes, session/JWT, TOTP, IP allowlist, lockout, and an append-only admin audit log. At minimum use `crypto.timingSafeEqual`.

### H3 — 🟠 HIGH: No device revocation or rotation
**Files:** `prisma/schema.prisma:42-53`, `auth.ts:requireDevice`
`tokenHash` never expires. A lost/stolen phone, a screenshot of the pairing QR, or a token in app logs remains valid forever and can forge confirmations.

**Fix:** `revokedAt`, `expiresAt`, `lastSeenIp`, a revoke endpoint, rotation on re-pair, and an alert when a device suddenly confirms many orders.

### H4 — 🟠 HIGH: Public 6-digit refs leak order and payment data
**Files:** `lib/refcode.ts:7-9`, `routes/orders.ts:193-240`
`GET /api/orders/:ref` is unauthenticated and returns `storeName`, `amountPaise`, `payeeName`, `intentUrl`, `paidAt`, `confirmedSource`, and `utr`. Combined with H1, an attacker can map a merchant's sales and collect UTRs. No `Cache-Control: no-store`, so shared caches may retain it.

**Fix:** use ≥128-bit refs or a separate unguessable status token; return only what the checkout needs; never expose `utr` publicly; add `Cache-Control: no-store`. Rate-limit lookups.

### H5 — 🟠 HIGH: Webhook SSRF
**Files:** `routes/admin.ts:23` (`webhookUrl`), `services/matcher.ts:176-186`
**Live proof:** set `webhookUrl` to `http://127.0.0.1:4599/internal-hook`, forged a match, and the backend POSTed the signed payload to the local listener. `fetch` follows redirects by default, so an allowed host can bounce to an internal one.

**Fix:** HTTPS only; resolve DNS and block private/link-local/loopback ranges; `redirect: "manual"`; optional domain allowlist; sign with a timestamp + event id.

### H6 — 🟠 HIGH: Client-controlled `receivedAt` bypasses the late-match window
**Files:** `routes/ingest.ts:26`, `services/matcher.ts:50`, `matcher.ts:147-160`
**Live proof:** backdated an order to 20 h old (DB simulation of an old order), then sent a forged credit with `receivedAt` = 10 h ago → `matched`, `paidAt` = the backdated time. The 12 h window is checked against the phone's clock, not the server's.

**Fix:** use server receive time for the window; accept `receivedAt` only as evidence with a bounded skew (±5 min) and flag outliers. Never let a client extend a match window.

---

## 3. Medium findings

| # | Finding | Evidence | Fix |
|---|---|---|---|
| M1 | 🔴→🟠 **Global alert hash suppresses other merchants** | `matcher.ts:49` hashes only `source\|sender\|body`; `schema.prisma:103` is globally unique | **Live proof:** merchant B stored `"Rs 321.45 … UTR 555666777888"`; merchant A's identical legitimate alert came back `duplicate`. Scope the hash to `merchantId` (`@@unique([merchantId, hash])`) and include the device. |
| M2 | Parser takes the first amount in the body | `parser.ts:139` | Prefer the amount nearest the credit keyword; reject bodies with multiple conflicting amounts. |
| M3 | EMAIL is parsed as PUSH | `parser.ts:166` | Add a real `EMAIL` lane + rules, or reject EMAIL until implemented. |
| M4 | `strictMode` off by default | `schema.prisma:25` | Default to bank-SMS-only; let merchants opt into PUSH. |
| M5 | Raw SMS bodies stored indefinitely | `schema.prisma:95-108` | Retention window, redaction of account tails/VPAs, delete-on-request; DPDP-aware notice. |
| M6 | No `Cache-Control: no-store` on order data | `routes/orders.ts:193` (absent) | Add it; drop `ETag` or make it per-token. |
| M7 | Webhook replay + no retry | `matcher.ts:176-186` | Add `eventId` + `timestamp`, merchant-side dedupe, retry with backoff, dead-letter log. |
| M8 | No idempotency key on order create | `routes/orders.ts:63` | Accept `Idempotency-Key`; return the existing order on retry. Stops accidental duplicate fingerprints. |
| M9 | Fingerprint exhaustion is a public DoS | `services/orderAllocator.ts`, 301 slots | Per-IP/per-session order-create limits, CAPTCHA on the storefront, short `confirmWindowMin`. |
| M10 | Duplicate merchant slug → unhandled 500 | `routes/admin.ts:49` | Catch `P2002`, return `409 slug_taken`. |
| M11 | `JWT_SECRET` / `DEVICE_TOKEN_SECRET` required but unused | `config.ts` | Remove or actually use them; today they imply protection that does not exist. |
| M12 | Admin password in `x-admin-password` | `routes/admin.ts:29` | Use `Authorization` + per-admin tokens so proxies/logs don't capture a reusable platform secret. |

---

## 4. Low / hardening

- No `Strict-Transport-Security` or `Content-Security-Policy` at the app layer (put HSTS at the proxy; CSP only matters if the frontend is served by this app).
- No `trust proxy`; IP-based limits will be wrong behind a proxy until configured.
- Timing-unsafe admin password compare (`admin.ts:30`).
- SSE `poll` interval has no cap and no `X-Accel-Buffering` on all proxies; add a max lifetime.
- Error handler logs raw error objects (`index.ts`); avoid logging request bodies if you add them later.
- No confirmation audit trail (which device/IP/rule confirmed which order). Add one for disputes.

---

## 5. Who can cheat, and what they gain

| Actor | Method | Result today |
|---|---|---|
| **Customer with a leaked device token** | POST a fake credit SMS | Order PAID, goods shipped, no money (C1) |
| **Customer who knows the merchant's phone number** | Text a fake "credited" SMS to the phone (if the Android receiver is unfiltered) | Same (C2) |
| **Customer who can trigger a notification** | Post a fake "You received ₹…" notification | Same on the PUSH lane (C2/M4) |
| **Anyone** | Scan 6-digit refs | Store, amount, VPA, UTR, paid time (H1/H4) |
| **Anyone** | Flood admin/SSE/status | Lockout-free brute force, memory/DB DoS (H1/H2) |
| **Merchant** | Forge their own confirmations with their own token | Inflated GMV for lenders/investors; fake "verified" sales |
| **Rogue staff device** | Confirm orders without money | Shrinkage; no per-device audit trail (H3) |
| **Attacker with admin password** | Create merchants/devices, set `webhookUrl` | Full platform takeover + SSRF (H2/H5) |
| **Customer paying a *different* open order's amount** | Pay ₹X that belongs to another order | That other order is marked PAID; no double-claim, but support noise |

**Merchant self-forgery is the deepest limitation.** Because the only sensor is the merchant's own phone, PaidSure cannot prove to a third party (lender, marketplace, buyer) that a payment happened. It can only prove "this merchant's device reported this message." Say that plainly in the README and never market it as bank-verified.

---

## 6. Fix order (recommended)

**Do first (blocks the free-goods path):**
1. Parser: reject `credit && debit`; remove the sender-agnostic SMS fallback; default `strictMode = true`.
2. Ingest: server-side sender allowlist; server timestamp for the match window; `@@unique([merchantId, hash])`.
3. Device: `revokedAt`/`expiresAt` + revoke endpoint + rotation.
4. Rate limits: admin (strict + lockout), orders, ingest, status, SSE concurrency.
5. Status: unguessable ref/status token, hide `utr`, `Cache-Control: no-store`.

**Then:**
6. Webhook SSRF guard + timestamp/event id + retries.
7. Per-admin accounts with MFA + audit log.
8. Idempotency keys + order-create throttling.
9. Retention/redaction for raw alerts.
10. Android app: sender-ID filter, lane attestation, secure token storage (Keystore), no token in logs.

**Test gates to add:** forged-SMS-with-token must not match; unknown sender must not match; debit+credit must not match; identical body for two merchants must both be stored; backdated `receivedAt` must not widen the window; admin 429 after N failures; private-IP webhook rejected.

---

## 7. Verification commands used

```bash
npm audit --omit=dev --json          # 0 production vulnerabilities
# live (server on :4000, throwaway merchants, cleaned up afterwards)
POST /api/admin/merchants            # x10 wrong password → 403, no 429
POST /api/orders                     # ₹499 order → PS-691310
POST /api/ingest (device token)      # hand-written "credited" SMS → matched
GET  /api/orders/PS-691310           # status PAID + utr
POST /api/ingest sender=RANDOM-999   # generic-sms-credit-v1 → matched
POST /api/ingest debit+credit body   # hdfc-credit-v1 → matched
200 × GET /api/orders/PS-000000      # 137 ms total (~1,460 req/s)
40 × GET /api/orders/:ref/events     # 40/40 held open
POST /api/ingest receivedAt=-10h     # matched after backdating order (window bypass)
webhookUrl=http://127.0.0.1:4599     # backend POSTed to loopback (SSRF)
```

All throwaway merchants (`audit-*`), orders, devices and alerts were deleted after testing; the dev DB is back to the single `demo-threads-269789` merchant.

---

## 8. Bottom line

- **As a ₹0 "did my phone see a credit?" notifier, the core is well built.** Atomic allocation, race-safe claiming, hashed tokens, clean CORS, no SQL/XSS, 0 production CVEs.
- **As a fraud-resistant checkout, it is not there yet.** The server currently accepts a client-declared bank message and timestamp as proof. That is the one thing to fix before onboarding real sellers.
- Nothing here requires paid infrastructure: allowlists, server timestamps, scoped hashes, revocation, and per-IP limits are all free code changes. Cloudflare's free tier covers edge rate limiting.
