import { describe, expect, it } from "vitest";
import {
  buildUpiPayUrl,
  paiseToUpiAmount,
} from "../src/lib/upi.js";

describe("paiseToUpiAmount", () => {
  it("formats two decimals with no separators", () => {
    expect(paiseToUpiAmount(99837)).toBe("998.37");
    expect(paiseToUpiAmount(1)).toBe("0.01");
    expect(paiseToUpiAmount(49900)).toBe("499.00");
    expect(paiseToUpiAmount(100)).toBe("1.00");
  });

  it("rejects invalid inputs", () => {
    expect(() => paiseToUpiAmount(0)).toThrow(RangeError);
    expect(() => paiseToUpiAmount(-5)).toThrow(RangeError);
    expect(() => paiseToUpiAmount(1.5)).toThrow(RangeError);
  });
});

describe("buildUpiPayUrl", () => {
  it("builds the standard pa/pn/am/cu/tn query", () => {
    const url = buildUpiPayUrl(
      { vpa: "shekar@okaxis", payeeName: "Shekar Store" },
      99837,
      "Order PS-000421",
    );
    expect(url).toMatch(/^upi:\/\/pay\?/);
    expect(url).toContain("pa=shekar%40okaxis");
    expect(url).toContain("pn=Shekar%20Store"); // %20, not "+"
    expect(url).toContain("am=998.37");
    expect(url).toContain("cu=INR");
    expect(url).toContain("tn=Order%20PS-000421");
  });

  it("encodes special characters in notes without breaking the URL", () => {
    const url = buildUpiPayUrl(
      { vpa: "a@b", payeeName: "A&B" },
      100,
      "2 × Chai & Snacks",
    );
    expect(url).toContain("pn=A%26B");
    expect(url).toContain(encodeURIComponent("2 × Chai & Snacks"));
    expect(url).not.toContain("&Chai"); // & inside tn must stay encoded
  });
});
