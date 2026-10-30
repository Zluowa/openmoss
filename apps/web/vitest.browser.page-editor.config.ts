import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

import stableConfig, { PAGE_EDITOR_BROWSER_SPEC } from "./vitest.browser.stable.config";

// Page specs drive the real Canvas Plate editor, which only exists once the pinned Canvas
// bundle is built (`scripts/prepare-moss-canvas-bundle.ts`, CI's Desktop Build job). Serve
// its /canvas/ route the way the Moss server does and point the specs at that origin.
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

const canvasServer = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://canvas.invalid").pathname;
  const relativePath = pathname.startsWith(CANVAS_ROUTE_PREFIX)
    ? normalize(decodeURIComponent(pathname.slice(CANVAS_ROUTE_PREFIX.length)) || "index.html")
    : null;
  const filePath =
    relativePath === null ||
    relativePath.startsWith("..") ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath)
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
    "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
});
await new Promise<void>((ready) => canvasServer.listen(0, "127.0.0.1", ready));
// The server lives exactly as long as this Vitest process.
canvasServer.unref();
const { port } = canvasServer.address() as AddressInfo;

// Merging would concatenate the stable include and exclude globs; this lane owns only Pages.
export default defineConfig({
  ...stableConfig,
  define: {
    ...stableConfig.define,
    "import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL": JSON.stringify(`ws://127.0.0.1:${port}`),
  },
  test: {
    ...stableConfig.test,
    include: [PAGE_EDITOR_BROWSER_SPEC],
    exclude: configDefaults.exclude,
  },
});
