// Origin: tests from packages/shared/src/themeCss.test.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8, plus Moss's text rule.
import { describe, expect, it } from "vitest";

import {
  MOSS_THEME_GUIDE,
  THEME_CSS_HOOKS,
  THEME_CSS_MAX_LENGTH,
  isMossThemePreset,
  themeCssDeclarationBlocked,
  themeCssLoadsRemoteFiles,
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

  it("knows which appearances a preset has", () => {
    expect(isMossThemePreset("moss", "light")).toBe(true);
    expect(isMossThemePreset("nord", "light")).toBe(false);
    expect(isMossThemePreset("constructor", "dark")).toBe(false);
  });
});
