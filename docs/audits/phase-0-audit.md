# Phase 0 Security & Quality Audit — PaidSure

**Scope:** everything committed at Phase 0 (scaffold, backend, frontend, design system, CI, docs, Android stub)
**Audited locally:** secret sweeps (tracked + full git history), `npm audit` (before/after), CORS behavior (live curl), boot verification, CI configuration, Prisma schema, build/typecheck/test chain.
**Verdict:** ✅ **PASS — Phase 0 cleared to proceed to Phase 1.**

## Score

| # | Category | Weight | Before | After | Notes |
|---|---|:---:|:---:|:---:|---|
| 1 | Secrets & credential handling | 10 | 10 | **10** | No secrets in tracked files or history; device tokens hashed at rest (schema); `.env.example` contains dev placeholders only |
| 2 | Dependency & supply-chain security | 10 | 3 | **10** | **2 critical (tinypool RCE) + 1 dev-server CVE + zod/deepmerge highs → 0 vulnerabilities**; production-audit gate added to CI |
| 3 | Runtime hardening | 10 | 7 | **8.5** | Security headers added; CORS moved to allowlist (verified deny-by-default); JSON body cap; `x-powered-by` off; generic 5xx |
| 4 | AuthN/AuthZ surface | 10 | 6 | **6** | No auth routes yet (by design in Phase 0); blueprint documented (JWT sessions, hashed device tokens); nothing shipped = nothing to attack |
| 5 | Data model integrity | 10 | 8 | **8** | Multi-tenant indexes, unique dedupe hash, cascade deletes; unique-open-amount allocation is transaction-gated in Phase 1 (pending); String statuses on SQLite documented |
| 6 | Privacy & compliance (DPDP) | 10 | 7 | **7** | Raw SMS stored deliberately as evidence: consent-first design, redaction rules, retention/field-encryption deferred to Phase 2 |
| 7 | Code quality & tests | 10 | 7.5 | **7.5** | Strict TS, lint/typecheck/test gates, 4/4 money-math tests; coverage intentionally thin at Phase 0 |
| 8 | CI/CD & reproducibility | 10 | 7 | **8.5** | `permissions: contents: read` added; `npm audit --omit=dev --audit-level=high` gate added; full gate chain green |
| 9 | Frontend security & design | 10 | 8.5 | **8.5** | No XSS sinks (no `dangerouslySetInnerHTML`); deps patched (vite 8); token system ported verbatim |
| 10 | Android readiness | 10 | 5 | **5** | Stub only (expected); permissions matrix + ingest contract documented; nothing built yet to audit |

### **Total: 69/100 → 79/100 (after remediation, same session)**

## Findings

### Fixed during this audit

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| F-01 | 🔴 Critical | `tinypool` ≤2.1.1 — prototype-pollution → RCE (via `vitest`, dev-only) | `vitest@5.0.5`; tests pass on the new major |
| F-02 | 🟠 High | `zod` <4.6.6 — memory exhaustion on oversized constrained collections (runtime dep) | `zod@4.6.7`; config schema revalidated by typecheck+tests |
| F-03 | 🟠 High | `deepmerge-ts` stack exhaustion via `@prisma/config`/`prisma` | `npm audit fix` (semver-compatible bump) |
| F-04 | 🟡 Moderate | `esbuild`/`vite` ≤6.4.3 dev-server request forgery (dev-only) | `vite@8.3.5` + `@vitejs/plugin-react@latest` |
| F-05 | 🟠 High | Blanket `cors()` — any origin allowed | `ALLOWED_ORIGINS` allowlist; **deny-by-default** (verified live: foreign `Origin` gets 0 ACAO headers); Vite dev proxy is same-origin so local dev needs no entry |
| F-06 | 🟡 Moderate | Missing security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` added |
| F-07 | 🟠 High | Workflows ran with default (write) `GITHUB_TOKEN` permissions | `permissions: contents: read` scoped |
| F-08 | 🟡 Moderate | No audit gate in CI | `npm audit --omit=dev --audit-level=high` step (passes at 0 findings) |
| F-09 | 🟡 Moderate | Production boot allowed SQLite + dev placeholder secrets | `assertNoProductionHazards()` — refuses to boot in prod with `file:` DB or `dev-*` secrets |
| F-10 | 🟢 Low | README tech table implied PostgreSQL as the default | Corrected: SQLite (dev) / PostgreSQL (prod) |

### Clean checks (no action needed)

- 🔒 **Secret scan:** no key/token-pattern matches in tracked files; `.env`, `dev.db`, keys never entered git history (verified by history walk)
- 🖼️ **`docs/banner.svg`:** no `<script>`/`foreignObject`/external refs — safe to ship in a README
- 📦 **Tracked-file review:** 31 files, nothing stray (no editor junk, no `.env`, no DB)
- 🧮 **Money math:** integer-paise rules assert-covered (float precision, suffix bounds)

### Implemented-practices worth noting

- Runtime env validation with `zod` (typed, fail-fast)
- Central error handler returns generic `internal_error` — no stack leakage
- Health endpoint does a real `SELECT 1` (honest `db: up/down`)
- `npm ci` (lockfile-pinned) in CI

## Deferred to Phase 1+ (tracked, not blockers)

| Item | Why deferred |
|---|---|
| Rate limiting on all routes | Routes don't exist yet; land with the order/ingest APIs |
| GitHub Actions pinned to commit SHAs | Tag pinning acceptable now; single-maintainer repo |
| JWT rotation + token TTLs | With the first authenticated routes |
| Transactional unique-amount allocator (`(merchantId, amountPaise)` unique among OPEN orders) | Core of Phase 1's order API — must arrive with it |
| SMS/e-mail retention policy + field-level encryption | Phase 2 privacy work (DPDP) |
| SAST via GitHub Code Scanning / Dependabot PRs | Enable after repo goes public |
| Android implementation | Phase 1 scaffold |

## Exit criteria status

| Criterion | Status |
|---|---|
| Frontend renders Apple-grade token system | ✅ (`tokens.css` verbatim port + demo shell, builds clean) |
| Backend boots with migrations | ✅ (live `/health` → `{"ok":true,"db":"up"}`) |
| CI-ready lint/format/test basics | ✅ (all gates green pre-commit) |
| Monorepo scaffold | ✅ (npm workspaces; Android stub documented) |
| Zero known vulnerabilities | ✅ (0 findings across both workspaces) |
