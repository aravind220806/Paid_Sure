/**
 * Matching engine — links verified credit evidence to an open order.
 *
 * Invariants:
 *  - Only CREDIT evidence can confirm.
 *  - Amount must equal an OPEN order's amountPaise exactly (allocator
 *    guarantees consumidores can't collide).
 *  - Evidence must belong to the merchant who owns the order (device is
 *    bound to merchant at ingest time).
 *  - Match window: alert time ∈ [order.createdAt, createdAt + lateMatchMinutes].
 *  - Race-safe: the order row is claimed with a conditional updateMany,
 *    so double-confirmations collapse into one winner.
 */
import { createHash, createHmac } from "node:crypto";
import { prisma } from "../db.js";
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
  | "review" // credit, but merchant policy wants eyes on it
  | "unmatched"; // credit, no fitting open order

export interface ProcessedMessage {
  outcome: MatchOutcome;
  orderRef?: string;
  ruleKey?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function processIngestMessage(
  merchantId: string,
  deviceId: string,
  msg: IngestMessage,
): Promise<ProcessedMessage> {
  const sender = msg.sender ?? null;
  const body = msg.body.slice(0, 4000);
  const fingerprint = sha256(`${msg.source}|${sender ?? ""}|${body.trim()}`);
  const receivedAt = msg.receivedAt ? new Date(msg.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) return { outcome: "ignored" };

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
      },
    });
  } catch {
    // Unique hash hit — identical alert replayed across lanes/reboots.
    return { outcome: "duplicate" };
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

  const order = await findOpenOrderFor(
    merchantId,
    parsed.amountPaise,
    receivedAt,
    merchant.lateMatchMinutes,
  );
  if (!order) return { outcome: "unmatched", ruleKey: parsed.ruleKey };

  // Conditional claim: only one of concurrent alerts flips the order.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "PAID",
      paidAt: receivedAt,
      confirmedSource: msg.source,
    },
  });
  if (claimed.count === 0) return { outcome: "unmatched", ruleKey: parsed.ruleKey };

  await prisma.parsedTransaction.update({
    where: { id: parsedTxn.id },
    data: { matchedOrderId: order.id, status: "MATCHED", matchedAt: receivedAt },
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
    paidAt: receivedAt.toISOString(),
  });

  return { outcome: "matched", orderRef: order.ref, ruleKey: parsed.ruleKey };
}

async function findOpenOrderFor(
  merchantId: string,
  amountPaise: number,
  at: Date,
  lateMatchMinutes: number,
) {
  const candidates = await prisma.order.findMany({
    where: { merchantId, status: "PENDING", amountPaise },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  const windowMs = lateMatchMinutes * 60_000;
  return (
    candidates.find(
      (o) => at >= o.createdAt && at.getTime() <= o.createdAt.getTime() + windowMs,
    ) ?? null
  );
}

/** Fire-and-forget, HMAC-signed `order.paid` notification. */
function fireMerchantWebhook(
  merchant: {
    webhookUrl: string | null;
    webhookSecret: string | null;
  },
  payload: Record<string, unknown>,
): void {
  if (!merchant.webhookUrl || !merchant.webhookSecret) return;
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", merchant.webhookSecret).update(body).digest("hex");
  fetch(merchant.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paidsure-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  }).catch((e) => {
    console.warn("[paidsure] webhook delivery failed", (e as Error)?.message);
  });
}
