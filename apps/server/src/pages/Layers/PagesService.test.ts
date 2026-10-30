import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { AutomationId, SpaceId, ThreadId, type Page, type PageSpaceId } from "@synara/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { makePagesServiceShape, PagesServiceLive } from "./PagesService";

const tests = it.layer(PagesServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-10-25T00:00:00.000Z";
const requestId = () => randomUUID();
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* PagesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Pages test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const create = (
    title: string,
    options: { parentPageId?: Page["id"]; spaceId?: PageSpaceId; content?: string } = {},
  ) =>
    service.mutate(
      {
        op: "create",
        requestId: requestId(),
        scopeSpaceId,
        title,
        content: options.content ?? "",
        parentPageId: options.parentPageId ?? null,
        spaceId: options.spaceId ?? null,
      },
      user,
    );
  const change = (page: Page, op: "trash" | "restore" | "trash-space" | "restore-space") =>
    service.mutate(
      {
        op,
        requestId: requestId(),
        scopeSpaceId,
        pageId: page.id,
        expectedRevision: page.revision,
      },
      user,
    );
  const seedThread = (scope: SpaceId | null) =>
    Effect.gen(function* () {
      const projectId = randomUUID();
      const threadId = ThreadId.makeUnsafe(randomUUID());
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
      VALUES (${projectId}, 'Test project', '/fixture', '[]', ${scope}, ${timestamp}, ${timestamp})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Test conversation', ${timestamp}, ${timestamp})`;
      return { threadId, projectId };
    });
  return { service, sql, scopeSpaceId, create, change, seedThread };
});

