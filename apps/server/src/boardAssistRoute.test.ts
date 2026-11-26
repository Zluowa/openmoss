// FILE: boardAssistRoute.test.ts
// Purpose: Integration tests for POST /api/moss/board/assist covering trusted-origin CORS,
//          owner/session auth, PR #106/#107 board-scope validation, and SSE streaming.

import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AuthSessionId, SpaceId } from "@moss/contracts";
import { createBoardAssistParser } from "@moss/shared/spaceItems/boardAssist";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPayService } from "./account/Services/MossPayService";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth";
import { boardAssistEffectRouteLayer, MOSS_BOARD_ASSIST_ROUTE_PATH } from "./boardAssistRoute";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultGroupsWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import { PagesServiceLive } from "./pages/Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL } from "./pages/Services/PagesService";
import { PageTypesService, PageTypesServiceLive } from "./pages/types/PageTypesService";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

function makeTestConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = path.join(os.tmpdir(), `moss-board-assist-${randomUUID()}`);
  return {
    mode: "web",
    port: 3000,
    host: "127.0.0.1",
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    groupsWorkspaceRoot: resolveDefaultGroupsWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    publicUrl: undefined,
    allowInsecureRemote: false,
    noBrowser: true,
    authToken: "board-assist-startup-token",
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as unknown as ServerConfigShape;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function startStubSseServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '{"op":"addNote","key":"k1","text":"路线图"}\n' } }],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '{"say":"已添加路线图便签"}\n' } }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind stub server");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

async function createRouteHarness() {
  const config = makeTestConfig();
  const pageTypesLayer = PageTypesServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const authLayer = Layer.mock(ServerAuth)({
    authenticateHttpRequest: (request) => {
      const token = request.headers.authorization;
      if (token === "Bearer owner-token") {
        return Effect.succeed({
          sessionId: AuthSessionId.makeUnsafe("owner-sess"),
          subject: "owner",
          method: "bearer-session-token",
          role: "owner",
          credentialSource: "bearer",
        });
      }
      if (token === "Bearer guest-token") {
        return Effect.succeed({
          sessionId: AuthSessionId.makeUnsafe("guest-sess"),
          subject: "guest",
          method: "bearer-session-token",
          role: "client",
          credentialSource: "bearer",
        });
      }
      return Effect.fail(new AuthError({ message: "Unauthorized", status: 401 }));
    },
  });
  const runtime = ManagedRuntime.make(pageTypesLayer);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const types = await runtime.runPromise(Effect.service(PageTypesService));
  const routeServices = Layer.mergeAll(
    Layer.succeed(PageTypesService, types),
    authLayer,
    Layer.succeed(ServerConfig, config),
    Layer.mock(MossPhoneAccountService)({}),
    Layer.mock(MossCloudAccountService)({}),
    Layer.mock(MossEnterpriseKeyAccount)({}),
    Layer.mock(MossPayService)({}),
  );
  const web = HttpRouter.toWebHandler(
    boardAssistEffectRouteLayer.pipe(HttpRouter.provideRequest(routeServices)),
    { disableLogger: true },
  );
  cleanups.push(async () => {
    await web.dispose();
    await runtime.dispose();
  });

  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  const now = "2026-11-22T00:00:00.000Z";
  await runtime.runPromise(
    sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
      VALUES (${scopeSpaceId}, 'Board space', 'folder', 0, ${now}, ${now})`,
  );
  const createdBoard = await runtime.runPromise(
    types.create(
      {
        requestId: randomUUID(),
        scopeSpaceId,
        kind: "board",
        title: "Architecture Board",
        spaceId: null,
        parentPageId: null,
        data: JSON.stringify({ version: 2, storage: "isolated", canvasProjectKey: "proj-board-1" }),
      },
      LOCAL_PAGES_PRINCIPAL,
    ),
  );
  return { web, scopeSpaceId, createdBoard, config };
}

describe("POST /api/moss/board/assist", () => {
  it("rejects untrusted origins, non-owners, and mismatched board scopes while streaming valid board asks", async () => {
    const stubUrl = await startStubSseServer();
    vi.stubEnv("MOSS_PAGE_APPS_AI_STUB_URL", stubUrl);
    const h = await createRouteHarness();

    const validPayload = {
      board: { shapes: [], truncated: false },
      ask: { text: "加一个路线图便签", via: "composer" },
      expectedBoard: {
        pageId: h.createdBoard.page.id,
        scopeSpaceId: h.scopeSpaceId,
        canvasProjectKey: "proj-board-1",
      },
    };
    const boardQuery = new URLSearchParams({
      canvasBoard: h.createdBoard.page.id,
      canvasBoardKey: "proj-board-1",
      canvasBoardSpace: h.scopeSpaceId,
    }).toString();

    const badOrigin = await h.web.handler(
      new Request(`http://127.0.0.1:3000${MOSS_BOARD_ASSIST_ROUTE_PATH}?${boardQuery}`, {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload),
      }),
    );
    expect(badOrigin.status).toBe(403);

    const nonOwner = await h.web.handler(
      new Request(`http://127.0.0.1:3000${MOSS_BOARD_ASSIST_ROUTE_PATH}?${boardQuery}`, {
        method: "POST",
        headers: {
          authorization: "Bearer guest-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload),
      }),
    );
    expect(nonOwner.status).toBe(403);

    const mismatch = await h.web.handler(
      new Request(`http://127.0.0.1:3000${MOSS_BOARD_ASSIST_ROUTE_PATH}?${boardQuery}`, {
        method: "POST",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...validPayload,
          expectedBoard: {
            pageId: h.createdBoard.page.id,
            scopeSpaceId: h.scopeSpaceId,
            canvasProjectKey: "proj-other",
          },
        }),
      }),
    );
    expect(mismatch.status).toBe(403);

    const ok = await h.web.handler(
      new Request(`http://127.0.0.1:3000${MOSS_BOARD_ASSIST_ROUTE_PATH}?${boardQuery}`, {
        method: "POST",
        headers: {
          authorization: "Bearer owner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(validPayload),
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await ok.text();
    const events = sseText
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("data:"))
      .map(
        (chunk) =>
          JSON.parse(chunk.slice(5).trim()) as { type: string; delta?: string; model?: string },
      );
    expect(events[0]).toEqual({ type: "start", tier: "default" });
    expect(events.at(-1)).toEqual({ type: "done", model: "moss-stub-model" });
    const parser = createBoardAssistParser();
    const parsedLines = events
      .filter((e) => e.type === "text" && typeof e.delta === "string")
      .flatMap((e) => parser.push(e.delta!));
    parsedLines.push(...parser.end());
    expect(parsedLines).toEqual([
      { kind: "op", op: { op: "addNote", key: "k1", text: "路线图" } },
      { kind: "say", text: "已添加路线图便签" },
    ]);
  });
});
