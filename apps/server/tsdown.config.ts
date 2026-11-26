// FILE: tsdown.config.ts
// Purpose: Builds the Moss server CLI and controls diagnostic source maps.
// Layer: Server build config
// Depends on: tsdown.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type UserConfig } from "tsdown";

const sourcemapEnv = process.env.MOSS_SERVER_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const migrationRuntimeSourceDigest = createHash("sha256")
  .update(migrationRuntimeSource, "utf8")
  .digest("hex");

// Effect and its platform packages are bundled: loading them file by file was about 270
// modules and 70 ms of every backend start, and bundling lets unused modules drop out.
// This is safe only because nothing left in node_modules imports Effect at runtime
// (@opencode/client is used through its promise entry, which does not). Two copies of
// Effect would break service identity, so a new runtime dependency that imports Effect
// must be added here too. Packages that an unbundled SDK also loads (undici, yaml, ws,
// zod, the MCP SDK) and anything native (node-pty, msgpackr's optional accelerator) stay
// external.
const BUNDLED_RUNTIME_PACKAGES = [
  "effect",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun",
  // Pure-JS dependencies of the packages above.
  "@standard-schema/spec",
  "fast-check",
  "find-my-way-ts",
  "ini",
  "mime",
  "multipasta",
  "pure-rand",
  "smol-toml",
  "toml",
  "uuid",
  // Inline @pierre/diffs (only parsePatchFiles is used; Shiki is tree-shaken away)
  // and @opencode/client (its Promise client does not load @opencode/{protocol,schema}
  // or their duplicate nested effect@4.0.0-rc.* trees).
  "@pierre/diffs",
  "@opencode/client",
];

function isBundledRuntimePackage(id: string): boolean {
  return BUNDLED_RUNTIME_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`));
}

const shared = {
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
  // the import behind a `process.versions.bun` check.
  external: [/^bun:/u],
  minify: true,
  sourcemap: buildSourcemap,
  // `effect` imports `yaml` in ConfigProvider; its bindings are tree-shaken out,
  // but because `yaml` stays external, Rolldown would otherwise preserve a dead
  // `import "yaml"` side-effect on the cold boot path (~13ms). `yaml` is pure.
  treeshake: {
    moduleSideEffects: [{ test: /^yaml$/u, external: true, sideEffects: false }],
  },
  define: {
    __MOSS_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
  },
  noExternal: (id) => id.startsWith("@moss/") || isBundledRuntimePackage(id),
  inlineOnly: false,
  outputOptions: {
    // Keep upstream notices beside bundled code, once in its owning chunk.
    legalComments: "inline",
    // The bundler's helpers (__exportAll, __commonJSMin, …) get a chunk of their own that
    // imports nothing. Left to itself the bundler may put them in index.mjs, and a chunk that
    // index.mjs loads first then reads them before index.mjs has defined them ("__exportAll is
    // not a function" at start). Bundled CommonJS packages, such as the 电子表格 formula
    // parser, make that happen.
    codeSplitting: {
      groups: [{ name: "rolldown-runtime", test: /rolldown[\\/]runtime/u }],
    },
  },
  banner: {
    js: "#!/usr/bin/env node\n",
  },
} satisfies UserConfig;

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts", "src/restoreMigrationBackup.ts", "src/compactDatabase.ts"],
    clean: true,
  },
  {
    ...shared,
    // This entry is a release-only runtime probe and uses top-level await for
    // lazy dependency loading. Keep it ESM-only so the regular CJS CLI build
    // cannot reject the whole server build during desktop packaging.
    entry: ["src/runtimeDependencySmoke.ts"],
    format: "esm",
    clean: false,
  },
]);
