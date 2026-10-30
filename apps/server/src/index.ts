import { captureSentryException } from "./observability/sentry";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, makeMossCli, type MossServerLayerOptions } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import serverPackageJson from "../package.json" with { type: "json" };

// JSON modules expose only a default export.
const { version } = serverPackageJson;
import { ServerLive } from "./effectServer";
import { NetService } from "@synara/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { consumeDesktopParentInput, withDesktopParentLifetime } from "./desktopParentLifetime";
import { hydrateWindowsUserEnvironment } from "./os-jank";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

export function mossServerProgram(options: MossServerLayerOptions = {}) {
  return Command.run(makeMossCli(options), { version })
    .pipe(Effect.provide(RuntimeLayer))
    .pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() =>
          captureSentryException(new Error("Moss server process failure"), {
            errorSource: "server-process",
            errorClass:
              cause && typeof cause === "object" && "_tag" in cause
                ? String((cause as { readonly _tag?: unknown })._tag).slice(0, 96)
                : cause instanceof Error
                  ? cause.name.slice(0, 96)
                  : "UnknownError",
          }),
        ),
      ),
    ) as Effect.Effect<void, unknown, never>;
}

if (import.meta.main) {
  // Before any layer resolves a provider home (account import, health probes).
  if (process.platform === "win32") hydrateWindowsUserEnvironment();
  const desktopParentInput = consumeDesktopParentInput(process.env, () => process.stdin);
  NodeRuntime.runMain(withDesktopParentLifetime(mossServerProgram(), desktopParentInput));
}
