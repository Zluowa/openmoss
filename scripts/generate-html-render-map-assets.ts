// FILE: generate-html-render-map-assets.ts
// Purpose: Regenerate packages/shared/src/htmlRenderMapAssets.generated.ts, the map
//          libraries Moss ships inside html_render pages instead of loading them from a
//          script CDN (unreachable from much of mainland China).
// Run: bun scripts/generate-html-render-map-assets.ts <leaflet> <maplibre-gl> <maplibre-gl-leaflet>
//      Each argument is the `package` folder of the npm tarball, unpacked
//      (`npm pack leaflet@1.9.4 maplibre-gl@5.24.0 @maplibre/maplibre-gl-leaflet@0.1.4`;
//      npm checks each tarball against the registry's integrity hash).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED = {
  leaflet: "1.9.4",
  "maplibre-gl": "5.24.0",
  "@maplibre/maplibre-gl-leaflet": "0.1.4",
} as const;

const [leafletDir, maplibreDir, bindingDir] = process.argv.slice(2);
if (!leafletDir || !maplibreDir || !bindingDir) {
  throw new Error(
    "Usage: bun scripts/generate-html-render-map-assets.ts <leaflet> <maplibre-gl> <maplibre-gl-leaflet>",
  );
}

function checkedPackage(dir: string, name: keyof typeof EXPECTED): void {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== name || manifest.version !== EXPECTED[name]) {
    throw new Error(
      `${dir} holds ${manifest.name}@${manifest.version}, not ${name}@${EXPECTED[name]}.`,
    );
  }
}

/**
 * The file as one inline <script> or <style> body: no source map comment (the map
 * is not shipped) and no closing tag that would end the element early.
 */
function inlineBody(path: string, kind: "script" | "style"): string {
  const text = readFileSync(path, "utf8")
    .replace(/\n?\/[/*]# sourceMappingURL=[^\n]*\s*$/u, "\n")
    .trim();
  return text.replaceAll(new RegExp(`</(${kind})`, "giu"), "<\\/$1");
}

checkedPackage(leafletDir, "leaflet");
checkedPackage(maplibreDir, "maplibre-gl");
checkedPackage(bindingDir, "@maplibre/maplibre-gl-leaflet");

const assets = {
  LEAFLET_JS: inlineBody(join(leafletDir, "dist", "leaflet.js"), "script"),
  LEAFLET_CSS: inlineBody(join(leafletDir, "dist", "leaflet.css"), "style"),
  MAPLIBRE_GL_JS: inlineBody(join(maplibreDir, "dist", "maplibre-gl.js"), "script"),
  MAPLIBRE_GL_CSS: inlineBody(join(maplibreDir, "dist", "maplibre-gl.css"), "style"),
  MAPLIBRE_GL_LEAFLET_JS: inlineBody(join(bindingDir, "leaflet-maplibre-gl.js"), "script"),
};

const OUTPUT_PATH = new URL(
  "../packages/shared/src/htmlRenderMapAssets.generated.ts",
  import.meta.url,
);
const moduleText = `// FILE: htmlRenderMapAssets.generated.ts
// GENERATED FILE — do not edit by hand.
// Regenerate: bun scripts/generate-html-render-map-assets.ts <leaflet> <maplibre-gl> <maplibre-gl-leaflet>
// The map libraries Moss inlines into html_render pages that draw a map (see
// htmlRenderMaps.ts), unchanged from their npm releases apart from the dropped
// source map comments. Licenses are in THIRD_PARTY_NOTICES.md:
//   leaflet@${EXPECTED.leaflet} (BSD-2-Clause): dist/leaflet.js, dist/leaflet.css
//   maplibre-gl@${EXPECTED["maplibre-gl"]} (BSD-3-Clause): dist/maplibre-gl.js, dist/maplibre-gl.css
//   @maplibre/maplibre-gl-leaflet@${EXPECTED["@maplibre/maplibre-gl-leaflet"]} (ISC): leaflet-maplibre-gl.js

export const HTML_RENDER_MAP_LIBRARY_VERSIONS = ${JSON.stringify(EXPECTED)} as const;

${Object.entries(assets)
  .map(([name, body]) => `export const ${name} = ${JSON.stringify(body)};`)
  .join("\n\n")}
`;

writeFileSync(OUTPUT_PATH, moduleText);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = fileURLToPath(OUTPUT_PATH);
const formatterPath = createRequire(import.meta.url).resolve("oxfmt/bin/oxfmt");
execFileSync(process.execPath, [formatterPath, outputPath], { cwd: repoRoot, stdio: "inherit" });
console.log(`wrote ${outputPath} (${moduleText.length} chars)`);
