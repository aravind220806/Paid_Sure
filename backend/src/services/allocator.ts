/**
 * Paisa-fingerprint allocator.
 *
 * Every order gets a distinct full-paise amount so a bank credit like
 * "credited Rs 998.37" identifies exactly one order of one merchant.
 *
 * Range: base price + 0…300 paise (0…₹3.00), split into ₹1 bands:
 *   0–99    normal traffic   (≤ ₹0.99 identifier)
 *   100–199 busy traffic     (≤ ₹1.99 identifier)
 *   200–300 peak traffic     (≤ ₹3.00 identifier)
 *
 * The *ceiling* widens with pressure (occupied amounts for the same price
 * neighbourhood), but allocation always fills the cheapest band first — a
 * quiet shop never pays more than the lower band. Uniqueness scope:
 * (merchant, amountPaise) among orders that are still open or inside the
 * late-payment safety window.
 */
import { randomInt } from "node:crypto";

/** Maximum identifier amount: ₹3.00 in paise. */
export const MAX_EXTRA_PAISE = 300;

/** Widen the range once this many slots in the current range are occupied. */
const WIDEN_AT_PAISE = [80, 180] as const;

/** The maximum extra amount allowed for a given traffic pressure. */
export function fingerprintCeiling(occupied: number): number {
  if (occupied <= WIDEN_AT_PAISE[0]) return 99;
  if (occupied <= WIDEN_AT_PAISE[1]) return 199;
  return MAX_EXTRA_PAISE;
}

/** Pick a random free offset in [low, high]; null when that band is full. */
export function pickFreeOffset(
  taken: Iterable<number>,
  low: number,
  high: number,
): number | null {
  const takenSet = taken instanceof Set ? taken : new Set(taken);
  const free: number[] = [];
  for (let n = low; n <= high; n++) {
    if (!takenSet.has(n)) free.push(n);
  }
  if (free.length === 0) return null;
  return free[randomInt(0, free.length)];
}

/**
 * Choose a fingerprint offset for a new order.
 *
 * @param basePaise      Product total in paise (e.g. ₹998 → 99800).
 * @param takenAmounts   Absolute amountPaise values already occupied by this
 *                       merchant in [basePaise, basePaise + 300]. Includes
 *                       open orders and recent payments inside the safety
 *                       window, so neighbouring price points cannot collide.
 * @returns offset in paise (0…300), or null when all 301 slots are taken.
 */
export function chooseFingerprintOffset(
  basePaise: number,
  takenAmounts: Iterable<number>,
): number | null {
  const takenOffsets = new Set<number>();
  for (const amount of takenAmounts) {
    const offset = amount - basePaise;
    if (offset >= 0 && offset <= MAX_EXTRA_PAISE) takenOffsets.add(offset);
  }

  const ceiling = fingerprintCeiling(takenOffsets.size);
  const bands: Array<[number, number]> = [
    [0, 99],
    [100, 199],
    [200, MAX_EXTRA_PAISE],
  ];

  // Fill the cheapest band first, widening only when it is full.
  for (const [low, high] of bands) {
    if (low > ceiling) break;
    const offset = pickFreeOffset(takenOffsets, low, Math.min(high, ceiling));
    if (offset !== null) return offset;
  }

  // Defensive fallback: a stale pressure sample must never turn free space
  // into a false "sold out" while slots remain.
  if (ceiling < MAX_EXTRA_PAISE) {
    return pickFreeOffset(takenOffsets, 0, MAX_EXTRA_PAISE);
  }
  return null;
}
