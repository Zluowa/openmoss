import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope } from "~/localization";

function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>);
}

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "light", variables: {} }),
}));

import { HtmlRenderPreviewPane } from "./HtmlRenderPreviewPane";

describe("HtmlRenderPreviewPane", () => {
  it("keeps source and save controls in the attachment-style panel chrome", () => {
    const markup = renderToStaticMarkup(
      <HtmlRenderPreviewPane
        threadId="thread-1"
        document={{ kind: "html-render", attachmentId: "attachment-1", title: "Revenue chart" }}
      />,
    );

    expect(markup).toContain('data-html-render-preview-header="true"');
    expect(markup).toContain('aria-label="显示源代码"');
    expect(markup).toContain('aria-label="保存可视化回复"');
    expect(markup).toContain("Revenue chart");
  });
});
