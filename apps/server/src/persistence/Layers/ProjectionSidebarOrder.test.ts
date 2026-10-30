import {
  SidebarOrderRevision,
  SidebarSectionId,
  ThreadId,
  type OrchestrationSidebarOrderItem,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionSidebarOrderRepository } from "../Services/ProjectionSidebarOrder.ts";
import { ProjectionSidebarOrderRepositoryLive } from "./ProjectionSidebarOrder.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionSidebarOrderRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-08-31T00:00:00.000Z";

function threadItem(
  id: string,
  destination: "pinned" | "default" | "custom",
  sortOrder: number,
): OrchestrationSidebarOrderItem {
  const custom = destination === "custom";
  return {
    key: `thread:${id}` as OrchestrationSidebarOrderItem["key"],
    itemType: "thread",
    destination,
    sectionId: custom ? SidebarSectionId.makeUnsafe("section-order") : null,
    sectionCreatedAt: custom ? NOW : null,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

layer("ProjectionSidebarOrderRepository", (it) => {
  it.effect("round-trips order state, compare-and-swap, and archive provenance", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSidebarOrderRepository;
      const initial = yield* repository.getState();
      assert.strictEqual(initial.revision, 0);
      assert.include(["ready", "legacy_import_required"], initial.migrationState);

      yield* repository.replaceAll({
        revision: SidebarOrderRevision.makeUnsafe(2),
        migrationState: "ready",
        updatedAt: NOW,
        items: [threadItem("default", "default", 0), threadItem("pinned", "pinned", 0)],
      });
      assert.strictEqual((yield* repository.getState()).revision, 2);
      assert.deepStrictEqual(
        (yield* repository.listAll()).map((item) => item.key),
        ["thread:default", "thread:pinned"],
      );

      assert.isFalse(
        yield* repository.compareAndSwap({
          expectedRevision: SidebarOrderRevision.makeUnsafe(1),
          nextRevision: SidebarOrderRevision.makeUnsafe(3),
          migrationState: "ready",
          updatedAt: NOW,
          items: [threadItem("default", "default", 0)],
        }),
      );
      assert.isTrue(
        yield* repository.compareAndSwap({
          expectedRevision: SidebarOrderRevision.makeUnsafe(2),
          nextRevision: SidebarOrderRevision.makeUnsafe(3),
          migrationState: "ready",
          updatedAt: NOW,
          items: [threadItem("custom", "custom", 0)],
        }),
      );
      assert.strictEqual((yield* repository.getState()).revision, 3);
      assert.strictEqual((yield* repository.listAll())[0]?.destination, "custom");

      const archivedThreadId = ThreadId.makeUnsafe("archived-order");
      yield* repository.upsertArchivePlacement({
        threadId: archivedThreadId,
        destination: "custom",
        sectionId: SidebarSectionId.makeUnsafe("section-order"),
        sectionCreatedAt: NOW,
        sortOrder: 4,
        archivedByCommandId: "archive-order",
        updatedAt: NOW,
      });
      const archive = yield* repository.getArchivePlacement({
        threadId: archivedThreadId,
      });
      assert.isTrue(Option.isSome(archive));
      if (Option.isSome(archive)) {
        assert.strictEqual(archive.value.destination, "custom");
        assert.strictEqual(archive.value.sortOrder, 4);
      }
      yield* repository.deleteArchivePlacement({ threadId: archivedThreadId });
      assert.isTrue(
        Option.isNone(yield* repository.getArchivePlacement({ threadId: archivedThreadId })),
      );
    }),
  );
});
