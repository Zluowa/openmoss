// Explicit production guest build and browser exercise; authorization fixtures are local.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../server/", import.meta.url)),
  test: {
    include: ["integration/guestProjection.integration.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 75_000,
  },
});
