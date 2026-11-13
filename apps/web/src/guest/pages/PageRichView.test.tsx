import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageRichView } from "./PageRichView";

const render = (nodes: unknown, content = "") =>
  renderToStaticMarkup(
    <PageRichView
      richContent={nodes === undefined ? undefined : JSON.stringify(nodes)}
      content={content}
      imageLabel="图片"
      imageNotShared="图片不随分享页面提供"
    />,
  );

describe("PageRichView", () => {
  it("renders headings, marks, lists and safe links", () => {
    const html = render([
      { type: "h1", children: [{ text: "标题" }] },
      {
        type: "p",
        children: [{ text: "粗", bold: true }, { text: "与" }, { text: "斜", italic: true }],
      },
      { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "第一" }] },
      { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "第二" }] },
      {
        type: "p",
        children: [{ type: "a", url: "https://example.com", children: [{ text: "链接" }] }],
      },
    ]);
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<em>斜</em>");
    expect(html).toContain("1.");
    expect(html).toContain("2.");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("never renders markup from text and keeps media out", () => {
    const html = render([
      { type: "p", children: [{ text: "<img src=x onerror=alert(1)>" }] },
      { type: "img", url: "https://example.com/a.png", children: [{ text: "" }] },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("图片不随分享页面提供");
  });

  it("falls back to the Markdown projection", () => {
    expect(render(undefined, "第一段\n\n第二段")).toContain("第二段");
  });

  it("shows the first tab with a tab bar, chips as their label, and highlights open comments", () => {
    const html = renderToStaticMarkup(
      <PageRichView
        richContent={JSON.stringify([
          { type: "moss_tab", id: "t1", title: "计划", level: 0, children: [{ text: "" }] },
          {
            type: "p",
            id: "b1",
            children: [
              { text: "上线 " },
              { text: "十月", comment: true, comment_c1: true },
              { text: " · " },
              {
                type: "moss_dropdown",
                options: ["未开始", "进行中"],
                value: 1,
                children: [{ text: "" }],
              },
            ],
          },
          { type: "moss_tab", id: "t2", title: "数据", level: 0, children: [{ text: "" }] },
          { type: "p", id: "b2", children: [{ text: "第二个标签页" }] },
        ])}
        content=""
        imageLabel="图片"
        imageNotShared="图片不随分享页面提供"
        openComments={new Set(["c1"])}
        tabsLabel="标签页"
      />,
    );
    expect(html).toContain('aria-label="标签页"');
    expect(html).toContain("计划");
    expect(html).toContain("数据");
    expect(html).not.toContain("第二个标签页");
    expect(html).toContain('data-guest-comment="c1"');
    expect(html).toContain('data-guest-block="b1"');
    expect(html).toContain("进行中");
  });
});
