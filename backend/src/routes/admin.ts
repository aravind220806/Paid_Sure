/**
 * Platform-admin bootstrap (header-auth with ADMIN_PASSWORD).
 * Phase 1 gives the smallest usable surface:
 *   POST /api/admin/merchants — create merchant, returns the API key ONCE
 *   POST /api/admin/merchants/:slug/devices — pair a phone, token shown ONCE
 *   GET  /api/admin/merchants/:slug/devices — capture health / token status
 *   POST /api/admin/merchants/:slug/devices/:id/revoke — lost/stolen phone
 *   POST /api/admin/merchants/:slug/devices/:id/rotate — replace a token
 *
 * The admin gate is deliberately blunt but hardened: timing-safe compare,
 * per-IP lockout after repeated failures, optional IP allowlist, and SSRF
 * validation for merchant webhook URLs.
 */
import { Router, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { asyncRoute } from "../lib/asyncRoute.js";
import { isSafeWebhookUrl } from "../lib/webhook.js";
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

const DEVICE_TTL_DAYS = 180;
const ADMIN_LOCK_AFTER = 5;
const ADMIN_LOCK_MS = 15 * 60_000;

interface FailureState {
  count: number;
  blockedUntil: number;
}
const failures = new Map<string, FailureState>();

function ipOf(req: Request): string {
  return req.ip ?? "unknown";
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths are equal and the compare is constant-time.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function adminGuarded(req: Request, res: Response): boolean {
  const ip = ipOf(req);
  const allowlist = config.ADMIN_IP_ALLOWLIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length > 0 && !allowlist.includes(ip)) {
    res.status(403).json({ ok: false, error: "admin_ip_not_allowed" });
    return false;
  }

  const now = Date.now();
  const state = failures.get(ip);
  if (state && state.blockedUntil > now) {
    res.setHeader("Retry-After", String(Math.ceil((state.blockedUntil - now) / 1000)));
    res.status(429).json({
      ok: false,
      error: "admin_locked",
      message: "Too many failed attempts. Try again later.",
    });
    return false;
  }

  const given = req.header("x-admin-password") ?? "";
  if (!safeEqual(given, config.ADMIN_PASSWORD)) {
    const count = (state && state.blockedUntil <= now ? 0 : state?.count ?? 0) + 1;
    failures.set(ip, {
      count: count >= ADMIN_LOCK_AFTER ? 0 : count,
      blockedUntil: count >= ADMIN_LOCK_AFTER ? now + ADMIN_LOCK_MS : 0,
    });
    res.status(403).json({ ok: false, error: "admin_password_required" });
    return false;
  }

  failures.delete(ip);
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
  if (parsed.data.webhookUrl && !(await isSafeWebhookUrl(parsed.data.webhookUrl))) {
    res.status(400).json({
      ok: false,
      error: "webhook_url_not_allowed",
      message: "webhookUrl must be a public HTTPS URL (no localhost/private IPs).",
    });
    return;
  }

  const apiKey = `psm_${randomBytes(24).toString("base64url")}`;
  const webhookSecret = randomBytes(24).toString("hex");
  try {
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
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "P2002") {
      res.status(409).json({ ok: false, error: "slug_taken" });
      return;
    }
    throw e;
  }
}));

async function merchantBySlug(slug: string) {
  return prisma.merchant.findUnique({
    where: { slug },
    select: { id: true },
  });
}

adminRouter.post("/merchants/:slug/devices", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const parsed = deviceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid_body" });
    return;
  }
  const merchant = await merchantBySlug(req.params.slug);
  if (!merchant) {
    res.status(404).json({ ok: false, error: "merchant_not_found" });
    return;
  }
  const token = `psd_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + DEVICE_TTL_DAYS * 24 * 60 * 60_000);
  const device = await prisma.device.create({
    data: {
      merchantId: merchant.id,
      label: parsed.data?.label ?? "Shop phone",
      tokenHash: sha256(token),
      expiresAt,
    },
    select: { id: true, label: true, expiresAt: true },
  });
  res.status(201).json({
    ok: true,
    device,
    pairToken: token, // shown once — only the hash is stored on the server
  });
}));

adminRouter.get("/merchants/:slug/devices", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const merchant = await merchantBySlug(req.params.slug);
  if (!merchant) {
    res.status(404).json({ ok: false, error: "merchant_not_found" });
    return;
  }
  const devices = await prisma.device.findMany({
    where: { merchantId: merchant.id },
    select: {
      id: true,
      label: true,
      lastSeenAt: true,
      lastSeenIp: true,
      batteryPct: true,
      listenerOn: true,
      smsOn: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  res.json({ ok: true, devices });
}));

adminRouter.post("/merchants/:slug/devices/:id/revoke", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const merchant = await merchantBySlug(req.params.slug);
  if (!merchant) {
    res.status(404).json({ ok: false, error: "merchant_not_found" });
    return;
  }
  const updated = await prisma.device.updateMany({
    where: { id: req.params.id, merchantId: merchant.id },
    data: { revokedAt: new Date() },
  });
  if (updated.count === 0) {
    res.status(404).json({ ok: false, error: "device_not_found" });
    return;
  }
  res.json({ ok: true, revoked: true });
}));

adminRouter.post("/merchants/:slug/devices/:id/rotate", asyncRoute(async (req, res) => {
  if (!adminGuarded(req, res)) return;
  const merchant = await merchantBySlug(req.params.slug);
  if (!merchant) {
    res.status(404).json({ ok: false, error: "merchant_not_found" });
    return;
  }
  const token = `psd_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + DEVICE_TTL_DAYS * 24 * 60 * 60_000);
  const updated = await prisma.device.updateMany({
    where: { id: req.params.id, merchantId: merchant.id },
    data: { tokenHash: sha256(token), revokedAt: null, expiresAt },
  });
  if (updated.count === 0) {
    res.status(404).json({ ok: false, error: "device_not_found" });
    return;
  }
  res.json({ ok: true, pairToken: token, expiresAt });
}));
