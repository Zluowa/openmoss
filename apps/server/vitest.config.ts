import * as os from "node:os";
import * as path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Server integration tests exercise sqlite/git orchestration and can
      // legitimately exceed the default timeout when the full workspace suite
      // is running under CI load.
      testTimeout: 90_000,
      hookTimeout: 90_000,
      env: {
        // Tests that fake a user profile without AppData\Local make Windows PowerShell
        // write its module cache relative to the working directory, i.e. into the repo.
        PSModuleAnalysisCachePath: path.join(
          os.tmpdir(),
          "moss-server-vitest-powershell",
          "ModuleAnalysisCache",
        ),
      },
    },
  }),
);
