import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, CorrelationId, EventId, ProjectId, ThreadId } from "@moss/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

// WALK-1 S-6: the warm-up mark is stored with the thread and read back the same way after a
// restart (the projection is rebuilt from events), so desktop and phone agree on what is listed.
it.effect("stores an item panel chat's warm-up mark and reads it back after a restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const makeLayer = () =>
      Layer.mergeAll(
        OrchestrationProjectionPipelineLive,
        OrchestrationProjectionSnapshotQueryLive,
      ).pipe(
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(persistenceLayer),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(NodeServices.layer),
      );
    const projectId = ProjectId.makeUnsafe("project-warm-up-mark");
    const itemChat = ThreadId.makeUnsafe("thread-item-chat");
    const terminalChat = ThreadId.makeUnsafe("thread-terminal-first");
    const createdAt = "2026-11-24T10:00:00.000Z";

    const readShells = Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* projectionPipeline.bootstrap;
      const shell = yield* snapshotQuery.getShellSnapshot();
      const full = yield* snapshotQuery.getSnapshot();
      return { shell, full };
    });

    const first = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-warm-up-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-warm-up-project"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-warm-up-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Items",
          workspaceRoot: "/tmp/project-warm-up-mark",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      for (const [threadId, title, marked] of [
        [itemChat, "周报", true],
        [terminalChat, "New terminal", false],
      ] as const) {
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe(`evt-${threadId}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-${threadId}`),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title,
            modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            ...(marked ? { listedAfterFirstSend: true } : {}),
            createdAt,
            updatedAt: createdAt,
          },
        });
      }
      return yield* readShells;
    }).pipe(Effect.provide(makeLayer()));

    const restarted = yield* readShells.pipe(Effect.provide(makeLayer()));

    for (const { shell, full } of [first, restarted]) {
      const shellItem = shell.threads.find((thread) => thread.id === itemChat);
      const shellTerminal = shell.threads.find((thread) => thread.id === terminalChat);
      assert.equal(shellItem?.listedAfterFirstSend, true);
      assert.isDefined(shellTerminal);
      assert.isUndefined(shellTerminal?.listedAfterFirstSend);
      assert.equal(full.threads.find((t) => t.id === itemChat)?.listedAfterFirstSend, true);
      assert.isUndefined(full.threads.find((t) => t.id === terminalChat)?.listedAfterFirstSend);
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "moss-projection-warm-up-mark-" }),
        NodeServices.layer,
      ),
    ),
  ),
);
