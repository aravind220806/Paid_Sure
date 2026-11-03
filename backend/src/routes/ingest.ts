/**
 * Capture ingest — the single doorway from paired Android phones.
 *   POST /api/ingest   (device token auth)
 *
 * Body: { batteryPct?, listenerOn?, smsOn?, messages: [{source, sender?, body, receivedAt?}] }
 * Each message: dedupe (fingerprint) → parse → match → webhook on PAID.
 * The API never exposes DB credentials to the device — tokens, not passwords.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { DeviceAuthedRequest, requireDevice } from "../auth.js";
import { processIngestMessage } from "../services/matcher.js";

const ingestSchema = z.object({
  batteryPct: z.number().int().min(0).max(100).optional(),
  listenerOn: z.boolean().optional(),
  smsOn: z.boolean().optional(),
  messages: z
    .array(
      z.object({
        source: z.enum(["PUSH", "SMS", "EMAIL"]),
        sender: z.string().max(191).optional(),
        body: z.string().min(1).max(4000),
        receivedAt: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const ingestRouter = Router();

ingestRouter.post(
  "/",
  requireDevice,
  async (req, res) => {
    const body = ingestSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    const { messages, ...health } = body.data;
    const device = (req as DeviceAuthedRequest).device;

    const results = [];
    for (const [i, message] of messages.entries()) {
      const outcome = await processIngestMessage(
        device.merchantId,
        device.id,
        message,
      );
      results.push({ index: i, ...outcome });
    }

    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        batteryPct: health.batteryPct ?? undefined,
        listenerOn: health.listenerOn ?? undefined,
        smsOn: health.smsOn ?? undefined,
      },
    });

    const matched = results.find((r) => r.outcome === "matched");
    res.json({
      ok: true,
      results,
      matchedOrderRef: matched?.orderRef ?? null,
    });
  },
);
