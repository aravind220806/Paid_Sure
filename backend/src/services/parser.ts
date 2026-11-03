/**
 * Parser v2 — verified evidence only.
 *
 * Lane priority (best first):
 *   1. PUSH from a known business app (GPay Business, PhonePe, Paytm, BharatPe)
 *   2. SMS from a known bank sender ID (HDFCBK, SBIINB, ICICIB, AXISBK, …)
 *   3. EMAIL from a known bank domain
 *
 * Anything else is still parsed into the evidence ledger, but it is marked
 * `verified: false` and the matcher routes it to REVIEW. An unknown sender can
 * never auto-confirm an order — that was the Phase 1 free-goods hole.
 *
 * Rules are deliberately conservative: a body that mentions both a credit and
 * a debit is ambiguous and is never treated as a credit. Add new bank/app
 * formats in docs/bank-formats.md first, then here, then in the tests.
 */

export type Lane = "SMS" | "PUSH" | "EMAIL";

export interface ParsedAlert {
  /** true = money received — the only thing that can confirm an order. */
  isCredit: boolean;
  amountPaise: number | null;
  utr: string | null;
  payerHint: string | null;
  ruleKey: string;
  confidence: number;
  lane: Lane;
  /**
   * true only when the sender/package/domain is on a verified allowlist AND
   * the body is unambiguous. Only verified credits may auto-confirm.
   */
  verified: boolean;
}

export interface AlertInput {
  source: string; // PUSH | SMS | EMAIL
  sender: string | null; // sender ID / package name / email From
  body: string; // raw text, truncated to 4 KB by the caller
}

export type ParseOutcome = ParsedAlert | null; // null = not payment evidence

interface RuleDef {
  key: string;
  lane: Lane;
  /** Tested against the compacted, upper-cased sender/package/domain. */
  senders: RegExp[];
  confidence: number;
}

const RULES: RuleDef[] = [
  // ── Business-app pushes (first preference: fastest + hardest to spoof) ──
  {
    key: "gpay-biz-push-v1",
    lane: "PUSH",
    senders: [/GPAYBUSINESS|NBUPAISA|NBUPAYMENTS|GPAY/],
    confidence: 95,
  },
  { key: "phonepe-biz-push-v1", lane: "PUSH", senders: [/PHONEPE/], confidence: 92 },
  { key: "paytm-biz-push-v1", lane: "PUSH", senders: [/PAYTM/], confidence: 92 },
  { key: "bharatpe-biz-push-v1", lane: "PUSH", senders: [/BHARATPE/], confidence: 90 },

  // ── Bank SMS (fallback: only from a real bank sender ID) ──
  { key: "hdfc-credit-v1", lane: "SMS", senders: [/HDFC/], confidence: 85 },
  { key: "sbi-credit-v1", lane: "SMS", senders: [/SBI|STATEBANK/], confidence: 85 },
  { key: "icici-credit-v1", lane: "SMS", senders: [/ICICI/], confidence: 85 },
  { key: "axis-credit-v1", lane: "SMS", senders: [/AXIS/], confidence: 85 },
  { key: "kotak-credit-v1", lane: "SMS", senders: [/KOTAK/], confidence: 85 },
  { key: "pnb-credit-v1", lane: "SMS", senders: [/PNB/], confidence: 85 },
  { key: "bob-credit-v1", lane: "SMS", senders: [/BOB|BANKOFBARODA/], confidence: 85 },
  { key: "idfc-credit-v1", lane: "SMS", senders: [/IDFC/], confidence: 85 },
  { key: "canara-credit-v1", lane: "SMS", senders: [/CANARA|CANBNK/], confidence: 85 },
  { key: "union-credit-v1", lane: "SMS", senders: [/UNIONB|UBINB/], confidence: 85 },
  { key: "yes-credit-v1", lane: "SMS", senders: [/YESBANK|YESBNK/], confidence: 85 },
  { key: "indusind-credit-v1", lane: "SMS", senders: [/INDUSIND|INDBNK/], confidence: 85 },
  { key: "federal-credit-v1", lane: "SMS", senders: [/FEDBNK|FEDRLB/], confidence: 85 },
  { key: "rbl-credit-v1", lane: "SMS", senders: [/RBL/], confidence: 85 },
  { key: "aubank-credit-v1", lane: "SMS", senders: [/AUBANK/], confidence: 85 },
  { key: "paytm-bank-credit-v1", lane: "SMS", senders: [/PAYTMBANK|PAYTMB/], confidence: 85 },
  { key: "airtel-bank-credit-v1", lane: "SMS", senders: [/AIRBNK|ATLPBK|AIRTELBANK/], confidence: 85 },
  { key: "jio-bank-credit-v1", lane: "SMS", senders: [/JIOBNK|JIOPBK|JIOBANK/], confidence: 85 },

  // ── Bank email (known domains only) ──
  {
    key: "bank-email-credit-v1",
    lane: "EMAIL",
    senders: [
      /HDFCBANK|SBICOIN|ICICIBANK|AXISBANK|KOTAK|PNB|BANKOFBARODA|IDFC|CANARA|UNIONBANK|YESBANK|INDUSIND|FEDERAL|RBL|AUBANK/,
    ],
    confidence: 80,
  },

  // ── Unknown senders: evidence only, never auto-confirm ──
  { key: "generic-sms-credit-v1", lane: "SMS", senders: [], confidence: 40 },
  { key: "generic-push-received-v1", lane: "PUSH", senders: [], confidence: 35 },
  { key: "generic-email-credit-v1", lane: "EMAIL", senders: [], confidence: 30 },
];

