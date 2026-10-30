import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

/**
 * Drives the real Canvas Plate editor, which exists only after the pinned Canvas bundle is
 * built; `test:browser:page-editor` serves that bundle and runs it in CI's Desktop Build job.
 */
export const PAGE_EDITOR_BROWSER_SPEC = "src/components/MossDataSpaceDestination.browser.tsx";

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, PAGE_EDITOR_BROWSER_SPEC],
      testNamePattern: /^(?!.*\[geometry:linux\])/,
      browser: {
        fileParallelism: false,
      },
    },
  }),
);
