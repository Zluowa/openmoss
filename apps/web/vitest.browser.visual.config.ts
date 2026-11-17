// Screenshot suite for Moss's shared UI wrappers (round 20261118-ui-sdk). Pixel baselines depend on
// the operating system's font rendering, so they sit beside the test with a platform suffix and run
// here, not in the cross-platform browser suite: `bun run test:browser:visual` in apps/web. Upgrades
// of the primitive library underneath the wrappers run it; a changed pixel on a control fails it.
// Refresh the baselines on purpose only: `bun run test:browser:visual --update`.
import { mergeConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config";

const merged = mergeConfig(browserConfig, {
  test: {
    browser: {
      viewport: { width: 1200, height: 900 },
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          comparatorOptions: {
            // Anti-aliasing noise only; a 1px border or a colour shift on a control fails.
            threshold: 0.1,
            allowedMismatchedPixelRatio: 0,
          },
          // `__screenshots__` is ignored (failure shots land there); the references are tracked.
          resolveScreenshotPath: ({
            arg,
            browserName,
            ext,
            platform,
            root,
            testFileDirectory,
            testFileName,
          }: {
            arg: string;
            browserName: string;
            ext: string;
            platform: string;
            root: string;
            testFileDirectory: string;
            testFileName: string;
          }) =>
            // One folder per test file, named without its extension, so no folder looks like a
            // source file to tools that scan the web source by name.
            `${root}/${testFileDirectory}/visual-baselines/${testFileName.replace(/\.visual\.tsx$/, "")}/${arg}-${browserName}-${platform}${ext}`,
        },
      },
    },
  },
});

// mergeConfig concatenates arrays; this suite runs its own files only.
merged.test = { ...merged.test, include: ["src/components/ui/**/*.visual.tsx"] };

export default merged;
