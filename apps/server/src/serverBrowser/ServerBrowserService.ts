/**
 * The server-hosted agent browser as a service: the runtime that drives it and
 * the hub that streams it. Nothing launches until an agent opens a browser.
 *
 * @module ServerBrowserService
 */
import * as Path from "node:path";

import { Effect, Layer, ServiceMap } from "effect";

import { ServerConfig } from "../config.ts";
import { makeDedicatedHeadlessShell } from "../htmlRender/HtmlRender.ts";

import { ServerBrowserRuntime } from "./ServerBrowserRuntime.ts";
import { ServerBrowserViewerHub } from "./ServerBrowserViewers.ts";

export interface ServerBrowserServiceShape {
  /** False when the server browser is turned off (`MOSS_SERVER_BROWSER=0`). */
  readonly enabled: boolean;
  readonly runtime: ServerBrowserRuntime;
  readonly hub: ServerBrowserViewerHub;
}

export class ServerBrowserService extends ServiceMap.Service<
  ServerBrowserService,
  ServerBrowserServiceShape
>()("moss/serverBrowser/ServerBrowserService") {}

export function serverBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.MOSS_SERVER_BROWSER?.trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

export const ServerBrowserServiceLive = Layer.effect(
  ServerBrowserService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const shell = makeDedicatedHeadlessShell(config.baseDir);
    // An explicit executable serves hosts that provision Chromium themselves.
    const override = process.env.MOSS_SERVER_BROWSER_EXECUTABLE?.trim();
    const runtime = new ServerBrowserRuntime({
      betterwrightHome: Path.join(config.baseDir, "tools", "server-browser", "betterwright"),
      filesDir: Path.join(config.baseDir, "tools", "server-browser", "files"),
      resolveExecutable: async () => {
        if (override) return override;
        let executable = await shell.executable();
        if (executable === undefined) {
          await shell.waitForInstall();
          executable = await shell.executable();
        }
        if (executable === undefined) throw new Error("The server browser is not installed.");
        return executable;
      },
    });
    const hub = new ServerBrowserViewerHub(runtime);
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
    return { enabled: serverBrowserEnabled(), runtime, hub } satisfies ServerBrowserServiceShape;
  }),
);
