import { describe, expect, it } from "vitest";
import { pickFreeSuffix } from "../src/services/allocator.js";

describe("pickFreeSuffix", () => {
  it("returns a 0–99 suffix outside the taken set", () => {
    for (let i = 0; i < 50; i++) {
      const s = pickFreeSuffix([0, 1, 2, 3, 4]);
      expect(s).not.toBeNull();
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(99);
      expect([0, 1, 2, 3, 4]).not.toContain(s);
    }
  });

  it("never returns a taken suffix across many draws", () => {
    const taken = [5, 10, 15, 20, 37, 42, 99];
    for (let i = 0; i < 100; i++) {
      const s = pickFreeSuffix(taken);
      expect(taken).not.toContain(s);
    }
  });

  it("returns null only when all 100 suffixes are taken", () => {
    const all = Array.from({ length: 100 }, (_, i) => i);
    expect(pickFreeSuffix(all)).toBeNull();
    const almost = all.slice(0, 99);
    expect(pickFreeSuffix(almost)).not.toBeNull();
  });

  it("handles the empty set", () => {
    expect(pickFreeSuffix([])).not.toBeNull();
  });
});
