import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "light", variables: {} }),
}));
vi.mock("~/hooks/useHtmlRenderShortcutPolicy", () => ({
  useHtmlRenderShortcutPolicy: () => ({ shortcuts: [], blocked: [] }),
}));

import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";
import { HtmlRenderDocument } from "./HtmlRenderDocument";

describe("SandboxedHtmlDocument", () => {
  it("uses T3's opaque inline sandbox without popup or same-origin privileges", () => {
    const markup = renderToStaticMarkup(<SandboxedHtmlDocument src="/frame" title="Chart" />);
    expect(markup).toContain('sandbox="allow-scripts allow-forms"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-popups");
  });

  it("allows forms and popups for a generic HTML document in a panel", () => {
    const markup = renderToStaticMarkup(
      <SandboxedHtmlDocument
        src="/frame"
        title="Chart"
        sandbox="allow-scripts allow-forms allow-popups"
      />,
    );
    expect(markup).toContain('sandbox="allow-scripts allow-forms allow-popups"');
    expect(markup).not.toContain("allow-same-origin");
  });

  it("is the exact renderer used by legacy T3 html_render pages", () => {
    expect(HtmlRenderDocument).toBe(SandboxedHtmlDocument);
  });
});
