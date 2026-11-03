import { describe, expect, it } from "vitest";
import {
  chooseFingerprintOffset,
  fingerprintCeiling,
  MAX_EXTRA_PAISE,
  pickFreeOffset,
} from "../src/services/allocator.js";

describe("fingerprintCeiling (traffic-aware range)", () => {
  it("stays in the ₹0.99 band for quiet traffic", () => {
    expect(fingerprintCeiling(0)).toBe(99);
    expect(fingerprintCeiling(80)).toBe(99);
  });

  it("opens the ₹1.99 band when the first band is ~80% full", () => {
    expect(fingerprintCeiling(81)).toBe(199);
    expect(fingerprintCeiling(180)).toBe(199);
  });

  it("opens the full ₹3.00 range under peak pressure", () => {
    expect(fingerprintCeiling(181)).toBe(300);
    expect(fingerprintCeiling(301)).toBe(300);
  });
});

describe("pickFreeOffset", () => {
  it("returns a free offset inside the requested band", () => {
    for (let i = 0; i < 50; i++) {
      const offset = pickFreeOffset([0, 1, 2, 3, 4], 0, 99);
      expect(offset).not.toBeNull();
      expect(offset!).toBeGreaterThanOrEqual(0);
      expect(offset!).toBeLessThanOrEqual(99);
      expect([0, 1, 2, 3, 4]).not.toContain(offset);
    }
  });

  it("never returns a taken offset", () => {
    const taken = [5, 10, 15, 20, 37, 42, 99];
    for (let i = 0; i < 100; i++) {
      const offset = pickFreeOffset(taken, 0, 99);
      expect(taken).not.toContain(offset);
    }
  });

  it("returns null when the band is full", () => {
    const full = Array.from({ length: 100 }, (_, i) => i);
    expect(pickFreeOffset(full, 0, 99)).toBeNull();
    expect(pickFreeOffset(full.slice(0, 99), 0, 99)).not.toBeNull();
  });
});

describe("chooseFingerprintOffset", () => {
  it("uses the cheapest band first on an empty shop", () => {
    for (let i = 0; i < 50; i++) {
      const offset = chooseFingerprintOffset(99_800, []);
      expect(offset).not.toBeNull();
      expect(offset!).toBeGreaterThanOrEqual(0);
      expect(offset!).toBeLessThanOrEqual(99);
    }
  });

  it("moves to the ₹1.00–₹1.99 band only after the first 100 slots are taken", () => {
    const taken = Array.from({ length: 100 }, (_, i) => 99_800 + i);
    for (let i = 0; i < 50; i++) {
      const offset = chooseFingerprintOffset(99_800, taken);
      expect(offset).not.toBeNull();
      expect(offset!).toBeGreaterThanOrEqual(100);
      expect(offset!).toBeLessThanOrEqual(199);
    }
  });

  it("moves to the ₹2.00–₹3.00 band only after the first 200 slots are taken", () => {
    const taken = Array.from({ length: 200 }, (_, i) => 99_800 + i);
    for (let i = 0; i < 50; i++) {
      const offset = chooseFingerprintOffset(99_800, taken);
      expect(offset).not.toBeNull();
      expect(offset!).toBeGreaterThanOrEqual(200);
      expect(offset!).toBeLessThanOrEqual(MAX_EXTRA_PAISE);
    }
  });

  it("returns null only when all 301 slots are occupied", () => {
    const all = Array.from({ length: MAX_EXTRA_PAISE + 1 }, (_, i) => 99_800 + i);
    expect(chooseFingerprintOffset(99_800, all)).toBeNull();
    expect(chooseFingerprintOffset(99_800, all.slice(0, 300))).not.toBeNull();
  });

  it("cannot collide with a neighbouring product price", () => {
    // ₹999.00 is order #101 for the ₹998 product, but also the base amount
    // of a ₹999 product. The allocator must see it and skip it.
    const taken = [99_800, 99_900]; // ₹998.00 (own base) + ₹999.00 (neighbour)
    for (let i = 0; i < 50; i++) {
      const offset = chooseFingerprintOffset(99_800, taken);
      expect(offset).not.toBeNull();
      expect(99_800 + offset!).not.toBe(99_900);
    }
  });
});
