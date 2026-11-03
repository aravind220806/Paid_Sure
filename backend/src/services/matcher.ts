/**
 * Matching engine — links verified credit evidence to an open order.
 *
 * Invariants:
 *  - Only CREDIT evidence can confirm.
 *  - Only VERIFIED evidence can auto-confirm. `verified` means the parser saw
 *    a known business-app package (GPay Business, PhonePe, Paytm, …) or a real
 *    bank sender ID (HDFCBK, SBIINB, ICICIB, AXISBK, …). Unknown senders are
 *    kept as evidence and routed to REVIEW — never PAID.
 *  - Amount must equal an OPEN order's amountPaise exactly (allocator
 *    guarantees consumers can't collide).
 *  - Evidence must belong to the merchant who owns the order (device is
 *    bound to merchant at ingest time).
 *  - Match window: device capture time ∈ [order.createdAt,
 *    createdAt + lateMatchMinutes]. The device timestamp is bounded: it may not
 *    be in the future, and `paidAt` is always the server's clock.
 *  - Race-safe: the order row is claimed with a conditional updateMany,
 *    so double-confirmations collapse into one winner.
 */
import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { deliverWebhook } from "../lib/webhook.js";
import { parseAlert } from "./parser.js";

export interface IngestMessage {
  source: "PUSH" | "SMS" | "EMAIL";
  sender?: string;
  body: string;
  receivedAt?: string; // ISO; device-side capture time
}

export type MatchOutcome =
  | "matched"
  | "duplicate" // identical alert fingerprint already stored
  | "ignored" // not credit / not parseable
  | "review" // credit, but unverified or merchant policy wants eyes on it
  | "unmatched"; // verified credit, no fitting open order

