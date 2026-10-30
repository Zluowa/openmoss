// FILE: tsdown.config.ts
// Purpose: Builds Electron main/preload code and controls diagnostic source maps.
// Layer: Desktop build config
// Depends on: tsdown.

import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.MOSS_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const buildSourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";
const windowsUpdaterPublisher = process.env.AZURE_TRUSTED_SIGNING_SUBJECT_DN?.trim() ?? "";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationRuntimeSource = fs.readFileSync(
  path.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
  "utf8",
);
const migrationRuntimeSourceDigest = createHash("sha256")
  .update(migrationRuntimeSource, "utf8")
  .digest("hex");

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: buildSourcemap,
  outExtensions: () => ({ js: ".js" }),
};

const isElectronRuntimeModule = (id: string): boolean =>
  id === "electron" || id.startsWith("electron/");

// The sandboxed Electron preload cannot resolve package imports at runtime.
// Inline every non-builtin dependency while keeping Electron and Node builtins
// external, so a future preload import cannot silently create another bare
// package require in the packaged app.
const bundlePreloadDependencies = (id: string): boolean =>
  !isElectronRuntimeModule(id) && !isBuiltin(id);

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    // Main process intentionally inlines selected transitive deps (proxy agents).
    // tsdown otherwise exits 1 on "Detected dependencies in bundle".
    inlineOnly: false,
    // Electron exposes this builtin only at runtime; keeping it external avoids
    // asking Rolldown to resolve a package that intentionally does not exist.
    external: ["original-fs"],
    define: {
      __MOSS_WINDOWS_UPDATER_PUBLISHER__: JSON.stringify(windowsUpdaterPublisher),
      __MOSS_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
    },
    noExternal: (id) => id.startsWith("@synara/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
    noExternal: bundlePreloadDependencies,
  },
  {
    ...shared,
    entry: ["src/browserAnnotations/guestPreload.ts"],
  },
  {
    ...shared,
    entry: { mcpSandboxPreload: "src/mcpAppSandbox/guestPreload.ts" },
  },
  {
    ...shared,
    // The cross-platform driver host, deployable to a Windows/Linux target:
    // `node dist-electron/cuaDriverHostStandalone.js --driver <path>`. It
    // must bundle the shared protocol (no node_modules on the target).
    entry: ["src/cuaDriverHostStandalone.ts"],
    noExternal: (id) => id.startsWith("@synara/"),
  },
]);
