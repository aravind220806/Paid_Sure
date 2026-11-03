/**
 * Orders API (Phase 1 core).
 *   POST /api/orders          — create (merchant key auth)
 *   GET  /api/orders/:ref     — public status + checkout payload
 *   GET  /api/orders/:ref/events — SSE live status
 */
import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { newOrderRef } from "../lib/refcode.js";
import { buildUpiPayUrl, paiseToUpiAmount } from "../lib/upi.js";
import { allocateFingerprint } from "../services/orderAllocator.js";
import {
  acquireConcurrent,
  rateLimit,
  releaseConcurrent,
  tokenOrIpKey,
} from "../lib/rateLimit.js";
import {
  MerchantAuthedRequest,
  requireMerchant,
} from "../auth.js";

const createSchema = z.object({
  /** Whole rupees ≥ 1. PaidSure adds the unique 0–₹3.00 paise fingerprint. */
  amount: z.number().int().min(1, "amount must be whole rupees ≥ 1").max(1_00_000),
  note: z.string().max(120).optional(),
  customerName: z.string().max(80).optional(),
});

class AllocationFailedError extends Error {}

/**
 * SQLite allows only one writer. Interactive transactions that overlap can
 * deadlock on a read→write upgrade, so dev/test order creation is serialized
 * in-process. PostgreSQL runs fully concurrently (the partial unique index
 * plus retry is the guard).
 */
let sqliteWriteQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL?.startsWith("file:")) return task();
  const run = sqliteWriteQueue.then(task, task);
  sqliteWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const ordersRouter = Router();

// Order creation is per merchant key (so one seller can't exhaust the shared
// fingerprint space for everyone); status lookups are per IP.
const orderCreateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  key: tokenOrIpKey,
  error: "order_rate_limited",
});
const statusLimiter = rateLimit({ windowMs: 60_000, max: 120 });
const sseAttemptLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const MAX_SSE_PER_IP = 5;
const SSE_MAX_LIFETIME_MS = 10 * 60_000;

const statusUrlFor = (ref: string): string =>
  `${config.PUBLIC_APP_URL.replace(/\/$/, "")}/s/${ref}`;

ordersRouter.post(
  "/",
  orderCreateLimiter,
  requireMerchant,
  asyncRoute(async (req, res) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    const { amount, note, customerName } = body.data;
    const merchant = (req as MerchantAuthedRequest).merchant;
    const basePaise = amount * 100;

    let created: CreatedOrder;
    try {
      created = await createOrderWithFingerprint(merchant, basePaise, note, customerName);
    } catch (e) {
      if (e instanceof AllocationFailedError) {
        res.set("Retry-After", "60");
        res.status(503).json({
          ok: false,
          error: "fingerprint_space_exhausted",
          message:
            "High demand for this price. All 301 payment identifiers are in use by orders still inside the safety window. Please retry in a minute.",
        });
        return;
      }
      throw e;
    }

    res.status(201).json({
      ok: true,
      order: {
        ref: created.ref,
        status: "PENDING",
        amountPaise: created.amountPaise,
        amount: paiseToUpiAmount(created.amountPaise),
        baseAmount: amount,
        baseAmountPaise: basePaise,
        extraPaise: created.extraPaise,
        intentUrl: created.intentUrl,
        statusUrl: statusUrlFor(created.ref),
        expiresAt: created.order.expiresAt?.toISOString() ?? null,
        store: { name: merchant.name, payeeName: merchant.payeeName, slug: merchant.slug },
      },
    });
  }),
);

interface CreatedOrder {
  ref: string;
  amountPaise: number;
  extraPaise: number;
  intentUrl: string;
  order: { id: string; createdAt: Date; expiresAt: Date | null };
}

/**
 * Allocate the fingerprint and create the order in one DB transaction, then
 * retry on a unique/index conflict. The partial unique index (created at boot)
 * is the final guard against two concurrent requests taking the same amount.
 */
