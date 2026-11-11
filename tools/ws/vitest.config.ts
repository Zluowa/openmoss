import { defineConfig } from "vitest/config";

// The workspace tool's own tests. They make real git repositories, junctions and locks in
// temporary folders; nothing outside the OS temp folder is touched.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 2,
  },
});
