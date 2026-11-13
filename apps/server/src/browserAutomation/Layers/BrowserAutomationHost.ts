import { WS_SERVER_HOSTED_BROWSER_CAPABILITY } from "@moss/contracts";
import { Effect, Layer } from "effect";

import { advertiseWsRuntimeCapability } from "../../wsCompatibility.ts";
import {
  ServerBrowserService,
  ServerBrowserServiceLive,
  type ServerBrowserServiceShape,
} from "../../serverBrowser/ServerBrowserService.ts";
import {
  BrowserAutomationHost,
  type BrowserAutomationHostShape,
} from "../Services/BrowserAutomationHost.ts";
import {
  BrowserHostRpcError,
  callBrowserHostTool,
  resolveBrowserHostCapability,
  resolveBrowserHostPipePath,
} from "../browserHostRpcClient.ts";

/** The desktop app's visible browser, reached over its private pipe. */
export function makeBrowserAutomationHost(
  env: NodeJS.ProcessEnv = process.env,
): BrowserAutomationHostShape {
  const pipePath = resolveBrowserHostPipePath(env);
  const capability = resolveBrowserHostCapability(env);
  if (env.MOSS_MODE === "desktop" && (!pipePath || !capability)) {
    console.warn("[browser-host] Desktop browser transport is unavailable", {
      pipeConfigured: pipePath !== null,
      capabilityLoaded: capability !== null,
    });
  }
  return {
    available: pipePath !== null && capability !== null,
    execute: (input) => {
      if (!pipePath || !capability) {
        return Effect.fail(
          new BrowserHostRpcError(
            "unavailable",
            "The visible Moss browser is only available in the desktop app.",
          ),
        );
      }
      return Effect.tryPromise({
        try: (signal) => callBrowserHostTool({ ...input, pipePath, capability, signal }),
        catch: (error) =>
          error instanceof BrowserHostRpcError
            ? error
            : new BrowserHostRpcError("transport", String(error)),
      });
    },
  };
}

/**
 * The headless browser on this server, for sessions no desktop app hosts: a
 * server reached over SSH, the web client, a phone. Viewers watch and take
 * control of it through the server browser stream.
 */
export function makeServerBrowserAutomationHost(
  server: ServerBrowserServiceShape,
): BrowserAutomationHostShape {
  return {
    available: server.enabled,
    execute: (input) =>
      Effect.tryPromise({
        try: (signal) =>
          server.runtime.execute({
            threadId: input.threadId,
            name: input.name,
            arguments: input.arguments,
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
            timeoutMs: input.timeoutMs,
            signal,
          }),
        catch: (error) =>
          error instanceof BrowserHostRpcError
            ? error
            : new BrowserHostRpcError("transport", String(error)),
      }),
    consumeNotice: (threadId) => server.runtime.consumeHandoffNotice(threadId),
  };
}

/** The desktop browser when a desktop app hosts this server, else the server browser. */
export const BrowserAutomationHostLive = Layer.effect(
  BrowserAutomationHost,
  Effect.gen(function* () {
    const desktop = makeBrowserAutomationHost();
    if (desktop.available || process.env.MOSS_MODE === "desktop") return desktop;
    const server = yield* ServerBrowserService;
    if (!server.enabled) return desktop;
    // Clients show the server-browser panel only when the agents really use it.
    advertiseWsRuntimeCapability(WS_SERVER_HOSTED_BROWSER_CAPABILITY);
    return makeServerBrowserAutomationHost(server);
  }),
).pipe(Layer.provide(ServerBrowserServiceLive));
