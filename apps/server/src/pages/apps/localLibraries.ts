// FILE: localLibraries.ts
// Purpose: Inline exact, shipped classic libraries without changing the app sandbox.
// Layer: Server pages/apps (derived response only; stored HTML stays unchanged)

import { createHash } from "node:crypto";

import { blankHtmlNonMarkup } from "@moss/shared/htmlMarkup";

import { hasUnknownVisualizationDependency } from "../../inlineVisualization";
import { hasExternalPageAppCssResource, preparePageAppFonts } from "./localFontLibraries";
import { APP_SCRIPT, APP_STYLE, pageAppScriptAttributes } from "./localLibraryHtml";
import { preparePageAppModules } from "./localModuleLibraries";

export const PAGE_APP_LOCAL_LIBRARIES = [
  {
    name: "D3",
    version: "7.9.0",
    asset: "d3.min.js",
    license: "ISC",
    sha256: "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
    urls: [
      "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
      "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.js",
      "https://unpkg.com/d3@7.9.0/dist/d3.min.js",
      "https://unpkg.com/d3@7.9.0/dist/d3.js",
      "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    ],
  },
  {
    name: "Chart.js",
    version: "4.5.1",
    asset: "chart.umd.js",
    license: "MIT",
    sha256: "ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a",
    urls: [
      "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js",
      "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js",
      "https://unpkg.com/chart.js@4.5.1/dist/chart.umd.js",
      "https://unpkg.com/chart.js@4.5.1/dist/chart.umd.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js",
    ],
  },
] as const;

const MAX_INLINED_BYTES = 4 * 1024 * 1024;
const MAX_INLINED_SCRIPTS = 16;
export type PageAppLibraryReader = (
  assetName: string,
  staticDir: string | undefined,
) => Promise<{
  readonly contents: Uint8Array;
  readonly contentType: string;
} | null>;

function hasExternalPageAppResource(html: string): boolean {
  if (hasUnknownVisualizationDependency(blankHtmlNonMarkup(html, ["script"]))) return true;
  // CSS is raw text: a literal <script src=...> inside it is not a resource.
  for (const match of blankHtmlNonMarkup(html, ["style"]).matchAll(APP_STYLE)) {
    if (hasExternalPageAppCssResource(match[1]!)) return true;
  }
  return false;
}

export async function preparePageAppLibraries(
  html: string,
  staticDir: string | undefined,
  readLibrary: PageAppLibraryReader,
): Promise<{ readonly html: string; readonly offlineReady: boolean }> {
  const chunks: string[] = [];
  const cache = new Map<string, string | null>();
  let offset = 0;
  let bytes = 0;
  let count = 0;
  let unresolved = false;
  for (const match of blankHtmlNonMarkup(html, ["script"]).matchAll(APP_SCRIPT)) {
    const attributes = match[1]!;
    const { attributes: parsed, duplicateSource } = pageAppScriptAttributes(attributes);
    const src = parsed.get("src");
    if (!src) continue;
    const url = src.value;
    const library = PAGE_APP_LOCAL_LIBRARIES.find((entry) =>
      entry.urls.some((allowed) => allowed === url),
    );
    const mediaType = (parsed.get("type")?.value ?? "").trim().toLowerCase();
    if (
      !library ||
      duplicateSource ||
      !["", "text/javascript", "application/javascript"].includes(mediaType) ||
      ["async", "defer", "onload", "onerror", "integrity"].some((name) => parsed.has(name)) ||
      count >= MAX_INLINED_SCRIPTS
    ) {
      unresolved = true;
      continue;
    }
    let source = cache.get(library.asset);
    if (source === undefined) {
      const file = await readLibrary(library.asset, staticDir).catch(() => null);
      source =
        file &&
        file.contents.byteLength <= MAX_INLINED_BYTES &&
        createHash("sha256").update(file.contents).digest("hex") === library.sha256
          ? new TextDecoder().decode(file.contents)
          : null;
      cache.set(library.asset, source);
    }
    if (source === null || bytes + Buffer.byteLength(source) > MAX_INLINED_BYTES) {
      unresolved = true;
      continue;
    }
    bytes += Buffer.byteLength(source);
    count += 1;
    // Preserve upstream license comments. Only an inline-inapplicable sourcemap link is removed.
    const script = source
      .replace(/^\/\/#[ \t]*sourceMappingURL=.*$/gmu, "")
      .replace(/<\//gu, "<\\/");
    const keptAttributes = attributes.slice(0, src.start) + attributes.slice(src.end);
    chunks.push(
      html.slice(offset, match.index),
      `<script${keptAttributes} data-moss-local-library="${library.name}@${library.version}">${script}</script>`,
    );
    offset = match.index + match[0].length;
  }
  chunks.push(html.slice(offset));
  const result = chunks.join("");
  const fonts = await preparePageAppFonts(result, staticDir, readLibrary);
  const modules = fonts.failed
    ? null
    : await preparePageAppModules(fonts.html, staticDir, readLibrary);
  // Never return a partially localized response when this resource group fails.
  if (
    !modules ||
    modules.failed ||
    Buffer.byteLength(modules.html) - Buffer.byteLength(html) > MAX_INLINED_BYTES
  ) {
    return { html, offlineReady: false };
  }
  return {
    html: modules.html,
    offlineReady: !unresolved && !hasExternalPageAppResource(modules.dependencyHtml),
  };
}
