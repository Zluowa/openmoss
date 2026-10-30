import { describe, expect, it } from "vitest";

import { findDesktopSmokeFailures } from "./smoke-test-diagnostics.mjs";

describe("desktop smoke diagnostics", () => {
  it("rejects the fatal macOS bundle failures seen during a real Moss launch", () => {
    expect(
      findDesktopSmokeFailures(`
[ERROR:icu_util.cc(234)] icudtl.dat not found in bundle
[desktop] renderer process gone (reason=crashed, exitCode=133)
GPU process isn't usable. Goodbye.
`),
    ).toEqual([
      "icudtl.dat not found in bundle",
      "GPU process isn't usable",
      "[desktop] renderer process gone",
    ]);
  });

  it("accepts ordinary startup output", () => {
    expect(findDesktopSmokeFailures("Moss renderer loaded successfully")).toEqual([]);
  });
});
