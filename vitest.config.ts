import * as path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import { testQuarantine } from "./tools/test-quarantine/vitest";

export default defineConfig({
  // Applies test-quarantine.json to every package that uses this config (contracts, shared,
  // desktop, scripts, and server through mergeConfig).
  plugins: [testQuarantine()],
  resolve: {
    alias: [
      {
        find: /^@moss\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
      // The web app's `~` alias (only workspace that defines one), so its
      // modules stay importable from tests without rewriting to relative paths.
      {
        find: /^~\//,
        replacement: `${path.resolve(import.meta.dirname, "./apps/web/src")}/`,
      },
    ],
  },
  test: {
    // Keep generated local replay workspaces and plugin caches out of product
    // test discovery. These directories contain copied tests that are not part
    // of this repository and can reference paths from the source workspace.
    exclude: [
      ...configDefaults.exclude,
      "**/.moss/**",
      "**/.moss-*/**",
      "**/.synara/**",
      "**/.synara-*/**",
      // E2E Codex homes are symlink overlays. Vitest resolves those links
      // before applying excludes, so also ignore the canonical plugin cache
      // paths that would otherwise be imported as workspace tests.
      "**/plugins/cache/**",
      "**/bundled-marketplaces/**",
      "**/.tmp/plugins/**",
    ],
  },
});
