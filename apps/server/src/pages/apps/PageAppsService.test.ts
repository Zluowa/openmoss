import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import type { PageApp, PageAppAiEvent, PageAppId } from "@moss/contracts";
import { Effect, Exit, Layer, Stream } from "effect";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { makePageAppsServiceShape, PageAppsService, LOCAL_OWNER_VIEWER } from "./PageAppsService";

const fakeAi = {
  ask: async function* (): AsyncGenerator<PageAppAiEvent> {
    yield { type: "text", delta: "Hel" };
    yield { type: "text", delta: "lo" };
    yield { type: "done", text: "Hello", model: "fake-model" };
  },
};

const layer = Layer.effect(PageAppsService, makePageAppsServiceShape({ ai: fakeAi })).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const tests = it.layer(layer);
const local = { kind: "local-user" } as const;
const member = { id: "m1", name: "Member", level: "interact", isOwner: false } as const;
const html = (body = "<p>hi</p>") =>
  `<!doctype html><html><head><title>Tracker</title></head><body>${body}</body></html>`;

const create = (capabilities: Record<string, unknown> = { db: {}, ai: {} }, source = html()) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    return (yield* service.mutate(
      { op: "create", requestId: randomUUID(), scopeSpaceId: null, html: source, capabilities },
      local,
    )).app;
  });
const grant = (app: PageApp, capability: string, viewer = LOCAL_OWNER_VIEWER) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    yield* service.consent({ op: "set", appId: app.id, capability, state: "granted" }, viewer);
  });
const dbCall = (app: PageApp, method: string, args: unknown, viewer = LOCAL_OWNER_VIEWER) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    return (yield* service.call(
      { appId: app.id, revision: app.revision, capability: "db", method, args },
      local,
      viewer,
    )).value;
  });

