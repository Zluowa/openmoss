// FILE: vite.config.ts
// Purpose: Builds the Moss web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import { createHash } from "node:crypto";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import pkg from "./package.json" with { type: "json" };
import { listFiles, pruneProductionIcons } from "./scripts/production-assets";
import { compressCacheFromEnv } from "./scripts/production-assets-compress-cache";
import {
  createTransformCache,
  normalizeTransformCachePath,
  transformCacheDirFromEnv,
  transformFingerprint,
} from "./scripts/production-assets-transform-cache";
import { testQuarantine } from "../../tools/test-quarantine/vitest";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.MOSS_WEB_SOURCEMAP?.trim().toLowerCase();
const webRoot = process.cwd();
const workspaceRoot = path.resolve(webRoot, "../..");
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT?.trim();
const sentryRelease = process.env.SENTRY_RELEASE?.trim() || `moss-web@${pkg.version}`;
const sentryUploadEnabled = Boolean(sentryAuthToken && sentryOrg && sentryProject);
// Do not even instantiate the Sentry bundler plugin for the dev server. Vite
// filters `apply: "build"` hooks, but the plugin still participates in config
// hashing and dependency optimization when it is present, which can make a
// cold Electron start spend minutes in Rolldown before serving the renderer.
const isViteBuildCommand =
  process.env.npm_lifecycle_event === "build" ||
  process.argv.some((argument) => argument === "build");

function resolveExistingRealPath(targetPath: string): string | null {
  try {
    return fsSync.realpathSync(targetPath);
  } catch {
    return null;
  }
}

const devServerFsAllow = [
  webRoot,
  path.resolve(webRoot, ".."),
  workspaceRoot,
  resolveExistingRealPath(path.join(webRoot, "node_modules")),
  resolveExistingRealPath(path.join(workspaceRoot, "node_modules")),
].filter(
  (value, index, values): value is string =>
    typeof value === "string" && values.indexOf(value) === index,
);

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : sentryUploadEnabled
        ? "hidden"
        : false;

const sentryPlugins =
  sentryUploadEnabled && isViteBuildCommand
    ? sentryVitePlugin({
        authToken: sentryAuthToken!,
        org: sentryOrg!,
        project: sentryProject!,
        telemetry: false,
        // Hidden maps exist only for the upload. Left in dist they would ship in the app.
        sourcemaps: {
          filesToDeleteAfterUpload: ["./dist/**/*.map"],
        },
        release: {
          name: sentryRelease,
          inject: true,
        },
      }).map((plugin) => ({ ...plugin, apply: "build" as const }))
    : [];

// input-otp's ESM bundle uses namespace imports for React. Rolldown's browser
// dependency proxy exposes React's CommonJS module through a default export,
// so the namespace has no `createContext`/hooks at runtime. Keep the upstream
// package (and its edge-case handling) while adapting only this module at the
// Vite transform boundary.
function inputOtpReactInteropPlugin(): Plugin {
  const inputOtpEntryPattern = /[\\/]input-otp[\\/]dist[\\/]index\.mjs$/u;
  const reactNamespaceImportPattern = /import\s*\*\s*as\s+([\w$]+)\s+from\s*["']react["']/gu;
  return {
    name: "moss-input-otp-react-interop",
    enforce: "pre",
    transform(code, id) {
      if (!inputOtpEntryPattern.test(id)) return null;
      const transformed = code.replace(
        reactNamespaceImportPattern,
        (_match, binding: string) => `import ${binding} from "react"`,
      );
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}

// Prune before compression. closeBundle hooks are parallel by default;
// enforce: "post" alone does not make the asynchronous compression hook wait.
function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "moss-central-icon-prune",
    apply: "build",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        await pruneProductionIcons(path.join(resolvedRoot, "public"), resolvedOutDir, [
          path.join(resolvedRoot, "src"),
          path.resolve(resolvedRoot, "../../packages/contracts/src"),
          path.resolve(resolvedRoot, "../../packages/shared/src"),
        ]);
        // MSW is used by the dev-served browser tests, never the production app.
        await Promise.all(
          ["", ".gz", ".br"].map((suffix) =>
            fs.rm(path.join(resolvedOutDir, `mockServiceWorker.js${suffix}`), { force: true }),
          ),
        );
      },
    },
  };
}

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".map"]);
// Below this size, compression savings don't beat the extra header bytes and
// the sidecar file overhead.
const PRECOMPRESS_MIN_BYTES = 1024;
// Brotli quality 6 + gzip level 6 is ~500x faster than max-quality brotli
// (sub-second vs ~2 minutes on large chunks) with <1 MB total delta across
// all 1,100+ static assets. Both remain overridable for release experiments.
const DEFAULT_PRECOMPRESS_CONCURRENCY = 4;
const DEFAULT_PRECOMPRESS_BROTLI_QUALITY = 6;
const DEFAULT_PRECOMPRESS_GZIP_LEVEL = 6;

