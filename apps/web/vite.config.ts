// FILE: vite.config.ts
// Purpose: Builds the Moss web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fsSync from "node:fs";
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
// Brotli quality 11 can reserve substantial native memory per input. Running
// every generated asset at once made the Windows packaging runner terminate
// the Vite process after bundling, before it could emit a useful diagnostic.
// A small fixed batch keeps memory bounded while still using all practical
// compression parallelism on the hosted builders.
const PRECOMPRESS_CONCURRENCY = 4;

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
      for (let start = 0; start < files.length; start += PRECOMPRESS_CONCURRENCY) {
        const batch = files.slice(start, start + PRECOMPRESS_CONCURRENCY);
        await Promise.all(
          batch.map(async (file) => {
            const source = await fs.readFile(file);
            if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
              await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
              return;
            }
            // Max-quality brotli on thousands of small files dominates plugin
            // wall-clock; below 16 KiB quality 9 is byte-for-byte competitive.
            const brotliQuality =
              source.byteLength < 16 * 1024 ? 9 : zlib.constants.BROTLI_MAX_QUALITY;
            const [gzipped, brotlied] = await Promise.all([
              gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
              brotliCompress(source, {
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
                },
              }),
            ]);
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
    },
  };
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
  }).then((plugin) => ({ ...plugin, apply: "build" as const })),
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
