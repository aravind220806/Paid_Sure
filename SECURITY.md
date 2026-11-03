# Security Policy & Audit Log — Issues and Fixes Across Stages

PaidSure is a non-custodial UPI payment confirmation gateway built for Indian merchants. Because it operates without charging transaction fees and verifies payments using merchant-side payment signals rather than bank custody accounts, preserving trust boundaries is critical.

This document details our security policy, vulnerability reporting guidelines, and a comprehensive breakdown of the architectural issues faced across each development stage and how they were resolved.

---

## 🔒 Reporting a Vulnerability

If you discover a security vulnerability or abuse vector in PaidSure:
1. **Do not open a public issue.**
2. Send an email to `security@paidsure.org` (or report via GitHub Private Vulnerability Reporting).
3. Include detailed steps to reproduce the issue and any relevant redacted SMS/push payloads.
4. We aim to acknowledge reports within 24 hours and issue patches within 72 hours.

---

## 🛠️ Issues Faced & Solutions Across Stages

Every payment gateway faces subtle fraud vectors, race conditions, and infrastructure edge cases. Below is the detailed record of the issues encountered during development and the solutions implemented—explained conceptually in terms of system design.

---

### Phase 0 — Foundation & Money Math Core

#### 1. Floating-Point Rounding & Currency Drift
* **The Issue:** Using standard 64-bit floating-point numbers (`number` in JavaScript/TypeScript) for currency calculations introduces fractional rounding anomalies. During division or repeated additions, fractions of a paisa can disappear or accumulate, causing subtle mismatches between bank alerts and stored database totals.
* **The Solution:** Adopted a strict integer-only rule. All monetary values are represented, stored, and calculated as integer **paise** (1 Rupee = 100 paise) across the database schema, internal services, and API layers. Formatting into rupee decimal representations is strictly restricted to user interface presentation.

#### 2. Database Connection Deadlocks on Concurrent Orders
* **The Issue:** In lightweight and local development databases (like SQLite), overlapping requests attempting to create orders simultaneously tried to read and upgrade locks on shared tables, resulting in database lock wait errors and crashes.
* **The Solution:** Implemented an in-process serialized write queue for file-based databases to cleanly sequence transactions, while pairing production PostgreSQL with row-level locks, transactional retries, and atomic operations.

#### 3. Information Leakage via Unhandled Server Errors
* **The Issue:** Unexpected runtime exceptions would occasionally dump technical database errors and execution stack traces directly in HTTP responses, leaking internal schema details to API consumers.
* **The Solution:** Implemented a centralized error handler. Unhandled exceptions are logged to secure server-side diagnostics, while the client receives clean, structured JSON responses with sanitized error codes.

---

### Phase 1 — Core Matching, Ingest & Anti-Cheat Hardening

#### 4. Ingest Telemetry Spoofing & Forged Bank Messages
* **The Issue:** Early architecture treated the device ingest endpoint as an absolute authority if presented with a valid pairing token. If a token was compromised (via app logs, device backups, or physical access to a shop phone), an attacker could submit hand-written "credit" messages and mark orders as paid without money ever arriving.
* **The Solution:** Shifted ingest from an authoritative proof into an untrusted telemetry channel. Added device token expiration, instant device revocation, and strict server-side sender allowlists. The server only auto-confirms alerts originating from verified financial institutions. Messages from unrecognized senders are quarantined into manual review rather than marked paid.

#### 5. UPI "Payment Request" (Collect Call) Exploitation
* **The Issue:** Malicious buyers discovered that sending a UPI Collect Request to the merchant's UPI ID triggered a notification on the merchant's phone ("Payment request received for ₹..."). Because the notification contained the word "received" and originated from a recognized UPI app package, generic parser rules mistakenly classified it as a credit confirmation.
* **The Solution:** Re-engineered the text parser with strict debit and request veto rules. Notifications containing terms like "request", "collect", or split requests are explicitly prevented from triggering credit matches, and are immediately rejected or flagged for manual inspection.

