import * as os from "node:os";
import { availableParallelism } from "node:os";
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
      // One worker per core (upstream Synara #2164). Each file runs in its own worker process
      // with its own temp dirs and SQLite databases; the Windows lane on the shared PC has run
      // the suite file-parallel (--maxWorkers=4) since 2026-11-03. Local callers on the shared
      // PC still pass an explicit --maxWorkers.
      maxWorkers: availableParallelism(),
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
