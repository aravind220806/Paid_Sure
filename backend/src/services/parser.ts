/**
 * Parser v1 — turns a raw capture (bank SMS / business-app push / email body)
 * into structured payment evidence. Pure functions only; the ingest route
 * feeds the same rules.
 *
 * Rule structure mirrors docs/bank-formats.md (senders → amount → utr → payer).
 * v1 ships: HDFC, SBI, ICICI, Axis, GPay/PhonePe/Paytm-for-Business pushes and
 * generic per-lane fallbacks. Extend rules FIRST in docs/bank-formats.md, then
 * here, then in the tests — never confirm on an untested format.
 */

export interface ParsedAlert {
  /** true = money received — the only thing that confirms an order. */
  isCredit: boolean;
  amountPaise: number | null;
  utr: string | null;
  payerHint: string | null;
  ruleKey: string;
  confidence: number;
}

export interface AlertInput {
  source: string; // PUSH | SMS | EMAIL
  sender: string | null; // sender ID / package name / email From
  body: string; // raw text, truncated to 4 KB by the caller
}

export type ParseOutcome = ParsedAlert | null; // null = not payment evidence

const RULES: RuleDef[] = [
  {
    key: "hdfc-credit-v1",
    lane: "SMS",
    senders: [/HDFC/i],
    debitAny: [/\bdebited\b|\bwithdrawn\b|\bspent\b|\bpurchased\b/i],
    creditAny: [/\bcredited\b/i],
    confidence: 85,
  },
  {
    key: "sbi-credit-v1",
    lane: "SMS",
    senders: [/^SBI/, /\bSTATE BANK\b/i],
    debitAny: [/\bdebited\b|\bwithdrawn\b|\bspent\b|\bpurchased\b/i],
    creditAny: [/\bcredited\b/i],
    confidence: 85,
  },
  {
    key: "icici-credit-v1",
    lane: "SMS",
    senders: [/ICICI/i],
    debitAny: [/\bdebited\b|\bwithdrawn\b|\bspent\b/i],
    creditAny: [/\bcredited\b/i],
    confidence: 85,
  },
  {
    key: "axis-credit-v1",
    lane: "SMS",
    senders: [/AXIS/i],
    debitAny: [/\bdebited\b|\bwithdrawn\b|\bspent\b/i],
    creditAny: [/\bcredited\b/i],
    confidence: 85,
  },
  {
    key: "gpay-biz-push-v1",
    lane: "PUSH",
    senders: [/gpaybusiness|nbu\.payments|gpay/i],
    textAny: [/\byou\s+received\b/i],
    debitAny: [/\bsent\b|\bpaid\s+out\b|\bdebited\b/i],
    creditAny: [/\breceived\b/i],
    confidence: 80,
  },
  {
    key: "phonepe-biz-push-v1",
    lane: "PUSH",
    senders: [/phonepe/i],
    textAny: [/phonepe/i],
    debitAny: [/\bsent\b|\bpaid\s+out\b|\bdebited\b/i],
    creditAny: [/\breceived\b/i],
    confidence: 80,
  },
  {
    key: "paytm-biz-push-v1",
    lane: "PUSH",
    senders: [/paytm/i],
    textAny: [/paytm/i],
    debitAny: [/\bsent\b|\bpaid\s+out\b|\bdebited\b/i],
    creditAny: [/\breceived\b/i],
    confidence: 80,
  },
  {
    key: "generic-sms-credit-v1",
    lane: "SMS",
    senders: [],
    debitAny: [/\bdebited\b|\bwithdrawn\b|\bpaid\s+(?:to|out)\b|\bsent\b/i],
    creditAny: [/\bcredited\b/i],
    confidence: 55,
  },
  {
    key: "generic-push-received-v1",
    lane: "PUSH",
    senders: [],
    debitAny: [/\bdebited\b|\bpaid\s+out\b/i],
    creditAny: [/\breceived\b/i],
    confidence: 45,
  },
];