async function createOrderWithFingerprint(
  merchant: MerchantAuthedRequest["merchant"],
  basePaise: number,
  note: string | undefined,
  customerName: string | undefined,
): Promise<CreatedOrder> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await withWriteLock(() =>
        prisma.$transaction(async (tx) => {
          const choice = await allocateFingerprint(
            tx,
            merchant.id,
            basePaise,
            merchant.lateMatchMinutes,
          );
          if (choice === null) throw new AllocationFailedError();

          const ref = await allocateRef(tx);
          const upiNote = note ? `${note} · ${ref}` : `Order ${ref}`;
          const intentUrl = buildUpiPayUrl(
            { vpa: merchant.vpa, payeeName: merchant.payeeName },
            choice.amountPaise,
            upiNote,
          );

          const order = await tx.order.create({
            data: {
              merchantId: merchant.id,
              ref,
              amountPaise: choice.amountPaise,
              baseAmountPaise: basePaise,
              intentUrl,
              qrPayload: intentUrl,
              note: note ?? null,
              customerName: customerName ?? null,
              expiresAt: new Date(Date.now() + merchant.confirmWindowMin * 60_000),
            },
            select: { id: true, createdAt: true, expiresAt: true },
          });

          return {
            ref,
            amountPaise: choice.amountPaise,
            extraPaise: choice.extraPaise,
            intentUrl,
            order,
          };
        }),
      );
    } catch (e) {
      if (e instanceof AllocationFailedError) throw e;
      if (!isRetryableAllocationError(e) || attempt === 5) throw e;
      // Small backoff (with attempt-based spacing) avoids a thundering herd.
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

function isRetryableAllocationError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P2002" || code === "P2034" || code === "P1008" || code === "P2028") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|write conflict|deadlock/i.test(message);
}

async function allocateRef(db: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = newOrderRef();
    const clash = await db.order.findUnique({ where: { ref } });
    if (!clash) return ref;
  }
  // 80 random bits makes this effectively impossible; fail rather than fall
  // back to a predictable timestamp ref.
  throw new Error("could not allocate a unique order ref");
}

ordersRouter.get("/:ref", statusLimiter, asyncRoute(async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { ref: req.params.ref },
    include: {
      merchant: {
        select: { name: true, payeeName: true, slug: true, lateMatchMinutes: true },
      },
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
  // Order data includes a UTR and the merchant's VPA — never let a shared
  // cache retain it.
  res.set("Cache-Control", "no-store, max-age=0");
  const checkoutExpired =
    order.status === "PENDING" && order.expiresAt != null && order.expiresAt < new Date();
  // Older rows predate baseAmountPaise; their fingerprint was always < ₹1.
  const baseAmountPaise =
    order.baseAmountPaise > 0
      ? order.baseAmountPaise
      : order.amountPaise - (order.amountPaise % 100);
  res.json({
    ok: true,
    order: {
      ref: order.ref,
      status: order.status,
      checkoutExpired,
      amountPaise: order.amountPaise,
      baseAmountPaise,
      extraPaise: Math.max(0, order.amountPaise - baseAmountPaise),
      payeeName: order.merchant.payeeName,
      storeName: order.merchant.name,
      intentUrl: order.intentUrl,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      matchableUntil: new Date(
        order.createdAt.getTime() + order.merchant.lateMatchMinutes * 60_000,
      ).toISOString(),
      confirmedSource: order.confirmedSource,
      paidAt: order.paidAt?.toISOString() ?? null,
      utr: (() => {
        const raw = order.transactions[0]?.utr;
        if (!raw) return null;
        return raw.length > 4 ? `••••••${raw.slice(-4)}` : raw;
      })(),
    },
  });
}));

ordersRouter.get("/:ref/events", sseAttemptLimiter, asyncRoute(async (req, res) => {
  const streamKey = `sse:${req.ip ?? "unknown"}`;
  if (!acquireConcurrent(streamKey, MAX_SSE_PER_IP)) {
    res.set("Retry-After", "10");
    res.status(429).json({
      ok: false,
      error: "too_many_streams",
      message: "Too many live status connections. Close another tab and retry.",
    });
    return;
  }

  let released = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let lifetime: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (poll) clearInterval(poll);
    if (lifetime) clearTimeout(lifetime);
    releaseConcurrent(streamKey);
  };

  try {
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
    let closed = false;
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

    const close = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      res.write("event: end\ndata: {}\n\n");
      res.end();
      release();
    };

    const done = await emit();
    if (done) {
      close();
      return;
    }

    poll = setInterval(() => {
      emit()
        .then((finished) => {
          if (finished) close();
        })
        .catch((error) => {
          console.error("[paidsure] SSE status stream failed", error);
          close();
        });
    }, 2000);

    // Do not let one browser hold a stream forever.
    lifetime = setTimeout(close, SSE_MAX_LIFETIME_MS);
    lifetime.unref?.();
    req.on("close", release);
  } catch (error) {
    release();
    throw error;
  }
}));
