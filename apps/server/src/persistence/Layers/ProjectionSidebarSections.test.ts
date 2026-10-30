import { SidebarSectionId, SidebarSectionItemKey } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionSidebarSectionRepository } from "../Services/ProjectionSidebarSections.ts";
import { ProjectionSidebarSectionRepositoryLive } from "./ProjectionSidebarSections.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionSidebarSectionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionSidebarSectionRepository", (it) => {
  it.effect("round-trips section order and durable thread membership", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSidebarSectionRepository;
      const sectionId = SidebarSectionId.makeUnsafe("section-repository");
      const now = "2026-08-31T00:00:00.000Z";

      yield* repository.upsertSection({
        sectionId,
        name: "Repository section",
        sortOrder: 2,
        isCollapsed: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        items: [],
      });
      yield* repository.upsertItem({
        sectionId,
        itemKey: SidebarSectionItemKey.makeUnsafe("thread:repository-thread"),
        itemType: "thread",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });

      const persisted = yield* repository.getById({ sectionId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.equal(persisted.value.name, "Repository section");
        assert.equal(persisted.value.sortOrder, 2);
        assert.deepEqual(
          persisted.value.items.map((item) => [item.itemKey, item.itemType, item.sortOrder]),
          [["thread:repository-thread", "thread", 0]],
        );
      }

      yield* repository.replaceItems({
        sectionId,
        items: [
          {
            sectionId,
            itemKey: SidebarSectionItemKey.makeUnsafe("thread:repository-before"),
            itemType: "thread",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            sectionId,
            itemKey: SidebarSectionItemKey.makeUnsafe("thread:repository-after"),
            itemType: "thread",
            sortOrder: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      const replaced = yield* repository.getById({ sectionId });
      assert.equal(Option.isSome(replaced), true);
      if (Option.isSome(replaced)) {
        assert.deepEqual(
          replaced.value.items.map((item) => [item.itemKey, item.sortOrder]),
          [
            ["thread:repository-before", 0],
            ["thread:repository-after", 1],
          ],
        );
      }

      yield* repository.deleteItem({
        itemKey: SidebarSectionItemKey.makeUnsafe("thread:repository-before"),
      });
      yield* repository.deleteItem({
        itemKey: SidebarSectionItemKey.makeUnsafe("thread:repository-after"),
      });
      const withoutItem = yield* repository.getById({ sectionId });
      assert.equal(Option.isSome(withoutItem), true);
      if (Option.isSome(withoutItem)) assert.deepEqual(withoutItem.value.items, []);

      yield* repository.deleteSection({ sectionId });
      assert.equal(Option.isNone(yield* repository.getById({ sectionId })), true);
      assert.deepEqual(yield* repository.listAll(), []);
    }),
  );
});
