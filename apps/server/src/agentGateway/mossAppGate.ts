// FILE: mossAppGate.ts
// Purpose: Settings › 插件 › 应用 switches for Moss's own apps, enforced at the
//          agent gateway: a turned-off app's tools leave `tools/list`, and a
//          call by name gets one plain refusal instead of running.
// Layer: Server agent gateway
// Exports: gateToolsByMossApp

import { Effect } from "effect";
import {
  mossBuiltInAppForTool,
  normalizeDisabledMossApps,
  type MossBuiltInAppId,
} from "@moss/shared/mossBuiltInApps";

import { GatewayToolError, gatewayToolErrorResult, type ToolEntry } from "./toolRuntime.ts";

/**
 * Wrap every tool that belongs to a built-in Moss app. The switch is read on
 * each listing and each call (settings are an in-memory Ref, so this is cheap),
 * which means flipping it applies to the very next turn without restarting any
 * provider session. Reading settings never fails the tool: an unreadable
 * setting counts as "on", the state Moss ships in.
 */
export function gateToolsByMossApp(
  tools: ReadonlyArray<ToolEntry>,
  readDisabledAppIds: Effect.Effect<ReadonlyArray<string>, unknown>,
): ReadonlyArray<ToolEntry> {
  const readDisabled: Effect.Effect<ReadonlySet<MossBuiltInAppId>> = readDisabledAppIds.pipe(
    Effect.map(normalizeDisabledMossApps),
    Effect.orElseSucceed((): ReadonlySet<MossBuiltInAppId> => new Set()),
  );
  return tools.map((tool) => {
    const appId = mossBuiltInAppForTool(tool.definition.name);
    if (appId === null) return tool;
    const isOn = readDisabled.pipe(Effect.map((disabled) => !disabled.has(appId)));
    const available = tool.available;
    return {
      ...tool,
      available: () =>
        Effect.gen(function* () {
          if (!(yield* isOn)) return false;
          return available === undefined ? true : yield* available();
        }),
      handler: (args, context) =>
        Effect.gen(function* () {
          if (!(yield* isOn)) {
            return gatewayToolErrorResult(
              new GatewayToolError(
                "app_disabled",
                "The person turned this Moss app off in Settings › 插件 › 应用. Do not retry; tell them they can turn it back on there.",
                { appId },
              ),
            );
          }
          return yield* tool.handler(args, context);
        }),
    };
  });
}
