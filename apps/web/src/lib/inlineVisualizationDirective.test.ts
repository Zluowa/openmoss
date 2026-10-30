import { describe, expect, it } from "vitest";

import {
  parseInlineVisualizationDirective,
  parseOpenUIDirective,
  readOpenUIDirective,
  remarkInlineVisualizationDirectives,
  remarkOpenUIDirectives,
} from "./inlineVisualizationDirective";

describe("inline visualization directives", () => {
  it.each([
    [
      '<cursor-content kind="visualization" src="visualizations/special-relativity.html"></cursor-content>',
      "visualizations/special-relativity.html",
    ],
    [
      '<cursor-content kind="visualization" src="viz/a.html" title="Relativity"></cursor-content>',
      "viz/a.html",
    ],
    ['<cursor-content kind="visualization" src="viz/b.html">', "viz/b.html"],
  ])("parses the T3 cursor-content fallback %s", (source, path) => {
    expect(parseInlineVisualizationDirective(source)).toMatchObject({ path });
  });

  it("does not parse Codex visualize markers (CLI 0.162.1 never emits them)", () => {
    for (const source of [
      'visualize{"path":"/tmp/chart.html"}',
      '\uE200visualize\uE202{"path":"/tmp/chart.html","mode":"wide","title":"Trend"}\uE201',
      '::codex-inline-vis{"path":"/tmp/chart.html"}',
      'visualize{"path":}',
      'Before visualize{"path":"/tmp/chart.html"}',
    ]) {
      expect(parseInlineVisualizationDirective(source)).toBeNull();
    }
  });

  it("rewrites a cursor-content html paragraph into an inlineVisualization node", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "html",
              value:
                '<cursor-content kind="visualization" src="visualizations/special-relativity.html"></cursor-content>',
            },
          ],
        },
      ],
    };
    remarkInlineVisualizationDirectives()(tree);
    const paragraph = tree.children[0]!;
    expect(paragraph.type).toBe("inlineVisualization");
    const data = (paragraph as { data?: { hProperties?: { dataVisualization?: string } } }).data;
    expect(JSON.parse(data?.hProperties?.dataVisualization ?? "{}")).toMatchObject({
      path: "visualizations/special-relativity.html",
    });
  });
});

