import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import { PAGE_EDITOR_BROWSER_SPECS } from "./src/test/browserTestLanes";
import browserConfig from "./vitest.browser.config";

// The Page editor specs need the built Canvas bundle: only test:browser:page-editor runs them.
export { PAGE_EDITOR_BROWSER_SPEC, PAGE_EDITOR_BROWSER_SPECS } from "./src/test/browserTestLanes";

export default mergeConfig(
  browserConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, ...PAGE_EDITOR_BROWSER_SPECS],
      testNamePattern: /^(?!.*\[geometry:linux\])/,
      browser: {
        fileParallelism: false,
      },
    },
  }),
);