function resolvePrecompressInt(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function resolvePrecompressConcurrency(): number {
  return resolvePrecompressInt(
    "MOSS_WEB_PRECOMPRESS_CONCURRENCY",
    DEFAULT_PRECOMPRESS_CONCURRENCY,
    1,
    16,
  );
}

function resolvePrecompressBrotliQuality(): number {
  return resolvePrecompressInt(
    "MOSS_WEB_PRECOMPRESS_BROTLI_QUALITY",
    DEFAULT_PRECOMPRESS_BROTLI_QUALITY,
    zlib.constants.BROTLI_MIN_QUALITY,
    zlib.constants.BROTLI_MAX_QUALITY,
  );
}

function resolvePrecompressGzipLevel(): number {
  return resolvePrecompressInt(
    "MOSS_WEB_PRECOMPRESS_GZIP_LEVEL",
    DEFAULT_PRECOMPRESS_GZIP_LEVEL,
    zlib.constants.Z_BEST_SPEED,
    zlib.constants.Z_BEST_COMPRESSION,
  );
}

// Emits .gz and .br sidecars next to compressible build outputs so the server
// can serve precompressed bytes by Accept-Encoding instead of compressing on
// the request path (apps/server/src/http.ts static route).
function precompressPlugin(): Plugin {
  let resolvedOutDir = "dist";
  return {
    name: "moss-precompress",
    apply: "build",
    // Run after central-icon pruning so removed files don't get sidecars.
    enforce: "post",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      // Opt-in (the desktop fast refresh): reuse sidecars of unchanged files by content hash.
      const cache = compressCacheFromEnv();
      const files = (await listFiles(resolvedOutDir)).filter((file) =>
        PRECOMPRESS_EXTENSIONS.has(path.extname(file)),
      );
      // A sidecar whose source shrank below threshold or stopped compressing
      // smaller must be removed, not just skipped: emptyOutDir protects full
      // builds, but partial/watch builds would otherwise serve a stale
      // compressed body under a current filename.
      const removeStale = (sidecarPath: string) => fs.rm(sidecarPath, { force: true });
      // Write to a temp file and rename: a watch-build server reading a
      // sidecar mid-write would otherwise get a truncated compressed stream.
      // Rename is atomic within a directory, so readers see either the old
      // sidecar or the complete new one.
      let tempSequence = 0;
      const writeSidecarAtomically = async (sidecarPath: string, data: Buffer) => {
        // Unique per write so concurrent builds against one outDir cannot
        // clobber each other's staging file.
        tempSequence += 1;
        const tempPath = `${sidecarPath}.${process.pid}.${tempSequence}.tmp`;
        await fs.writeFile(tempPath, data);
        await fs.rename(tempPath, sidecarPath);
      };
      let sidecarCount = 0;
      const precompressConcurrency = resolvePrecompressConcurrency();
      const configuredBrotliQuality = resolvePrecompressBrotliQuality();
      const gzipLevel = resolvePrecompressGzipLevel();
      for (let start = 0; start < files.length; start += precompressConcurrency) {
        const batch = files.slice(start, start + precompressConcurrency);
        await Promise.all(
          batch.map(async (file) => {
            const source = await fs.readFile(file);
            if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
              await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
              return;
            }
            const brotliQuality =
              source.byteLength < 16 * 1024
                ? Math.min(configuredBrotliQuality, 9)
                : configuredBrotliQuality;
            const runGzip = () => gzip(source, { level: gzipLevel });
            const runBrotli = () =>
              brotliCompress(source, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
                },
              });
            const [gzipped, brotlied] = await Promise.all(
              cache
                ? [
                    cache.compress("gz", source, `level=${gzipLevel}`, runGzip),
                    cache.compress(
                      "br",
                      source,
                      `quality=${brotliQuality};size=${source.byteLength}`,
                      runBrotli,
                    ),
                  ]
                : [runGzip(), runBrotli()],
            );
            await Promise.all([
              gzipped.byteLength < source.byteLength
                ? writeSidecarAtomically(`${file}.gz`, gzipped)
                : removeStale(`${file}.gz`),
              brotlied.byteLength < source.byteLength
                ? writeSidecarAtomically(`${file}.br`, brotlied)
                : removeStale(`${file}.br`),
            ]);
            sidecarCount += 1;
          }),
        );
      }
      console.info(`[precompress] emitted gzip+brotli sidecars for ${sidecarCount} files.`);
      if (cache) {
        const pruned = await cache.prune();
        console.info(
          `[precompress] cache ${cache.dir}: ${cache.stats.hits} reused, ${cache.stats.misses} compressed, ${pruned} stale removed.`,
        );
      }
    },
  };
}

