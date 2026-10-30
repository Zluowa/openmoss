import { describe, expect, it } from "vitest";

import {
  PAGE_RICH_CONTENT_LIMITS,
  parsePageRichContent,
  projectPageRichNodes,
} from "./pageRichContent";

describe("canonical Page Plate content", () => {
  it("preserves unknown legal rich nodes and derives headings, lists, code, table and links from actual text", () => {
    const ast = [
      { type: "h2", id: "heading", children: [{ text: "Research" }] },
      { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "Finding", bold: true }] },
      { type: "a", url: "https://example.test/notes", children: [{ text: "Source" }] },
      {
        type: "code_block",
        lang: "ts",
        children: [{ type: "code_line", children: [{ text: "const answer = 42;" }] }],
      },
      {
        type: "table",
        children: [
          {
            type: "tr",
            children: [{ type: "th", children: [{ type: "p", children: [{ text: "Name" }] }] }],
          },
          {
            type: "tr",
            children: [{ type: "td", children: [{ type: "p", children: [{ text: "Value" }] }] }],
          },
        ],
      },
      {
        type: "future-widget",
        widgetState: { color: "green", version: 17 },
        children: [{ text: "Future content" }],
      },
    ];
    const result = parsePageRichContent(JSON.stringify(ast, null, 2));
    expect(JSON.parse(result.richContent)).toEqual(ast);
    for (const fragment of [
      "## Research",
      "- **Finding**",
      "[Source](https://example.test/notes)",
      "```ts\nconst answer = 42;",
      "| Name |",
      "| --- |",
      "| Value |",
      "Future content",
    ])
      expect(result.content).toContain(fragment);
  });

  it("treats HTML as inert text and leaves historical unsafe data intact while excluding its URL from the projection", () => {
    const ast = [
      {
        type: "future-html",
        html: "<script>throw new Error('must remain data')</script>",
        children: [
          { text: "<img src=x onerror=alert(1)>" },
          { type: "a", url: "javascript:alert(1)", children: [{ text: "Unsafe link" }] },
        ],
      },
    ];
    const raw = JSON.stringify(ast);
    const content = projectPageRichNodes(ast);
    expect(JSON.stringify(ast)).toBe(raw);
    expect(content).toContain("&lt;img");
    expect(content).not.toContain("<img");
    expect(content).not.toContain("javascript:");
    expect(content).toContain("Unsafe link");
    expect(() => parsePageRichContent(raw)).toThrow("unsafe link URL");
    const inertOnly = [
      {
        type: "future-html",
        html: ast[0]!.html,
        children: [{ text: "<script>literal data</script>" }],
      },
    ];
    expect(JSON.parse(parsePageRichContent(JSON.stringify(inertOnly)).richContent)).toEqual(
      inertOnly,
    );
  });

  it("preserves empty documents, empty element children and unknown legal URL fields without adding a template", () => {
    expect(parsePageRichContent("[]")).toMatchObject({ richContent: "[]", content: "", nodes: [] });
    const ast = [
      { type: "p", children: [] },
      {
        type: "future-widget",
        url: "custom:data-for-a-future-widget",
        state: { retained: true },
        children: [],
      },
    ];
    const result = parsePageRichContent(JSON.stringify(ast));
    expect(JSON.parse(result.richContent)).toEqual(ast);
    expect(result.content).toBe("");
  });

  it("accepts durable links and media, including relative paths, while retaining their original rich bytes", () => {
    for (const type of ["a", "img", "video", "audio", "file", "media_embed"]) {
      for (const url of [
        "https://example.test/asset",
        "http://example.test/asset",
        "/assets/one.png",
        "../assets/one.png",
        "notes/source",
        "#section",
      ]) {
        const ast = [{ type, url, children: [{ text: "Source" }] }];
        expect(JSON.parse(parsePageRichContent(JSON.stringify(ast)).richContent)).toEqual(ast);
      }
    }
    expect(
      parsePageRichContent(
        JSON.stringify([
          { type: "a", url: "mailto:moss@example.test", children: [{ text: "Contact" }] },
        ]),
      ).content,
    ).toBe("[Contact](mailto:moss@example.test)");
    expect(
      parsePageRichContent(
        JSON.stringify([{ type: "a", url: "notes/source file", children: [{ text: "Source" }] }]),
      ).content,
    ).toBe("[Source](notes/source%20file)");
  });

  it.each(["a", "img", "video", "audio", "file", "media_embed"])(
    "rejects active, temporary or credential-bearing new %s URLs",
    (type) => {
      for (const url of [
        "javascript:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html,active",
        "blob:https://example.test/temporary",
        "file:///C:/private",
        "moss://app/private",
        "https://user:password@example.test/private",
        " https://example.test/asset",
        "https://example.test/asset\n",
        "https://example.test/a\u0000b",
      ]) {
        expect(() =>
          parsePageRichContent(JSON.stringify([{ type, url, children: [{ text: "Unsafe" }] }])),
        ).toThrow("Invalid page richContent");
      }
      if (type !== "a")
        expect(() =>
          parsePageRichContent(
            JSON.stringify([{ type, url: "mailto:moss@example.test", children: [] }]),
          ),
        ).toThrow("media requires a durable");
    },
  );

  it("rejects malformed node trees and dangerous keys without altering object prototypes", () => {
    for (const input of [
      "not JSON",
      "{}",
      "[1]",
      '[{"type":"p","children":[{"text":1}]}]',
      '[{"type":"p","children":[],"metadata":{"__proto__":{"polluted":true}}}]',
      '[{"type":"p","children":[],"constructor":{}}]',
      '[{"type":"p","children":[],"metadata":{"prototype":{}}}]',
    ]) {
      expect(() => parsePageRichContent(input)).toThrow("Invalid page richContent");
    }
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toBeUndefined();
  });

  it("enforces independent byte, nesting and container limits", () => {
    expect(() =>
      parsePageRichContent(
        JSON.stringify([{ text: "😀".repeat(PAGE_RICH_CONTENT_LIMITS.bytes / 4) }]),
      ),
    ).toThrow("byte limit");
    let nested: unknown = { text: "leaf" };
    for (let i = 0; i < PAGE_RICH_CONTENT_LIMITS.depth; i++)
      nested = { type: "unknown", children: [nested] };
    expect(() => parsePageRichContent(JSON.stringify([nested]))).toThrow("depth limit");
    expect(() =>
      parsePageRichContent(
        JSON.stringify(
          Array.from({ length: PAGE_RICH_CONTENT_LIMITS.nodes }, () => ({ text: "" })),
        ),
      ),
    ).toThrow("node limit");
  });

  it("uses code fences longer than embedded backtick runs", () => {
    const result = parsePageRichContent(
      JSON.stringify([
        { type: "p", children: [{ text: "```<script>data</script>", code: true }] },
        { type: "code_block", children: [{ type: "code_line", children: [{ text: "```" }] }] },
      ]),
    );
    expect(result.content).toContain("```` ```<script>data</script> ````");
    expect(result.content).toContain("````\n```\n````");
  });
});
