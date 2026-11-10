import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { ThreadId, type PageDraftId } from "@moss/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite";
import { PagesServiceLive } from "../../Layers/PagesService";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../../Services/PagesService";
import { PageDraftsService } from "../Services/PageDraftsService";
import { PageDraftsServiceLive, validatePageDraftOps } from "./PageDraftsService";

const tests = it.layer(
  PageDraftsServiceLive.pipe(
    Layer.provideMerge(PagesServiceLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const timestamp = "2026-11-04T00:00:00.000Z";

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* PagesService;
  const drafts = yield* PageDraftsService;
  const created = yield* pages.mutate(
    {
      op: "create",
      requestId: randomUUID(),
      scopeSpaceId: null,
      title: "计划",
      richContent: JSON.stringify([{ type: "p", id: "a", children: [{ text: "第一段" }] }]),
      spaceId: null,
      parentPageId: null,
    },
    user,
  );
  const projectId = randomUUID();
  const threadId = ThreadId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES (${projectId}, 'Test project', '/fixture', '[]', ${null}, ${timestamp}, ${timestamp})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Writer', ${timestamp}, ${timestamp})`;
  return { drafts, page: created.page, agent: { kind: "agent" as const, threadId } };
});

tests("page drafts", (it) => {
  it.effect(
    "an agent proposes, the person accepts, and the page body is untouched by the server",
    () =>
      Effect.gen(function* () {
        const { drafts, page, agent } = yield* harness;
        const pages = yield* PagesService;
        const proposed = yield* drafts.mutate(
          {
            op: "create",
            requestId: "r1",
            scopeSpaceId: null,
            pageId: page.id,
            baseRevision: page.revision,
            summary: "补充第二段",
            ops: [{ kind: "insert", afterBlockId: "a", markdown: "第二段" }],
            // An agent cannot borrow another conversation's identity.
            authorThreadId: ThreadId.makeUnsafe("someone-else"),
          },
          agent,
        );
        const draft = proposed.drafts[0]!;
        assert.strictEqual(draft.author, "agent");
        assert.strictEqual(draft.authorThreadId, agent.threadId);
        assert.strictEqual(draft.status, "open");

        const again = yield* drafts.mutate(
          {
            op: "create",
            requestId: "r1",
            scopeSpaceId: null,
            pageId: page.id,
            baseRevision: page.revision,
            ops: [{ kind: "insert", markdown: "第二段" }],
          },
          agent,
        );
        assert.strictEqual(again.drafts[0]!.id, draft.id);

        const agentResolve = yield* Effect.exit(
          drafts.mutate(
            {
              op: "resolve",
              scopeSpaceId: null,
              pageId: page.id,
              draftIds: [draft.id],
              action: "accept",
            },
            agent,
          ),
        );
        assert.isTrue(Exit.isFailure(agentResolve));

        const listed = yield* drafts.list({ scopeSpaceId: null, pageId: page.id }, user);
        assert.deepStrictEqual(
          listed.drafts.map((entry) => entry.id),
          [draft.id],
        );
        const resolved = yield* drafts.mutate(
          {
            op: "resolve",
            scopeSpaceId: null,
            pageId: page.id,
            draftIds: [draft.id],
            action: "accept",
          },
          user,
        );
        assert.strictEqual(resolved.drafts[0]!.status, "accepted");
        assert.strictEqual(resolved.drafts[0]!.resolvedRevision, page.revision);
        assert.strictEqual(
          (yield* drafts.list({ scopeSpaceId: null, pageId: page.id }, user)).drafts.length,
          0,
        );
        const body = yield* pages.read({ scopeSpaceId: null, pageId: page.id }, user);
        assert.strictEqual(body.page.revision, page.revision);
      }),
  );

  it.effect("the local UI may attribute a streamed reply to its conversation", () =>
    Effect.gen(function* () {
      const { drafts, page, agent } = yield* harness;
      const result = yield* drafts.mutate(
        {
          op: "create",
          requestId: "stream",
          scopeSpaceId: null,
          pageId: page.id,
          baseRevision: page.revision,
          ops: [{ kind: "insert", markdown: "生成的内容" }],
          authorThreadId: agent.threadId,
        },
        user,
      );
      assert.strictEqual(result.drafts[0]!.author, "agent");
      const discarded = yield* drafts.mutate(
        {
          op: "resolve",
          scopeSpaceId: null,
          pageId: page.id,
          draftIds: [result.drafts[0]!.id],
          action: "discard",
        },
        user,
      );
      assert.strictEqual(discarded.drafts[0]!.status, "discarded");
      const missing = yield* Effect.exit(
        drafts.mutate(
          {
            op: "resolve",
            scopeSpaceId: null,
            pageId: page.id,
            draftIds: ["nope" as PageDraftId],
            action: "discard",
          },
          user,
        ),
      );
      assert.isTrue(Exit.isFailure(missing));
    }),
  );
});

it("rejects ambiguous or empty draft changes", () => {
  assert.throws(() => validatePageDraftOps([{ kind: "insert" }]));
  assert.throws(() => validatePageDraftOps([{ kind: "insert", markdown: "a", richContent: "[]" }]));
  assert.throws(() => validatePageDraftOps([{ kind: "replace", blockId: "x", markdown: "  " }]));
  assert.throws(() =>
    validatePageDraftOps([{ kind: "insert", atStart: true, afterBlockId: "a", markdown: "a" }]),
  );
  assert.throws(() => validatePageDraftOps([{ kind: "insert", richContent: "{" }]));
  validatePageDraftOps([
    { kind: "delete", blockId: "a" },
    { kind: "replace-all", markdown: "" },
    { kind: "insert", richContent: JSON.stringify([{ type: "p", children: [{ text: "x" }] }]) },
  ]);
});
