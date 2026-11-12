import { describe, expect, it } from "vitest";

import { rebasePageDraftOps } from "./pageDraftRebase";

const p = (id: string, text: string) => ({ type: "p", id, children: [{ text }] });
const placeholder = {
  type: "moss_visualization",
  id: "viz",
  title: "柱状图：甲3 乙5 丙2",
  appPageId: null,
  children: [{ text: "" }],
};
const video = { type: "video", id: "vid", url: "/media/leaf.mp4", children: [{ text: "" }] };
const base = [p("a", "第一段"), placeholder];

describe("rebasePageDraftOps", () => {
  it("keeps every change when the page did not move", () => {
    const ops = [{ kind: "delete" as const, blockId: "a" }];
    expect(rebasePageDraftOps(ops, base, base)).toEqual({ ops, dropped: 0 });
  });

  // Acceptance round 10 (X1): a stale whole-page proposal marked the person's new video for
  // removal; accepting it would have deleted it.
  it("leaves a block the person added after the snapshot untouched", () => {
    const current = [...base, video];
    const proposal = [p("a", "第一段"), { ...placeholder, appPageId: "app-1" }];
    const result = rebasePageDraftOps(
      [{ kind: "replace-all", richContent: JSON.stringify(proposal) }],
      base,
      current,
    );
    expect(result.ops).toHaveLength(1);
    const merged = JSON.parse((result.ops[0] as { richContent: string }).richContent);
    expect(merged.map((node: { id: string }) => node.id)).toEqual(["a", "viz", "vid"]);
    expect(merged[2]).toEqual(video);
    expect(merged[1].appPageId).toBe("app-1");
  });

  it("does not overwrite or delete a block the person edited after the snapshot", () => {
    const current = [p("a", "第一段（改过）"), placeholder];
    const result = rebasePageDraftOps(
      [
        { kind: "replace", blockId: "a", markdown: "AI 改写" },
        { kind: "delete", blockId: "a" },
      ],
      base,
      current,
    );
    expect(result).toEqual({ ops: [], dropped: 2 });
    const whole = rebasePageDraftOps(
      [{ kind: "replace-all", richContent: JSON.stringify([p("a", "AI 改写")]) }],
      base,
      current,
    );
    expect(JSON.parse((whole.ops[0] as { richContent: string }).richContent)).toEqual([
      p("a", "第一段（改过）"),
    ]);
  });

  it("still applies the unrelated changes of the same suggestion", () => {
    const current = [p("a", "第一段（改过）"), placeholder, video];
    const fill = JSON.stringify([{ ...placeholder, appPageId: "app-1" }]);
    const result = rebasePageDraftOps(
      [
        { kind: "replace", blockId: "a", markdown: "AI 改写" },
        { kind: "replace", blockId: "viz", richContent: fill },
        { kind: "insert", afterBlockId: "viz", markdown: "说明" },
        { kind: "delete", blockId: "vid" },
      ],
      base,
      current,
    );
    expect(result.dropped).toBe(2);
    expect(result.ops).toEqual([
      { kind: "replace", blockId: "viz", richContent: fill },
      { kind: "insert", afterBlockId: "viz", markdown: "说明" },
    ]);
  });

  it("drops a Markdown rewrite once the page moved, and never revives a removed block", () => {
    const current = [placeholder];
    expect(
      rebasePageDraftOps([{ kind: "replace-all", markdown: "# 新页面" }], base, current).ops,
    ).toEqual([]);
    const whole = rebasePageDraftOps(
      [{ kind: "replace-all", richContent: JSON.stringify(base) }],
      base,
      current,
    );
    expect(JSON.parse((whole.ops[0] as { richContent: string }).richContent)).toEqual([
      placeholder,
    ]);
  });

  it("changes nothing when the base revision is unknown", () => {
    const ops = [{ kind: "delete" as const, blockId: "a" }];
    expect(rebasePageDraftOps(ops, null, [])).toEqual({ ops, dropped: 0 });
  });
});
