import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SERVER_BROWSER_DOWNLOAD_TTL_MS, ServerBrowserRuntime } from "./ServerBrowserRuntime.ts";
import { ServerBrowserService } from "./ServerBrowserService.ts";
import { makeServerBrowserStreamRouteLayer } from "./serverBrowserStreamRoute.ts";

/** Requests carrying this header count as authenticated, as a session cookie would. */
const AUTH_HEADER = "x-test-authenticated";

describe("server browser download route", () => {
  let home: string;
  let now: number;
  let runtime: ServerBrowserRuntime;
  let offered: string[];
  let scope: Scope.Closeable;
  let origin: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "moss-server-browser-route-"));
    now = 1_000_000;
    offered = [];
    runtime = new ServerBrowserRuntime({
      betterwrightHome: join(home, "bw"),
      filesDir: join(home, "files"),
      resolveExecutable: async () => {
        throw new Error("no browser in this test");
      },
      now: () => now,
    });
    runtime.setEvents({
      tabsChanged: () => {},
      controlChanged: () => {},
      dialog: () => {},
      threadClosed: () => {},
      reveal: () => {},
      pendingChanged: () => {},
      navigationBlocked: () => {},
      download: (_threadId, _tabId, download) => offered.push(download.path),
    });
    scope = await Effect.runPromise(Scope.make());
    let nodeServer: http.Server | null = null;
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const routes = makeServerBrowserStreamRouteLayer({
            authorize: (request) => Effect.succeed(request.headers[AUTH_HEADER] === "yes"),
          });
          yield* httpServer.serve(yield* HttpRouter.toHttpEffect(routes));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerBrowserService, {
                enabled: true,
                runtime,
                hub: {} as never,
              }),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Missing test server address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  });

  /** Keep a file the way a person's download in the page is kept, and return its path. */
  const keep = async (fileName: string, contents: string): Promise<string> => {
    const before = offered.length;
    await (
      runtime as unknown as {
        keepDownload: (threadId: string, tabId: string, download: unknown) => Promise<void>;
      }
    ).keepDownload("thread-a", "tab-a", {
      suggestedFilename: () => fileName,
      saveAs: (path: string) => writeFile(path, contents),
    });
    expect(offered).toHaveLength(before + 1);
    return offered.at(-1)!;
  };

  const get = (path: string, authenticated = true) =>
    fetch(`${origin}${path}`, { headers: authenticated ? { [AUTH_HEADER]: "yes" } : {} });

  it("serves a download once, and only to an authenticated request", async () => {
    const path = await keep("report.txt", "quarterly numbers");
    expect(new URL(path, origin).searchParams.has("token")).toBe(false);

    const anonymous = await get(path, false);
    expect(anonymous.status).toBe(403);

    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''report.txt",
    );
    expect(await first.text()).toBe("quarterly numbers");

    const second = await get(path);
    expect(second.status).toBe(404);
  });

  it("refuses an expired download", async () => {
    const path = await keep("late.txt", "too late");
    now += SERVER_BROWSER_DOWNLOAD_TTL_MS + 1;
    expect((await get(path)).status).toBe(404);
  });

  it("keeps the link short-lived: about two minutes", () => {
    expect(SERVER_BROWSER_DOWNLOAD_TTL_MS).toBe(2 * 60_000);
  });

  it("refuses an unknown token", async () => {
    expect((await get("/api/server-browser/download?download=not-a-token")).status).toBe(404);
    expect((await get("/api/server-browser/download")).status).toBe(404);
  });
});