tests("PageAppsService", (it) => {
  it.effect("stores a preview without invalidating a frame, and clears it on content changes", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      let app = yield* create();
      const thumbnail =
        "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKwA//9k=";
      const initial = app;
      const capture = {
        op: "set-thumbnail",
        requestId: randomUUID(),
        appId: app.id,
        expectedRevision: app.revision,
        thumbnail,
      } as const;
      app = (yield* service.mutate(capture, local)).app;
      assert.equal(app.revision, initial.revision);
      assert.equal(app.updatedAt, initial.updatedAt);
      assert.equal(app.thumbnail, thumbnail);
      assert.equal((yield* service.versions({ appId: app.id }, local)).versions.length, 1);
      assert.equal((yield* service.read({ appId: app.id }, local)).app.thumbnail, thumbnail);
      assert.equal(
        (yield* service.frameContent(app.id, initial.revision)).revision,
        initial.revision,
      );
      app = (yield* service.mutate(
        {
          op: "update",
          requestId: randomUUID(),
          appId: app.id,
          expectedRevision: app.revision,
          html: html("Changed"),
        },
        local,
      )).app;
      assert.isNull(app.thumbnail);
      const stale = yield* Effect.exit(
        service.mutate({ ...capture, requestId: randomUUID() }, local),
      );
      assert.isTrue(Exit.isFailure(stale));
      app = (yield* service.mutate(
        { ...capture, requestId: randomUUID(), expectedRevision: app.revision },
        local,
      )).app;
      app = (yield* service.mutate(
        {
          op: "restore-version",
          requestId: randomUUID(),
          appId: app.id,
          expectedRevision: app.revision,
          revision: initial.revision,
        },
        local,
      )).app;
      assert.isNull(app.thumbnail);
      app = (yield* service.mutate(
        { op: "trash", requestId: randomUUID(), appId: app.id, expectedRevision: app.revision },
        local,
      )).app;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            service.mutate(
              { ...capture, requestId: randomUUID(), expectedRevision: app.revision },
              local,
            ),
          ),
        ),
      );
    }),
  );

  it.effect("creates with title from <title>, writes the manifest, and is idempotent", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const requestId = randomUUID();
      const input = {
        op: "create",
        requestId,
        scopeSpaceId: null,
        html: html(),
        capabilities: { db: {} },
      } as const;
      const first = yield* service.mutate(input, local);
      const again = yield* service.mutate(input, local);
      assert.equal(first.app.id, again.app.id);
      assert.equal(first.app.title, "Tracker");
      assert.deepEqual(first.app.capabilities, { db: {} });
      const read = yield* service.read({ appId: first.app.id }, local);
      assert.include(read.html, 'id="moss-app-manifest"');
      const conflict = yield* Effect.exit(service.mutate({ ...input, html: html("other") }, local));
      assert.isTrue(Exit.isFailure(conflict));
    }),
  );

  it.effect("rejects unknown capabilities and invalid db rules", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.exit(create({ teleport: {} }));
      assert.isTrue(Exit.isFailure(unknown));
      const badRules = yield* Effect.exit(
        create({ db: { rules: [{ path: "a", read: "admin", write: "view" }] } }),
      );
      assert.isTrue(Exit.isFailure(badRules));
    }),
  );

  it.effect("versions every content change, restores, and keeps at most 100", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      let app = yield* create();
      app = (yield* service.mutate(
        {
          op: "rename",
          requestId: randomUUID(),
          appId: app.id,
          expectedRevision: app.revision,
          title: "Renamed",
        },
        local,
      )).app;
      assert.equal(app.title, "Renamed");
      assert.include((yield* service.read({ appId: app.id }, local)).html, '"title": "Renamed"');
      const stale = yield* Effect.exit(
        service.mutate(
          {
            op: "favorite",
            requestId: randomUUID(),
            appId: app.id,
            expectedRevision: 1,
            favorite: true,
          },
          local,
        ),
      );
      assert.isTrue(Exit.isFailure(stale));
      for (let i = 0; i < 101; i++) {
        app = (yield* service.mutate(
          {
            op: "update",
            requestId: randomUUID(),
            appId: app.id,
            expectedRevision: app.revision,
            html: html(`<p>${i}</p>`),
          },
          local,
        )).app;
      }
      const versions = yield* service.versions({ appId: app.id, limit: 100 }, local);
      assert.equal(versions.versions.length, 100);
      assert.equal(versions.versions[0]!.revision, app.revision);
      // A new version keeps the declared capabilities unless the HTML says otherwise.
      assert.deepEqual(app.capabilities, { db: {}, ai: {} });
      const oldest = versions.versions.at(-1)!.revision;
      app = (yield* service.mutate(
        {
          op: "restore-version",
          requestId: randomUUID(),
          appId: app.id,
          expectedRevision: app.revision,
          revision: oldest,
        },
        local,
      )).app;
      assert.include((yield* service.read({ appId: app.id }, local)).html, `<p>${oldest - 3}</p>`);
    }),
  );

  it.effect("favorite, trash and restore; trashed pages stop serving", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      let app = yield* create();
      const base = () => ({
        requestId: randomUUID(),
        appId: app.id,
        expectedRevision: app.revision,
      });
      app = (yield* service.mutate({ op: "favorite", ...base(), favorite: true }, local)).app;
      assert.isTrue(app.favorite);
      app = (yield* service.mutate({ op: "trash", ...base() }, local)).app;
      assert.isNotNull(app.trashedAt);
      const listed = yield* service.list({ scopeSpaceId: null }, local);
      assert.isFalse(listed.apps.some((item) => item.id === app.id));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.frameContent(app.id, app.revision))));
      app = (yield* service.mutate({ op: "restore", ...base() }, local)).app;
      assert.isNull(app.trashedAt);
    }),
  );

  it.effect("db needs declaration and a stored grant", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const noDb = yield* create({ ai: {} });
      const undeclared = yield* Effect.exit(dbCall(noDb, "get", { path: "a/b" }));
      assert.isTrue(
        Exit.isFailure(undeclared) && JSON.stringify(undeclared).includes("not_declared"),
      );
      const app = yield* create();
      const ungranted = yield* Effect.exit(dbCall(app, "get", { path: "a/b" }));
      assert.isTrue(Exit.isFailure(ungranted) && JSON.stringify(ungranted).includes("not_granted"));
      yield* grant(app, "db");
      yield* dbCall(app, "set", { path: "tasks/t1", data: { title: "One", n: 2 } });
      yield* dbCall(app, "set", { path: "tasks/t2", data: { title: "Two", n: 1 } });
      yield* dbCall(app, "update", { path: "tasks/t1", data: { done: true } });
      const doc = (yield* dbCall(app, "get", { path: "tasks/t1" })) as {
        data: Record<string, unknown>;
      };
      assert.deepEqual(doc.data, { title: "One", n: 2, done: true });
      const query = (yield* dbCall(app, "query", {
        collection: "tasks",
        orderBy: { field: "n", dir: "asc" },
        where: [{ field: "n", op: ">=", value: 1 }],
      })) as { docs: { id: string }[] };
      assert.deepEqual(
        query.docs.map((d) => d.id),
        ["t2", "t1"],
      );
      const missingUpdate = yield* Effect.exit(
        dbCall(app, "update", { path: "tasks/zz", data: {} }),
      );
      assert.isTrue(Exit.isFailure(missingUpdate));
      const badBody = yield* Effect.exit(dbCall(app, "set", { path: "tasks/t3", data: [1] }));
      assert.isTrue(Exit.isFailure(badBody));
      yield* dbCall(app, "delete", { path: "tasks/t2" });
      const after = (yield* dbCall(app, "query", { collection: "tasks" })) as { docs: unknown[] };
      assert.equal(after.docs.length, 1);
      // The owner cannot read a member's private subtree.
      yield* grant(app, "db", member);
      yield* dbCall(app, "set", { path: "data/users/m1/n1", data: { secret: 1 } }, member);
      const hidden = (yield* dbCall(app, "get", { path: "data/users/m1/n1" })) as {
        exists: boolean;
      };
      assert.isFalse(hidden.exists);
      void service;
    }),
  );

  it.effect("db rules reject writes below the declared level", () =>
    Effect.gen(function* () {
      const app = yield* create({ db: { rules: [{ path: "", write: "admin" }] } });
      yield* grant(app, "db", member);
      const denied = yield* Effect.exit(
        dbCall(app, "set", { path: "tasks/t1", data: { a: 1 } }, member),
      );
      assert.isTrue(Exit.isFailure(denied) && JSON.stringify(denied).includes("invalid_argument"));
    }),
  );

  it.effect("db watch emits the current value, then changes", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const app = yield* create();
      yield* grant(app, "db");
      const first = yield* service
        .watch(
          {
            appId: app.id,
            revision: app.revision,
            capability: "db",
            method: "watchQuery",
            args: { collection: "items" },
          },
          local,
          LOCAL_OWNER_VIEWER,
        )
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual((Array.from(first)[0]!.value as { docs: unknown[] }).docs, []);
    }),
  );

  it.effect("ai streams text and needs consent", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const app = yield* create();
      const watch = () =>
        service
          .watch(
            {
              appId: app.id,
              revision: app.revision,
              capability: "ai",
              method: "ask",
              args: { input: "hi" },
            },
            local,
            LOCAL_OWNER_VIEWER,
          )
          .pipe(Stream.runCollect);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(watch())));
      yield* grant(app, "ai");
      const events = Array.from(yield* watch()).map((event) => event.value);
      assert.deepEqual(events.at(-1), { type: "done", text: "Hello", model: "fake-model" });
    }),
  );

  it.effect("page.publish republishes as a new version", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const app = yield* create({ page: {} });
      const result = (yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "page",
          method: "publish",
          args: { html: html("<p>v2</p>") },
        },
        local,
        LOCAL_OWNER_VIEWER,
      )).value as { revision: number };
      assert.equal(result.revision, 2);
      const denied = yield* Effect.exit(
        service.call(
          {
            appId: app.id,
            revision: 2,
            capability: "page",
            method: "publish",
            args: { html: html() },
          },
          local,
          member,
        ),
      );
      assert.isTrue(Exit.isFailure(denied));
    }),
  );

  it.effect("frame tokens verify, expire and resist tampering", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const payload = {
        appId: "app" as PageAppId,
        revision: 1,
        parentOrigin: "http://127.0.0.1:6010",
        mode: "full" as const,
        expiresAt: Date.now() + 60_000,
      };
      const token = service.mintFrameToken(payload);
      assert.deepEqual(service.verifyFrameToken(token), payload);
      assert.isNull(service.verifyFrameToken(token, payload.expiresAt + 1));
      const [body, mac] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({ a: "other", r: 1, o: "x", m: "full", e: payload.expiresAt }),
      ).toString("base64url");
      assert.isNull(service.verifyFrameToken(`${forged}.${mac}`));
      assert.isNull(service.verifyFrameToken(`${body}.`));
    }),
  );
});