export interface ProcessedMessage {
  outcome: MatchOutcome;
  orderRef?: string;
  ruleKey?: string;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_PAST_SKEW_MS = 30 * 60_000;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Device clocks drift and phones go offline; accept a capture time up to the
 * late-match window old, but never a future time (that would let a device
 * pre-date an order) nor a time older than 30 minutes. Returns null when the timestamp is nonsense.
 */
function eventTime(raw: string | undefined, now: Date): Date | null {
  if (!raw) return now;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return null;
  if (parsed.getTime() < now.getTime() - MAX_PAST_SKEW_MS) return null;
  return parsed.getTime() > now.getTime() ? now : parsed;
}

export async function processIngestMessage(
  merchantId: string,
  deviceId: string,
  msg: IngestMessage,
): Promise<ProcessedMessage> {
  const now = new Date();
  const sender = msg.sender ?? null;
  const body = msg.body.slice(0, 4000);
  const capturedAt = eventTime(msg.receivedAt, now);
  if (capturedAt == null) return { outcome: "ignored" };

  // Merchant-scoped fingerprint: the same bank text must never suppress
  // another merchant's alert (Phase 1 global-unique bug).
  const fingerprint = sha256(
    `${merchantId}|${msg.source}|${sender ?? ""}|${body.trim()}`,
  );

  let alert;
  try {
    alert = await prisma.paymentAlert.create({
      data: {
        merchantId,
        deviceId,
        source: msg.source,
        sender,
        body,
        hash: fingerprint,
        receivedAt: capturedAt,
        serverReceivedAt: now,
      },
    });
  } catch (e) {
    // Unique (merchantId, hash) hit — identical alert replayed across lanes.
    if ((e as { code?: string } | null)?.code === "P2002") {
      return { outcome: "duplicate" };
    }
    throw e;
  }

  const parsed = parseAlert({ source: msg.source, sender, body });
  if (!parsed) {
    await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });
    return { outcome: "ignored" };
  }

  if (!parsed.isCredit || parsed.amountPaise == null) {
    await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });
    return { outcome: "ignored", ruleKey: parsed.ruleKey };
  }

  const parsedTxn = await prisma.parsedTransaction.create({
    data: {
      alertId: alert.id,
      merchantId,
      isCredit: true,
      amountPaise: parsed.amountPaise,
      utr: parsed.utr,
      payerHint: parsed.payerHint,
      source: msg.source,
      ruleKey: parsed.ruleKey,
      confidence: parsed.confidence,
    },
  });

  // Unverified evidence is recorded but never auto-confirms.
  if (!parsed.verified) {
    await prisma.parsedTransaction.update({
      where: { id: parsedTxn.id },
      data: { status: "REVIEW" },
    });
    await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });
    return { outcome: "review", ruleKey: parsed.ruleKey };
  }

  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return { outcome: "ignored", ruleKey: parsed.ruleKey };

  // strictMode: only bank-authenticated lanes (SMS / EMAIL) may auto-confirm.
  if (merchant.strictMode && msg.source === "PUSH") {
    await prisma.parsedTransaction.update({
      where: { id: parsedTxn.id },
      data: { status: "REVIEW" },
    });
    await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });
    return { outcome: "review", ruleKey: parsed.ruleKey };
  }

  // One payment UTR may only ever confirm ONE order. Replaying an identical
  // UTR across orders or lanes is blocked.
  if (parsed.utr) {
    const alreadyUsed = await prisma.parsedTransaction.findFirst({
      where: {
        merchantId,
        utr: parsed.utr,
        status: "MATCHED",
      },
    });
    if (alreadyUsed) {
      await prisma.parsedTransaction.update({
        where: { id: parsedTxn.id },
        data: { status: "DUPLICATE" },
      });
      await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });
      return { outcome: "duplicate", ruleKey: parsed.ruleKey };
    }
  }

  const order = await findOpenOrderFor(
    merchantId,
    parsed.amountPaise,
    capturedAt,
    merchant.lateMatchMinutes,
    now,
  );
  if (!order) return { outcome: "unmatched", ruleKey: parsed.ruleKey };

  // Conditional claim: only one of concurrent alerts flips the order.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "PAID",
      paidAt: now, // server clock — never the device's
      confirmedSource: msg.source,
    },
  });
  if (claimed.count === 0) return { outcome: "unmatched", ruleKey: parsed.ruleKey };

  await prisma.parsedTransaction.update({
    where: { id: parsedTxn.id },
    data: { matchedOrderId: order.id, status: "MATCHED", matchedAt: now },
  });
  await prisma.paymentAlert.update({ where: { id: alert.id }, data: { processed: true } });

  fireMerchantWebhook(merchant, {
    event: "order.paid",
    ref: order.ref,
    merchant: merchant.slug,
    amountPaise: order.amountPaise,
    utr: parsed.utr,
    payerHint: parsed.payerHint,
    source: msg.source,
    ruleKey: parsed.ruleKey,
    paidAt: now.toISOString(),
  });

  return { outcome: "matched", orderRef: order.ref, ruleKey: parsed.ruleKey };
}

async function findOpenOrderFor(
  merchantId: string,
  amountPaise: number,
  at: Date,
  lateMatchMinutes: number,
  now = new Date(),
) {
  const candidates = await prisma.order.findMany({
    where: { merchantId, status: "PENDING", amountPaise },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  const windowMs = lateMatchMinutes * 60_000;
  return (
    candidates.find(
      (o) =>
        now.getTime() <= o.createdAt.getTime() + windowMs &&
        at >= o.createdAt &&
        at.getTime() <= o.createdAt.getTime() + windowMs,
    ) ?? null
  );
}

/**
 * Fire-and-forget, HMAC-signed `order.paid` notification. The URL is SSRF
 * checked (HTTPS/public hosts only) and redirects are never followed.
 */
function fireMerchantWebhook(
  merchant: {
    webhookUrl: string | null;
    webhookSecret: string | null;
  },
  payload: Record<string, unknown>,
): void {
  if (!merchant.webhookUrl || !merchant.webhookSecret) return;
  void deliverWebhook(merchant.webhookUrl, merchant.webhookSecret, payload);
}
