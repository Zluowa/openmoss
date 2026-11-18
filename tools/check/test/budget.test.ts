import { join } from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  estimateDroppableTestSeconds,
  overTestBudget,
  UNIT_FILE_SECONDS,
  UNKNOWN_BROWSER_FILE_SECONDS,
} from "../lib/plan.ts";

describe("the quick job's test budget", () => {
  it("estimates browser files from stored timings, unknown ones and unit files at defaults", () => {
    expect(
      estimateDroppableTestSeconds({
        unitFiles: 10,
        browserFiles: ["src/a.browser.tsx", "src/new.browser.tsx"],
        browserSeconds: { "src/a.browser.tsx": 30 },
        browserOverheadSeconds: 1,
      }),
    ).toBe(30 + 1 + UNKNOWN_BROWSER_FILE_SECONDS + 1 + 10 * UNIT_FILE_SECONDS);
  });

  it("leaves tests to the full lanes only past a budget, and never without one", () => {
    expect(overTestBudget(241, 240)).toBe(true);
    expect(overTestBudget(240, 240)).toBe(false);
    expect(overTestBudget(10_000, undefined)).toBe(false);
  });

  it("puts a change as wide as #704's over the quick job's 240 s budget, and a one-file change under it", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const stored = JSON.parse(
      readFileSync(join(root, "apps/web/src/test/browserFileDurations.json"), "utf8"),
    ) as {
      seconds: Record<string, number>;
    };
    const allBrowser = Object.keys(stored.seconds).filter((file) => file.endsWith(".browser.tsx"));
    const wide = estimateDroppableTestSeconds({
      unitFiles: 200,
      browserFiles: allBrowser.slice(0, 20),
      browserSeconds: stored.seconds,
    });
    expect(overTestBudget(wide, 240)).toBe(true);
    const narrow = estimateDroppableTestSeconds({
      unitFiles: 3,
      browserFiles: [],
      browserSeconds: stored.seconds,
    });
    expect(overTestBudget(narrow, 240)).toBe(false);
  });
});
