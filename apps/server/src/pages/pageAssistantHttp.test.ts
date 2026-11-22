// FILE: pageAssistantHttp.test.ts
// Purpose: Tests GET/PUT /api/moss/pages/:pageId/assistant-thread persistence & concurrency
//          and GET /api/moss/pages/events SSE immediate refresh/undo event streaming.

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { AuthSessionId, SpaceId, ThreadId } from "@moss/contracts";
import { createDashboard } from "@moss/shared/spaceItems/dashboard";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultGroupsWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../config";
import { PagesServiceLive } from "./Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL, PagesService } from "./Services/PagesService";
import { pageAssistantEffectRouteLayer } from "./pageAssistantHttp";
import { pageUpdateSubscriberCountForTests } from "./pageEvents";
import { PageTypesService, PageTypesServiceLive } from "./types/PageTypesService";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";

function makeTestConfig(): ServerConfigShape {
  const baseDir = path.join(os.tmpdir(), `moss-page-http-${randomUUID()}`);
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
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
  } as unknown as ServerConfigShape;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function createHarness() {
  const config = makeTestConfig();
  const pageLayers = PageTypesServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const authLayer = Layer.mock(ServerAuth)({
    authenticateHttpRequest: (request) =>
      request.headers.authorization === "Bearer owner-token"
        ? Effect.succeed({
            sessionId: AuthSessionId.makeUnsafe("sess-1"),
            subject: "owner",
            method: "bearer-session-token",
            role: "owner",
            credentialSource: "bearer",
          })
        : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
  });
  const runtime = ManagedRuntime.make(pageLayers);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const pages = await runtime.runPromise(Effect.service(PagesService));
  const types = await runtime.runPromise(Effect.service(PageTypesService));
  const routeServices = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.succeed(PagesService, pages),
    Layer.succeed(PageTypesService, types),
    authLayer,
    Layer.succeed(ServerConfig, config),
  );
  const web = HttpRouter.toWebHandler(
    pageAssistantEffectRouteLayer.pipe(HttpRouter.provideRequest(routeServices)),
    { disableLogger: true },
  );
  cleanups.push(async () => {
    await web.dispose();
    await runtime.dispose();
  });

  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  const otherSpaceId = SpaceId.makeUnsafe(randomUUID());
  const projectId = randomUUID();
  const agentThreadId = ThreadId.makeUnsafe("agent-thread-1");
  const now = "2026-11-22T00:00:00.000Z";
  await runtime.runPromise(
    sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
      VALUES (${scopeSpaceId}, 'Primary', 'folder', 0, ${now}, ${now}),
             (${otherSpaceId}, 'Other', 'folder', 1, ${now}, ${now})`,
  );
  await runtime.runPromise(
    sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
      VALUES (${projectId}, 'Project', '/fixture', '[]', ${scopeSpaceId}, ${now}, ${now})`,
  );
  await runtime.runPromise(
    sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${agentThreadId}, ${projectId}, 'Agent thread', ${now}, ${now})`,
  );
  const doc = await runtime.runPromise(
    pages.mutate(
      {
        op: "create",
        requestId: randomUUID(),
        scopeSpaceId,
        title: "Bound Doc",
        content: "hello",
        spaceId: null,
        parentPageId: null,
      },
      LOCAL_PAGES_PRINCIPAL,
    ),
  );
  const dash = await runtime.runPromise(
    types.create(
      {
        requestId: randomUUID(),
        scopeSpaceId,
        kind: "app",
        title: "Metrics Dashboard",
        spaceId: null,
        parentPageId: null,
        data: JSON.stringify(createDashboard("Metrics Dashboard")),
      },
      LOCAL_PAGES_PRINCIPAL,
    ),
  );
  return { web, runtime, pages, types, scopeSpaceId, otherSpaceId, agentThreadId, doc, dash };
}

describe("page assistant thread HTTP & SSE events", () => {
  it("persists defaultAssistantThreadId idempotently and enforces scope boundaries", async () => {
    const h = await createHarness();
    const base = `http://127.0.0.1:3000/api/moss/pages/${h.doc.page.id}/assistant-thread`;
    const headers = { authorization: "Bearer owner-token", "content-type": "application/json" };

    const initial = await h.web.handler(
      new Request(`${base}?scopeSpaceId=${h.scopeSpaceId}`, { headers }),
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ pageId: h.doc.page.id, defaultAssistantThreadId: null });

    const crossScope = await h.web.handler(
      new Request(`${base}?scopeSpaceId=${h.otherSpaceId}`, { headers }),
    );
    expect(crossScope.status).toBe(404);

    const firstPut = await h.web.handler(
      new Request(base, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          scopeSpaceId: h.scopeSpaceId,
          threadId: "thread-first",
          ifUnset: true,
        }),
      }),
    );
    expect(firstPut.status).toBe(200);
    expect(await firstPut.json()).toEqual({
      pageId: h.doc.page.id,
      defaultAssistantThreadId: "thread-first",
    });

    const racePut = await h.web.handler(
      new Request(base, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          scopeSpaceId: h.scopeSpaceId,
          threadId: "thread-second",
          ifUnset: true,
        }),
      }),
    );
    expect(racePut.status).toBe(200);
    expect(await racePut.json()).toEqual({
      pageId: h.doc.page.id,
      defaultAssistantThreadId: "thread-first",
    });

    const overwritePut = await h.web.handler(
      new Request(base, {
        method: "PUT",
        headers,
        body: JSON.stringify({ scopeSpaceId: h.scopeSpaceId, threadId: "thread-explicit" }),
      }),
    );
    expect(overwritePut.status).toBe(200);
    expect(await overwritePut.json()).toEqual({
      pageId: h.doc.page.id,
      defaultAssistantThreadId: "thread-explicit",
    });

    // Updating doc revision leaves defaultAssistantThreadId intact.
    await h.runtime.runPromise(
      h.pages.mutate(
        {
          op: "update",
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: h.doc.page.id,
          expectedRevision: h.doc.page.revision,
          content: "updated",
        },
        LOCAL_PAGES_PRINCIPAL,
      ),
    );
    const reread = await h.web.handler(
      new Request(`${base}?scopeSpaceId=${h.scopeSpaceId}`, { headers }),
    );
    expect(await reread.json()).toEqual({
      pageId: h.doc.page.id,
      defaultAssistantThreadId: "thread-explicit",
    });
  });

  it("streams scoped page-updated events with rollback revisions for Docs and Dashboards", async () => {
    const h = await createHarness();
    const controller = new AbortController();
    const response = await h.web.handler(
      new Request(`http://127.0.0.1:3000/api/moss/pages/events?scopeSpaceId=${h.scopeSpaceId}`, {
        method: "GET",
        headers: { authorization: "Bearer owner-token" },
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const readChunk = async () => {
      const next = await reader.read();
      return decoder.decode(next.value ?? new Uint8Array());
    };

    const readyText = await readChunk();
    expect(readyText).toContain('"type":"ready"');

    const agentPrincipal = { kind: "agent" as const, threadId: h.agentThreadId };
    const nextDash = {
      ...createDashboard("Metrics Dashboard"),
      params: { period: "7d" },
    };
    await h.runtime.runPromise(
      h.types.save(
        {
          requestId: randomUUID(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: h.dash.page.id,
          expectedRevision: h.dash.page.revision,
          data: JSON.stringify(nextDash),
        },
        agentPrincipal,
      ),
    );

    const eventText = await readChunk();
    expect(eventText).toContain('"type":"page-updated"');
    expect(eventText).toContain(`"pageId":"${h.dash.page.id}"`);
    expect(eventText).toContain('"undoRevision":1');
    expect(eventText).toContain('"applyMode":"auto"');

    controller.abort();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pageUpdateSubscriberCountForTests()).toBe(0);
  });
});
