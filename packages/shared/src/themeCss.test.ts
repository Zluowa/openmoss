// Origin: tests from packages/shared/src/themeCss.test.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8, plus Moss's text rule.
import { describe, expect, it } from "vitest";

import {
  MOSS_THEME_GUIDE,
  THEME_CSS_HOOKS,
  THEME_CSS_MAX_LENGTH,
  isMossThemePreset,
  resolveThemeCssImages,
  themeCssImageIds,
  themeCssDeclarationBlocked,
  themeCssLoadsRemoteFiles,
  themeCssUnstableSelectors,
  themeCssValueFetches,
} from "./themeCss";

// %23 decodes to # inside the SVG, so url(%23g) names its own gradient.
const SVG_WITH_OWN_GRADIENT =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3ClinearGradient id=%22g%22/%3E%3Crect fill=%22url(%23g)%22/%3E%3C/svg%3E";

describe("themeCssValueFetches", () => {
  it.each([
    ["remote url()", 'url("https://example.com/a")', true],
    ["unquoted remote url()", "url(https://example.com/a)", true],
    ["same-origin path", 'url("/api/thing")', true],
    ["protocol-relative address", "url(//example.com/a)", true],
    ["image-set()", 'image-set("https://example.com/a" 1x)', true],
    ["src()", 'src("https://example.com/a")', true],
    // An unparsed value keeps its escapes, so an escaped function name hides in it.
    ["escaped url() in a custom property", "u\\72l(https://example.com/a)", true],
    ["escaped image-set()", "im\\61ge-set(var(--leak) 1x)", true],
    ["escaped var() fallback", "v\\61r(--none, u\\72l(https://example.com/a))", true],
    // A no-break space before the scheme makes this a path on the app's own origin.
    ["padded data: address", 'url(" data:/../../probe")', true],
    ["data: image", 'url("data:image/png;base64,AA")', false],
    ["data: SVG naming its own gradient", `url("${SVG_WITH_OWN_GRADIENT}")`, false],
    ["data: address after CSS whitespace", 'url( "data:image/png;base64,AA")', false],
    // The url( sits inside a string, so the address after that string is a real remote url().
    [
      "remote url() after a string that mentions url(",
      `"url('data:" url("https://evil.example/a") "'"`,
      true,
    ],
    ["fragment reference", 'url("#blur")', false],
    ["var()", "var(--pattern)", false],
    ["plain color", "red", false],
  ])("%s", (_name, value, fetches) => {
    expect(themeCssValueFetches(value)).toBe(fetches);
  });
});

describe("themeCssLoadsRemoteFiles", () => {
  it("refuses @import", () => {
    expect(themeCssLoadsRemoteFiles('@import "https://example.com/theme.css";')).toBe(true);
    expect(themeCssLoadsRemoteFiles("@IMPORT url(theme.css);")).toBe(true);
  });

  it("refuses a remote url() and image-set()", () => {
    expect(themeCssLoadsRemoteFiles("body { background: url(https://example.com/a.png); }")).toBe(
      true,
    );
    expect(themeCssLoadsRemoteFiles("body { background: image-set(url(#a) 1x); }")).toBe(true);
  });

  it("ignores what comments say", () => {
    expect(themeCssLoadsRemoteFiles("/* url(https://example.com/a) */ body { color: red; }")).toBe(
      false,
    );
  });

  it("allows a url() inside a data: address", () => {
    expect(
      themeCssLoadsRemoteFiles(`.repro { background-image: url('${SVG_WITH_OWN_GRADIENT}'); }`),
    ).toBe(false);
  });
});

