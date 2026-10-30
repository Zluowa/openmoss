import { describe, expect, it } from "vitest";

import {
  CODEX_SUBAGENT_SPARKLE_COUNT,
  codexSubagentSparkleIndex,
} from "./codexSubagentSparkleSeed";

describe("codexSubagentSparkleIndex", () => {
  it("matches Codex qOc for the 28-mark palette", () => {
    expect(CODEX_SUBAGENT_SPARKLE_COUNT).toBe(28);
    expect(codexSubagentSparkleIndex("cedar")).toBe(11);
    expect(codexSubagentSparkleIndex("Birch")).toBe(4);
    expect(codexSubagentSparkleIndex("")).toBe(0);
    expect(codexSubagentSparkleIndex("01a070c0-7161-7890-861c")).toBe(10);
  });
});