// Formats that mention "₹" next to credit-like words but are NOT a plain
// P2C credit (balance lines, merchant-bill statements, failures).
const BODY_NOISE_RE = [
  /\bbalance\b|\bbal\b\s?\binc\b/i,
  /\b(?:failed|declined|pending|revers(ed|al)|refund(ed)?)\b/i,
  /\bbill\s?pay|\brecharge\b|\bemi\b/i,
];

/** ₹ / Rs. / Rs / INR + 998 / 1,234 / 998.37 — first match wins. */
const AMOUNT_RE = /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;

/**
 * Reference after a label word. Label alternation deliberately lists longer
 * variants first so "UPI Ref no 512345678912" binds the label to the digits,
 * not to a stray "no".
 */
const UTR_RE =
  /\b(?:utr|upi\s?-?\s?ref(?:erence)?|txn\s?id|reference|ref(?:\s?no\.?|\s?#|#))\s*[:.\- ]*([a-z0-9][a-z0-9-]{5,21})/i;

const PAYER_VPA_RE = /([a-z0-9][a-z0-9._-]{2,64}@[a-z][a-z0-9]{2,})/i;
const PAYER_FROM_RE = /\bfrom\s+([A-Za-z0-9][A-Za-z0-9@._\- ]{1,38})/i;

// Cuts the "from X to Shop" capture at the next clause boundary.
const PAYER_TRAILER_RE = /\s+(?:to|at|on|via|usar?ing)\s+/i;

function firstCapture(text: string, re: RegExp): string | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m?.[1]?.trim()?.toLowerCase() ?? null;
}

function extractAmountPaise(text: string): number | null {
  AMOUNT_RE.lastIndex = 0;
  const m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function extractPayerHint(text: string): string | null {
  const viaFrom = firstCapture(text, PAYER_FROM_RE);
  if (viaFrom != null) {
    return viaFrom.split(PAYER_TRAILER_RE)[0].trim() || null;
  }
  return firstCapture(text, PAYER_VPA_RE);
}

function ruleApplies(rule: RuleDef, input: AlertInput): boolean {
  const sender = input.sender;
  if (sender != null && rule.senders.some((re) => re.test(sender))) {
    return true;
  }
  return (rule.textAny ?? []).some((re) => re.test(input.body));
}

export function parseAlert(input: AlertInput): ParseOutcome {
  const body = input.body.slice(0, 4000);
  const lane = input.source === "SMS" ? "SMS" : "PUSH";

  const applicable = RULES.filter(
    (r) => (r.lane === lane || r.lane === "BOTH") && ruleApplies(r, input),
  );
  // Specific rules (senders → text) win; otherwise fall back to the lane's
  // generic rule. Both paths still run through the same credit/noise checks.
  const rule =
    applicable[0] ??
    RULES.find(
      (r) =>
        (r.lane === lane || r.lane === "BOTH") && r.key.startsWith("generic-"),
    ) ??
    null;
  if (rule == null) return null;

  if (rule.ignoreAny?.some((re) => re.test(body))) return null;

  const creditWord = rule.creditAny.some((re) => re.test(body));
  const debitWord = rule.debitAny.some((re) => re.test(body));

  // No credit context → either a confident debit (still evidence) or noise.
  if (!creditWord) {
    if (debitWord) {
      return {
        isCredit: false,
        amountPaise: null,
        utr: null,
        payerHint: null,
        ruleKey: rule.key,
        confidence: rule.confidence,
      };
    }
    return null;
  }

  // A body that both credits and debits/debits-in-history is ambiguous: skip.
  if (BODY_NOISE_RE.some((re) => re.test(body))) return null;

  const amountPaise = extractAmountPaise(body);
  if (amountPaise == null) return null;

  return {
    isCredit: true,
    amountPaise,
    utr: firstCapture(body, UTR_RE),
    payerHint: extractPayerHint(body),
    ruleKey: rule.key,
    confidence: rule.confidence,
  };
}

interface RuleDef {
  key: string;
  lane: "SMS" | "PUSH" | "BOTH";
  senders: RegExp[];
  /** Body keywords for the same bank/app when the sender id is unreliable. */
  textAny?: RegExp[];
  ignoreAny?: RegExp[];
  debitAny: RegExp[];
  creditAny: RegExp[];
  confidence: number;
}
