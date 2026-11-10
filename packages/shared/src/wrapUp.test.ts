import { describe, expect, it } from "vitest";

import { isWrapUpToolName, parseWrapUp, WRAP_UP_LIMITS } from "./wrapUp";

describe("parseWrapUp", () => {
  it("reads a recap with a question and answer buttons", () => {
    expect(
      parseWrapUp({
        recap: "Merged 16 PRs; the China gateway is still on the old build.",
        ask: "Have you topped up Tencent Cloud?",
        actions: [{ label: "Topped up" }, { label: "Not yet" }],
      }),
    ).toEqual({
      recap: "Merged 16 PRs; the China gateway is still on the old build.",
      ask: "Have you topped up Tencent Cloud?",
      actions: ["Topped up", "Not yet"],
    });
  });

  it("accepts JSON text, drops buttons without a question, and dedupes", () => {
    expect(parseWrapUp('{"recap":"Done.","actions":[{"label":"Ship"}]}')).toEqual({
      recap: "Done.",
      ask: null,
      actions: [],
    });
    expect(
      parseWrapUp({ recap: "x", ask: "Go?", actions: ["Yes", "Yes", "No", "Later"] })?.actions,
    ).toEqual(["Yes", "No"]);
  });

  it("clips long fields and refuses an empty recap", () => {
    const box = parseWrapUp({
      recap: "r".repeat(400),
      ask: "a".repeat(200),
      actions: ["b".repeat(40)],
    })!;
    expect(box.recap.length).toBe(WRAP_UP_LIMITS.recapChars);
    expect(box.ask?.length).toBe(WRAP_UP_LIMITS.askChars);
    expect(box.actions[0]?.length).toBe(WRAP_UP_LIMITS.actionLabelChars);
    expect(parseWrapUp({ recap: "  " })).toBeNull();
    expect(parseWrapUp("not json")).toBeNull();
  });
});

describe("isWrapUpToolName", () => {
  it("matches prefixed MCP names", () => {
    expect(isWrapUpToolName("moss_wrap_up")).toBe(true);
    expect(isWrapUpToolName("mcp__moss__moss_wrap_up")).toBe(true);
    expect(isWrapUpToolName("moss_wrap_up_extra")).toBe(false);
    expect(isWrapUpToolName(undefined)).toBe(false);
  });
});
