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
    // This lane is where the quarantined geometry cases run (test-quarantine.json), so the
    // quarantine selects them here instead of skipping them.
    env: { ...browserConfig.test!.env, MOSS_TEST_QUARANTINE: "only" },
    browser: {
      ...browserConfig.test!.browser,
      fileParallelism: false,
    },
  },
});
