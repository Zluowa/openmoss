import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    // A name filter still imports every included module before skipping it.
    // Keep the reviewed tag inventory in browser-ci-partitions.test.ts in sync.
    include: ["src/components/ChatView.browser.tsx"],
    passWithNoTests: false,
    testNamePattern: /\[geometry:linux\]/,
    browser: {
      ...browserConfig.test!.browser,
      fileParallelism: false,
    },
  },
});
