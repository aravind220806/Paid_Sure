/**
 * Money helpers. Phase 0: integer-paise math — the foundation of the
 * unique-amount allocator (Phase 1) where every order must end in a
 * distinct paise suffix so an SMS like "credited ₹499.37" identifies
 * exactly one open order.
 *
 * Rule of the codebase: amounts are NEVER floats at rest. Store paise.
 */

/** Convert a rupee amount (499.37) into integer paise (49937). */
export function toPaise(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new TypeError("amount must be a finite number");
  }
  const paise = Math.round(amount * 100);
  if (paise <= 0) {
    throw new RangeError("amount must be greater than zero");
  }
  return paise;
}

/** Combine a whole-rupee base with a 0–99 paise suffix: 499 + 37 → 49937 paise. */
export function paiseSuffix(baseRupees: number, suffix: number): number {
  if (!Number.isInteger(baseRupees) || baseRupees <= 0) {
    throw new RangeError("baseRupees must be a positive integer");
  }
  if (!Number.isInteger(suffix) || suffix < 0 || suffix > 99) {
    throw new RangeError("suffix must be an integer 0–99");
  }
  return baseRupees * 100 + suffix;
}

/** Format integer paise for humans: 99837 → "₹998.37" (Indian locale). */
export function formatINR(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new TypeError("paise must be a non-negative integer");
  }
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
