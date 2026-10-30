import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionSidebarSectionRepository } from "../../persistence/Services/ProjectionSidebarSections.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "moss-sidebar-sections-durable-",
});

const runWithRuntime = async <A>(
  layer: Layer.Layer<any, any, any>,
  effect: Effect.Effect<A, any, any>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(layer as unknown as Layer.Layer<any, never, never>);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
};

it.effect("keeps section membership after the writing runtime is replaced", () => {
  let tempDirectoryPath: string | undefined;
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const tempDirectory = yield* Effect.promise(() =>
      fs.mkdtemp(path.join(os.tmpdir(), "moss-sidebar-sections-durable-")),
    );
    tempDirectoryPath = tempDirectory;
    const dbPath = path.join(tempDirectory, "state.sqlite");
    const makeProjectionLayer = () =>
      Layer.mergeAll(
        OrchestrationProjectionPipelineLive,
        OrchestrationProjectionSnapshotQueryLive,
      ).pipe(
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
        Layer.provideMerge(Layer.succeed(ServerConfig, serverConfig)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provide(NodeServices.layer),
      );

    const projectId = ProjectId.makeUnsafe("project-sidebar-sections-durable");
    const threadId = ThreadId.makeUnsafe("thread-sidebar-sections-durable");
    const sectionId = SidebarSectionId.makeUnsafe("section-sidebar-sections-durable");
    const createdAt = "2026-08-31T00:00:00.000Z";

    const firstSnapshot = yield* Effect.promise(() =>
      runWithRuntime(
        makeProjectionLayer(),
        Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();

          const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
            eventStore
              .append(event)
              .pipe(
                Effect.flatMap((savedEvent) =>
                  projectionPipeline.projectEvent(savedEvent).pipe(Effect.as(savedEvent)),
                ),
              );

          yield* appendAndProject({
            type: "project.created",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-project"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-project"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-project"),
            metadata: {},
            payload: {
              projectId,
              title: "Durable section project",
              workspaceRoot: "/tmp/sidebar-sections-durable",
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
            },
          });
          yield* appendAndProject({
            type: "thread.created",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-thread"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-thread"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-thread"),
            metadata: {},
            payload: {
              threadId,
              projectId,
              title: "Durable section thread",
              modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt,
              updatedAt: createdAt,
            },
          });
          yield* appendAndProject({
            type: "sidebar-section.created",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-created"),
            aggregateKind: "sidebar-section",
            aggregateId: sectionId,
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-create"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-create"),
            metadata: {},
            payload: {
              sectionId,
              name: "Durable section",
              sortOrder: 0,
              isCollapsed: false,
              initialThreadId: threadId,
              createdAt,
              updatedAt: createdAt,
            },
          });
          const placed = yield* appendAndProject({
            type: "sidebar-section.thread-placed",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-placed"),
            aggregateKind: "sidebar-section",
            aggregateId: sectionId,
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-create"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-create"),
            metadata: {},
            payload: {
              sectionId,
              threadId,
              destination: "custom",
              updatedAt: createdAt,
            },
          });
          yield* appendAndProject({
            type: "thread.archived",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-archived"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-31T00:00:01.000Z",
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-archive"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-archive"),
            metadata: {},
            payload: {
              threadId,
              archivedAt: "2026-08-31T00:00:01.000Z",
              updatedAt: "2026-08-31T00:00:01.000Z",
              placement: {
                sectionId,
                sectionCreatedAt: createdAt,
                sortOrder: 0,
              },
            },
          });
          const restored = yield* appendAndProject({
            type: "thread.unarchived",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-restored"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-31T00:00:02.000Z",
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-undo"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("command-sidebar-sections-durable-undo"),
            metadata: {},
            payload: {
              threadId,
              updatedAt: "2026-08-31T00:00:02.000Z",
              isArchiveCohortFinal: true,
              restoredSidebarPlacement: {
                sectionId,
                sectionCreatedAt: createdAt,
                sortOrder: 0,
              },
              restoredSidebarPlacements: [
                {
                  threadId,
                  placement: {
                    sectionId,
                    sectionCreatedAt: createdAt,
                    sortOrder: 0,
                  },
                },
              ],
            },
          });

          const events = yield* Stream.runCollect(eventStore.readAll());
          const shell = yield* snapshotQuery.getShellSnapshot();
          const sectionRows = yield* sql<{
            readonly sectionId: string;
            readonly name: string;
            readonly sortOrder: number;
          }>`
            SELECT
              section_id AS "sectionId",
              name,
              sort_order AS "sortOrder"
            FROM projection_sidebar_sections
            WHERE deleted_at IS NULL
          `;
          const itemRows = yield* sql<{
            readonly sectionId: string;
            readonly itemKey: string;
            readonly itemType: string;
            readonly sortOrder: number;
          }>`
            SELECT
              section_id AS "sectionId",
              item_key AS "itemKey",
              item_type AS "itemType",
              sort_order AS "sortOrder"
            FROM projection_sidebar_section_items
          `;
          return {
            placedSequence: placed.sequence,
            restoredSequence: restored.sequence,
            eventTypes: Array.from(events).map((event) => event.type),
            shell,
            sectionRows,
            itemRows,
          };
        }),
      ),
    );

    assert.equal(firstSnapshot.placedSequence, 4);
    assert.equal(firstSnapshot.restoredSequence, 6);
    assert.deepEqual(firstSnapshot.eventTypes, [
      "project.created",
      "thread.created",
      "sidebar-section.created",
      "sidebar-section.thread-placed",
      "thread.archived",
      "thread.unarchived",
    ]);
    assert.deepEqual(
      firstSnapshot.shell.sidebarSections?.map((section) => ({
        id: section.id,
        name: section.name,
        items: section.items.map((item) => item.key),
      })),
      [{ id: sectionId, name: "Durable section", items: [`thread:${threadId}`] }],
    );
    assert.deepEqual(firstSnapshot.sectionRows, [
      { sectionId, name: "Durable section", sortOrder: 0 },
    ]);
    assert.deepEqual(firstSnapshot.itemRows, [
      { sectionId, itemKey: `thread:${threadId}`, itemType: "thread", sortOrder: 0 },
    ]);

    const freshSnapshot = yield* Effect.promise(() =>
      runWithRuntime(
        makeProjectionLayer(),
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          yield* runMigrations();
          yield* projectionPipeline.bootstrap;
          return yield* snapshotQuery.getShellSnapshot();
        }),
      ),
    );
    assert.deepEqual(freshSnapshot.sidebarSections, firstSnapshot.shell.sidebarSections);
    assert.equal(
      freshSnapshot.threads.some((thread) => thread.id === threadId),
      true,
    );

    const replayedFromEmptyProjection = yield* Effect.promise(() =>
      runWithRuntime(
        makeProjectionLayer(),
        Effect.gen(function* () {
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();
          yield* sql`DELETE FROM projection_state`;
          yield* sql`DELETE FROM projection_sidebar_section_items`;
          yield* sql`DELETE FROM projection_sidebar_sections`;
          yield* sql`DELETE FROM projection_threads`;
          yield* sql`DELETE FROM projection_projects`;
          yield* projectionPipeline.bootstrap;
          return yield* snapshotQuery.getShellSnapshot();
        }),
      ),
    );
    assert.deepEqual(
      replayedFromEmptyProjection.sidebarSections,
      firstSnapshot.shell.sidebarSections,
    );
    assert.equal(
      replayedFromEmptyProjection.threads.some((thread) => thread.id === threadId),
      true,
    );

    const multiPlacementRestore = yield* Effect.promise(() =>
      runWithRuntime(
        makeProjectionLayer(),
        Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const projectionPipeline = yield* OrchestrationProjectionPipeline;
          const projectionThreadRepository = yield* ProjectionThreadRepository;
          const projectionSidebarSectionRepository = yield* ProjectionSidebarSectionRepository;
          yield* runMigrations();

          const root = yield* projectionThreadRepository.getById({ threadId });
          assert.equal(Option.isSome(root), true);
          if (Option.isNone(root)) return [];
          const beforeId = ThreadId.makeUnsafe("thread-sidebar-sections-durable-before");
          const childId = ThreadId.makeUnsafe("thread-sidebar-sections-durable-child");
          const afterId = ThreadId.makeUnsafe("thread-sidebar-sections-durable-after");
          const appendId = ThreadId.makeUnsafe("thread-sidebar-sections-durable-append");
          const makeThread = (id: ThreadId, parentThreadId: ThreadId | null = null) => ({
            ...root.value,
            threadId: id,
            title: `Durable ${id}`,
            parentThreadId,
            archivedAt: null,
            archivedByCommandId: null,
            archivedSidebarSectionId: null,
            archivedSidebarSectionCreatedAt: null,
            archivedSidebarSortOrder: null,
            deletedAt: null,
          });
          yield* projectionThreadRepository.upsert(makeThread(beforeId));
          yield* projectionThreadRepository.upsert(makeThread(childId, threadId));
          yield* projectionThreadRepository.upsert(makeThread(afterId));
          yield* projectionThreadRepository.upsert(makeThread(appendId));

          const item = (itemThreadId: ThreadId, sortOrder: number) => ({
            sectionId,
            itemKey: SidebarSectionItemKey.makeUnsafe(`thread:${itemThreadId}`),
            itemType: "thread" as const,
            sortOrder,
            createdAt,
            updatedAt: createdAt,
          });
          yield* projectionSidebarSectionRepository.replaceItems({
            sectionId,
            items: [item(beforeId, 0), item(threadId, 1), item(afterId, 2), item(childId, 3)],
          });

          const archiveCommandId = CommandId.makeUnsafe(
            "command-sidebar-sections-durable-multi-archive",
          );
          const archiveEvents = [
            {
              threadId: childId,
              eventId: EventId.makeUnsafe("event-sidebar-sections-durable-multi-child-archived"),
              sortOrder: 3,
            },
            {
              threadId,
              eventId: EventId.makeUnsafe("event-sidebar-sections-durable-multi-root-archived"),
              sortOrder: 1,
            },
          ] as const;
          for (const archive of archiveEvents) {
            const archived = yield* eventStore.append({
              type: "thread.archived",
              eventId: archive.eventId,
              aggregateKind: "thread",
              aggregateId: archive.threadId,
              occurredAt: "2026-08-31T00:00:03.000Z",
              commandId: archiveCommandId,
              causationEventId: null,
              correlationId: archiveCommandId,
              metadata: {},
              payload: {
                threadId: archive.threadId,
                archivedAt: "2026-08-31T00:00:03.000Z",
                updatedAt: "2026-08-31T00:00:03.000Z",
                placement: {
                  sectionId,
                  sectionCreatedAt: createdAt,
                  sortOrder: archive.sortOrder,
                },
              },
            });
            yield* projectionPipeline.projectEvent(archived);
          }
          yield* projectionSidebarSectionRepository.deleteItem({
            itemKey: SidebarSectionItemKey.makeUnsafe(`thread:${afterId}`),
          });
          yield* projectionSidebarSectionRepository.upsertItem(item(appendId, 1));

          const childUnarchived = yield* eventStore.append({
            type: "thread.unarchived",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-multi-child-restored"),
            aggregateKind: "thread",
            aggregateId: childId,
            occurredAt: "2026-08-31T00:00:04.000Z",
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-multi-undo"),
            causationEventId: null,
            correlationId: CommandId.makeUnsafe("command-sidebar-sections-durable-multi-undo"),
            metadata: {},
            payload: {
              threadId: childId,
              updatedAt: "2026-08-31T00:00:04.000Z",
              restoredSidebarPlacement: {
                sectionId,
                sectionCreatedAt: createdAt,
                sortOrder: 3,
              },
              isArchiveCohortFinal: false,
              restoredSidebarPlacements: [],
            },
          });
          yield* projectionPipeline.projectEvent(childUnarchived);

          const rootUnarchived = yield* eventStore.append({
            type: "thread.unarchived",
            eventId: EventId.makeUnsafe("event-sidebar-sections-durable-multi-root-restored"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-31T00:00:05.000Z",
            commandId: CommandId.makeUnsafe("command-sidebar-sections-durable-multi-undo"),
            causationEventId: null,
            correlationId: CommandId.makeUnsafe("command-sidebar-sections-durable-multi-undo"),
            metadata: {},
            payload: {
              threadId,
              updatedAt: "2026-08-31T00:00:05.000Z",
              restoredSidebarPlacement: {
                sectionId,
                sectionCreatedAt: createdAt,
                sortOrder: 1,
              },
              isArchiveCohortFinal: true,
              restoredSidebarPlacements: [
                {
                  threadId,
                  placement: { sectionId, sectionCreatedAt: createdAt, sortOrder: 1 },
                },
                {
                  threadId: childId,
                  placement: { sectionId, sectionCreatedAt: createdAt, sortOrder: 3 },
                },
              ],
            },
          });
          yield* projectionPipeline.projectEvent(rootUnarchived);

          const restoredSection = yield* projectionSidebarSectionRepository.getById({
            sectionId,
          });
          assert.equal(Option.isSome(restoredSection), true);
          if (Option.isNone(restoredSection)) return [];
          return restoredSection.value.items.map((entry) => [entry.itemKey, entry.sortOrder]);
        }),
      ),
    );
    assert.deepEqual(multiPlacementRestore, [
      ["thread:thread-sidebar-sections-durable-before", 0],
      ["thread:thread-sidebar-sections-durable", 1],
      ["thread:thread-sidebar-sections-durable-append", 2],
      ["thread:thread-sidebar-sections-durable-child", 3],
    ]);
  }).pipe(
    Effect.ensuring(
      Effect.promise(() =>
        tempDirectoryPath === undefined
          ? Promise.resolve()
          : fs.rm(tempDirectoryPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    ),
    Effect.provide(serverConfigLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
});
