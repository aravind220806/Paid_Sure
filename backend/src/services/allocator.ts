/**
 * Unique-amount allocator.
 *
 * Every open order gets a distinct full-paise amount so an SMS like
 * "credited Rs 998.37" identifies exactly one order of one merchant.
 * The merchant keeps the whole-rupee total; PaidSure owns the 0–99 paise
 * suffix. Uniqueness scope: (merchant, amountPaise) among OPEN orders.
 */
import { randomInt } from "node:crypto";

/** 0–99 suffix not in `taken`; null when all 100 are busy. */
export function pickFreeSuffix(taken: Iterable<number>): number | null {
  const takenSet = new Set(taken);
  if (takenSet.size >= 100) return null;
  // Random order of 0..99 — avoids suffix clustering (not always .00 first).
  const deck = Array.from({ length: 100 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.find((n) => !takenSet.has(n)) ?? null;
}

export { };

export function paiseAmountOf(baseRupees: number, suffix: number): number {
  return baseRupees * 100 + suffix;
}
