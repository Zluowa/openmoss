import { describe, expect, it } from "vitest";

import {
  formatInlineSubagentNameList,
  selectInlineSubagentNames,
} from "./inlineSubagentActivity.logic";

describe("formatInlineSubagentNameList", () => {
  it("joins up to three names the way Codex subagents.activity.summary does", () => {
    expect(formatInlineSubagentNameList(["Cedar"], "en")).toBe("Cedar");
    expect(formatInlineSubagentNameList(["Cedar", "Birch"], "en")).toBe("Cedar and Birch");
    expect(formatInlineSubagentNameList(["Cedar", "Birch", "Pine"], "en")).toBe(
      "Cedar, Birch and Pine",
    );
    expect(formatInlineSubagentNameList(["Cedar", "Birch", "Pine", "Oak"], "en")).toBe(
      "Cedar, Birch and 2 more",
    );
  });

  it("uses Chinese list punctuation", () => {
    expect(formatInlineSubagentNameList(["Cedar", "Birch", "Pine"], "zh-CN")).toBe(
      "Cedar、Birch 和 Pine",
    );
  });

  it("keeps the overflow slice at two names", () => {
    expect(selectInlineSubagentNames(["a", "b", "c", "d"]).hiddenCount).toBe(2);
  });
});
