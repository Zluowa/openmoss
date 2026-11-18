// FILE: agentRuntimeNotice.ts
// Purpose: Tells the running server that an agent runtime finished downloading, so its next
//          launch uses it without a restart (apps/server/src/desktopAgentRuntimes.ts).
// Layer: Electron main process

import * as Http from "node:http";

import { DESKTOP_AGENT_RUNTIMES_ROUTE_PATH } from "@moss/shared/codexRuntime";

const REQUEST_TIMEOUT_MS = 5_000;
/** A backend that is starting or restarting gets a few chances; its next start reads the env anyway. */
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

function postOnce(input: {
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
  readonly body: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.backendHttpUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "::1" && url.hostname !== "localhost") {
      reject(new Error("Agent runtime notice requires a loopback backend endpoint."));
      return;
    }
    url.pathname = DESKTOP_AGENT_RUNTIMES_ROUTE_PATH;
    url.search = "";
    url.hash = "";
    const request = Http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${input.shutdownToken}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(input.body)),
        },
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Agent runtime notice timed out."));
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

/** Best effort: the server's next start receives the same paths in its environment. */
export async function notifyBackendAgentRuntimeReady(input: {
  readonly backendHttpUrl: () => string;
  readonly shutdownToken: string;
  readonly ready: ReadonlyArray<{ readonly name: string; readonly executablePath: string }>;
  readonly onError?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const sleep =
    input.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }));
  const body = JSON.stringify({ ready: input.ready });
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const backendHttpUrl = input.backendHttpUrl();
    if (backendHttpUrl && input.shutdownToken) {
      try {
        const status = await postOnce({ backendHttpUrl, shutdownToken: input.shutdownToken, body });
        if (status === 202) return true;
        input.onError?.(`agent runtime notice returned HTTP ${status}`);
      } catch (error) {
        input.onError?.(`agent runtime notice failed: ${String(error)}`);
      }
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]!);
  }
  return false;
}