tests("Pages durable local documents", (it) => {
  it.effect(
    "creates an independent document space and editable root, and reconstructs persisted bodies",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const created = yield* h.service.mutate(
          {
            op: "create-space",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Research",
            content: "# Real saved document",
          },
          user,
        );
        assert.ok(created.space);
        assert.notStrictEqual(String(created.space.id), String(h.scopeSpaceId));
        assert.strictEqual(created.page.rootPageId, created.page.id);
        assert.strictEqual(created.page.spaceId, created.space.id);
        const renamed = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            title: "Field notes",
            content: "Durable notes",
          },
          user,
        );
        const reconstructed = yield* makePagesServiceShape();
        assert.strictEqual(
          (yield* reconstructed.read(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).content,
          "Durable notes",
        );
        assert.strictEqual(
          (yield* reconstructed.spaces({ scopeSpaceId: h.scopeSpaceId }, user)).spaces[0]?.title,
          "Field notes",
        );
        assert.strictEqual(renamed.space?.revision, 2);
        assert.strictEqual(
          (yield* reconstructed.read(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id, revision: 1 },
            user,
          )).content,
          "# Real saved document",
        );
      }),
  );

  it.effect(
    "uses request identity for retries and rejects a different payload using the same identity",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const input = {
          op: "create" as const,
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Once",
          content: "saved",
          spaceId: null,
          parentPageId: null,
        };
        const first = yield* h.service.mutate(input, user);
        assert.deepStrictEqual(yield* h.service.mutate(input, user), first);
        const conflict = yield* Effect.flip(
          h.service.mutate({ ...input, title: "Different" }, user),
        );
        assert.strictEqual(conflict.code, "conflict");
        assert.strictEqual(
          (yield* h.service.list({ scopeSpaceId: h.scopeSpaceId }, user)).pages.length,
          1,
        );
      }),
  );

  it.effect(
    "allows one concurrent revision writer and retains both the successful body and old version",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const created = yield* h.create("Concurrent", { content: "before" });
        const exits = yield* Effect.all(
          ["A", "B"].map((content) =>
            Effect.exit(
              h.service.mutate(
                {
                  op: "update",
                  requestId: requestId(),
                  scopeSpaceId: h.scopeSpaceId,
                  pageId: created.page.id,
                  expectedRevision: 1,
                  content,
                },
                user,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(exits.filter(Exit.isSuccess).length, 1);
        assert.strictEqual(exits.filter(Exit.isFailure).length, 1);
        const current = yield* h.service.read(
          { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
          user,
        );
        assert.ok(current.content === "A" || current.content === "B");
        assert.strictEqual(current.page.revision, 2);
        assert.strictEqual(
          (yield* h.service.versions(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).versions.length,
          2,
        );
      }),
  );

  it.effect(
    "moves an entire tree, rejects cycles, and preserves independently trashed descendants on parent restore",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const root = yield* h.create("Root");
        const child = yield* h.create("Child", { parentPageId: root.page.id });
        const grandchild = yield* h.create("Grandchild", { parentPageId: child.page.id });
        const cycle = yield* Effect.flip(
          h.service.mutate(
            {
              op: "move",
              requestId: requestId(),
              scopeSpaceId: h.scopeSpaceId,
              pageId: root.page.id,
              expectedRevision: 1,
              parentPageId: grandchild.page.id,
              spaceId: null,
            },
            user,
          ),
        );
        assert.strictEqual(cycle.code, "cycle");
        const destination = yield* h.service.mutate(
          {
            op: "create-space",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Destination",
          },
          user,
        );
        assert.ok(destination.space);
        const moved = yield* h.service.mutate(
          {
            op: "move",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: root.page.id,
            expectedRevision: 1,
            parentPageId: null,
            spaceId: destination.space.id,
          },
          user,
        );
        assert.strictEqual(moved.affectedPageIds.length, 3);
        const movedChild = yield* h.service.read(
          { scopeSpaceId: h.scopeSpaceId, pageId: child.page.id },
          user,
        );
        assert.strictEqual(movedChild.page.rootPageId, destination.page.id);
        assert.strictEqual(movedChild.page.spaceId, destination.space.id);
        yield* h.change(movedChild.page, "trash");
        const trashed = yield* h.change(moved.page, "trash");
        yield* h.change(trashed.page, "restore");
        const visible = (yield* h.service.list({ scopeSpaceId: h.scopeSpaceId }, user)).pages;
        assert.ok(visible.some((page) => page.id === root.page.id));
        assert.ok(
          !visible.some((page) => page.id === child.page.id || page.id === grandchild.page.id),
        );
      }),
  );

  it.effect(
    "protects document-space roots while providing explicit space trash and restoration",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const created = yield* h.service.mutate(
          {
            op: "create-space",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Space",
          },
          user,
        );
        assert.strictEqual((yield* Effect.flip(h.change(created.page, "trash"))).code, "invalid");
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.mutate(
              {
                op: "move",
                requestId: requestId(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: created.page.id,
                expectedRevision: 1,
                spaceId: null,
                parentPageId: null,
              },
              user,
            ),
          )).code,
          "invalid",
        );
        const trashed = yield* h.change(created.page, "trash-space");
        assert.ok(trashed.space?.trashedAt);
        const restored = yield* h.change(trashed.page, "restore-space");
        assert.strictEqual(restored.space?.trashedAt, null);
      }),
  );

  it.effect(
    "derives agent authorization from the active caller conversation and rejects cross-space reads and sources",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const own = yield* h.seedThread(h.scopeSpaceId);
        const foreign = yield* h.seedThread(null);
        const created = yield* h.create("Private");
        const agent = { kind: "agent" as const, threadId: own.threadId };
        assert.strictEqual(
          (yield* h.service.read({ scopeSpaceId: h.scopeSpaceId, pageId: created.page.id }, agent))
            .page.id,
          created.page.id,
        );
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.read(
              { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
              { kind: "agent", threadId: foreign.threadId },
            ),
          )).code,
          "forbidden",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.mutate(
              {
                op: "update",
                requestId: requestId(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: created.page.id,
                expectedRevision: 1,
                sourceThreadId: foreign.threadId,
              },
              agent,
            ),
          )).code,
          "forbidden",
        );
        yield* h.sql`UPDATE projection_threads SET archived_at = ${timestamp} WHERE thread_id = ${own.threadId}`;
        assert.strictEqual(
          (yield* Effect.flip(h.service.list({ scopeSpaceId: h.scopeSpaceId }, agent))).code,
          "forbidden",
        );
      }),
  );

  it.effect(
    "persists trusted comments, pins, and body restoration without rewinding current tree placement",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const caller = yield* h.seedThread(h.scopeSpaceId);
        const created = yield* h.create("First title", { content: "first body" });
        const updated = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            content: "second body",
            title: "Second title",
          },
          user,
        );
        const commented = yield* h.service.mutate(
          {
            op: "comment",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: updated.page.revision,
            content: "Reviewed",
          },
          { kind: "agent", threadId: caller.threadId },
        );
        assert.strictEqual(commented.comment?.authorThreadId, caller.threadId);
        const pinned = yield* h.service.mutate(
          {
            op: "pin",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: commented.page.revision,
            pinned: true,
          },
          user,
        );
        const restored = yield* h.service.mutate(
          {
            op: "restore-version",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: pinned.page.revision,
            revision: 1,
          },
          user,
        );
        assert.strictEqual(restored.content, "first body");
        assert.strictEqual(restored.page.title, "First title");
        assert.strictEqual(restored.page.pinned, true);
        assert.strictEqual(
          (yield* h.service.comments(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).comments.length,
          1,
        );
        const history = yield* h.service.versions(
          { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id, limit: 2 },
          user,
        );
        assert.deepStrictEqual(
          history.versions.map((entry) => entry.page.revision),
          [5, 4],
        );
      }),
  );

  it.effect(
    "uses Library asset references with explicit scope checks and never copies or mutates source assets",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const caller = yield* h.seedThread(h.scopeSpaceId);
        const assetId = randomUUID();
        yield* h.sql`INSERT INTO library_items (item_id, title, kind, source, source_cli, path, created_at, updated_at)
      VALUES (${assetId}, 'Local notes', 'document', 'user:import', 'moss', '/read-only-source.md', ${timestamp}, ${timestamp})`;
        const created = yield* h.create("Attachments");
        const agent = { kind: "agent" as const, threadId: caller.threadId };
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.mutate(
              {
                op: "update",
                requestId: requestId(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: created.page.id,
                expectedRevision: 1,
                assetIds: [assetId],
              },
              agent,
            ),
          )).code,
          "forbidden",
        );
        const attached = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            assetIds: [assetId],
          },
          user,
        );
        const edited = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: attached.page.revision,
            content: "agent edit",
          },
          agent,
        );
        assert.deepStrictEqual(edited.page.assetIds, [assetId]);
        const rows = yield* h.sql<{
          path: string;
        }>`SELECT path FROM library_items WHERE item_id = ${assetId}`;
        assert.strictEqual(rows[0]?.path, "/read-only-source.md");
      }),
  );

  it.effect(
    "attaches only existing same-scope automations with CAS and never enables or schedules them",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const caller = yield* h.seedThread(h.scopeSpaceId);
        const automationId = AutomationId.makeUnsafe(randomUUID());
        yield* h.sql`INSERT INTO automation_definitions (automation_id, project_id, name, prompt, schedule_json, enabled,
      model_selection_json, runtime_mode, interaction_mode, worktree_mode, mode, stop_on_error,
      minimum_interval_seconds, retry_policy_json, misfire_policy, acknowledged_risks_json, iteration_count, created_at, updated_at)
      VALUES (${automationId}, ${caller.projectId}, 'Page maintenance', 'Update page', '{}', 0,
        '{}', 'approval-required', 'default', 'none', 'recurring', 1, 60, '{}', 'skip', '[]', 0, ${timestamp}, ${timestamp})`;
        const created = yield* h.create("Scheduled page");
        const attached = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            automationIds: [automationId],
          },
          user,
        );
        assert.deepStrictEqual(attached.page.automationIds, [automationId]);
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.mutate(
              {
                op: "update",
                requestId: requestId(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: created.page.id,
                expectedRevision: 1,
                automationIds: [],
              },
              user,
            ),
          )).code,
          "conflict",
        );
        const rows = yield* h.sql<{
          enabled: number;
          next_run_at: string | null;
        }>`SELECT enabled, next_run_at FROM automation_definitions WHERE automation_id = ${automationId}`;
        assert.strictEqual(rows[0]?.enabled, 0);
        assert.strictEqual(rows[0]?.next_run_at, null);
      }),
  );

  it.effect(
    "persists canonical rich nodes, projects their real text, and keeps rich versions across service reconstruction",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const ast = [
          { type: "h1", children: [{ text: "Rich title" }] },
          {
            type: "future-widget",
            metadata: { stable: "preserved" },
            children: [{ text: "Durable body" }],
          },
        ];
        const created = yield* h.service.mutate(
          {
            op: "create",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Rich",
            spaceId: null,
            parentPageId: null,
            richContent: JSON.stringify(ast),
            content: "Untrusted stale projection",
          },
          user,
        );
        assert.deepStrictEqual(JSON.parse(created.richContent!), ast);
        assert.ok(created.content.includes("# Rich title"));
        assert.ok(created.content.includes("Durable body"));
        assert.ok(!created.content.includes("Untrusted stale projection"));
        const renamed = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            title: "Renamed rich",
          },
          user,
        );
        const reconstructed = yield* makePagesServiceShape();
        assert.strictEqual(
          (yield* reconstructed.read(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).richContent,
          created.richContent,
        );
        const history = yield* reconstructed.versions(
          { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
          user,
        );
        assert.deepStrictEqual(
          history.versions.map((entry) => entry.richContent),
          [created.richContent, created.richContent],
        );
        assert.strictEqual(renamed.richContent, created.richContent);
      }),
  );

  it.effect(
    "rejects silent rich-to-text downgrades, permits explicit conversion and restores the original rich version",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const richContent = JSON.stringify([
          { type: "p", children: [{ text: "Rich original", bold: true }] },
        ]);
        const created = yield* h.service.mutate(
          {
            op: "create-space",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Rich space",
            richContent,
          },
          user,
        );
        const rejected = yield* Effect.flip(
          h.service.mutate(
            {
              op: "update",
              requestId: requestId(),
              scopeSpaceId: h.scopeSpaceId,
              pageId: created.page.id,
              expectedRevision: 1,
              content: "would lose marks",
            },
            user,
          ),
        );
        assert.strictEqual(rejected.code, "invalid");
        assert.ok(rejected.message.includes("richContent: null"));
        assert.strictEqual(
          (yield* h.service.read({ scopeSpaceId: h.scopeSpaceId, pageId: created.page.id }, user))
            .page.revision,
          1,
        );
        const plain = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            content: "Explicit Markdown",
            richContent: null,
          },
          user,
        );
        assert.strictEqual(plain.richContent, undefined);
        assert.strictEqual(plain.content, "Explicit Markdown");
        const restored = yield* h.service.mutate(
          {
            op: "restore-version",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 2,
            revision: 1,
          },
          user,
        );
        assert.strictEqual(restored.richContent, richContent);
        assert.strictEqual(restored.content, "**Rich original**");
        assert.strictEqual(restored.page.revision, 3);
      }),
  );

  it.effect("preserves rich bodies through move, pin, trash, restore and comments", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const parent = yield* h.create("Parent");
      const richContent = JSON.stringify([
        { type: "p", children: [{ text: "Keep this rich node", italic: true }] },
      ]);
      let result = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Rich child",
          spaceId: null,
          parentPageId: null,
          richContent,
        },
        user,
      );
      result = yield* h.service.mutate(
        {
          op: "move",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: result.page.id,
          expectedRevision: result.page.revision,
          spaceId: null,
          parentPageId: parent.page.id,
        },
        user,
      );
      result = yield* h.service.mutate(
        {
          op: "pin",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: result.page.id,
          expectedRevision: result.page.revision,
          pinned: true,
        },
        user,
      );
      result = yield* h.change(result.page, "trash");
      result = yield* h.change(result.page, "restore");
      result = yield* h.service.mutate(
        {
          op: "comment",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: result.page.id,
          expectedRevision: result.page.revision,
          content: "A comment",
        },
        user,
      );
      assert.strictEqual(result.richContent, richContent);
      const versions = yield* h.service.versions(
        { scopeSpaceId: h.scopeSpaceId, pageId: result.page.id },
        user,
      );
      assert.ok(versions.versions.every((entry) => entry.richContent === richContent));
    }),
  );

  it.effect(
    "retains rich CAS and idempotent request identity, with invalid rich input rolled back",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const caller = yield* h.seedThread(h.scopeSpaceId);
        const agent = { kind: "agent" as const, threadId: caller.threadId };
        const input = {
          op: "create" as const,
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "CLI rich",
          spaceId: null,
          parentPageId: null,
          richContent: JSON.stringify([{ type: "p", children: [{ text: "From caller" }] }]),
        };
        const created = yield* h.service.mutate(input, agent);
        assert.strictEqual(created.page.sourceThreadId, caller.threadId);
        assert.deepStrictEqual(yield* h.service.mutate(input, agent), created);
        const changed = yield* h.service.mutate(
          {
            op: "update",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            richContent: JSON.stringify([{ type: "p", children: [{ text: "Changed" }] }]),
          },
          agent,
        );
        assert.strictEqual(
          (yield* Effect.flip(
            h.service.mutate(
              {
                op: "update",
                requestId: requestId(),
                scopeSpaceId: h.scopeSpaceId,
                pageId: created.page.id,
                expectedRevision: 1,
                richContent: input.richContent,
              },
              agent,
            ),
          )).code,
          "conflict",
        );
        const invalid = yield* Effect.flip(
          h.service.mutate(
            {
              op: "update",
              requestId: requestId(),
              scopeSpaceId: h.scopeSpaceId,
              pageId: created.page.id,
              expectedRevision: 2,
              richContent: '[{"type":"p","children":[],"__proto__":{}}]',
            },
            agent,
          ),
        );
        assert.strictEqual(invalid.code, "invalid");
        assert.deepStrictEqual(
          yield* h.service.read({ scopeSpaceId: h.scopeSpaceId, pageId: created.page.id }, agent),
          { page: changed.page, content: changed.content, richContent: changed.richContent },
        );
      }),
  );

  it.effect(
    "rejects unsafe new rich URLs atomically and retains historical raw bodies on reads and version history",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const created = yield* h.service.mutate(
          {
            op: "create",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            title: "Empty rich",
            spaceId: null,
            parentPageId: null,
            richContent: "[]",
          },
          user,
        );
        assert.strictEqual(created.richContent, "[]");
        assert.strictEqual(created.content, "");
        const rejectedRequestId = requestId();
        const rejected = yield* Effect.flip(
          h.service.mutate(
            {
              op: "update",
              requestId: rejectedRequestId,
              scopeSpaceId: h.scopeSpaceId,
              pageId: created.page.id,
              expectedRevision: 1,
              richContent: JSON.stringify([
                { type: "img", url: "blob:https://example.test/transient", children: [] },
              ]),
            },
            user,
          ),
        );
        assert.strictEqual(rejected.code, "invalid");
        assert.strictEqual(
          (yield* h.service.read({ scopeSpaceId: h.scopeSpaceId, pageId: created.page.id }, user))
            .page.revision,
          1,
        );
        assert.strictEqual(
          (yield* h.service.versions(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).versions.length,
          1,
        );
        // Simulate a pre-policy stored version. Read/history must preserve the raw
        // document for recovery rather than rewriting or silently discarding it.
        const historicalRaw =
          '[ { "type": "a", "url": "javascript:legacy()", "children": [ { "text": "Recover me" } ] } ]';
        yield* h.sql`UPDATE pages_versions SET rich_content = ${historicalRaw} WHERE page_id = ${created.page.id} AND revision = 1`;
        const recovered = yield* makePagesServiceShape();
        assert.strictEqual(
          (yield* recovered.read({ scopeSpaceId: h.scopeSpaceId, pageId: created.page.id }, user))
            .richContent,
          historicalRaw,
        );
        assert.strictEqual(
          (yield* recovered.versions(
            { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
            user,
          )).versions[0]?.richContent,
          historicalRaw,
        );
        const safe = yield* recovered.mutate(
          {
            op: "update",
            requestId: rejectedRequestId,
            scopeSpaceId: h.scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: 1,
            richContent: JSON.stringify([{ type: "p", children: [] }]),
          },
          user,
        );
        assert.strictEqual(safe.page.revision, 2);
        assert.strictEqual(safe.richContent, '[{"type":"p","children":[]}]');
      }),
  );
});
