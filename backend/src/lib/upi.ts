/**
 * UPI intent URL builder (pure, no I/O).
 *
 * Produces the payload the customer's UPI app opens pre-filled:
 *   upi://pay?pa=shop@okaxis&pn=Shop&am=998.37&cu=INR&tn=Order%20PS-000421
 *
 * Encoding detail: spaces must stay %20. URLSearchParams would emit "+",
 * which some UPI apps render literally — build the query by hand.
 */

/** 99837 → "998.37" (UPI `am` format: two decimals, no thousands separators). */
export function paiseToUpiAmount(paise: number): string {
  if (!Number.isInteger(paise) || paise <= 0) {
    throw new RangeError("paise must be a positive integer");
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return `${rupees}.${String(remainder).padStart(2, "0")}`;
}

export interface UpiPayee {
  /** Receiving VPA — money lands here. */
  vpa: string;
  /** Name shown to the payer's UPI app (`pn`). */
  payeeName: string;
}

export function buildUpiPayUrl(
  payee: UpiPayee,
  amountPaise: number,
  note: string,
): string {
  const enc = encodeURIComponent;
  const am = paiseToUpiAmount(amountPaise);
  return (
    `upi://pay?pa=${enc(payee.vpa)}` +
    `&pn=${enc(payee.payeeName)}` +
    `&am=${encodeURIComponent(am)}` +
    `&cu=INR` +
    `&tn=${enc(note)}`
  );
}
