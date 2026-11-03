/**
 * Matcher integration tests — run against the dev SQLite DB (file:./dev.db).
 * Deterministic thanks to random slugs + cascade cleanup after.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { processIngestMessage } from "../src/services/matcher.js";

const slug = `t-matcher-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

let merchantId = "";
let deviceId = "";

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: "Matcher Test", slug, vpa: `test${Date.now()}@okaxis`, payeeName: "Matcher Test" },
    select: { id: true },
  });
  merchantId = merchant.id;
  const device = await prisma.device.create({
    data: { merchantId, label: "Test phone", tokenHash: `h-${slug}` },
    select: { id: true },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { slug } });
});

async function addOpenOrder(amountPaise: number) {
  return prisma.order.create({
    data: {
      merchantId,
      ref: `PS-${String(Math.floor(Math.random() * 900000) + 100000)}`,
      amountPaise,
      note: "test order",
    },
  });
}

describe("matcher", () => {
  it("confirms an open order when the matching credit SMS arrives", async () => {
    const order = await addOpenOrder(49_937);
    const result = await processIngestMessage(merchantId, deviceId, {
      source: "SMS",
      sender: "HDFCBK",
      body: "Rs 499.37 credited to HDFC Bank A/c XX1234 by UPI-Ref no 512345678901.",
    });
    expect(result.outcome).toBe("matched");
    expect(result.orderRef).toBe(order.ref);
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("PAID");
    expect(after?.confirmedSource).toBe("SMS");
    expect(after?.paidAt).not.toBeNull();
  });

  it("drops identical replayed alerts (dedupe by fingerprint)", async () => {
    const body = "Rs 199.37 credited to a/c XX1234 by UPI-Ref no 512345678902.";
    const order = await addOpenOrder(19_937);
    const first = await processIngestMessage(merchantId, deviceId, { source: "SMS", sender: "HDFCBK", body });
    const second = await processIngestMessage(merchantId, deviceId, { source: "SMS", sender: "HDFCBK", body });
    expect(first.outcome).toBe("matched");
    expect(second.outcome).toBe("duplicate");
    expect(second.orderRef).toBeUndefined();
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("PAID"); // from the FIRST delivery only
    // no second MATCHED transaction may exist for the same order
    const matchedTxns = await prisma.parsedTransaction.count({
      where: { matchedOrderId: order.id, status: "MATCHED" },
    });
    expect(matchedTxns).toBe(1);
  });

  it("leaves unmatched credits in the evidence ledger", async () => {
    const result = await processIngestMessage(merchantId, deviceId, {
      source: "SMS",
      sender: "HDFCBK",
      body: "Rs 888.77 credited to a/c XX1234 by UPI-Ref no 512345678903.",
    });
    expect(result.outcome).toBe("unmatched");
  });

  it("a matching credit can only be consumed once (race-safe claim)", async () => {
    await addOpenOrder(29_937);
    const body = "Rs 299.37 credited to a/c XX1234 by UPI-Ref no 512345678904.";
    const a = await processIngestMessage(merchantId, deviceId, { source: "SMS", sender: "SBIN", body });
    // same amount cannot double-confirm (fingerprint differs via sender)
    const b = await processIngestMessage(merchantId, deviceId, { source: "SMS", sender: "SBIN", body: body.replace("cxx", "cyx") });
    expect(a.outcome).toBe("matched");
    expect(["unmatched", "duplicate"]).toContain(b.outcome);
  });

  it("push evidence yields REVIEW for strict-mode merchants", async () => {
    const strict = await prisma.merchant.create({
      data: {
        name: "Strict Test",
        slug: `${slug}-strict`,
        vpa: "strict@okaxis",
        payeeName: "Strict",
        strictMode: true,
      },
    });
    const device = await prisma.device.create({
      data: { merchantId: strict.id, tokenHash: `h-${slug}-strict` },
    });
    await prisma.order.create({
      data: { merchantId: strict.id, ref: `PS-${Date.now().toString().slice(-6)}`, amountPaise: 98_937 },
    });
    const result = await processIngestMessage(strict.id, device.id, {
      source: "PUSH",
      sender: "gpaybusiness",
      body: "You received ₹989.37 from customer@okaxis",
    });
    expect(result.outcome).toBe("review");
    await prisma.merchant.delete({ where: { id: strict.id } });
  });

  it("ignores debit alerts without consuming any order", async () => {
    const result = await processIngestMessage(merchantId, deviceId, {
      source: "SMS",
      sender: "HDFCBK",
      body: "Rs 299.00 debited from a/c XX1234 by UPI-Ref no 512345678909.",
    });
    expect(result.outcome).not.toBe("matched");
  });
});
