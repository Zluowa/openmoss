import { defineConfig } from "vitest/config";

// The quarantine tool's own tests (`bun run test:test-quarantine`). Nested Vitest runs use the
// fixtures under test/fixtures; nothing outside the OS temp folder is written.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    maxWorkers: 2,
  },
});
