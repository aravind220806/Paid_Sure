import { describe, expect, it } from "vitest";
import { parseAlert } from "../src/services/parser.js";

const sms = (sender: string, body: string) =>
  parseAlert({ source: "SMS", sender, body });
const push = (sender: string | null, body: string) =>
  parseAlert({ source: "PUSH", sender, body });

describe("parser v2 — verified bank SMS", () => {
  it("parses an HDFC credit with UPI Ref from a real bank sender", () => {
    const p = sms(
      "HDFCBK",
      "Rs 289.00 credited to HDFC Bank A/c XX1234 on 02-08-24 by UPI-Ref no 512345678912. If not done, call 18001234.",
    );
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(28900);
    expect(p?.ruleKey).toBe("hdfc-credit-v1");
    expect(p?.utr).toBe("512345678912");
    expect(p?.verified).toBe(true);
  });

  it("parses an SBI credit with comma formatting", () => {
    const p = sms("SBIIN", "INR 1,234.50 credited to your a/c XX9876 by UPI.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(123_450);
    expect(p?.verified).toBe(true);
  });

  it("parses ICICI and Axis credit SMS", () => {
    expect(sms("ICICIB", "Rs 199.00 credited to your ICICI a/c on 03-09-24")?.amountPaise).toBe(19900);
    expect(sms("AXISBK", "₹99.37 credited to your Axis Bank a/c XX4567")?.amountPaise).toBe(9937);
    expect(sms("VM-HDFCBK", "Rs 10.00 credited to a/c XX1")?.verified).toBe(true);
  });

  it("rejects debit SMS as non-credit evidence", () => {
    const p = sms("HDFCBK", "Rs 500.00 debited from A/c XX1234 towards UPI payment.");
    expect(p).not.toBeNull();
    expect(p?.isCredit).toBe(false);
  });

  it("never treats a body with both credit and debit words as a credit", () => {
    const p = sms(
      "HDFCBK",
      "Rs 500.00 debited from A/c XX1234 and Rs 500.00 credited to A/c XX1234.",
    );
    expect(p?.isCredit).toBe(false);
    expect(p?.amountPaise).toBeNull();
  });

  it("rejects cashback/reward credits (not a customer payment)", () => {
    expect(sms("HDFCBK", "Rs 50.00 cashback credited to your a/c.")).toBeNull();
    expect(sms("HDFCBK", "Rs 25.00 reward points credited.")).toBeNull();
  });

  it("rejects balance/marketing noise", () => {
    expect(sms("HDFCBK", "Your account balance is Rs 12,000.00 as on 05-08")).toBeNull();
    expect(sms("SBIIN", "UPI transaction of Rs 299.00 failed. Amount will be refunded.")).toBeNull();
  });
});

describe("parser v2 — business-app pushes (first preference)", () => {
  it("parses a GPay for Business receive-push", () => {
    const p = push(
      "gpaybusiness",
      "You received ₹499.37 from customer@okaxis. Open Google Pay for details.",
    );
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(49937);
    expect(p?.ruleKey).toBe("gpay-biz-push-v1");
    expect(p?.payerHint).toContain("customer@okaxis");
    expect(p?.verified).toBe(true);
  });

  it("parses a GPay package name", () => {
    const p = push(
      "com.google.android.apps.nbu.paisa.user",
      "You received ₹120.00 from a customer.",
    );
    expect(p?.verified).toBe(true);
    expect(p?.amountPaise).toBe(12000);
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
    expect(p?.verified).toBe(true);
  });

  it("parses a Paytm for Business receive-push", () => {
    const p = push("net.one97.paytm", "Received Rs 998.0 in your Paytm for Business account.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(99800);
    expect(p?.verified).toBe(true);
  });

  it("rejects sent-payment pushes", () => {
    const p = push("com.phonepe.app", "You sent Rs 250.00 to shopkeeper@upi on PhonePe.");
    expect(p?.isCredit ?? false).toBe(false);
  });

  it("rejects payment collect requests (money requests)", () => {
    expect(
      push(
        "com.google.android.apps.nbu.paisa.user",
        "Payment request received for ₹499.50 from attacker@oksbi",
      ),
    ).toBeNull();
    expect(
      push(
        "com.phonepe.app",
        "Rahul requested ₹250.00 from you on PhonePe. Tap to pay.",
      ),
    ).toBeNull();
  });

  it("rejects in-app P2P chat messages", () => {
    expect(
      push(
        "com.google.android.apps.nbu.paisa.user",
        "Rahul: Payment received ₹499.50 UTR 999888777666",
      ),
    ).toBeNull();
    expect(
      push(
        "com.google.android.apps.nbu.paisa.user",
        "Alice sent you a message: ₹499 received from my side",
      ),
    ).toBeNull();
  });
});

describe("parser v2 — unknown senders are evidence only", () => {
  it("parses an unknown bank's credit SMS but marks it unverified", () => {
    const p = sms("AD-BANKS", "Rs 125.00 credited to your account on 01-09-24.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(12500);
    expect(p?.ruleKey).toBe("generic-sms-credit-v1");
    expect(p?.verified).toBe(false);
  });

  it("parses an unknown app's receive-push but marks it unverified", () => {
    const p = push(null, "You received ₹150.25 from a customer via QR.");
    expect(p?.isCredit).toBe(true);
    expect(p?.amountPaise).toBe(15025);
    expect(p?.verified).toBe(false);
  });

  it("does not trust a normal phone number pretending to be a bank", () => {
    const p = sms("9876543210", "Rs 499.69 credited to your account. UTR 123456789012.");
    expect(p?.isCredit).toBe(true);
    expect(p?.verified).toBe(false);
  });

  it("does not trust loose telecom promo headers as verified banks", () => {
    const promoJio = sms("VM-JIOMBL", "Welcome! Rs 499.50 credited into your account.");
    expect(promoJio?.verified).toBe(false);

    const bankJio = sms("VM-JIOBNK", "Rs 499.50 credited to your Jio Payments Bank a/c.");
    expect(bankJio?.verified).toBe(true);
  });

  it("returns null for anything with no amount", () => {
    expect(push(null, "You received a payment")).toBeNull();
    expect(sms("SBIIN", "Credited without procedure")).toBeNull();
  });

  it("returns null for unrelated notifications", () => {
    expect(push(null, "Backing up your phone... 42% complete")).toBeNull();
    expect(push("com.whatsapp", "New message from Ramesh")).toBeNull();
  });
});

describe("parser v2 — email lane", () => {
  it("verifies a known bank domain and rejects an unknown domain", () => {
    const known = parseAlert({
      source: "EMAIL",
      sender: "alerts@hdfcbank.net",
      body: "Rs 700.00 credited to your account. UTR 123456789012.",
    });
    expect(known?.verified).toBe(true);
    expect(known?.lane).toBe("EMAIL");

    const unknown = parseAlert({
      source: "EMAIL",
      sender: "someone@evil.test",
      body: "Rs 700.00 credited to your account. UTR 123456789012.",
    });
    expect(unknown?.verified).toBe(false);
  });
});

describe("parser v2 — amount disambiguation", () => {
  it("ignores a balance amount far from the credit keyword", () => {
    const p = sms(
      "HDFCBK",
      "Rs 499.69 credited to A/c XX1234. Avl Bal Rs 12,000.00.",
    );
    expect(p?.amountPaise).toBe(49969);
  });

  it("refuses two equally-likely credited amounts", () => {
    const p = sms(
      "HDFCBK",
      "Rs 100.00 credited to A/c XX1 and Rs 200.00 credited to A/c XX2.",
    );
    expect(p).toBeNull();
  });
});
