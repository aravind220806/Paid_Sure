/**
 * Orders API (Phase 1 core).
 *   POST /api/orders          — create (merchant key auth)
 *   GET  /api/orders/:ref     — public status + checkout payload
 *   GET  /api/orders/:ref/events — SSE live status
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { newOrderRef } from "../lib/refcode.js";
import { buildUpiPayUrl, paiseToUpiAmount } from "../lib/upi.js";
import { pickFreeSuffix } from "../services/allocator.js";
import {
  MerchantAuthedRequest,
  requireMerchant,
} from "../auth.js";

const createSchema = z.object({
  /** Whole rupees ≥ 1. PaidSure adds the unique 0–99 paise fingerprint itself. */
  amount: z.number().int().min(1, "amount must be whole rupees ≥ 1").max(1_00_000),
  note: z.string().max(120).optional(),
  customerName: z.string().max(80).optional(),
});

class AllocationFailedError extends Error {}

export const ordersRouter = Router();

const statusUrlFor = (ref: string): string =>
  `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/s/${ref}`;

ordersRouter.post(
  "/",
  requireMerchant,
  async (req, res) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    const { amount, note, customerName } = body.data;
    const merchant = (req as MerchantAuthedRequest).merchant;

    let amountPaise: number;
    try {
      amountPaise = await allocate(merchant.id, amount);
    } catch (e) {
      if (e instanceof AllocationFailedError) {
        res.status(503).json({
          ok: false,
          error: "amount_space_exhausted",
          message: "All 300 unique-amount variants for this rupee total are in use by open orders. Close or expire some open orders first.",
        });
        return;
      }
      throw e;
    }

    const ref = await allocateRef();
    const upiNote = note ? `${note} · ${ref}` : `Order ${ref}`;
    const intentUrl = buildUpiPayUrl(
      { vpa: merchant.vpa, payeeName: merchant.payeeName },
      amountPaise,
      upiNote,
    );

    const order = await prisma.order.create({
      data: {
        merchantId: merchant.id,
        ref,
        amountPaise,
        intentUrl,
        qrPayload: intentUrl,
        note: note ?? null,
        customerName: customerName ?? null,
        expiresAt: new Date(Date.now() + merchant.confirmWindowMin * 60_000),
      },
      select: { id: true, createdAt: true, expiresAt: true },
    });

    res.status(201).json({
      ok: true,
      order: {
        ref,
        status: "PENDING",
        amountPaise,
        amount: paiseToUpiAmount(amountPaise),
        baseAmount: amount,
        intentUrl,
        statusUrl: statusUrlFor(ref),
        expiresAt: order.expiresAt?.toISOString() ?? null,
        store: { name: merchant.name, payeeName: merchant.payeeName, slug: merchant.slug },
      },
    });
  },
);

async function allocate(merchantId: string, rupees: number): Promise<number> {
  // Unique among OPEN orders for this merchant. Strategy: for hop 0..2 try
  // rupees + hop (whole-rupee shift happens only when ~100 orders share the
  // same rupee amount — rare; erroring out beats silently charging more).
  for (let hop = 0; hop < 3; hop++) {
    const base = rupees + hop;
    const low = base * 100;
    const rows = await prisma.order.findMany({
      where: {
        merchantId,
        status: "PENDING",
        amountPaise: { gte: low, lt: low + 100 },
      },
      select: { amountPaise: true },
    });
    const suffix = pickFreeSuffix(rows.map((r) => r.amountPaise - low));
    if (suffix !== null) return low + suffix;
  }
  throw new AllocationFailedError();
}

async function allocateRef(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = newOrderRef();
    const clash = await prisma.order.findUnique({ where: { ref } });
    if (!clash) return ref;
  }
  return `PS-${Date.now().toString(36).toUpperCase().slice(-8)}`;
}

ordersRouter.get("/:ref", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { ref: req.params.ref },
    include: {
      merchant: { select: { name: true, payeeName: true, slug: true } },
      transactions: {
        where: { status: "MATCHED" },
        select: { utr: true, ruleKey: true, matchedAt: true },
        take: 1,
      },
    },
  });
  if (!order) {
    res.status(404).json({ ok: false, error: "order_not_found" });
    return;
  }
  const isExpired =
    order.status === "PENDING" && order.expiresAt != null && order.expiresAt < new Date();
  res.json({
    ok: true,
    order: {
      ref: order.ref,
      status: isExpired ? "EXPIRED" : order.status,
      amountPaise: order.amountPaise,
      payeeName: order.merchant.payeeName,
      storeName: order.merchant.name,
      intentUrl: order.intentUrl,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      confirmedSource: order.confirmedSource,
      paidAt: order.paidAt?.toISOString() ?? null,
      utr: order.transactions[0]?.utr ?? null,
    },
  });
});

ordersRouter.get("/:ref/events", async (req, res) => {
  const initial = await prisma.order.findUnique({ where: { ref: req.params.ref } });
  if (!initial) {
    res.status(404).json({ ok: false, error: "order_not_found" });
    return;
  }
  res.set({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  let lastSent = "";
  const send = (payload: unknown) => {
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const emit = async () => {
    const order = await prisma.order.findUnique({ where: { ref: initial.ref } });
    if (!order) return true;
    if (order.status !== lastSent) {
      lastSent = order.status;
      send({ ref: order.ref, status: order.status, paidAt: order.paidAt?.toISOString() ?? null });
    }
    return order.status !== "PENDING"; // true → close the stream
  };

  await emit();
  const poll = setInterval(async () => {
    const done = await emit();
    if (done) {
      clearInterval(poll);
      res.write("event: end\ndata: {}\n\n");
      res.end();
    }
  }, 2000);
  req.on("close", () => clearInterval(poll));
});
