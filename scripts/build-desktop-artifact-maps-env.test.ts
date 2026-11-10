import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Path } from "effect";

import { resolveBuildOptions } from "./build-desktop-artifact.ts";

const noFlags = {
  platform: Option.none(),
  target: Option.none(),
  arch: Option.none(),
  buildVersion: Option.none(),
  sourceCommit: Option.none(),
  sourceTag: Option.none(),
  lockfileSha256: Option.none(),
  outputDir: Option.none(),
  skipBuild: Option.none(),
  keepStage: Option.none(),
  signed: Option.none(),
  verbose: Option.none(),
  mockUpdates: Option.none(),
  mockUpdateServerPort: Option.none(),
  productionConfigMode: Option.none(),
  mapsEnvFile: Option.none(),
  releaseMode: Option.none(),
} as const;

it.layer(NodeServices.layer)("--maps-env-file", (it) => {
  it.effect("resolves the file only for strict production config", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const strict = yield* resolveBuildOptions({
        ...noFlags,
        productionConfigMode: Option.some("strict"),
        mapsEnvFile: Option.some("operator/maps.env"),
      });
      assert.ok(strict.mapsEnvFile && path.isAbsolute(strict.mapsEnvFile));
      assert.ok(strict.mapsEnvFile.endsWith(path.join("operator", "maps.env")));

      const off = yield* Effect.exit(
        resolveBuildOptions({
          ...noFlags,
          productionConfigMode: Option.some("off"),
          mapsEnvFile: Option.some("operator/maps.env"),
        }),
      );
      assert.ok(Exit.isFailure(off));
      const failure = Cause.squash(off.cause);
      assert.match(
        failure instanceof Error ? failure.message : String(failure),
        /^--maps-env-file \(MOSS_DESKTOP_MAPS_ENV_FILE\) needs --production-config-mode strict/,
      );

      const unset = yield* resolveBuildOptions({
        ...noFlags,
        productionConfigMode: Option.some("strict"),
      });
      assert.equal(unset.mapsEnvFile, undefined);
    }),
  );
});
