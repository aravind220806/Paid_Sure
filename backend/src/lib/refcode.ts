/**
 * Human order references: "PS-000421" style. Uniqueness is checked against
 * the DB by the caller (collision odds are 1-in-a-million per call).
 */
import { randomInt } from "node:crypto";

export function newOrderRef(): string {
  return `PS-${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
}
