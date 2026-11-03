/**
 * Platform-admin bootstrap (header-auth with ADMIN_PASSWORD).
 * Phase 1 gives the smallest usable surface:
 *   POST /api/admin/merchants — create merchant, returns the API key ONCE
 *   POST /api/admin/merchants/:slug/devices — pair a phone, token shown ONCE
 * Merchant dashboard (self-serve UI + QR) is Phase 2 work.
 */
import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { sha256 } from "../auth.js";

const merchantSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,31}$/, "slug: lowercase letters, digits, dashes"),
  vpa: z.string().regex(/^[\w.\-]{2,64}@[\w.\-/]{2,32}$/, "vpa: like shop@okaxis"),
  payeeName: z.string().min(1).max(50),
  webhookUrl: z.string().url().max(500).optional(),
});

const deviceSchema = z.object({ label: z.string().max(60).optional() });

function adminGuarded(req: Request, res: Response): boolean {
  const given = req.header("x-admin-password");
  if (!given || given !== config.ADMIN_PASSWORD) {
    res.status(403).json({ ok: false, error: "admin_password_required" });
    return false;
  }
  return true;
}

export const adminRouter = Router();

adminRouter.post("/merchants", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const parsed = merchantSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "invalid_body";
    res.status(400).json({ ok: false, error: "invalid_body", message: msg });
    return;
  }
  const apiKey = `psm_${randomBytes(24).toString("base64url")}`;
  const webhookSecret = randomBytes(24).toString("hex");
  const merchant = await prisma.merchant.create({
    data: {
      name: parsed.data.name,
      slug: parsed.data.slug,
      vpa: parsed.data.vpa,
      payeeName: parsed.data.payeeName,
      webhookUrl: parsed.data.webhookUrl ?? null,
      webhookSecret,
      apiKeyHash: sha256(apiKey),
    },
    select: { slug: true, vpa: true, payeeName: true },
  });
  res.status(201).json({
    ok: true,
    merchant,
    apiKey, // shown once — only the hash is stored
    webhookSecret, // shown once — merchant pastes this into their backend
  });
}));

adminRouter.post("/merchants/:slug/devices", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const parsed = deviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid_body" });
    return;
  }
  const merchant = await prisma.merchant.findUnique({
    where: { slug: req.params.slug },
    select: { id: true },
  });
  if (!merchant) {
    res.status(404).json({ ok: false, error: "merchant_not_found" });
    return;
  }
  const token = `psd_${randomBytes(24).toString("base64url")}`;
  const device = await prisma.device.create({
    data: {
      merchantId: merchant.id,
      label: parsed.data?.label ?? "Shop phone",
      tokenHash: sha256(token),
    },
    select: { id: true, label: true },
  });
  res.status(201).json({
    ok: true,
    device,
    pairToken: token, // shown once — only the hash is stored on the server
  });
}));