// Formats that mention credit-like words but are NOT a plain P2C credit
// (failures, reversals, cashback/rewards, balance-only lines, OTPs, payment requests).
const BODY_NOISE_RE = [
  /\b(?:failed|declined|pending|revers(?:ed|al)|refund(?:ed)?)\b/i,
  /\bbill\s?pay|\brecharge\b|\bemi\b/i,
  /\bcashback\b|\breward(?:s)?\b|\bpoints?\b|\binterest\b|\bsalary\b/i,
  /\bcredit\s+card\b/i,
  /\b(?:otp|password|pin)\b/i,
  /\b(?:request(?:ed|ing)?|collect(?:ed|ing)?|mandate|autopay|split\s*bill|reminder)\b/i,
];

// Chat / direct messaging notifications in payment apps ("Rahul: Payment received...", "Alice sent you a message: ...")
const CHAT_OR_MESSAGE_RE =
  /^(?:[a-zA-Z0-9_\s]{2,30}:\s+|.*?\b(?:sent\s+you\s+a\s+message|sent\s+a\s+message|new\s+message|chat)\b)/i;

/** ₹ / Rs. / Rs / INR + 998 / 1,234 / 998.37 — first match wins. */
const AMOUNT_RE = /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;

/** Debit context. A body with both credit and debit words is ambiguous. */
const DEBIT_RE = /\b(?:debited|debit|withdrawn|withdrawal|spent|purchased|paid\s+out|sent)\b/i;

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

interface AmountHit {
  value: number;
  start: number;
}

function extractAmounts(text: string): AmountHit[] {
  AMOUNT_RE.lastIndex = 0;
  const hits: AmountHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const value = Math.round(Number(m[1].replace(/,/g, "")) * 100);
    if (Number.isFinite(value) && value > 0) hits.push({ value, start: m.index });
  }
  return hits;
}

/**
 * Pick the amount closest to a credit keyword. If two different amounts sit
 * near credit keywords, the message is ambiguous — return null instead of
 * guessing. This stops promo/balance lines from confirming an order.
 */
function pickAmountPaise(text: string, creditIndices: number[]): number | null {
  const hits = extractAmounts(text);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0].value;

  const near = hits.filter((h) =>
    creditIndices.some((index) => Math.abs(h.start - index) <= 30),
  );
  if (near.length >= 2) {
    const distinct = new Set(near.map((h) => h.value));
    if (distinct.size > 1) return null;
    return near[0].value;
  }

  const ranked = hits
    .map((h) => ({
      ...h,
      distance: Math.min(...creditIndices.map((index) => Math.abs(h.start - index))),
    }))
    .sort((a, b) => a.distance - b.distance);
  const [best, second] = ranked;
  if (second && second.distance - best.distance < 8 && second.value !== best.value) {
    return null;
  }
  return best.value;
}

function extractPayerHint(text: string): string | null {
  const viaFrom = firstCapture(text, PAYER_FROM_RE);
  if (viaFrom != null) {
    return viaFrom.split(PAYER_TRAILER_RE)[0].trim() || null;
  }
  return firstCapture(text, PAYER_VPA_RE);
}

function laneFor(source: string): Lane {
  if (source === "SMS") return "SMS";
  if (source === "EMAIL") return "EMAIL";
  return "PUSH";
}

/** "VM-HDFCBK", "AD-HDFCBK", "HDFC Bank" → "VMHDFCBK", "ADHDFCBK", "HDFCBANK". */
function compactSender(sender: string | null): string {
  return (sender ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function ruleFor(lane: Lane, sender: string): RuleDef | null {
  const matched = RULES.find(
    (r) => r.lane === lane && r.senders.some((re) => re.test(sender)),
  );
  if (matched) return matched;
  return RULES.find((r) => r.lane === lane && r.key.startsWith("generic-")) ?? null;
}

export function parseAlert(input: AlertInput): ParseOutcome {
  const body = input.body.slice(0, 4000);
  const lane = laneFor(input.source);
  const sender = compactSender(input.sender);
  const rule = ruleFor(lane, sender);
  if (rule == null) return null;

  // A sender/package/domain on an allowlist is the only path to auto-confirm.
  const verified = rule.senders.length > 0;

  if (BODY_NOISE_RE.some((re) => re.test(body))) return null;
  if (lane === "PUSH" && CHAT_OR_MESSAGE_RE.test(body)) return null;

  const creditMatches = [...body.matchAll(/\b(?:credited|received)\b/gi)];
  const creditWord = creditMatches.length > 0;
  const debitWord = DEBIT_RE.test(body);

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
        lane,
        verified,
      };
    }
    return null;
  }

  // A body that both credits and debits is ambiguous: never confirm.
  if (debitWord) {
    return {
      isCredit: false,
      amountPaise: null,
      utr: null,
      payerHint: null,
      ruleKey: rule.key,
      confidence: rule.confidence,
      lane,
      verified: false,
    };
  }

  const amountPaise = pickAmountPaise(
    body,
    creditMatches.map((match) => match.index ?? 0),
  );
  if (amountPaise == null) return null;

  return {
    isCredit: true,
    amountPaise,
    utr: firstCapture(body, UTR_RE),
    payerHint: extractPayerHint(body),
    ruleKey: rule.key,
    confidence: rule.confidence,
    lane,
    verified,
  };
}
