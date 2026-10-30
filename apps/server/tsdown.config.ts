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

const shared = {
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  // Bun builtins only resolve at runtime under Bun; MigrationBackup.ts guards
  // the import behind a `process.versions.bun` check.
  external: [/^bun:/u],
  sourcemap: buildSourcemap,
  define: {
    __MOSS_MIGRATION_RUNTIME_SOURCE_DIGEST__: JSON.stringify(migrationRuntimeSourceDigest),
  },
  noExternal: (id) => id.startsWith("@synara/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
} satisfies UserConfig;

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts", "src/restoreMigrationBackup.ts"],
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
