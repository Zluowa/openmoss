import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId } from "@moss/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { PagesServiceLive } from "./PagesService";

const tests = it.layer(PagesServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-11-13T00:00:00.000Z";
const requestId = () => randomUUID();

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* PagesService;
  const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES (${scopeSpaceId}, 'Doc style test', 'folder', 0, ${timestamp}, ${timestamp})`;
  const created = yield* service.mutate(
    {
      op: "create",
      requestId: requestId(),
      scopeSpaceId,
      title: "Plan",
      spaceId: null,
      parentPageId: null,
    },
    user,
  );
  return { service, scopeSpaceId, created };
});

tests("page doc style and comments on words", (it) => {
  it.effect("stores the doc style on the page for every reader and clears it with null", () =>
    Effect.gen(function* () {
      const { service, scopeSpaceId, created } = yield* setup;
      assert.strictEqual(created.page.docStyle, undefined);
      const styled = yield* service.mutate(
        {
          op: "page-appearance",
          requestId: requestId(),
          scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: created.page.revision,
          docStyle: { width: "wide", headingFont: "serif", textFont: "sans", lang: "en" },
        },
        user,
      );
      assert.deepStrictEqual(styled.page.docStyle, {
        width: "wide",
        headingFont: "serif",
        textFont: "sans",
        lang: "en",
      });
      const read = yield* service.read({ scopeSpaceId, pageId: created.page.id }, user);
      assert.strictEqual(read.page.docStyle?.width, "wide");
      const listed = yield* service.list({ scopeSpaceId }, user);
      assert.strictEqual(
        listed.pages.find((page) => page.id === created.page.id)?.docStyle?.headingFont,
        "serif",
      );
      const cleared = yield* service.mutate(
        {
          op: "page-appearance",
          requestId: requestId(),
          scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: styled.page.revision,
          docStyle: null,
        },
        user,
      );
      assert.strictEqual(cleared.page.docStyle ?? null, null);
    }),
  );

  it.effect("saves, replaces, lists and deletes comment threads on words", () =>
    Effect.gen(function* () {
      const { service, scopeSpaceId, created } = yield* setup;
      const pageId = created.page.id;
      const thread = (body: string) =>
        JSON.stringify({ id: "c1", body, anchor: { selector: "b1" } });
      yield* service.textCommentMutate(
        { op: "save", scopeSpaceId, pageId, commentId: "c1", thread: thread("first") },
        user,
      );
      yield* service.textCommentMutate(
        { op: "save", scopeSpaceId, pageId, commentId: "c1", thread: thread("edited") },
        user,
      );
      yield* service.textCommentMutate(
        { op: "save", scopeSpaceId, pageId, commentId: "c2", thread: thread("second") },
        user,
      );
      const listed = yield* service.textComments({ scopeSpaceId, pageId }, user);
      assert.deepStrictEqual(
        listed.comments.map((comment) => [comment.id, JSON.parse(comment.thread).body]).sort(),
        [
          ["c1", "edited"],
          ["c2", "second"],
        ],
      );
      yield* service.textCommentMutate(
        { op: "delete", scopeSpaceId, pageId, commentId: "c1" },
        user,
      );
      const after = yield* service.textComments({ scopeSpaceId, pageId }, user);
      assert.deepStrictEqual(
        after.comments.map((comment) => comment.id),
        ["c2"],
      );
      const bad = yield* Effect.exit(
        service.textCommentMutate(
          { op: "save", scopeSpaceId, pageId, commentId: "no spaces allowed", thread: "{}" },
          user,
        ),
      );
      assert.isTrue(Exit.isFailure(bad));
    }),
  );
});