describe("openui directives", () => {
  it("parses a complete <openui> element", () => {
    const source = '<openui>root = Button("Deploy")</openui>';
    expect(parseOpenUIDirective(source)).toEqual({
      source,
      code: 'root = Button("Deploy")',
      partial: false,
    });
  });

  it("parses a multi-line <openui> element with a title attribute", () => {
    const source =
      '<openui title="Trend chart">\nroot = Card([intro])\nintro = TextContent("Hi")\n</openui>';
    expect(parseOpenUIDirective(source)).toEqual({
      source,
      code: 'root = Card([intro])\nintro = TextContent("Hi")',
      title: "Trend chart",
      partial: false,
    });
  });

  it("marks a still-streaming <openui> block without a closing tag as partial", () => {
    const source = "<openui>\nroot = Card([intro])";
    expect(parseOpenUIDirective(source)).toEqual({
      source,
      code: "root = Card([intro])",
      partial: true,
    });
  });

  it("rejects empty bodies, stray text and other tags", () => {
    expect(parseOpenUIDirective("<openui>   </openui>")).toBeNull();
    expect(parseOpenUIDirective('text <openui>root = Button("Hi")</openui>')).toBeNull();
    expect(parseOpenUIDirective('<openui-foo>root = Button("Hi")</openui-foo>')).toBeNull();
    expect(parseOpenUIDirective("</openui>")).toBeNull();
  });

  it("converts a fenced ```openui code node", () => {
    const tree = {
      type: "root",
      children: [
        { type: "code", lang: "openui", value: 'root = Button("Deploy")' },
        { type: "code", lang: "js", value: 'console.log("openui")' },
      ],
    };
    remarkOpenUIDirectives()(tree);
    const [converted, untouched] = tree.children as unknown as [
      { type: string; data?: { hProperties?: { dataOpenui?: string } } },
      { type: string },
    ];
    expect(converted!.type).toBe("openuiVisualization");
    expect(JSON.parse(converted!.data?.hProperties?.dataOpenui ?? "{}")).toEqual({
      source: '```openui\nroot = Button("Deploy")\n```',
      code: 'root = Button("Deploy")',
      partial: false,
    });
    expect(untouched!.type).toBe("code");
  });

  it("converts a single html node <openui> block", () => {
    const tree = {
      type: "root",
      children: [{ type: "html", value: '<openui>\nroot = Text("Hi")\n</openui>' }],
    };
    remarkOpenUIDirectives()(tree);
    const node = tree.children[0] as {
      type: string;
      data?: { hProperties?: { dataOpenui?: string } };
    };
    expect(node.type).toBe("openuiVisualization");
    expect(JSON.parse(node.data?.hProperties?.dataOpenui ?? "{}")).toMatchObject({
      code: 'root = Text("Hi")',
      partial: false,
    });
  });

  it("stitches blank-line-split sibling nodes back into one openui node", () => {
    // Markdown terminates a raw HTML block at a blank line, so a program with
    // blank lines arrives as html + paragraph + html siblings.
    const tree = {
      type: "root",
      children: [
        { type: "html", value: "<openui>" },
        {
          type: "paragraph",
          children: [{ type: "text", value: "root = Card([intro])" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", value: 'intro = TextContent("Hi")' }],
        },
        { type: "html", value: "</openui>" },
        { type: "paragraph", children: [{ type: "text", value: "afterwards" }] },
      ],
    };
    remarkOpenUIDirectives()(tree);
    expect(tree.children).toHaveLength(2);
    const node = tree.children[0] as {
      type: string;
      data?: { hProperties?: { dataOpenui?: string } };
    };
    expect(node.type).toBe("openuiVisualization");
    expect(JSON.parse(node.data?.hProperties?.dataOpenui ?? "{}")).toMatchObject({
      code: 'root = Card([intro])\n\nintro = TextContent("Hi")',
      partial: false,
    });
    expect(tree.children[1]!.type).toBe("paragraph");
  });

  it("keeps a partial <openui> block when the closing tag has not streamed in", () => {
    const tree = {
      type: "root",
      children: [
        { type: "html", value: "<openui>" },
        { type: "paragraph", children: [{ type: "text", value: "root = Card(" }] },
      ],
    };
    remarkOpenUIDirectives()(tree);
    expect(tree.children).toHaveLength(1);
    const node = tree.children[0] as {
      type: string;
      data?: { hProperties?: { dataOpenui?: string } };
    };
    expect(JSON.parse(node.data?.hProperties?.dataOpenui ?? "{}")).toMatchObject({
      partial: true,
    });
  });

  it("does not convert openui-shaped text inside a non-openui code fence", () => {
    const tree = {
      type: "root",
      children: [{ type: "code", lang: "html", value: "<openui>root = X</openui>" }],
    };
    remarkOpenUIDirectives()(tree);
    expect(tree.children[0]!.type).toBe("code");
  });

  it("round-trips a directive through readOpenUIDirective", () => {
    const directive = parseOpenUIDirective('<openui>root = Button("Go")</openui>')!;
    expect(readOpenUIDirective(JSON.stringify(directive))).toEqual(directive);
    expect(readOpenUIDirective("not json")).toBeNull();
    expect(readOpenUIDirective(JSON.stringify({ source: 1 }))).toBeNull();
  });

  it("stitches via source positions when program strings contain markdown emphasis", () => {
    // Regression: a model wrote TextContent strings with `**bold**` inside a
    // blank-line-split <openui> block. Markdown parses those into emphasis
    // nodes, value-based stitching aborts on them, and the program tail leaks
    // into the chat as raw DSL source. Position-based slicing keeps the
    // program byte-exact. (Hand-built tree with remark-style offsets.)
    const program = [
      "<openui>",
      "root = Card([intro])",
      "",
      'intro = TextContent("光速不变是 **核心公设** — 一切从它推出")',
      "",
      "</openui>",
    ].join("\n");
    const openAt = 0;
    const introAt = program.indexOf("intro = TextContent");
    const closeAt = program.indexOf("</openui>");
    const tree = {
      type: "root",
      children: [
        {
          type: "html",
          value: "<openui>\nroot = Card([intro])",
          position: {
            start: { offset: openAt },
            end: { offset: program.indexOf("\n\n", openAt) },
          },
        },
        {
          // remark parses the emphasis inside the string: text + strong + text.
          type: "paragraph",
          children: [
            { type: "text", value: 'intro = TextContent("光速不变是 ' },
            { type: "strong", children: [{ type: "text", value: "核心公设" }] },
            { type: "text", value: ' — 一切从它推出")' },
          ],
          position: {
            start: { offset: introAt },
            end: {
              offset:
                introAt + 'intro = TextContent("光速不变是 **核心公设** — 一切从它推出")'.length,
            },
          },
        },
        {
          type: "html",
          value: "</openui>",
          position: {
            start: { offset: closeAt },
            end: { offset: closeAt + "</openui>".length },
          },
        },
      ],
    };
    remarkOpenUIDirectives()(tree as never, { value: program } as never);
    expect(tree.children).toHaveLength(1);
    const node = tree.children[0] as {
      type: string;
      data?: { hProperties?: { dataOpenui?: string } };
    };
    expect(node.type).toBe("openuiVisualization");
    const directive = JSON.parse(node.data?.hProperties?.dataOpenui ?? "{}") as {
      code: string;
      partial: boolean;
    };
    expect(directive.partial).toBe(false);
    // The program text survives byte-exact — markdown markers intact.
    expect(directive.code).toContain('"光速不变是 **核心公设** — 一切从它推出"');
    expect(directive.code).toContain("root = Card([intro])");
  });
});
