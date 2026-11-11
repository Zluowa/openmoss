// Fixture config for tools/test-quarantine/test/plugin.test.ts: the plugin with a list given
// by MOSS_QUARANTINE_FIXTURE_LIST, on win32, over the fixture files only.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { testQuarantine } from "../../vitest";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  plugins: [
    testQuarantine({
      repoRoot: root,
      file: process.env.MOSS_QUARANTINE_FIXTURE_LIST!,
      platform: "win32",
    }),
  ],
  test: { root, include: ["packages/shared/src/*.fixture.ts"] },
});
