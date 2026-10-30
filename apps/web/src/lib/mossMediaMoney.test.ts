import { describe, expect, it } from "vitest";
import { formatMediaOriginalCost, formatMediaPoints, isMediaNanoAmount } from "./mossMediaMoney";

describe("media money", () => {
  it("keeps every nano-CNY visible without floating point or integer-credit rounding", () => {
    expect(formatMediaPoints("1")).toBe("0.0000001");
    expect(formatMediaPoints("10000000")).toBe("1");
    expect(formatMediaPoints("1000000000")).toBe("100");
    expect(formatMediaPoints("9007199254740993")).toBe("900,719,925.4740993");
    expect(formatMediaOriginalCost("1")).toBe("0.000000001");
    expect(formatMediaPoints("0")).toBe("0");
  });
  it.each(["-1", "1.2", "1e9", "01", " 1", "", "9".repeat(40), 1, null])(
    "rejects invalid wire amount %s",
    (amount) => {
      expect(isMediaNanoAmount(amount)).toBe(false);
    },
  );
});
