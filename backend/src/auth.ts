/**
 * Bearer auth for the two Phase-1 doorways:
 *   - merchant API keys (`psm_…`, hashed in Merchant.apiKeyHash)
 *   - paired device tokens (`psd_…`, hashed in Device.tokenHash)
 * Nothing else ever reaches the DB — this is the whole security boundary.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { prisma } from "./db.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export interface MerchantAuthedRequest extends Request {
  merchant: {
    id: string;
    name: string;
    slug: string;
    vpa: string;
    payeeName: string;
    strictMode: boolean;
    lateMatchMinutes: number;
    confirmWindowMin: number;
  };
}

export interface DeviceAuthedRequest extends Request {
  device: {
    id: string;
    merchantId: string;
    label: string;
  };
}

export const requireMerchant: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const token = bearerToken(req);
  if (!token || !token.startsWith("psm_")) {
    res.status(401).json({ ok: false, error: "merchant_key_required" });
    return;
  }
  const merchant = await prisma.merchant.findFirst({
    where: { apiKeyHash: sha256(token) },
    select: {
      id: true,
      name: true,
      slug: true,
      vpa: true,
      payeeName: true,
      strictMode: true,
      lateMatchMinutes: true,
      confirmWindowMin: true,
    },
  });
  if (!merchant) {
    res.status(401).json({ ok: false, error: "invalid_merchant_key" });
    return;
  }
  (req as MerchantAuthedRequest).merchant = merchant;
  next();
};

export const requireDevice: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const token = bearerToken(req);
  if (!token || !token.startsWith("psd_")) {
    res.status(401).json({ ok: false, error: "device_token_required" });
    return;
  }
  const device = await prisma.device.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, merchantId: true, label: true },
  });
  if (!device) {
    res.status(401).json({ ok: false, error: "invalid_device_token" });
    return;
  }
  (req as DeviceAuthedRequest).device = device;
  next();
};
