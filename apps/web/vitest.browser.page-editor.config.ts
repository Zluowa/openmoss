import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

import stableConfig, { PAGE_EDITOR_BROWSER_SPEC } from "./vitest.browser.stable.config";

// Page specs drive the real Canvas Plate editor, which only exists once the pinned Canvas
// bundle is built (`scripts/prepare-moss-canvas-bundle.ts`, CI's Desktop Build job). Serve
// its /canvas/ route from Vite's dev server so the iframe shares Vitest's origin and
// `expect.element(frameLocator)` can inspect `iframe.contentDocument`.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const canvasStaticRoot = resolve(
  process.env.MOSS_CANVAS_STATIC_DIR?.trim() ||
    resolve(repoRoot, "apps/desktop/canvas-bundle/apps/codex-canvas/dist"),
);
if (!existsSync(resolve(canvasStaticRoot, "page-editor.html"))) {
  throw new Error(
    `The Page editor browser specs need the built Canvas bundle; ${canvasStaticRoot} has no page-editor.html. Run scripts/prepare-moss-canvas-bundle.ts or set MOSS_CANVAS_STATIC_DIR.`,
  );
}

const CANVAS_ROUTE_PREFIX = "/canvas/";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type CanvasServerPlugin = NonNullable<ViteUserConfig["plugins"]>[number];

const canvasStaticPlugin: CanvasServerPlugin = {
  name: "moss-page-editor-canvas-static",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://canvas.invalid").pathname;
      if (!pathname.startsWith(CANVAS_ROUTE_PREFIX)) {
        next();
        return;
      }
      const relativePath = normalize(
        decodeURIComponent(pathname.slice(CANVAS_ROUTE_PREFIX.length)) || "index.html",
      );
      const filePath =
        relativePath.startsWith("..") || relativePath.includes("\0") || isAbsolute(relativePath)
          ? null
          : resolve(canvasStaticRoot, relativePath);
      if (
        request.method !== "GET" ||
        filePath === null ||
        !filePath.startsWith(`${canvasStaticRoot}${sep}`) ||
        !existsSync(filePath) ||
        !statSync(filePath).isFile()
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type":
          CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    });
  },
};

const shotsDir = process.env.VITE_MOSS_PAGE_EDITOR_SHOTS?.trim();
const shotsVariant = process.env.VITE_MOSS_PAGE_EDITOR_SHOTS_VARIANT?.trim();

// Merging would concatenate the stable include and exclude globs; this lane owns only Pages.
export default defineConfig({
  ...stableConfig,
  plugins: [...(stableConfig.plugins ?? []), canvasStaticPlugin],
  define: {
    ...stableConfig.define,
    "import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL": JSON.stringify("same-origin"),
    ...(shotsDir
      ? { "import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS": JSON.stringify(shotsDir) }
      : {}),
    ...(shotsVariant
      ? {
          "import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS_VARIANT": JSON.stringify(shotsVariant),
        }
      : {}),
  },
  test: {
    ...stableConfig.test,
    include: [PAGE_EDITOR_BROWSER_SPEC],
    exclude: configDefaults.exclude,
  },
});
