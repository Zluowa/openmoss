import { describe, expect, it } from "vitest";

import { prepareDraftOpsForPage } from "./pageDraftBlocks";

const placeholder = {
  type: "moss_visualization",
  id: "viz",
  title: "折线图：一月10 二月14 三月9",
  prompt: "折线图：一月10 二月14 三月9",
  appPageId: null,
  children: [{ text: "" }],
};
const page = [{ type: "p", id: "a", children: [{ text: "第一段" }] }, placeholder];
const rich = (op: { richContent?: string }) => JSON.parse(op.richContent!);

describe("prepareDraftOpsForPage", () => {
  // Acceptance round 10 (V1): the accepted suggestion turned the 可视化 block into plain text.
  it("refuses to replace a 可视化 block with text, naming the tool to use", () => {
    expect(() =>
      prepareDraftOpsForPage(
        [{ kind: "replace", blockId: "viz", markdown: "折线图：一月10 二月14 三月9" }],
        page,
      ),
    ).toThrow(/moss_app_visualize/u);
    expect(() =>
      prepareDraftOpsForPage(
        [
          {
            kind: "replace",
            blockId: "viz",
            richContent: JSON.stringify([{ type: "p", children: [{ text: "图" }] }]),
          },
        ],
        page,
      ),
    ).toThrow(/可视化 block/u);
  });

  it("turns the Markdown form of a 可视化 block back into the block", () => {
    const [op] = prepareDraftOpsForPage(
      [{ kind: "replace", blockId: "viz", markdown: "[折线图](moss-app-page:app-9)\n" }],
      page,
    );
    expect(op).toMatchObject({ kind: "replace", blockId: "viz" });
    expect(rich(op as { richContent: string })).toEqual([
      {
        type: "moss_visualization",
        title: "折线图",
        prompt: placeholder.prompt,
        appPageId: "app-9",
        children: [{ text: "" }],
      },
    ]);
  });

  it("repairs a 可视化 node written with appId and no children", () => {
    const [op] = prepareDraftOpsForPage(
      [
        {
          kind: "replace",
          blockId: "viz",
          richContent: JSON.stringify([{ type: "moss_visualization", appId: "app-3" }]),
        },
      ],
      page,
    );
    expect(rich(op as { richContent: string })[0]).toEqual({
      type: "moss_visualization",
      appPageId: "app-3",
      title: placeholder.title,
      prompt: placeholder.prompt,
      children: [{ text: "" }],
    });
  });

  it("refuses a Markdown rewrite of a page holding blocks Markdown cannot keep", () => {
    expect(() => prepareDraftOpsForPage([{ kind: "replace-all", markdown: "# 新" }], page)).toThrow(
      /targeted ops/u,
    );
    expect(prepareDraftOpsForPage([{ kind: "replace-all", markdown: "# 新" }], [page[0]!])).toEqual(
      [{ kind: "replace-all", markdown: "# 新" }],
    );
  });

  it("leaves ordinary changes as they are", () => {
    const ops = [
      { kind: "insert" as const, afterBlockId: "a", markdown: "第二段" },
      { kind: "delete" as const, blockId: "a" },
    ];
    expect(prepareDraftOpsForPage(ops, page)).toEqual(ops);
  });
});
