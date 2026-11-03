/**
 * Order sweeper.
 *
 * A PENDING order stays matchable for the merchant's late-match window
 * (createdAt + lateMatchMinutes), even after its checkout link expires.
 * This job closes it only once that window has passed, so late payments
 * still confirm correctly while old orders stop blocking fingerprint slots
 * forever.
 *
 * The allocator then keeps the amount reserved for another lateMatchMinutes
 * after this status change, which gives a full safety buffer against duplicate
 * or late credits arriving after the order is closed.
 */
import { prisma } from "../db.js";

export async function sweepExpiredOrders(now = new Date()): Promise<number> {
  const merchants = await prisma.merchant.findMany({
    select: { id: true, lateMatchMinutes: true },
  });

  let closed = 0;
  for (const merchant of merchants) {
    const cutoff = new Date(now.getTime() - merchant.lateMatchMinutes * 60_000);
    const result = await prisma.order.updateMany({
      where: {
        merchantId: merchant.id,
        status: "PENDING",
        createdAt: { lt: cutoff },
      },
      data: { status: "EXPIRED" },
    });
    closed += result.count;
  }
  return closed;
}

/** Run the sweeper every minute; unref so it never keeps the process alive. */
export function startOrderSweeper(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    sweepExpiredOrders().catch((error) => {
      console.error("[paidsure] order sweeper failed", error);
    });
  }, intervalMs);
  timer.unref();
  return timer;
}
