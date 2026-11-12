import { describe, expect, it } from "vitest";

import { normalizePageDraftArgs, parseLooseJson } from "./pageDraftInput";

// The 可视化 block a model tries to write in acceptance round 10 (requestId
// line-chart-replace-005…009), and the ways it sent it.
const node = {
  type: "moss_visualization",
  title: "折线图",
  appPageId: "ec7e9f14-745d-44f4-853c-4a29062c0f8a",
  children: [{ text: "" }],
};
const canonical = JSON.stringify([node]);
const call = (richContent: unknown, extra: Record<string, unknown> = {}) => ({
  requestId: "line-chart-replace-005",
  scopeSpaceId: null,
  pageId: "page-1",
  baseRevision: 3,
  kind: "visualization",
  ops: [{ kind: "replace", blockId: "viz", richContent }],
  ...extra,
});
const richOf = (result: ReturnType<typeof normalizePageDraftArgs>) => {
  if ("hint" in result) throw new Error(result.hint);
  return (result.args.ops as Array<{ richContent?: string }>)[0]!.richContent;
};

describe("normalizePageDraftArgs", () => {
  it.each([
    ["the canonical escaped string", canonical],
    ["an array instead of a string (“literal quotes, no backslashes”)", [node]],
    ["a single node object", node],
    ["a string escaped one level too deep", JSON.stringify(canonical)],
    ["a code-fenced string", "```json\n" + canonical + "\n```"],
    ["escaped JSON without the outer quotes", canonical.replace(/"/gu, '\\"')],
  ])("accepts richContent as %s", (_label, richContent) => {
    expect(richOf(normalizePageDraftArgs(call(richContent)))).toBe(canonical);
  });

  it("accepts ops sent as a JSON string, `type` for `kind` and `id` for `blockId`", () => {
    const result = normalizePageDraftArgs({
      pageId: "page-1",
      ops: JSON.stringify([{ type: "replace", id: "viz", richContent: [node] }]),
    });
    expect(result).toEqual({
      args: {
        pageId: "page-1",
        scopeSpaceId: null,
        ops: [{ kind: "replace", blockId: "viz", richContent: canonical }],
      },
    });
  });

  it("accepts a single op spread over the top level and the whole call as a string", () => {
    const flat = normalizePageDraftArgs({
      pageId: "page-1",
      baseRevision: "3",
      kind: "replace",
      blockId: "viz",
      richContent: [node],
    });
    expect(richOf(flat)).toBe(canonical);
    expect(richOf(normalizePageDraftArgs(JSON.stringify(call([node]))))).toBe(canonical);
  });

  it("says exactly what to resend when the body cannot be repaired", () => {
    const broken = normalizePageDraftArgs(call('[{"type":"moss_visualization",'));
    expect(broken).toEqual({
      hint: expect.stringMatching(/JSON array of nodes \(not a string\)/u),
    });
    expect(normalizePageDraftArgs({ pageId: "p", ops: [{ kind: "replace" }] })).toEqual({
      hint: expect.stringMatching(/needs blockId/u),
    });
    expect(normalizePageDraftArgs({ ops: [] })).toEqual({
      hint: expect.stringMatching(/pageId is required/u),
    });
  });

  it("parses loose JSON but leaves plain text alone", () => {
    expect(parseLooseJson("```\n[1]\n```")).toEqual({ ok: true, value: [1] });
    expect(parseLooseJson("not json")).toEqual({ ok: false });
  });
});
