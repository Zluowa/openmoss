import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { SpaceId } from "@moss/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { LOCAL_PAGES_PRINCIPAL as user, PagesService } from "../Services/PagesService";
import { PagesServiceLive } from "./PagesService";

const tests = it.layer(PagesServiceLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const timestamp = "2026-11-04T00:00:00.000Z";
const requestId = () => randomUUID();

tests("page icon and cover", (it) => {
  it.effect("sets, keeps and clears a page's icon and cover as one versioned edit each", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* PagesService;
      const scopeSpaceId = SpaceId.makeUnsafe(randomUUID());
      yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${scopeSpaceId}, 'Appearance test', 'folder', 0, ${timestamp}, ${timestamp})`;
      const created = yield* service.mutate(
        {
          op: "create",
          requestId: requestId(),
          scopeSpaceId,
          title: "Changelog",
          spaceId: null,
          parentPageId: null,
        },
        user,
      );
      assert.strictEqual(created.page.icon, undefined);
      assert.strictEqual(created.page.cover, undefined);

      const iconed = yield* service.mutate(
        {
          op: "page-appearance",
          requestId: requestId(),
          scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: created.page.revision,
          icon: "page-text",
          cover: "sage",
        },
        user,
      );
      assert.strictEqual(iconed.page.icon, "page-text");
      assert.strictEqual(iconed.page.cover, "sage");
      assert.strictEqual(iconed.page.revision, created.page.revision + 1);

      // A field left out keeps its value; null clears it.
      const cleared = yield* service.mutate(
        {
          op: "page-appearance",
          requestId: requestId(),
          scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: iconed.page.revision,
          cover: null,
        },
        user,
      );
      assert.strictEqual(cleared.page.icon, "page-text");
      assert.strictEqual(cleared.page.cover, null);

      const read = yield* service.read({ scopeSpaceId, pageId: created.page.id }, user);
      assert.strictEqual(read.page.icon, "page-text");
      // The read comes from the stored version, which keeps the cleared cover as null.
      assert.strictEqual(read.page.cover ?? null, null);
      // Ordinary edits keep the appearance.
      const renamed = yield* service.mutate(
        {
          op: "update",
          requestId: requestId(),
          scopeSpaceId,
          pageId: created.page.id,
          expectedRevision: cleared.page.revision,
          title: "Release notes",
        },
        user,
      );
      assert.strictEqual(renamed.page.icon, "page-text");

      const stale = yield* Effect.exit(
        service.mutate(
          {
            op: "page-appearance",
            requestId: requestId(),
            scopeSpaceId,
            pageId: created.page.id,
            expectedRevision: created.page.revision,
            icon: null,
          },
          user,
        ),
      );
      assert.isTrue(Exit.isFailure(stale));
    }),
  );
});
