import { describe, expect, it } from "vitest";
import { parseAlert } from "../src/services/parser.js";

const sms = (sender: string, body: string) =>
  parseAlert({ source: "SMS", sender, body });
const push = (sender: string | null, body: string) =>
  parseAlert({ source: "PUSH", sender, body: body });

describe("parser v1 — bank SMS credits", () => {
  it("parses an HDFC credit with UPI Ref", () => {
    const p = sms(
      "HDFCBK",
      "Rs 289.00 credited to HDFC Bank A/c XX1234 on 02-08-24 by UPI-Ref no 512345678912. If not done, call 18001234.",
    );
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(28900);
    expect(p?.ruleKey).toBe("hdfc-credit-v1");
    expect(p?.utr).toBe("512345678912");
  });

  it("parses an SBI credit with comma formatting", () => {
    const p = sms("SBIIN", "INR 1,234.50 credited to your a/c XX9876 by UPI.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(123_450);
  });

  it("parses ICICI and Axis credit SMS", () => {
    expect(sms("ICICIB", "Rs 199.00 credited to your ICICI a/c on 03-09-24")?.amountPaise).toBe(19900);
    expect(sms("AXISBK", "₹99.37 credited to your Axis Bank a/c XX4567")?.amountPaise).toBe(9937);
  });

  it("rejects debit SMS as non-credit evidence", () => {
    const p = sms("HDFCBK", "Rs 500.00 debited from A/c XX1234 towards UPI payment.");
    expect(p).not.toBeNull();
    expect(p?.isCredit).toBe(false);
  });

  it("rejects balance/marketing noise", () => {
    expect(sms("HDFCBK", "Your account balance is Rs 12,000.00 as on 05-08")).toBeNull();
    expect(sms("SBIIN", "UPI transaction of Rs 299.00 failed. Amount will be refunded.")).toBeNull();
  });
});

describe("parser v1 — business-app pushes", () => {
  it("parses a GPay for Business receive-push", () => {
    const p = push(
      "gpaybusiness",
      "You received ₹499.37 from customer@okaxis. Open Google Pay for details.",
    );
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(49937);
    expect(p?.ruleKey).toBe("gpay-biz-push-v1");
    expect(p?.payerHint).toContain("customer@okaxis");
  });

  it("parses a PhonePe Business receive-push", () => {
    const p = push(
      "com.phonepe.app",
      "You have received a payment of Rs 250.50 on PhonePe Business. UTR 412345678901.",
    );
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(25050);
    expect(p?.ruleKey).toBe("phonepe-biz-push-v1");
    expect(p?.utr).toBe("412345678901");
  });

  it("parses a Paytm for Business receive-push", () => {
    const p = push(null, "Received Rs 998.0 in your Paytm for Business account.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(99800);
  });

  it("rejects sent-payment pushes", () => {
    const p = push("com.phonepe.app", "You sent Rs 250.00 to shopkeeper@upi on PhonePe.");
    expect(p?.isCredit ?? false).toBe(false);
  });
});

describe("parser v1 — generic fallbacks", () => {
  it("handles an unknown bank's credit SMS", () => {
    const p = sms("AD-BANKS", "Rs 125.00 credited to your account on 01-09-24.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(12500);
    expect(p?.ruleKey).toBe("generic-sms-credit-v1");
  });

  it("handles an unknown app's receive-push", () => {
    const p = push(null, "You received ₹150.25 from a customer via QR.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(15025);
  });

  it("returns null for anything with no amount", () => {
    expect(push(null, "You received a payment"))?.toBeNull();
    expect(sms("SBIIN", "Credited without procedure")).toBeNull();
  });

  it("returns null for unrelated notifications", () => {
    expect(push(null, "Backing up your phone... 42% complete")).toBeNull();
    expect(push("com.whatsapp", "New message from Ramesh")).toBeNull();
  });
});
