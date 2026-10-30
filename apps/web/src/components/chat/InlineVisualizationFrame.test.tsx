import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "~/localization";

function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>);
}

import {
  INLINE_VISUALIZATION_FRAME_CLASS,
  InlineVisualizationFrame,
} from "./InlineVisualizationFrame";

describe("InlineVisualizationFrame", () => {
  it("uses a clear unavailable fallback with a collapsible source instead of exposing a raw marker", () => {
    const markup = renderToStaticMarkup(
      <InlineVisualizationFrame
        threadId="thread-1"
        directive={{ source: 'visualize{"path":"/missing.html"}', mode: "wide" }}
      />,
    );
    expect(markup).toContain("此设备上无法加载可视化内容。");
    expect(markup).toContain("显示源代码");
    expect(markup).toContain('data-inline-visualization-state="unavailable"');
  });

  it("keeps the ready visualization document borderless like T3's frame", () => {
    expect(INLINE_VISUALIZATION_FRAME_CLASS).toBe(
      "group/html-render relative my-2 overflow-hidden",
    );
    expect(INLINE_VISUALIZATION_FRAME_CLASS).not.toMatch(/(?:^|\s)border(?:\s|$)/u);
    expect(INLINE_VISUALIZATION_FRAME_CLASS).not.toMatch(/(?:^|\s)bg-background(?:\s|$)/u);
  });
});
