// FILE: localFontLibraries.ts
// Purpose: Embed only exact shipped Fontsource files in active CSS URL tokens.
// Layer: Server pages/apps (no remote CSS fetch or family substitution)

import { createHash } from "node:crypto";

import { blankHtmlNonMarkup } from "@moss/shared/htmlMarkup";

import type { PageAppLibraryReader } from "./localLibraries";
import { APP_STYLE } from "./localLibraryHtml";

export const PAGE_APP_LOCAL_FONTS = [
  {
    package: "@fontsource-variable/inter",
    version: "5.2.8",
    asset: "inter-latin.woff2",
    filename: "inter-latin-wght-normal.woff2",
    sha256: "3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62",
    license: "inter.OFL.txt",
  },
  {
    package: "@fontsource-variable/jetbrains-mono",
    version: "5.2.8",
    asset: "jetbrains-mono-latin.woff2",
    filename: "jetbrains-mono-latin-wght-normal.woff2",
    sha256: "18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e",
    license: "jetbrains-mono.OFL.txt",
  },
] as const;
// Consume comments and CSS strings before looking for real URL tokens. Escaped
// URLs and nested constructs deliberately stay as authored and non-offline.
const CSS_TOKEN =
  /\/\*[\s\S]*?(?:\*\/|$)|@import\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![\w-])url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^()]*?))\s*\)/giu;

export function hasExternalPageAppCssResource(css: string): boolean {
  for (const token of css.matchAll(CSS_TOKEN)) {
    const url = token[1] ?? token[2] ?? token[3] ?? token[4] ?? token[5];
    if (
      url &&
      (url.includes("\\") ||
        /^(?:https?:)?\/\//iu.test(url) ||
        (token[5] !== undefined && /[\s"']/u.test(url)))
    )
      return true;
  }
  return false;
}

export async function preparePageAppFonts(
  html: string,
  staticDir: string | undefined,
  read: PageAppLibraryReader,
): Promise<{ html: string; failed: boolean }> {
  const chunks: string[] = [];
  const cache = new Map<string, string>();
  let at = 0;
  let count = 0;
  try {
    for (const block of blankHtmlNonMarkup(html, ["style"]).matchAll(APP_STYLE)) {
      const css = block[1]!;
      const cssStart =
        block.index + block[0].length - /<\/style\s*>$/iu.exec(block[0])![0].length - css.length;
      for (const token of css.matchAll(CSS_TOKEN)) {
        const url = token[3] ?? token[4] ?? token[5];
        if (!url) continue;
        const font = PAGE_APP_LOCAL_FONTS.find((entry) =>
          ["https://cdn.jsdelivr.net/npm/", "https://unpkg.com/"].some(
            (base) => url === `${base}${entry.package}@${entry.version}/files/${entry.filename}`,
          ),
        );
        if (!font) continue;
        if (++count > 16) return { html, failed: true };
        let data = cache.get(font.asset);
        if (!data) {
          const file = await read(font.asset, staticDir);
          if (
            !file ||
            file.contents.byteLength > 128 * 1024 ||
            createHash("sha256").update(file.contents).digest("hex") !== font.sha256
          )
            return { html, failed: true };
          data = `data:font/woff2;base64,${Buffer.from(file.contents).toString("base64")}`;
          cache.set(font.asset, data);
        }
        const start = cssStart + token.index;
        chunks.push(html.slice(at, start), `url("${data}")`);
        at = start + token[0].length;
      }
    }
    chunks.push(html.slice(at));
    return { html: chunks.join(""), failed: false };
  } catch {
    return { html, failed: true };
  }
}
