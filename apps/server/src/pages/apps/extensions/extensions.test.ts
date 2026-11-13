import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { assert, it } from "@effect/vitest";
import type { PageApp, PageAppAiEvent, PageAppViewer } from "@moss/contracts";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite";
import { LOCAL_OWNER_VIEWER, makePageAppsServiceShape, PageAppsService } from "../PageAppsService";
import type { PageAppExtensionDeps } from ".";
import { OPEN_POLICY, type PageAppMcpManagedPolicy } from "./mcpPolicy";
import type {
  PageAppMcpRawResult,
  PageAppMcpResolvedServer,
  PageAppMcpSession,
  PageAppMcpTool,
} from "./mcpSources";
import { makePageAppExtensionStore } from "./PageAppExtensionStore";

const fakeAi = {
  ask: async function* (): AsyncGenerator<PageAppAiEvent> {
    yield { type: "done", text: "", model: "fake" };
  },
};

const upstream = { calls: [] as string[] };
const TOOLS: PageAppMcpTool[] = [
  {
    name: "list_notes",
    title: "列出笔记",
    description: "Lists notes",
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_note",
    title: "删除笔记",
    description: "Deletes a note",
    annotations: { destructiveHint: true },
  },
  { name: "add_note", title: null, description: null, annotations: { destructiveHint: false } },
];
const notesSession: PageAppMcpSession = {
  listTools: async () => TOOLS,
  callTool: async (name, args): Promise<PageAppMcpRawResult> => {
    upstream.calls.push(name);
    return {
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}:${upstream.calls.length}` }],
      structuredContent: null,
      isError: false,
    };
  },
};
const policyBox: { current: PageAppMcpManagedPolicy } = { current: OPEN_POLICY };
const projectRoot = mkdtempSync(nodePath.join(tmpdir(), "moss-page-files-"));
mkdirSync(nodePath.join(projectRoot, "docs"));
mkdirSync(nodePath.join(projectRoot, ".git"));
writeFileSync(nodePath.join(projectRoot, "docs", "readme.md"), "# Hello\n");
writeFileSync(nodePath.join(projectRoot, ".git", "config"), "secret");
writeFileSync(nodePath.join(projectRoot, "data.csv"), "a,b\n1,2\n");

const layer = Layer.effect(
  PageAppsService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const extensions: PageAppExtensionDeps = {
      store: makePageAppExtensionStore(sql),
      sources: {
        resolve: async (server): Promise<PageAppMcpResolvedServer> =>
          server.toLowerCase() === "notes"
            ? {
                server,
                key: "local:notes",
                label: "notes",
                kind: "local",
                session: notesSession,
                reason: null,
                needsAuth: false,
              }
            : {
                server,
                key: `missing:${server}`,
                label: server,
                kind: null,
                session: null,
                reason: "not here",
                needsAuth: false,
              },
        dispose: async () => undefined,
      },
      policy: async () => policyBox.current,
      project: () => Effect.succeed({ id: "p1", title: "Demo", root: projectRoot }),
      now: () => new Date().toISOString(),
    };
    return yield* makePageAppsServiceShape({ ai: fakeAi, extensions });
  }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const tests = it.layer(layer);
const local = { kind: "local-user" } as const;
const member: PageAppViewer = { id: "m1", name: "Member", level: "interact", isOwner: false };

const MCP = { servers: [{ server: "notes", tools: ["list_notes", "delete_note", "add_note"] }] };
const create = (capabilities: Record<string, unknown>) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    return (yield* service.mutate(
      {
        op: "create",
        requestId: randomUUID(),
        scopeSpaceId: null,
        html: "<!doctype html><title>Ext</title><p>x</p>",
        capabilities,
      },
      local,
    )).app;
  });
const call = (
  app: PageApp,
  capability: string,
  method: string,
  args: unknown,
  viewer = LOCAL_OWNER_VIEWER,
) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    return (yield* service.call(
      { appId: app.id, revision: app.revision, capability, method, args },
      local,
      viewer,
    )).value as any;
  });
const code = <A, E extends { code: string }>(effect: Effect.Effect<A, E, PageAppsService>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return "ok";
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail") as
      | { error: { code: string } }
      | undefined;
    return error?.error.code ?? "defect";
  });

tests("应用页 mcp", (it) => {
  it.effect("refuses bad declarations at publish", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* code(create({ mcp: { servers: [] } })), "invalid_argument");
      assert.strictEqual(
        yield* code(create({ mcp: { servers: [{ server: "notes", tools: ["bad name!"] }] } })),
        "invalid_argument",
      );
    }),
  );

  it.effect("checks allowlist, consent, caching, destructive confirm and remember", () =>
    Effect.gen(function* () {
      upstream.calls.length = 0;
      const app = yield* create({ mcp: MCP });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "drop_all" })),
        "not_declared",
      );
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "other", tool: "list_notes" })),
        "not_declared",
      );
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "list_notes" })),
        "consent_required",
      );
      const listed = yield* call(app, "mcp", "list", null);
      assert.strictEqual(listed.servers[0].state, "prompt");
      yield* call(app, "mcp", "grant", { server: "notes", state: "granted" });

      const first = yield* call(app, "mcp", "call", {
        server: "notes",
        tool: "list_notes",
        args: { q: 1 },
      });
      assert.strictEqual(first.cache, undefined);
      const second = yield* call(app, "mcp", "call", {
        server: "notes",
        tool: "list_notes",
        args: { q: 1 },
      });
      assert.isNumber(second.cache.storedAt);
      assert.deepStrictEqual(upstream.calls, ["list_notes"]);
      yield* call(app, "mcp", "call", {
        server: "notes",
        tool: "list_notes",
        args: { q: 1 },
        cache: { refresh: true },
      });
      assert.strictEqual(upstream.calls.length, 2);
      // Arguments containing the old key separator still match exactly.
      yield* call(app, "mcp", "call", { server: "notes", tool: "list_notes", args: { q: "a|b" } });
      const other = yield* call(app, "mcp", "invalidate", { server: "other" });
      assert.strictEqual(other.dropped, 0);
      const exact = yield* call(app, "mcp", "invalidate", { server: "notes", args: { q: "a|b" } });
      assert.strictEqual(exact.dropped, 1);
      const rest = yield* call(app, "mcp", "invalidate", { server: "NOTES", tool: "list_notes" });
      assert.strictEqual(rest.dropped, 1);
      upstream.calls.length = 2;

      // Plain writes run without a prompt and are never cached.
      yield* call(app, "mcp", "call", { server: "notes", tool: "add_note", args: { text: "a" } });
      yield* call(app, "mcp", "call", { server: "notes", tool: "add_note", args: { text: "a" } });
      assert.strictEqual(upstream.calls.filter((name) => name === "add_note").length, 2);

      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "delete_note" })),
        "confirmation_required",
      );
      yield* call(app, "mcp", "call", { server: "notes", tool: "delete_note", approval: "once" });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "delete_note" })),
        "confirmation_required",
      );
      yield* call(app, "mcp", "call", {
        server: "notes",
        tool: "delete_note",
        approval: "remember",
      });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "delete_note" })),
        "ok",
      );

      // Refusing the server forgets remembered tools and blocks calls.
      yield* call(app, "mcp", "grant", { server: "notes", state: "denied" });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "list_notes" })),
        "not_granted",
      );
      yield* call(app, "mcp", "grant", { server: "notes", state: "granted" });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "delete_note" })),
        "confirmation_required",
      );

      const sql = yield* SqlClient.SqlClient;
      const audit = yield* sql<{
        outcome: string;
        target: string;
      }>`SELECT outcome, target FROM page_app_audit WHERE app_id = ${app.id}`;
      assert.isTrue(audit.some((row) => row.outcome === "cached"));
      assert.isTrue(
        audit.some((row) => row.outcome === "not_declared" && row.target === "notes/drop_all"),
      );
      assert.isTrue(
        audit.some((row) => row.outcome === "ok" && row.target === "notes/delete_note"),
      );
    }),
  );

  it.effect("serves only the owner and follows the managed policy", () =>
    Effect.gen(function* () {
      const app = yield* create({ mcp: MCP });
      yield* call(app, "mcp", "grant", { server: "notes", state: "granted" });
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "list_notes" }, member)),
        "unavailable",
      );
      policyBox.current = { ...OPEN_POLICY, blockTools: ["notes/list_*"] };
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "list_notes" })),
        "policy_blocked",
      );
      policyBox.current = { ...OPEN_POLICY, confirmTools: ["*/add_note"] };
      assert.strictEqual(
        yield* code(call(app, "mcp", "call", { server: "notes", tool: "add_note" })),
        "confirmation_required",
      );
      policyBox.current = OPEN_POLICY;
    }),
  );

  it.effect("watches read-only tools only, replaying the cache first", () =>
    Effect.gen(function* () {
      const app = yield* create({ mcp: MCP });
      yield* call(app, "mcp", "grant", { server: "notes", state: "granted" });
      yield* call(app, "mcp", "call", { server: "notes", tool: "list_notes", args: { w: 1 } });
      const service = yield* PageAppsService;
      const events = yield* service
        .watch(
          {
            appId: app.id,
            revision: app.revision,
            capability: "mcp",
            method: "watch",
            args: { server: "notes", tool: "list_notes", args: { w: 1 }, staleTime: 0 },
          },
          local,
          LOCAL_OWNER_VIEWER,
        )
        .pipe(Stream.take(2), Stream.runCollect);
      const list = [...events].map((event) => event.value as any);
      assert.isTrue(list[0].result.cache.revalidating);
      assert.strictEqual(list[1].result.cache, undefined);
      const refused = yield* service
        .watch(
          {
            appId: app.id,
            revision: app.revision,
            capability: "mcp",
            method: "watch",
            args: { server: "notes", tool: "delete_note" },
          },
          local,
          LOCAL_OWNER_VIEWER,
        )
        .pipe(Stream.runCollect, Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
    }),
  );
});

tests("应用页 files", (it) => {
  it.effect("lists and reads the project without .git, refuses escapes", () =>
    Effect.gen(function* () {
      const app = yield* create({ files: {} });
      const service = yield* PageAppsService;
      yield* service.consent(
        { op: "set", appId: app.id, capability: "files", state: "granted" },
        LOCAL_OWNER_VIEWER,
      );
      const top = yield* call(app, "files", "list", {});
      assert.deepStrictEqual(
        top.entries.map((entry: { path: string }) => entry.path),
        ["data.csv", "docs"],
      );
      const all = yield* call(app, "files", "list", { recursive: true });
      assert.isTrue(all.entries.some((entry: { path: string }) => entry.path === "docs/readme.md"));
      const read = yield* call(app, "files", "read", { path: "docs/readme.md" });
      assert.strictEqual(Buffer.from(read.base64, "base64").toString(), "# Hello\n");
      const part = yield* call(app, "files", "read", { path: "data.csv", offset: 4, length: 3 });
      assert.strictEqual(Buffer.from(part.base64, "base64").toString(), "1,2");
      assert.strictEqual(
        yield* code(call(app, "files", "read", { path: "../outside" })),
        "invalid_argument",
      );
      assert.strictEqual(
        yield* code(call(app, "files", "read", { path: ".git/config" })),
        "not_found",
      );
      assert.strictEqual(yield* code(call(app, "files", "list", {}, member)), "not_granted");
    }),
  );
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==",
  "base64",
);
const upload = (
  app: PageApp,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  viewer = LOCAL_OWNER_VIEWER,
) =>
  Effect.gen(function* () {
    const begun = yield* call(
      app,
      "assets",
      "begin",
      { name, mimeType, size: bytes.byteLength },
      viewer,
    );
    yield* call(
      app,
      "assets",
      "chunk",
      { uploadId: begun.uploadId, base64: Buffer.from(bytes).toString("base64") },
      viewer,
    );
    return yield* call(app, "assets", "finish", { uploadId: begun.uploadId }, viewer);
  });

tests("应用页 assets", (it) => {
  it.effect("uploads checked files, sanitizes SVG, lists and deletes", () =>
    Effect.gen(function* () {
      const app = yield* create({ assets: {} });
      const asset = yield* upload(app, "dot.png", "image/png", png);
      assert.strictEqual(asset.size, png.byteLength);
      assert.strictEqual(asset.path, `/__moss_app/asset/${asset.id}`);
      assert.strictEqual(
        yield* code(upload(app, "fake.png", "image/png", Buffer.from("hello"))),
        "invalid_argument",
      );
      assert.strictEqual(
        yield* code(upload(app, "x.exe", "application/x-msdownload", Buffer.from("MZ"))),
        "invalid_argument",
      );
      const svg = yield* upload(
        app,
        "a.svg",
        "image/svg+xml",
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>',
        ),
      );
      const read = yield* call(app, "assets", "read", { id: svg.id });
      const text = Buffer.from(read.base64, "base64").toString();
      assert.notInclude(text, "script");
      assert.notInclude(text, "onload");
      assert.include(text, "<rect");
      assert.strictEqual(
        yield* code(upload(app, "m.png", "image/png", png, member)),
        "not_granted",
      );
      const listed = yield* call(app, "assets", "list", null);
      assert.strictEqual(listed.assets.length, 2);
      assert.isTrue((yield* call(app, "assets", "delete", { id: asset.id })).deleted);
      assert.strictEqual((yield* call(app, "assets", "list", null)).assets.length, 1);
    }),
  );
});

/** Lets forked joins run until the room holds `count` peers (the test clock never advances sleeps). */
const untilPeers = (app: PageApp, count: number) =>
  Effect.gen(function* () {
    for (let round = 0; round < 500; round += 1) {
      if ((yield* call(app, "room", "peers", null)).peers.length === count) return;
      yield* Effect.yieldNow;
    }
  });

tests("应用页 room", (it) => {
  it.effect("relays presence and events between windows, with topic limits", () =>
    Effect.gen(function* () {
      const app = yield* create({ room: { topics: { admin: { publish: "owner" } } } });
      const service = yield* PageAppsService;
      for (const viewer of [LOCAL_OWNER_VIEWER, member])
        yield* service.consent(
          { op: "set", appId: app.id, capability: "room", state: "granted" },
          viewer,
        );
      const join = (viewer: PageAppViewer, take: number) =>
        service
          .watch(
            {
              appId: app.id,
              revision: app.revision,
              capability: "room",
              method: "join",
              args: { state: { name: viewer.name } },
            },
            local,
            viewer,
          )
          .pipe(Stream.take(take), Stream.runCollect, Effect.forkChild);
      // Window A: welcome, peers (B joined), event from B.
      const a = yield* join(LOCAL_OWNER_VIEWER, 3);
      yield* untilPeers(app, 1);
      const peersBefore = yield* call(app, "room", "peers", null);
      assert.strictEqual(peersBefore.peers.length, 1);
      // Window B: welcome only; it then publishes.
      const bEvents = service
        .watch(
          { appId: app.id, revision: app.revision, capability: "room", method: "join", args: {} },
          local,
          member,
        )
        .pipe(
          Stream.tap((event) =>
            (event.value as any).type === "welcome"
              ? Effect.gen(function* () {
                  const peerId = (event.value as any).peerId;
                  assert.strictEqual(
                    yield* code(
                      call(app, "room", "publish", { peerId, topic: "admin", data: 1 }, member),
                    ),
                    "not_granted",
                  );
                  assert.strictEqual(
                    yield* code(
                      call(
                        app,
                        "room",
                        "publish",
                        { peerId: "nope", topic: "cursor", data: 1 },
                        member,
                      ),
                    ),
                    "not_found",
                  );
                  yield* call(
                    app,
                    "room",
                    "publish",
                    { peerId, topic: "cursor", data: { x: 5 } },
                    member,
                  );
                })
              : Effect.void,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
      yield* bEvents;
      const events = [...(yield* Fiber.join(a))].map((event) => event.value as any);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["welcome", "peers", "event"],
      );
      assert.deepStrictEqual(events[2].data, { x: 5 });
      assert.strictEqual(events[2].from.name, "Member");
      yield* untilPeers(app, 0);
      assert.strictEqual((yield* call(app, "room", "peers", null)).peers.length, 0);
    }),
  );
});

tests("应用页 comments", (it) => {
  it.effect("adds, lists, resolves and deletes with the right people", () =>
    Effect.gen(function* () {
      const app = yield* create({ comments: {} });
      const anchor = { target: "#total", label: "Total", x: 0.5, y: 0.5, quote: null };
      const added = yield* call(app, "comments", "add", { anchor, body: "Check this" }, member);
      assert.isTrue(added.comment.mine);
      assert.strictEqual(
        yield* code(call(app, "comments", "add", { anchor, body: "  " })),
        "invalid_argument",
      );
      const listed = yield* call(app, "comments", "list", null);
      assert.strictEqual(listed.comments.length, 1);
      assert.isFalse(listed.comments[0].mine);
      yield* call(app, "comments", "resolve", { id: added.comment.id });
      assert.isString((yield* call(app, "comments", "list", null)).comments[0].resolvedAt);
      const viewerOnly: PageAppViewer = { id: "v1", name: "V", level: "view", isOwner: false };
      assert.strictEqual(
        yield* code(call(app, "comments", "delete", { id: added.comment.id }, viewerOnly)),
        "not_granted",
      );
      assert.strictEqual(
        yield* code(call(app, "comments", "add", { anchor, body: "x" }, viewerOnly)),
        "not_granted",
      );
      yield* call(app, "comments", "delete", { id: added.comment.id });
      assert.strictEqual((yield* call(app, "comments", "list", null)).comments.length, 0);
    }),
  );
});
