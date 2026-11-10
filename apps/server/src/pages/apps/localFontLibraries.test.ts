// FILE: localFontLibraries.test.ts
// Purpose: Font version, token, byte and license boundaries.
// Layer: Server app tests

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";
import { PAGE_APP_LOCAL_FONTS } from "./localFontLibraries";
import { preparePageAppLibraries } from "./localLibraries";

const fontUrl = (font: (typeof PAGE_APP_LOCAL_FONTS)[number] = PAGE_APP_LOCAL_FONTS[0]) =>
  `https://cdn.jsdelivr.net/npm/${font.package}@${font.version}/files/${font.filename}`;
const style = (url: string) =>
  `<style>@font-face{font-family:"Fixture";font-weight:100 900;src:url('${url}')}</style>`;

describe("page app local fonts", () => {
  it.each(PAGE_APP_LOCAL_FONTS)(
    "embeds only the exact $package@$version file and ships its OFL",
    async (font) => {
      const html = style(fontUrl(font));
      const result = await preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary);
      expect(result.offlineReady).toBe(true);
      expect(result.html).toContain('font-family:"Fixture";font-weight:100 900;');
      const base64 = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/u.exec(result.html)![1]!;
      expect(createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex")).toBe(
        font.sha256,
      );
      const license = await readFile(
        new URL(
          `../../../../web/public/inline-visualization-libs/${font.license}`,
          import.meta.url,
        ),
        "utf8",
      );
      expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(license).toContain("TERMINATION");
    },
  );

  it.each([
    fontUrl().replace("5.2.8", "5.2.7"),
    `${fontUrl()}?v=1`,
    "https://fonts.googleapis.com/css2?family=Inter",
    "//cdn.example/font.woff2",
  ])("preserves unknown font resources as non-offline: %s", async (url) => {
    const html = style(url);
    const read = vi.fn(async () => null);
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps comments, CSS strings and inert styles byte-identical", async () => {
    const url = fontUrl();
    const html = `<style>/* url('${url}') */ p::after{content:"url('${url}')"}</style><template>${style(url)}</template>`;
    const read = vi.fn(async () => null);
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    'url("https\\3a //cdn.example/font.woff2")',
    "@import 'https\\3a //cdn.example/style.css';",
    'url("unterminated)',
  ])("preserves unsupported CSS URL syntax as non-offline: %s", async (css) => {
    const html = `<style>p{src:${css}}</style>`;
    expect(await preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary)).toEqual({
      html,
      offlineReady: false,
    });
  });

  it.each([
    null,
    { contents: new TextEncoder().encode("invalid font"), contentType: "font/woff2" },
  ])("keeps unavailable or tampered fonts unchanged", async (file) => {
    const html = style(fontUrl());
    expect(await preparePageAppLibraries(html, undefined, async () => file)).toEqual({
      html,
      offlineReady: false,
    });
  });

  it("does not leave a partial font replacement on budget exhaustion", async () => {
    const html = style(fontUrl()).repeat(17);
    expect(await preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary)).toEqual({
      html,
      offlineReady: false,
    });
  });
});
