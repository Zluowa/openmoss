// FILE: themeCss.browser.ts
// Purpose: Theme CSS cannot make the browser load a file from another host, and cannot write
//          text, while its safe rules still apply.
// Layer: Web browser test (real Chromium CSS parser, network requests watched by Playwright)
// Origin: extends apps/web/src/themeCss.browser.test.ts from T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8 with a request probe and Moss's
//   extra rules.

import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import { applyThemeCss } from "~/theme/themeCss";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    beginAppThumbnailRequestProbe: (appTitle?: string, readonlyHost?: boolean) => Promise<void>;
    endAppThumbnailRequestProbe: () => Promise<
      { resourceType: string; local: boolean; appFrame: boolean }[]
    >;
  }
}

const SAFE_DATA_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%224%22 height=%224%22%3E%3Crect width=%224%22 height=%224%22 fill=%22%23abc%22/%3E%3C/svg%3E";

function mountProbe(attribute: string, tag = "div"): HTMLElement {
  const element = document.createElement(tag);
  element.setAttribute(attribute, "");
  element.textContent = "probe";
  element.style.width = "40px";
  element.style.height = "40px";
  document.body.append(element);
  return element;
}

/** Give the browser time to start any fetch a style asked for: style, layout, paint. */
async function settle(): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

function keptCssText(): string {
  return document.adoptedStyleSheets
    .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
    .join("\n");
}

const HOSTILE_THEME_CSS = String.raw`
  @import url(https://example.com/sheet.css);
  @namespace svg url(http://www.w3.org/2000/svg);
  @property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://example.com/d); }
  @counter-style leak { system: cyclic; symbols: url(https://example.com/f); }
  @font-face { font-family: "Leak Font"; src: url(https://example.com/font.woff2); }
  @keyframes leak { to { background-image: url(https://example.com/g); } }
  :root { --leak: u\72l(https://example.com/a); --label: "Another product"; }
  [data-theme-css-probe] {
    color: rgb(1, 2, 3);
    background-image: u\72l(https://example.com/b);
    list-style-image: var(--leak);
    border-image-source: var(--registered);
    mask-image: v\61r(--none, u\72l(https://example.com/e));
    font-family: "Leak Font", sans-serif;
    animation: leak 10s infinite;
    @media (min-width: 0px) { cursor: url(https://example.com/c), auto; }
    & span { background-image: url(https://example.com/nested); }
  }
  [data-theme-css-probe-set] { background-image: im\61ge-set("https://example.com/h" 1x); }
  [data-theme-css-probe-padded] { background-image: url("\a0 data:/../../probe-padded"); }
  @supports (display: block) { [data-theme-css-probe-groups] { background-image: url(https://example.com/supports); } }
  @layer theme { [data-theme-css-probe-groups] { border-image-source: url(https://example.com/layer); } }
  @container (min-width: 0px) { [data-theme-css-probe-groups] { list-style-image: url(https://example.com/container); } }
  @scope ([data-theme-css-probe-groups]) { :scope { mask-image: url(https://example.com/scope); } }
  [data-theme-css-probe]::before { content: "Another product"; }
  [data-theme-css-probe]::after { content: var(--label); }
  [data-theme-css-probe-safe] { background-image: url("${SAFE_DATA_IMAGE}"); outline-color: rgb(4, 5, 6); }
  [data-theme-css-probe-safe]::after { content: ""; display: block; width: 4px; height: 4px; }
`;

describe("theme CSS guard", () => {
  afterEach(() => {
    applyThemeCss(undefined);
  });

  it("drops every rule that would load a remote file or write text, and keeps the rest", async () => {
    const probe = mountProbe("data-theme-css-probe");
    probe.append(document.createElement("span"));
    const imageSet = mountProbe("data-theme-css-probe-set");
    const padded = mountProbe("data-theme-css-probe-padded");
    const groups = mountProbe("data-theme-css-probe-groups", "li");
    const safe = mountProbe("data-theme-css-probe-safe");
    // The control: one remote load outside the guard, which the probe must see in the same
    // window. Without it, "no requests" could mean the page had not fetched anything yet.
    const canary = mountProbe("data-theme-css-canary");
    const canaryStyle = document.createElement("style");
    canaryStyle.textContent =
      "[data-theme-css-canary] { background-image: url(https://example.org/canary.png); }";
    try {
      await commands.beginAppThumbnailRequestProbe("no app frame");
      document.head.append(canaryStyle);
      void getComputedStyle(canary).backgroundImage;
      const result = applyThemeCss(HOSTILE_THEME_CSS);
      const style = getComputedStyle(probe);
      // Touch every property that could start a load, then let the page paint.
      void [
        style.backgroundImage,
        style.listStyleImage,
        style.borderImageSource,
        style.maskImage,
        style.cursor,
        getComputedStyle(probe.querySelector("span")!).backgroundImage,
        getComputedStyle(imageSet).backgroundImage,
        getComputedStyle(padded).backgroundImage,
        getComputedStyle(groups).backgroundImage,
      ];
      await settle();
      const requests = await commands.endAppThumbnailRequestProbe();

      // Only the canary reached another host.
      expect(requests.filter((request) => !request.local)).toEqual([
        { resourceType: "image", local: false, appFrame: false },
      ]);
      expect(keptCssText()).not.toContain("example.com");
      expect(keptCssText()).not.toContain("/../../");
      // A custom property may hold a string, but no text property is left to show one.
      expect(keptCssText()).not.toMatch(/(?:content|quotes):[^;]*Another product/);
      expect(result.droppedDeclarations).toBeGreaterThan(0);
      expect(result.droppedRules).toBeGreaterThan(0);

      expect(style.color).toBe("rgb(1, 2, 3)");
      expect(style.backgroundImage).toBe("none");
      expect(style.listStyleImage).toBe("none");
      expect(style.borderImageSource).toBe("none");
      expect(style.maskImage).toBe("none");
      expect(style.cursor).toBe("auto");
      expect(getComputedStyle(imageSet).backgroundImage).toBe("none");
      expect(getComputedStyle(padded).backgroundImage).toBe("none");
      expect(getComputedStyle(groups).backgroundImage).toBe("none");
      expect(getComputedStyle(groups).borderImageSource).toBe("none");
      expect(getComputedStyle(groups).listStyleImage).toBe("none");
      expect(getComputedStyle(groups).maskImage).toBe("none");
      expect(["none", "normal"]).toContain(getComputedStyle(probe, "::before").content);
      expect(["none", "normal"]).toContain(getComputedStyle(probe, "::after").content);

      // The safe rules in the same sheet still apply: data: images and decorative content.
      expect(getComputedStyle(safe).backgroundImage).toContain("data:image/svg+xml");
      expect(getComputedStyle(safe).outlineColor).toBe("rgb(4, 5, 6)");
      expect(getComputedStyle(safe, "::after").content).toBe('""');
    } finally {
      canaryStyle.remove();
      for (const element of [probe, imageSet, padded, groups, safe, canary]) element.remove();
    }
  });

  it("removes the CSS again", () => {
    const probe = mountProbe("data-theme-css-probe");
    try {
      applyThemeCss("[data-theme-css-probe] { color: rgb(7, 8, 9); }");
      expect(getComputedStyle(probe).color).toBe("rgb(7, 8, 9)");
      applyThemeCss(undefined);
      expect(getComputedStyle(probe).color).not.toBe("rgb(7, 8, 9)");
      expect(keptCssText()).not.toContain("data-theme-css-probe");
    } finally {
      probe.remove();
    }
  });
});
