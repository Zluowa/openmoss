import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadId, type Page } from "@moss/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { makePagesServiceShape, PagesServiceLive, spaceOutputKind } from "./PagesService";

const tests = it.layer(PagesServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-10-25T00:00:00.000Z";
const requestId = () => randomUUID();
const checkpointFiles = (entries: { path: string; kind: string }[]) =>
  JSON.stringify(entries.map((entry) => ({ ...entry, additions: 1, deletions: 0 })));
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* PagesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Space items test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const mutate = (page: Page, op: "trash" | "purge" | "trash-space") =>
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
  return { service, sql, scopeSpaceId, mutate };
});

tests("资料空间 items", (it) => {
  it.effect("stores an item kind and reads old rows as pages", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const slides = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Quarterly deck",
          kind: "slides",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const page = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Plain page",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const listed = yield* h.service.list({ scopeSpaceId: h.scopeSpaceId }, user);
      const byId = new Map(listed.pages.map((entry) => [entry.id, entry]));
      assert.strictEqual(byId.get(slides.page.id)?.kind, "slides");
      assert.strictEqual(byId.get(page.page.id)?.kind, undefined);
    }),
  );

  it.effect("sets a space icon only through the space root", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const created = yield* h.service.mutate(
        { op: "create-space", requestId: requestId(), scopeSpaceId: h.scopeSpaceId, title: "Trip" },
        user,
      );
      yield* h.service.mutate(
        {
          op: "space-icon",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: created.page.revision,
          icon: "🌿",
        },
        user,
      );
      const spaces = yield* h.service.spaces({ scopeSpaceId: h.scopeSpaceId }, user);
      assert.strictEqual(spaces.spaces.find((entry) => entry.id === created.space?.id)?.icon, "🌿");
      const child = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Day one",
          spaceId: created.page.spaceId,
          parentPageId: created.page.id,
        },
        user,
      );
      const refused = yield* Effect.exit(
        h.service.mutate(
          {
            op: "space-icon",
            requestId: requestId(),
            scopeSpaceId: h.scopeSpaceId,
            pageId: child.page.id,
            expectedRevision: child.page.revision,
            icon: "x",
          },
          user,
        ),
      );
      assert.ok(Exit.isFailure(refused));
    }),
  );

  it.effect("purges only trashed pages, with their subtree, versions and comments", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const parent = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Parent",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const child = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Child",
          spaceId: null,
          parentPageId: parent.page.id,
        },
        user,
      );
      assert.ok(Exit.isFailure(yield* Effect.exit(h.mutate(parent.page, "purge"))));
      const trashed = yield* h.mutate(parent.page, "trash");
      const purged = yield* h.mutate(trashed.page, "purge");
      assert.deepStrictEqual(
        [...purged.affectedPageIds].toSorted(),
        [parent.page.id, child.page.id].toSorted(),
      );
      const listed = yield* h.service.list(
        { scopeSpaceId: h.scopeSpaceId, includeTrashed: true },
        user,
      );
      assert.ok(
        !listed.pages.some((entry) => entry.id === parent.page.id || entry.id === child.page.id),
      );
      const versions = yield* h.sql<{ n: number }>`SELECT COUNT(*) AS n FROM pages_versions
        WHERE page_id IN (${parent.page.id}, ${child.page.id})`;
      assert.strictEqual(versions[0]?.n, 0);
    }),
  );

  it.effect("deletes trash older than 30 days when the scope is listed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      let clock = "2026-10-01T00:00:00.000Z";
      const service = yield* makePagesServiceShape({ now: () => clock });
      const old = yield* service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Old",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      yield* service.mutate(
        {
          op: "trash",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          pageId: old.page.id,
          expectedRevision: old.page.revision,
        },
        user,
      );
      clock = "2026-10-30T00:00:00.000Z";
      const recent = yield* service.list(
        { scopeSpaceId: h.scopeSpaceId, includeTrashed: true },
        user,
      );
      assert.ok(
        recent.pages.some((entry) => entry.id === old.page.id),
        "29 days: still in trash",
      );
      clock = "2026-11-01T00:00:00.000Z";
      const later = yield* service.list(
        { scopeSpaceId: h.scopeSpaceId, includeTrashed: true },
        user,
      );
      assert.ok(!later.pages.some((entry) => entry.id === old.page.id), "31 days: purged");
    }),
  );

  it.effect("lists files agents wrote in this scope's chats and remembers trash", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const projectId = randomUUID();
      const threadId = ThreadId.makeUnsafe(randomUUID());
      const otherProject = randomUUID();
      const otherThread = ThreadId.makeUnsafe(randomUUID());
      yield* h.sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
        VALUES (${projectId}, 'Research', '/work/research', '[]', ${h.scopeSpaceId}, ${timestamp}, ${timestamp}),
               (${otherProject}, 'Elsewhere', '/work/other', '[]', NULL, ${timestamp}, ${timestamp})`;
      yield* h.sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, ${projectId}, 'Make a report', ${timestamp}, ${timestamp}),
               (${otherThread}, ${otherProject}, 'Other chat', ${timestamp}, ${timestamp})`;
      yield* h.sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_turn_count, checkpoint_files_json)
        VALUES (${threadId}, 'turn-1', 'completed', '2026-10-25T01:00:00.000Z', '2026-10-25T01:05:00.000Z', 1,
                  ${checkpointFiles([
                    { path: "out/report.html", kind: "added" },
                    { path: "src/index.ts", kind: "modified" },
                    { path: "chart.png", kind: "added" },
                  ])}),
               (${threadId}, 'turn-2', 'completed', '2026-10-25T02:00:00.000Z', '2026-10-25T02:05:00.000Z', 2,
                  ${checkpointFiles([
                    { path: "out/report.html", kind: "modified" },
                    { path: "old.csv", kind: "deleted" },
                  ])}),
               (${otherThread}, 'turn-1', 'completed', '2026-10-25T01:00:00.000Z', '2026-10-25T01:05:00.000Z', 1,
                  ${checkpointFiles([{ path: "elsewhere.html", kind: "added" }])})`;
      const listed = yield* h.service.outputs({ scopeSpaceId: h.scopeSpaceId }, user);
      assert.deepStrictEqual(
        listed.outputs.map((entry) => [entry.title, entry.kind, entry.updatedAt]),
        [
          ["report.html", "file", "2026-10-25T02:05:00.000Z"],
          ["chart.png", "image", "2026-10-25T01:05:00.000Z"],
        ],
      );
      assert.strictEqual(listed.outputs[0]?.workspaceRoot, "/work/research");
      assert.strictEqual(listed.outputs[0]?.threadTitle, "Make a report");
      const report = listed.outputs[0]!;
      yield* h.service.outputState(
        { scopeSpaceId: h.scopeSpaceId, outputId: report.id, action: "trash" },
        user,
      );
      const visible = yield* h.service.outputs({ scopeSpaceId: h.scopeSpaceId }, user);
      assert.deepStrictEqual(
        visible.outputs.map((entry) => entry.title),
        ["chart.png"],
      );
      const withTrash = yield* h.service.outputs(
        { scopeSpaceId: h.scopeSpaceId, includeTrashed: true },
        user,
      );
      assert.ok(withTrash.outputs.find((entry) => entry.id === report.id)?.trashedAt);
      yield* h.service.outputState(
        { scopeSpaceId: h.scopeSpaceId, outputId: report.id, action: "purge" },
        user,
      );
      const afterPurge = yield* h.service.outputs(
        { scopeSpaceId: h.scopeSpaceId, includeTrashed: true },
        user,
      );
      assert.ok(!afterPurge.outputs.some((entry) => entry.id === report.id));
      const foreign = yield* Effect.exit(
        h.service.outputState(
          {
            scopeSpaceId: h.scopeSpaceId,
            outputId: `${otherThread}|elsewhere.html`,
            action: "trash",
          },
          user,
        ),
      );
      assert.ok(Exit.isFailure(foreign));
    }),
  );

  it.effect("lists versions without their bodies when asked for a summary", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const body = "x".repeat(50_000);
      const created = yield* h.service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId: h.scopeSpaceId,
          title: "Big",
          content: body,
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      const full = yield* h.service.versions(
        { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id },
        user,
      );
      assert.strictEqual(full.versions[0]?.content, body);
      const summary = yield* h.service.versions(
        { scopeSpaceId: h.scopeSpaceId, pageId: created.page.id, summaryOnly: true },
        user,
      );
      assert.strictEqual(summary.versions[0]?.content, "");
      assert.strictEqual(summary.versions[0]?.richContent, undefined);
      assert.strictEqual(summary.versions[0]?.page.revision, 1);
      assert.strictEqual(summary.versions[0]?.operation, "create");
    }),
  );

  it("classifies chat outputs by extension", () => {
    assert.strictEqual(spaceOutputKind("a/b/Report.HTML"), "file");
    assert.strictEqual(spaceOutputKind("data.xlsx"), "file");
    assert.strictEqual(spaceOutputKind("photo.webp"), "image");
    assert.strictEqual(spaceOutputKind("main.ts"), null);
    assert.strictEqual(spaceOutputKind("Makefile"), null);
  });
});
