import { describe, expect, it } from "vitest";

import { deckHtmlDocument } from "./slidesHtml";

describe("deck web page export", () => {
  it("is one self-contained page that shows a slide at a time and pages with the keyboard", () => {
    const html = deckHtmlDocument(
      "季度 <回顾>",
      ["<div>一</div>", "<div>二</div>"],
      "rgb(17 17 16)",
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>季度 &lt;回顾&gt;</title>");
    expect(html.match(/<section class="slide"/gu)).toHaveLength(2);
    expect(html).toContain('data-index="1" aria-label="2 / 2" hidden');
    expect(html).toContain("ArrowRight");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/u);
  });
});
