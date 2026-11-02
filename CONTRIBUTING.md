# Contributing to PaidSure

Thanks for helping make payment confirmation trustworthy for small merchants. 🙏

## Quick orientation

- **Backend** — Node + Express + TypeScript + Prisma (see `backend/`)
- **Frontend** — React + Vite (see `frontend/`)
- **Android helper** — Kotlin, "PaidSure Alerts" (see `android/`)
- The **heart of the project** is the parser + matching engine: it turns raw payment evidence (bank SMS / business-app push / bank email) into a confirmed order.

## The highest-value contribution: a new bank format

If your bank's credit-alert SMS isn't supported yet, you can add it in minutes:

1. Open `docs/bank-formats.md` and check whether a rule already exists.
2. Copy a **redacted sample SMS** of the credit alert (never share real names/numbers).
3. Add a rule following the structure in `docs/bank-formats.md` and include your redacted sample as a **test case**.
4. Run the parser test suite and open a PR.

A bank rule without a test case will be asked for in review.

## Dev setup

```bash
cd backend && npm install && npx prisma migrate dev && npm run dev
cd ../frontend && npm install && npm run dev
# android/ opens in Android Studio
```

Environment variables are documented in `README.md`.

## Ground rules

- **Never commit** real SMS content, phone numbers, VPAs, keys or secrets. Redact before pasting anywhere.
- **Never trust the client** — amounts and statuses must be computed/verified server-side. This invariant is enforced in review.
- Keep the design language consistent: frontend work must use the shared design tokens (`frontend/src/design/`), not ad-hoc styles.
- Android changes must preserve the battery budget: event-driven only, no polling loops or wake locks.

## Before opening a PR

```bash
npm run lint && npm run test
```

- Keep PRs focused; one feature or fix per PR.
- Link the issue you're addressing, and describe how you verified the change (a manual test path is a great addition).

## Reporting issues

- Bug report? Include: what you did, what you expected, what happened, and — for parser issues — the **redacted raw SMS**.
- Feature idea? Describe the *merchant problem* first, not just the feature.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
