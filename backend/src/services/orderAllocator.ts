import type { Prisma, PrismaClient } from "@prisma/client";
import {
  chooseFingerprintOffset,
  fingerprintCeiling,
  MAX_EXTRA_PAISE,
} from "./allocator.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface FingerprintChoice {
  amountPaise: number;
  extraPaise: number;
  /** Occupied slots in this price neighbourhood at allocation time. */
  pressure: number;
  /** Traffic ceiling that was active for this allocation (99 / 199 / 300). */
  ceilingPaise: number;
}

/**
 * Amounts that currently block allocation for a base price.
 *
 * Includes:
 *  - every PENDING order (the sweeper closes them after the late-match window)
 *  - any non-PENDING order updated inside the late-payment safety window
 *
 * The second rule is what stops a paid order's amount being reused while a
 * duplicate or late credit could still arrive and match a new order.
 */
export async function getFingerprintOccupancy(
  db: Db,
  merchantId: string,
  basePaise: number,
  retireMinutes: number,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - retireMinutes * 60_000);
  return db.order.findMany({
    where: {
      merchantId,
      amountPaise: { gte: basePaise, lte: basePaise + MAX_EXTRA_PAISE },
      OR: [{ status: "PENDING" }, { updatedAt: { gt: cutoff } }],
    },
    select: { amountPaise: true },
    orderBy: { amountPaise: "asc" },
  });
}

/** Allocate a unique fingerprint amount, or null when all 301 are occupied. */
export async function allocateFingerprint(
  db: Db,
  merchantId: string,
  basePaise: number,
  retireMinutes: number,
  now = new Date(),
): Promise<FingerprintChoice | null> {
  const rows = await getFingerprintOccupancy(db, merchantId, basePaise, retireMinutes, now);
  const taken = rows.map((row) => row.amountPaise);
  const offset = chooseFingerprintOffset(basePaise, taken);
  if (offset === null) return null;

  return {
    amountPaise: basePaise + offset,
    extraPaise: offset,
    pressure: taken.length,
    ceilingPaise: fingerprintCeiling(taken.length),
  };
}
