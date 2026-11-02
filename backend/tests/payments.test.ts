import { describe, expect, it } from "vitest";
import { formatINR, paiseSuffix, toPaise } from "../src/utils/payments.js";

describe("money helpers", () => {
  it("converts rupees to integer paise safely (float precision)", () => {
    expect(toPaise(499.37)).toBe(49937);
    expect(toPaise(998.3)).toBe(99830);
    expect(toPaise(79.99)).toBe(7999);
  });

  it("rejects invalid amounts", () => {
    expect(() => toPaise(0)).toThrow(RangeError);
    expect(() => toPaise(-2.5)).toThrow(RangeError);
    expect(() => toPaise(Number.NaN)).toThrow(TypeError);
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("builds the unique paise amount from base + suffix", () => {
    expect(paiseSuffix(499, 37)).toBe(49937);
    expect(paiseSuffix(1000, 0)).toBe(100000);
    expect(() => paiseSuffix(499.5, 1)).toThrow(RangeError);
    expect(() => paiseSuffix(499, 100)).toThrow(RangeError);
  });

  it("formats paise for display", () => {
    expect(formatINR(99837)).toBe("₹998.37");
    expect(formatINR(5)).toBe("₹0.05");
  });
});
