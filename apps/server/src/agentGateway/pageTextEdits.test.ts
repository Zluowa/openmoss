import { describe, expect, it } from "vitest";

import { normalizePageDraftArgs } from "./pageDraftInput";
import { pageBlockOutline, resolveTextReplacements } from "./pageTextEdits";

const page = [
  { type: "h1", id: "t", children: [{ text: "Q3 launch plan" }] },
  {
    type: "p",
    id: "lead",
    children: [{ text: "Ship to " }, { text: "500 weekly", bold: true }, { text: " teams." }],
  },
  {
    type: "p",
    id: "list",
    listStyleType: "disc",
    indent: 1,
    children: [{ text: "Risk one, risk two" }],
  },
  { type: "p", children: [{ text: "no id here" }] },
];

describe("pageBlockOutline", () => {
  it("lists each block's id, type and short text", () => {
    expect(pageBlockOutline(page)).toEqual([
      { id: "t", type: "h1", text: "Q3 launch plan", level: 1 },
      { id: "lead", type: "p", text: "Ship to 500 weekly teams." },
      { id: "list", type: "p", text: "Risk one, risk two", list: "disc" },
      { id: null, type: "p", text: "no id here" },
    ]);
  });

  it("names a tab block by its title and level", () => {
    expect(
      pageBlockOutline([
        { type: "moss_tab", id: "tab1", title: "Raw data", level: 1, children: [{ text: "" }] },
      ]),
    ).toEqual([{ id: "tab1", type: "moss_tab", text: "Raw data", tabLevel: 1 }]);
  });

  it("cuts long blocks", () => {
    const [entry] = pageBlockOutline([
      { type: "p", id: "x", children: [{ text: "a".repeat(300) }] },
    ]);
    expect(entry!.text).toHaveLength(121);
  });
});

describe("resolveTextReplacements", () => {
  it("rewrites words in place and keeps their formatting", () => {
    const result = resolveTextReplacements(
      [{ kind: "replace-text", find: "500 weekly", replacement: "750 weekly" }],
      page,
    );
    expect("ops" in result && result.ops).toEqual([
      {
        kind: "replace",
        blockId: "lead",
        richContent: JSON.stringify([
          {
            type: "p",
            id: "lead",
            children: [
              { text: "Ship to " },
              { text: "750 weekly", bold: true },
              { text: " teams." },
            ],
          },
        ]),
      },
    ]);
  });

  it("replaces across formatting and merges edits of one block", () => {
    const result = resolveTextReplacements(
      [
        { kind: "replace-text", find: "to 500", replacement: "to about 500" },
        { kind: "replace-text", find: " teams", replacement: "" },
        { kind: "delete", blockId: "t" },
      ],
      page,
    );
    if (!("ops" in result)) throw new Error(result.hint);
    expect(result.ops).toHaveLength(2);
    const [replaced] = JSON.parse(result.ops[0]!.richContent as string) as Array<{
      children: { text: string }[];
    }>;
    expect(replaced!.children.map((child) => child.text).join("")).toBe(
      "Ship to about 500 weekly.",
    );
    expect(result.ops[1]).toEqual({ kind: "delete", blockId: "t" });
  });

  it("picks the nth occurrence inside a named block", () => {
    const result = resolveTextReplacements(
      [{ kind: "replace-text", blockId: "list", find: "risk", replacement: "Risk", nth: 1 }],
      page,
    );
    if (!("ops" in result)) throw new Error(result.hint);
    expect(JSON.parse(result.ops[0]!.richContent as string)[0].children[0].text).toBe(
      "Risk one, Risk two",
    );
  });

  it("asks for an exact quote when the words are not there", () => {
    const result = resolveTextReplacements(
      [{ kind: "replace-text", find: "600 weekly", replacement: "x" }],
      page,
    );
    expect("hint" in result && result.hint).toContain("not in the page");
    expect(
      "hint" in
        resolveTextReplacements(
          [{ kind: "replace-text", blockId: "nope", find: "a", replacement: "b" }],
          page,
        ),
    ).toBe(true);
  });

  it("passes through moss_pages_draft normalization untouched", () => {
    const normalized = normalizePageDraftArgs({
      pageId: "p1",
      ops: [{ kind: "replace-text", find: "a", replacement: "b" }],
    });
    expect("args" in normalized && normalized.args.ops).toEqual([
      { kind: "replace-text", find: "a", replacement: "b" },
    ]);
  });
});