type TransformHandler = (
  this: { environment?: { name: string } },
  code: string,
  id: string,
  options?: { moduleType?: string },
) => Promise<unknown>;

/**
 * Opt-in (MOSS_WEB_TRANSFORM_CACHE, set by the desktop fast refresh): serves the React Compiler's
 * Babel result for a module whose source, id and transform fingerprint were seen before
 * (scripts/production-assets-transform-cache.ts). Without the variable the plugin is unchanged.
 */
function cacheCompilerTransform<P extends Plugin>(plugin: P): P {
  const dir = transformCacheDirFromEnv();
  const transform = plugin.transform as { handler?: TransformHandler } | undefined;
  if (!dir || !transform || typeof transform.handler !== "function") return plugin;
  const inner = transform.handler;
  let cache: ReturnType<typeof createTransformCache> | undefined;
  let root = process.cwd();
  // Each tool resolved from where it is used: the store path names its version.
  const resolveFrom = (from: string, name: string): string | undefined => {
    try {
      return fsSync.realpathSync(createRequire(from).resolve(name));
    } catch {
      return undefined;
    }
  };
  const open = () => {
    const rawWorkspaceRoot = path.resolve(root, "../..");
    const workspaceRoots = [rawWorkspaceRoot];
    try {
      const realWorkspaceRoot = fsSync.realpathSync(rawWorkspaceRoot);
      if (realWorkspaceRoot !== rawWorkspaceRoot) workspaceRoots.unshift(realWorkspaceRoot);
    } catch {
      // Keep resolved workspace root when realpath is unavailable.
    }
    const app = path.join(root, "package.json");
    const pluginBabel = resolveFrom(app, "@rolldown/plugin-babel");
    const pluginReact = resolveFrom(app, "@vitejs/plugin-react");
    const parts = [
      pluginBabel,
      pluginReact,
      pluginBabel && resolveFrom(pluginBabel, "@babel/core"),
      pluginReact && resolveFrom(pluginReact, "babel-plugin-react-compiler"),
      resolveFrom(app, "babel-plugin-react-compiler"),
    ];
    const configFile = path.join(root, "vite.config.ts");
    if (parts.some((part) => !part) || !fsSync.existsSync(configFile)) {
      console.warn("[transform-cache] could not fingerprint the compiler; cache off");
      return undefined;
    }
    return {
      workspaceRoots,
      cache: createTransformCache(
        dir,
        transformFingerprint([
          ...(parts as string[]).map((part) => normalizeTransformCachePath(part, workspaceRoots)),
          createHash("sha256").update(fsSync.readFileSync(configFile)).digest("hex"),
          `NODE_ENV=${process.env.NODE_ENV ?? ""}`,
          `BABEL_ENV=${process.env.BABEL_ENV ?? ""}`,
          `MOSS_WEB_SOURCEMAP=${process.env.MOSS_WEB_SOURCEMAP ?? ""}`,
        ]),
      ),
    };
  };
  let opened = false;
  let workspaceRoots: ReadonlyArray<string> = [workspaceRoot];
  transform.handler = async function (code, id, options) {
    if (!opened) {
      opened = true;
      const openedCache = open();
      if (openedCache) {
        cache = openedCache.cache;
        workspaceRoots = openedCache.workspaceRoots;
      }
    }
    if (!cache) return inner.call(this, code, id, options);
    return cache.transform(
      {
        id: normalizeTransformCachePath(id, workspaceRoots),
        code,
        moduleType: options?.moduleType ?? "js",
        environment: this.environment?.name ?? "",
      },
      () => inner.call(this, code, id, options) as never,
    );
  };
  const configResolved = plugin.configResolved;
  return {
    ...plugin,
    configResolved(this: unknown, config: { root: string }) {
      root = config.root;
      return typeof configResolved === "function"
        ? (configResolved as (this: unknown, c: unknown) => unknown).call(this, config)
        : undefined;
    },
    async buildEnd(error?: Error) {
      if (!cache || error) return;
      const removed = await cache.prune();
      console.info(
        `[transform-cache] ${cache.dir}: ${cache.stats.hits} reused, ${cache.stats.misses} compiled, ${removed} stale removed.`,
      );
    },
  } as P;
}