describe("themeCssDeclarationBlocked", () => {
  it.each([
    ["content", '""', false],
    ["content", "''", false],
    ["content", "none", false],
    ["content", "counter(item)", false],
    ["content", '"Another product"', true],
    ["content", "'Sign in again'", true],
    ["content", "var(--label)", true],
    ["content", "attr(title)", true],
    ["content", 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")', true],
    ["content", "linear-gradient(red, blue)", true],
    ["quotes", '"<" ">"', true],
    ["list-style-type", '"> "', true],
    ["list-style-type", "disc", false],
    ["text-overflow", '"..."', true],
    // Strings elsewhere are names, not text on screen.
    ["font-family", '"JetBrains Mono", monospace', false],
    ["grid-template-areas", '"a b"', false],
    // Any rule that loads a file is still dropped, whatever the property.
    ["background-image", "url(https://example.com/a)", true],
    ["--wallpaper", 'url("data:image/png;base64,AA")', false],
  ])("%s: %s", (property, value, blocked) => {
    expect(themeCssDeclarationBlocked(property, value)).toBe(blocked);
  });
});

describe("theme guide", () => {
  it("states the CSS limit and lists every stable selector", () => {
    expect(THEME_CSS_MAX_LENGTH).toBe(50_000);
    expect(MOSS_THEME_GUIDE).toContain("50,000 characters");
    for (const hook of THEME_CSS_HOOKS) expect(MOSS_THEME_GUIDE).toContain(hook.selector);
  });

  it("says where a chat background goes and that saving is not seeing", () => {
    expect(THEME_CSS_HOOKS.map((hook) => hook.selector)).toContain(
      '[data-workspace-area="conversation"]',
    );
    expect(MOSS_THEME_GUIDE).toContain(
      'behind the chat goes on [data-workspace-area="conversation"]',
    );
    expect(MOSS_THEME_GUIDE).toContain("not that every rule shows");
    expect(MOSS_THEME_GUIDE).toContain("terminal text");
    expect(MOSS_THEME_GUIDE).toContain("::-webkit-scrollbar");
  });

  it("knows which appearances a preset has", () => {
    expect(isMossThemePreset("moss", "light")).toBe(true);
    expect(isMossThemePreset("nord", "light")).toBe(false);
    expect(isMossThemePreset("constructor", "dark")).toBe(false);
  });
});

describe("themeCssUnstableSelectors", () => {
  it("accepts rules built from the stable hooks, element names, pseudos and .dark", () => {
    expect(
      themeCssUnstableSelectors(
        [
          '[data-workspace-area="conversation"] { background: url("data:image/png;base64,{x}") }',
          ".dark [data-slot='button']:hover, :root:not(.dark) .chat-markdown p { color: red }",
          "[data-messages-timeline-root]::before { content: '' }",
          "@media (min-width: 40rem) { [data-chat-header] { height: 3rem } }",
          "@keyframes pulse { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }",
          "[data-chat-composer-surface] { & [data-composer-editor] { font-size: 15px } }",
          "/* .not-a-selector { } */ ::-webkit-scrollbar-thumb { background: red }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("names classes, ids, attributes and slots outside the stable list", () => {
    expect(
      themeCssUnstableSelectors(
        [
          ".flex-1 > div, [data-chat-header] { color: red }",
          "#root { color: red }",
          "[data-state=open], [aria-expanded] { color: red }",
          '[data-slot="toast-title"], [data-slot] { color: red }',
          "@media (prefers-reduced-motion) { .animate-spin { animation: none } }",
        ].join("\n"),
      ),
    ).toEqual([
      ".flex-1 > div",
      "#root",
      "[data-state=open]",
      "[aria-expanded]",
      '[data-slot="toast-title"]',
      "[data-slot]",
      ".animate-spin",
    ]);
  });
});

describe("stored theme pictures", () => {
  const id = `${"0123456789abcdef".repeat(4)}.png`;

  it("accepts a reference of the fixed shape, quoted or not", () => {
    for (const value of [
      `url(moss-theme-image:${id})`,
      `url("moss-theme-image:${id}")`,
      `url( 'moss-theme-image:${id}' ) right bottom / auto 80% no-repeat`,
      `url(moss-theme-image:${id}), url("data:image/png;base64,AAAA")`,
    ]) {
      expect(themeCssValueFetches(value), value).toBe(false);
    }
    expect(themeCssLoadsRemoteFiles(`x { background: url(moss-theme-image:${id}) }`)).toBe(false);
    expect(
      themeCssImageIds(`a{b:url(moss-theme-image:${id})} c{d:url("moss-theme-image:${id}")}`),
    ).toEqual([id]);
  });

  it("refuses every other shape, so no host, path or query can ride on it", () => {
    for (const value of [
      `url(moss-theme-image:${id.toUpperCase()})`,
      `url(moss-theme-image:${id.replace(".png", ".svg")})`,
      `url(moss-theme-image:${id}?x=1)`,
      `url(moss-theme-image:${id}#x)`,
      `url(moss-theme-image:${id}/../../x)`,
      `url(moss-theme-image:../${id})`,
      `url(moss-theme-image://example.com/${id})`,
      `url(moss-theme-image:${id.slice(1)})`,
      `url(MOSS-THEME-IMAGE:${id})`,
      `url("moss-theme-image:${id}' )`,
      `url(\\6d oss-theme-image:${id})`,
      `url(moss-theme-image\\3a ${id})`,
      `image-set(url(moss-theme-image:${id}) 1x)`,
      `src(moss-theme-image:${id})`,
      `url(https://example.com/a) url(moss-theme-image:${id})`,
      `url(moss-theme-image:${id}) url(https://example.com/a)`,
      `url( moss-theme-image:${id})`,
    ]) {
      expect(themeCssValueFetches(value), value).toBe(true);
    }
  });

  it("resolves only checked references, to the address the client gives", () => {
    expect(
      resolveThemeCssImages(
        `url("moss-theme-image:${id}") right bottom, url(moss-theme-image:${id})`,
        (found) => `http://127.0.0.1:3773/api/theme-images/${found}?token="x`,
      ),
    ).toBe(
      `url("http://127.0.0.1:3773/api/theme-images/${id}?token=%22x") right bottom, url("http://127.0.0.1:3773/api/theme-images/${id}?token=%22x")`,
    );
    expect(resolveThemeCssImages(`url(moss-theme-image:${id}?x)`, () => "bad")).toBe(
      `url(moss-theme-image:${id}?x)`,
    );
  });

  it("tells the agent to store pictures as files", () => {
    expect(MOSS_THEME_GUIDE).toContain("moss-theme-image:hero");
    expect(MOSS_THEME_GUIDE).toContain("SVG is refused");
    expect(MOSS_THEME_GUIDE).not.toContain("near 30 KB");
  });
});
