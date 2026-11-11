// Fixture for tools/test-quarantine/test/plugin.test.ts; never part of a real lane.
import { describe, expect, it } from "vitest";

describe("sample", () => {
  it("keeps running", () => {
    expect(1).toBe(1);
  });
  it("is quarantined by name", () => {
    expect(1).toBe(1);
  });
  describe("block", () => {
    it.each(["light", "dark"])("fits the bar (%s)", () => {
      expect(1).toBe(1);
    });
  });
});