// The React Compiler stays build-only in the app (dev keeps fast Oxc reloads);
// the browser test harness drops it through vitest.browser.config's
// withoutVitePlugin filter, which is why it must be one shared object.
// @rolldown/plugin-babel is async (it resolves to the real plugin), so the
// shared object is the promise itself; the resolved plugin and the promise both
// carry `apply: "build"` so identity and shape checks see one consistent value.
export const reactCompilerPlugin: PluginOption & { apply: "build" } = Object.assign(
  babel({
    // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
    // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
    // whereas the previous version of the plugin parsed all files with a .ts extension.
    // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset()],
  }).then((plugin) => ({ ...cacheCompilerTransform(plugin as Plugin), apply: "build" as const })),
  { apply: "build" as const },
);

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    inputOtpReactInteropPlugin(),
    react(),
    reactCompilerPlugin,
    tailwindcss(),
    centralIconPrunePlugin(),
    precompressPlugin(),
    // The Sentry bundler plugin is explicitly build-only. Keeping it in the
    // exported object preserves config identity for unit/browser consumers;
    // Vite filters the plugin before dev-server hooks run.
    ...sentryPlugins,
    // Vitest-only (it has just a configureVitest hook): applies test-quarantine.json to the web
    // unit lane and, through the configs that extend this one, to every browser lane.
    testQuarantine(),
  ],
  optimizeDeps: {
    // Let the dev server serve the HTML and transform the app while Rolldown
    // finishes dependency discovery in the background. Vite 8 defaults this
    // to true, which makes every first renderer request wait behind the full
    // workspace crawl and presents as a blank/spinner window in Electron.
    holdUntilCrawlEnd: false,
    include: [
      "@base-ui/react/preview-card",
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react",
      "react-dom",
      "react-dom/client",
      "react-icons/gr",
      "zustand/vanilla",
    ],
    exclude: ["input-otp"],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(sentryRelease),
  },
  resolve: {
    // Packages linked in from outside the workspace (the spreadsheet engine) resolve React from
    // their real path; dedupe keeps them on the app's one React like the aliases below. The
    // engine's formula parser is deduped too: Moss adds functions to the one parser class the
    // engine and the shared sheet code both use (sheetFormulaFunctions.ts).
    dedupe: ["react", "react-dom", "@fortune-sheet/formula-parser"],
    // Workspace hoisting can place peer-only packages at the repository root,
    // while Node's package resolver starts from that package's real path. Pin
    // React to the web app's single runtime copy so peer imports (notably
    // input-otp) resolve identically in Vitest, Vite, and Electron.
    alias: {
      react: path.resolve(webRoot, "node_modules/react"),
      "react-dom": path.resolve(webRoot, "node_modules/react-dom"),
      // Older Codex preview code referenced a CSS subpath that docx-preview
      // 0.4 no longer exports. Keep that legacy import Vite-safe while the
      // active panel relies on the package root and its injected styles.
      "docx-preview/dist/docx-preview.css": path.resolve(
        webRoot,
        "src/components/docx-preview.css",
      ),
    },
    tsconfigPaths: true,
  },
  ssr: {
    // Keep the peer-only OTP package inside Vite's transform boundary so the
    // React interop plugin above also applies during Node-based unit tests.
    noExternal: ["input-otp"],
  },
  server: {
    port,
    strictPort: true,
    fs: {
      // Dev worktrees may reuse node_modules from another exact-lock worktree.
      // Allow the resolved dependency roots so font and asset requests do not
      // stall the app before React mounts.
      allow: devServerFsAllow,
    },
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // precompressPlugin already emits .gz/.br sidecars in parallel; skipping
    // Vite's single-threaded gzip size report avoids compressing 1,100+ chunks twice.
    reportCompressedSize: false,
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
