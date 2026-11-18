import { defineConfig } from "vitest/config";

// The acceptance kit's own tests: tour parsing and verdicts, and the tour runner against a fake
// Moss. No app is launched here; launching is proven by a real run (see README.md).
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
