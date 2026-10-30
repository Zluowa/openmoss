import { defineConfig } from "vitest/config";

import { parseBrowserCasePartition } from "./src/test/browserCasePartition";
import stableConfig from "./vitest.browser.stable.config";

const chatViewFile = "src/components/ChatView.browser.tsx";
const stableTestConfig = stableConfig.test!;
const casePartition = parseBrowserCasePartition(process.env.MOSS_BROWSER_CASE_PARTITION);
// Every project starts a browser API server, including when files are sharded.
// Inheriting one fixed port makes the second project fail before any test runs.
const browserApiBasePort = Number(process.env.VITEST_BROWSER_API_PORT ?? 51_100);

export default defineConfig({
  ...stableConfig,
  define: {
    ...stableConfig.define,
    MOSS_BROWSER_CASE_PARTITION: JSON.stringify(casePartition),
  },
  test: {
    ...stableTestConfig,
    // Project inheritance concatenates include arrays. Give each project sole
    // ownership of its files instead of inheriting the full browser glob set.
    include: [],
    projects: [
      {
        extends: true,
        test: {
          name: "chat",
          browser: { api: { port: browserApiBasePort + 1 } },
          include: [chatViewFile],
          setupFiles: ["src/test/browserCasePartitionSetup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          browser: { api: { port: browserApiBasePort + 2 } },
          include: stableTestConfig.include!,
          exclude: [chatViewFile],
        },
      },
    ],
  },
});
