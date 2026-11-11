// FILE: buildBrowserFixture.ts
// Purpose: Bundle an Electron e2e renderer fixture with bun while resolving the
// Vite-only `?url` asset imports that the production renderer graph contains.
// Usage: bun e2e/buildBrowserFixture.ts <entry> <outdir> [defineJson]

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const ASSET_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** Vite turns `import x from "./a.svg?url"` into a URL string; a data URL keeps the fixture self-contained. */
const viteUrlImports: import("bun").BunPlugin = {
  name: "vite-url-imports",
  setup(build) {
    build.onResolve({ filter: /\?url$/u }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -"?url".length)),
      namespace: "vite-url",
    }));
    build.onLoad({ filter: /.*/u, namespace: "vite-url" }, (args) => {
      const mimeType =
        ASSET_MIME_TYPES[extname(args.path).toLowerCase()] ?? "application/octet-stream";
      const dataUrl = `data:${mimeType};base64,${readFileSync(args.path).toString("base64")}`;
      return { contents: `export default ${JSON.stringify(dataUrl)};`, loader: "js" };
    });
  },
};

const [entry, outdir, defineJson] = process.argv.slice(2);
if (!entry || !outdir) {
  throw new Error("usage: bun e2e/buildBrowserFixture.ts <entry> <outdir> [defineJson]");
}

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  format: "iife",
  plugins: [viteUrlImports],
  define: defineJson ? (JSON.parse(defineJson) as Record<string, string>) : {},
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
