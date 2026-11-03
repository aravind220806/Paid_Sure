/**
 * Human order references: "PS-" + 20 hex characters (80 random bits).
 *
 * Phase 1 used a 6-digit ref (`PS-000421`), which was enumerable in minutes
 * with no rate limit. The public status URL now carries an unguessable ref;
 * the `PS-` prefix keeps links recognisable.
 */
import { randomBytes } from "node:crypto";

export function newOrderRef(): string {
  return `PS-${randomBytes(10).toString("hex")}`;
}
