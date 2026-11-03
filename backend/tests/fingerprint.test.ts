/**
 * Fingerprint allocator integration tests — real SQLite DB, isolated merchant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  allocateFingerprint,
  getFingerprintOccupancy,
} from "../src/services/orderAllocator.js";
import { sweepExpiredOrders } from "../src/services/orderSweeper.js";

const slug = `t-fingerprint-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
let merchantId = "";
let refCounter = 0;

function nextRef(): string {
  refCounter += 1;
  return `PS-T${Date.now().toString(36).toUpperCase()}${refCounter}`;
}

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: {
      name: "Fingerprint Test",
      slug,
      vpa: `fingerprint${Date.now()}@okaxis`,
      payeeName: "Fingerprint Test",
      lateMatchMinutes: 720,
    },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { slug } });
});

describe("fingerprint allocator", () => {
  it("never reuses an amount held by an open order", async () => {
    const taken = 49_937; // ₹499.37
    await prisma.order.create({
      data: {
        merchantId,
        ref: nextRef(),
        amountPaise: taken,
        baseAmountPaise: 49_900,
      },
    });

    const choice = await allocateFingerprint(prisma, merchantId, 49_900, 720);
    expect(choice).not.toBeNull();
    expect(choice!.amountPaise).not.toBe(taken);
    expect(choice!.extraPaise).toBeGreaterThanOrEqual(0);
    expect(choice!.extraPaise).toBeLessThanOrEqual(300);
  });

  it("reserves a recently paid order's amount (duplicate safety)", async () => {
    const taken = 59_937; // ₹599.37
    await prisma.order.create({
      data: {
        merchantId,
        ref: nextRef(),
        amountPaise: taken,
        baseAmountPaise: 59_900,
        status: "PAID",
        paidAt: new Date(),
      },
    });

    const occupied = await getFingerprintOccupancy(prisma, merchantId, 59_900, 720);
    expect(occupied.map((o) => o.amountPaise)).toContain(taken);

    const choice = await allocateFingerprint(prisma, merchantId, 59_900, 720);
    expect(choice).not.toBeNull();
    expect(choice!.amountPaise).not.toBe(taken);
  });

  it("can reuse an amount after the safety window", async () => {
    const amount = 69_937; // ₹699.37
    const paidAt = new Date(Date.now() - 13 * 60 * 60_000);
    await prisma.order.create({
      data: {
        merchantId,
        ref: nextRef(),
        amountPaise: amount,
        baseAmountPaise: 69_900,
        status: "PAID",
        paidAt,
      },
    });

    const now = new Date();
    const inside = await getFingerprintOccupancy(prisma, merchantId, 69_900, 720, now);
    expect(inside.map((o) => o.amountPaise)).toContain(amount);

    // 13 hours later the 12-hour safety window has passed.
    const later = new Date(now.getTime() + 13 * 60 * 60_000);
    const outside = await getFingerprintOccupancy(prisma, merchantId, 69_900, 720, later);
    expect(outside.map((o) => o.amountPaise)).not.toContain(amount);
  });

  it("widens into the ₹1.00–₹1.99 band when the cheap band is full", async () => {
    const base = 89_900; // ₹899
    await prisma.order.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        merchantId,
        ref: nextRef(),
        amountPaise: base + i, // ₹899.00 … ₹899.99
        baseAmountPaise: base,
      })),
    });

    const choice = await allocateFingerprint(prisma, merchantId, base, 720);
    expect(choice).not.toBeNull();
    expect(choice!.ceilingPaise).toBe(199);
    expect(choice!.extraPaise).toBeGreaterThanOrEqual(100);
    expect(choice!.extraPaise).toBeLessThanOrEqual(199);
  });

  it("closes orders after the late-match window and keeps their amount reserved", async () => {
    const amount = 79_937; // ₹799.37
    const old = await prisma.order.create({
      data: {
        merchantId,
        ref: nextRef(),
        amountPaise: amount,
        baseAmountPaise: 79_900,
        createdAt: new Date(Date.now() - 13 * 60 * 60_000),
        expiresAt: new Date(Date.now() - 12.5 * 60 * 60_000),
      },
    });

    await sweepExpiredOrders();
    const after = await prisma.order.findUnique({ where: { id: old.id } });
    expect(after?.status).toBe("EXPIRED");

    // The amount is still inside the post-expiry safety buffer.
    const occupied = await getFingerprintOccupancy(prisma, merchantId, 79_900, 720);
    expect(occupied.map((o) => o.amountPaise)).toContain(amount);
  });
});
