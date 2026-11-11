import { defineConfig } from "vitest/config";

// `bun run check`'s own tests (`bun run test:check`). One test makes a git repository in the OS
// temp folder; nothing else is written.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    maxWorkers: 2,
  },
});