#### 6. In-App P2P Chat Notification Injection
* **The Issue:** Popular payment applications (including Google Pay and PhonePe) support in-app peer-to-peer user chat. A buyer could send an in-app chat message stating "Payment received ₹499 UTR...", triggering a phone notification from the payment app package that mimicked an authentic settlement alert.
* **The Solution:** Added package, channel, and message structure verification. Chat notifications are filtered out by matching against specific payment notification templates and rejecting unstructured conversational formats.

#### 7. Broad SMS Sender Headers & Promotional Text Collisions
* **The Issue:** Overly broad sender regular expressions (such as matching broad telecom brand names) caused routine promotional SMS, cashback rewards, or recharge receipts to trigger false payment confirmations.
* **The Solution:** Restricted sender pattern matching to official transactional banking headers (such as DLT-registered bank headers) and expanded noise filters to automatically discard promotional offers, reward points, and recharge receipts.

#### 8. Predictable Order Numbers & Public UTR Exposure
* **The Issue:** Public checkout URLs originally used six-digit references that were easily enumerable by automated scripts, and status endpoints returned bank UTRs and merchant VPAs without authentication.
* **The Solution:** Replaced sequential references with unguessable, high-entropy tokens. Stripped sensitive financial identifiers (such as the bank UTR) from public status queries, reserving them strictly for authenticated merchant dashboards, and applied non-cacheable headers.

#### 9. Global Alert Deduplication Suppressing Other Merchants
* **The Issue:** Alert deduplication initially hashed only the message text globally across the system. When two distinct merchants received identical generic bank credit text, the second merchant's alert was incorrectly discarded as a duplicate.
* **The Solution:** Scoped deduplication hashes strictly to each specific merchant and ingest device pair, preventing cross-store alert suppression.

#### 10. Past Timestamp Manipulation (Window Bypassing)
* **The Issue:** Clients could submit alerts with backdated capture timestamps, bypassing the late-match window and force-matching expired orders.
* **The Solution:** Replaced reliance on client-declared capture times with the server's authoritative clock for active match-window validation, permitting only bounded device clock drift.

#### 11. Webhook Server-Side Request Forgery (SSRF) & DNS Rebinding
* **The Issue:** Custom merchant webhook destinations could be pointed to local server ports or internal cloud metadata addresses. In addition, rapid DNS switching (0-second TTL) could bypass initial hostname checks.
* **The Solution:** Enforced HTTPS-only endpoints in production, blocked loopback, private, and link-local IP ranges, disabled HTTP redirects, and bound delivery payloads with event IDs, timestamps, and HMAC signatures.

#### 12. Paise Fingerprint Exhaustion (Denial of Service)
* **The Issue:** With 301 paise slots (₹0.00 to ₹3.00) available per base price, an automated bot could open hundreds of checkouts to lock out all slots, preventing legitimate customers from purchasing.
* **The Solution:** Introduced rate limits on order creation, added background sweeper routines that quickly release abandoned slots after checkout countdowns, and enforced concurrency limits on real-time status connections.

---

### Phase 2 (Roadmap) — Catalog Sync, Privacy & Mobile Attestation

#### 13. Client-Side Cart Price Tampering
* **The Challenge:** Simple button integrations on external web pages could expose product prices to manipulation before reaching the server.
* **The Solution:** Introducing server-side product catalog synchronization where order creation references server-verified product IDs and fixed rates rather than arbitrary client-provided numbers.

#### 14. Regulatory Data Retention & DPDP Privacy Compliance
* **The Challenge:** Retaining raw bank SMS notifications indefinitely presents privacy and regulatory exposure.
* **The Solution:** Implementing automated redaction of sensitive account numbers and personal details in stored alerts, backed by automated retention windows that purge raw text after reconciliation.

#### 15. Mobile OS Background Suspension & Device Trust
* **The Challenge:** Aggressive OEM battery management can freeze background capture services, and rooted devices could tamper with local notification reading.
* **The Solution:** Integrating hardware-backed cryptographic signing (Android KeyStore), attestation checks (Play Integrity), and an automated setup wizard to keep capture services alive reliably.

