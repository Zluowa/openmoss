import { defineConfig } from "vitest/config";

// The merge queue's own tests. They use a fake runner for gh, ssh and lane processes, and real
// git repositories in temporary folders; nothing outside the OS temp folder is touched. Each test
// spawns tens of git processes, which take seconds each on a loaded Windows machine.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    maxWorkers: 2,
  },
});
