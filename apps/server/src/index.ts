import { captureSentryException, flushSentry } from "./observability/sentry";
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
import { NetService } from "@moss/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { consumeDesktopParentInput, withDesktopParentLifetime } from "./desktopParentLifetime";
import { exitDesktopBackend } from "./desktopFatalExit";
import { hydrateWindowsUserEnvironment } from "./os-jank";
import { installWindowsProviderProcessGuard } from "./platform/windowsProviderProcessGuard";
import { installWindowsExitPriority } from "./platform/windowsExitPriority";
import {
  disposeWarmWindowsTeardownObservers,
  enableWarmWindowsTeardownObservers,
} from "@moss/shared/supervisedProcessTeardown";

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
        Effect.promise(async () => {
          captureSentryException(new Error("Moss server process failure"), {
            errorSource: "server-process",
            errorClass:
              cause && typeof cause === "object" && "_tag" in cause
                ? String((cause as { readonly _tag?: unknown })._tag).slice(0, 96)
                : cause instanceof Error
                  ? cause.name.slice(0, 96)
                  : "UnknownError",
          });
          // The process exits right after this, which would drop a queued event.
          await flushSentry();
        }),
      ),
    ) as Effect.Effect<void, unknown, never>;
}

if (import.meta.main) {
  // Before any layer resolves a provider home (account import, health probes).
  if (process.platform === "win32") {
    hydrateWindowsUserEnvironment();
    installWindowsProviderProcessGuard();
    installWindowsExitPriority();
    // Agent launches take a pre-warmed process-tree observer instead of waiting for one.
    enableWarmWindowsTeardownObservers();
  }
  const desktopParentInput = consumeDesktopParentInput(process.env, () => process.stdin);
  // Effect finalizers close the server and provider resources, but Electron's
  // Node mode can retain native handles after the scoped program resolves.
  // The desktop backend has no independent work after that point: terminate
  // the owned process once its runtime has completed instead of leaving the
  // desktop waiting for an unrelated handle to drain. The exit code keeps the
  // runtime's own mapping (0 success, 130 interrupt, 1 failure) so the desktop
  // log and crash diagnostics still tell a clean exit from a crash. This exit runs
  // before runMain's own error report, so a crash writes its cause to stderr first.
  NodeRuntime.runMain(
    withDesktopParentLifetime(mossServerProgram(), desktopParentInput).pipe(
      Effect.ensuring(Effect.sync(disposeWarmWindowsTeardownObservers)),
      Effect.onExit((exit) =>
        process.env.MOSS_MODE !== "desktop"
          ? Effect.void
          : exitDesktopBackend(exit, {
              writeStderr: (text, done) => {
                process.stderr.write(text, () => done());
              },
              exitProcess: (code) => process.exit(code),
            }),
      ),
    ),
  );
}
