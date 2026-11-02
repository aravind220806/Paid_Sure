# Bank & App Alert Formats (Parser Rules)

PaidSure confirms orders from **payment evidence alerts** received on the
merchant's own phone. This document catalogs the format of those alerts and how
parser rules map them to structured data.

> This is a living document. When you add support for a new bank or app, add its
> sample + rule here. **Always redact** names, phone numbers, account numbers
> and real VPAs before committing.

## What an alert must tell us

From each alert the parser extracts:

| Field | Purpose |
|---|---|
| `type` | credit (money received) vs anything else — only credits matter for confirmation |
| `amount_paise` | the credited amount, in paise (integer) |
| `utr` / `ref` | transaction reference, when present — used as duplicate/audit trail |
| `payer_hint` | payer VPA/name when present — feeds the future customer CRM |
| `timestamp` | device-side receive time (SMS) or notification post time (push) |
| `source` | which capture lane produced it: `push` / `sms` / `email` |

## Rule structure

Rules are declarative patterns stored per bank/app (seeded into `ParserRule`;
zip-agnostic regex style shown for illustration):

```jsonc
{
  "id": "hdfc-credit-v1",
  "match": {
    "sender": ["HDFCBK", "HDFC"],           // sender ID patterns
    "anyOf": ["credited", "credited to"]    // credit keywords
  },
  "amount": { "patterns": ["(?:Rs\\.?|INR|₹)\\s?([0-9,]+(?:\\.[0-9]{1,2})?)"] },
  "utr":    { "patterns": ["(?:Ref|UTR|Ref no)\\s?[:]?.?([0-9A-Z]{6,})"] },
  "payer":  { "patterns": ["from\\s+([A-Za-z0-9@.\\-]+)"] },
  "ignore": { "anyOf": ["debited", "withdrawn"] }  // never a credit
}
```

- A **generic fallback rule** handles unknown banks: credit keyword + standard
  Indian amount patterns (`Rs / Rs. / INR / ₹`) + optional UTR pattern.
- Every rule update must ship with a **test case** = the raw (redacted) SMS and
  the expected extracted fields.

## Format catalog — seeds for v1

> Add real samples here as they're collected during testing. Redact!

| Bank / App | Status | Notes |
|---|---|---|
| Generic fallback | ✅ planned | credit keyword + amount + optional UTR |
| HDFC | ⏳ need sample | sender-like `HDFCBK`; amount "Rs." |
| SBI | ⏳ need sample | "credited", INR amounts |
| ICICI | ⏳ need sample | UTC-style ref patterns |
| Axis | ⏳ need sample | |
| Kotak | ⏳ need sample | |
| PNB | ⏳ need sample | |
| Bank of Baroda | ⏳ need sample | |
| IDFC First | ⏳ need sample | |
| AU Small Finance | ⏳ need sample | |
| Canara / Union | ⏳ need sample | |
| Paytm Payments Bank | ⏳ need sample | |
| Airtel Payments Bank | ⏳ need sample | |
| PhonePe Business (push) | ⏳ need sample | notification text varies by version |
| Paytm for Business (push) | ⏳ need sample | notification text varies by version |
| Google Pay (push) | ⏳ need sample | "Money received" style notifications |

## Practical notes

- **Bank SMS is transactional** and bypasses DND, but can still be delayed or
  lost (full inbox, eSIM quirks) — that's why PaidSure uses three lanes and a
  late-match window.
- Notification text of business apps changes with app updates; treat push
  formats as *versioned rules* and prefer the bank SMS as the authoritative
  confirmation when both agree.
- Emails (IMAP tier) follow bank-specific subject/body conventions; do not
  parse HTML, use plain-text parts.
- Never auto-confirm on amounts alone when two open orders share the same
  paise suffix for a merchant — the allocator guarantees uniqueness, but the
  matcher should still prefer the oldest open order and surface ties for
  manual confirm.

## Contributing a format — checklist

- [ ] Redacted raw sample (SMS text / push text / email subject+body)
- [ ] Rule JSON added to the ruleset with an `id` like `bank-credit-v1`
- [ ] Test case asserting extracted `amount_paise`, `utr`, `type`
- [ ] Row added to the catalog table above
