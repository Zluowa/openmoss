// FILE: localModuleLibraries.ts
// Purpose: Resolve exact shipped modules before execution without widening CSP.
// Layer: Server pages/apps (derived response only)

import { createHash } from "node:crypto";

import { blankHtmlNonMarkup } from "@moss/shared/htmlMarkup";

import type { PageAppLibraryReader } from "./localLibraries";
import { APP_SCRIPT, pageAppScriptAttributes } from "./localLibraryHtml";
import { init, parse } from "./vendor/moduleLexer";

export const PAGE_APP_LOCAL_MODULES = [
  {
    asset: "d3.esm.js",
    sha256: "786182832481e4b21013420e1ae2c3b67e20b193bea5329323d0b806946c942e",
    urls: ["https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm"],
  },
  {
    asset: "chart.esm.js",
    sha256: "2ec7bb601389d7bb2477e1ae28990f94c9c49fd4a0265cbd6124da183be1ee28",
    urls: ["https://cdn.jsdelivr.net/npm/chart.js@4.5.1/+esm"],
  },
  {
    asset: "three.module.js",
    sha256: "d835eab0b3bca3fdfd51e2ce7d06911f4a089b08db73cc3cd70fe5e3005a623f",
    urls: [
      "https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js",
      "https://unpkg.com/three@0.182.0/build/three.module.js",
    ],
  },
] as const;
const CORE = {
  asset: "three.core.js",
  sha256: "283be43b2229e15f46dac84cd19354ede5f06cac7ffb185e765cfcfb2c1eec90",
};
const MAX_MODULE_BYTES = 3 * 1024 * 1024;
const MAX_MODULE_SCRIPTS = 16;

interface LocalModule {
  readonly urls: readonly string[];
  readonly source: string;
  readonly core?: string;
}

/** All URLs are created before the single import map is inserted. */
export function buildPageAppModuleBootstrap(modules: readonly LocalModule[]): string {
  const payload = JSON.stringify(modules).replace(/</gu, "\\u003c");
  return `<script data-moss-local-modules>(function(){
    const anchor=document.currentScript,urls=[];let map;
    const cleanup=function(){if(map)map.remove();for(const url of urls)URL.revokeObjectURL(url);urls.length=0;removeEventListener("pagehide",cleanup);};
    const make=function(source){const url=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));urls.push(url);return url;};
    try{
      addEventListener("pagehide",cleanup,{once:true});
      const imports=Object.create(null);
      for(const entry of ${payload}){
        const core=entry.core?make(entry.core):null;
        const source=core?entry.source.replaceAll("from './three.core.js'","from "+JSON.stringify(core)):entry.source;
        const url=make(source);for(const name of entry.urls)imports[name]=url;
      }
      map=document.createElement("script");map.type="importmap";map.textContent=JSON.stringify({imports});anchor.before(map);
    }catch(_){cleanup();}
  })();</script>`;
}

export async function preparePageAppModules(
  html: string,
  staticDir: string | undefined,
  read: PageAppLibraryReader,
): Promise<{ html: string; dependencyHtml: string; failed: boolean }> {
  const unchanged = { html, dependencyHtml: html, failed: true };
  const scripts = Array.from(blankHtmlNonMarkup(html, ["script"]).matchAll(APP_SCRIPT));
  const requested = new Map<(typeof PAGE_APP_LOCAL_MODULES)[number], Set<string>>();
  const moduleRanges: Array<{ start: number; end: number }> = [];
  let moduleCount = 0;
  let hasImportMap = false;
  try {
    await init();
    for (const match of scripts) {
      const { attributes } = pageAppScriptAttributes(match[1]!);
      const type = (attributes.get("type")?.value ?? "").trim().toLowerCase();
      if (type === "importmap") hasImportMap = true;
      if (type !== "module") continue;
      if (
        ++moduleCount > MAX_MODULE_SCRIPTS ||
        attributes.has("src") ||
        attributes.has("async") ||
        attributes.has("integrity")
      )
        return unchanged;
      const body = match[2]!;
      const [imports] = parse(body);
      for (const specifier of imports) {
        // Only literal, static imports/reexports with no attributes. Strings,
        // comments and import.meta cannot accidentally become replacements.
        if (
          specifier.d !== -1 ||
          specifier.t !== 1 ||
          specifier.a !== -1 ||
          !specifier.n ||
          body.slice(specifier.s, specifier.e) !== specifier.n
        )
          return unchanged;
        const library = PAGE_APP_LOCAL_MODULES.find((entry) =>
          entry.urls.some((url) => url === specifier.n),
        );
        if (!library) return unchanged;
        const urls = requested.get(library) ?? new Set<string>();
        urls.add(specifier.n);
        requested.set(library, urls);
      }
      moduleRanges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (hasImportMap) return unchanged;
    const modules: LocalModule[] = [];
    let bytes = 0;
    const readSource = async (asset: { asset: string; sha256: string }) => {
      const file = await read(asset.asset, staticDir);
      if (
        !file ||
        file.contents.byteLength > MAX_MODULE_BYTES ||
        createHash("sha256").update(file.contents).digest("hex") !== asset.sha256
      )
        throw new Error("Unavailable module");
      bytes += file.contents.byteLength;
      if (bytes > MAX_MODULE_BYTES) throw new Error("Module budget exceeded");
      return new TextDecoder().decode(file.contents);
    };
    for (const [library, urls] of requested) {
      const source = await readSource(library);
      const core = library.asset === "three.module.js" ? await readSource(CORE) : undefined;
      if (core && source.split("from './three.core.js'").length !== 3) return unchanged;
      modules.push({ urls: [...urls], source, ...(core ? { core } : {}) });
    }
    // Availability covers declared imports, not arbitrary runtime URL creation
    // or fetch calls (the latter still face the unchanged connect-src policy).
    const dependencyParts: string[] = [];
    let at = 0;
    for (const range of moduleRanges) {
      dependencyParts.push(html.slice(at, range.start), " ".repeat(range.end - range.start));
      at = range.end;
    }
    dependencyParts.push(html.slice(at));
    if (!modules.length) return { html, dependencyHtml: dependencyParts.join(""), failed: false };
    const bootstrap = buildPageAppModuleBootstrap(modules);
    // Before every app script, including classic scripts that may start imports.
    const insertAt = scripts[0]!.index;
    return {
      html: html.slice(0, insertAt) + bootstrap + html.slice(insertAt),
      dependencyHtml: dependencyParts.join(""),
      failed: false,
    };
  } catch {
    return unchanged;
  }
}
