import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_SERVER_SETTINGS, MessageId } from "@moss/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { expect, it, vi } from "vitest";
import { ServerConfig } from "../config";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeProjectImportRepository } from "../persistence/projectImportRepository";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { makeProjectImportHandlers } from "./projectImportRoute";
import {
  resolveProjectImportSources,
  resolveProjectImportSourceHome,
} from "./projectImportSources";
import { ServerSettingsService } from "../serverSettings.ts";

function makeRuntime() {
  return ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "moss-project-import-recovery-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

it.each(["pending", "completed"] as const)(
  "recovers a deleted %s import with durable reservations and command receipts",
  async (status) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readHistory = vi.fn(({ threadId }: { threadId: string }) =>
        Effect.succeed({
          nextCursor: null,
          messages: [
            {
              messageId: MessageId.makeUnsafe(`import:${threadId}:message`),
              role: "user" as const,
              text: "Original conversation",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        }),
      );
      const copy = vi.fn(({ threadId }: { threadId: string }) =>
        Effect.succeed({ threadId, resumeCursor: { threadId: `copy:${threadId}` } }),
      );
      const handlers = makeProjectImportHandlers({
        repository,
        orchestrationEngine: engine,
        providerService: {
          importExternalThread: copy,
          stopRuntimeSession: () => Effect.void,
        } as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        readImportedTranscript: async () => [
          { id: "m1", role: "user" as const, text: "Original conversation", createdAt },
        ],
        discover: async () => ({
          sourceHome: "/codex",
          projects: [{ id: "source-project", title: "Source project", roots: [process.cwd()] }],
          sessions: [
            {
              id: "source-thread",
              projectId: "source-project",
              title: "Source conversation",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: true,
            },
          ],
        }),
        readHistory,
      });
      const preview = () =>
        runtime.runPromise(handlers.listProjectImports({ providers: ["codex"] }));
      const project = (await preview()).projects[0]!;
      const input = { projectKey: project.key, threadKey: project.threads[0]!.key };
      if (status === "pending") {
        // Fail after durable message and archive commands have already been accepted.
        const complete = repository.complete;
        repository.complete = vi
          .fn(complete)
          .mockReturnValueOnce(Effect.die("interrupted completion"));
        await expect(runtime.runPromise(handlers.importProject(input))).rejects.toThrow(
          "interrupted completion",
        );
      } else {
        await runtime.runPromise(handlers.importProject(input));
      }
      const original = (await runtime.runPromise(repository.find(input.threadKey)))!;
      expect(original.status).toBe(status);
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: original.threadId,
        }),
      );
      // Reload the command model from SQLite, as happens when the server restarts.
      await runtime.runPromise(engine.refreshCommandReadModel());
      expect((await preview()).projects[0]!.threads[0]!.alreadyImported).toBe(false);

      const replacement = await runtime.runPromise(handlers.importProject(input));

      expect(replacement.status).toBe("imported");
      expect(replacement.threadId).not.toBe(original.threadId);
      // Registration copies nothing; the transcript arrives when the conversation is opened.
      expect(copy).not.toHaveBeenCalled();
      await runtime.runPromise(
        handlers.loadProjectImportHistory({ threadId: replacement.threadId! }),
      );
      expect(await runtime.runPromise(repository.find(input.threadKey))).toMatchObject({
        threadId: replacement.threadId,
        status: "completed",
      });
      const active = (await runtime.runPromise(engine.getReadModel())).threads.filter(
        (thread) => thread.deletedAt === null,
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.messages.map((message) => message.text)).toEqual(["Original conversation"]);
      expect(active[0]?.archivedAt).not.toBeNull();
      expect((await preview()).projects[0]!.threads[0]!.alreadyImported).toBe(true);
      await expect(runtime.runPromise(handlers.importProject(input))).resolves.toMatchObject({
        threadId: replacement.threadId,
        status: "already-present",
      });
    } finally {
      await runtime.dispose();
    }
  },
);

it.each(["codex", "claudeAgent"] as const)(
  "keeps %s older pages durable and read-only across retries and restarts",
  async (provider) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const source = resolveProjectImportSources(DEFAULT_SERVER_SETTINGS, [provider])[0]!;
      const sourceHome = await resolveProjectImportSourceHome(source);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readHistory = vi.fn(({ threadId, cursor }: { threadId: string; cursor?: string }) =>
        Effect.succeed({
          nextCursor: cursor === "oldest" ? null : cursor === "older" ? "oldest" : "older",
          messages: [
            {
              messageId: MessageId.makeUnsafe(`import:${threadId}:${cursor ?? "recent"}`),
              role: "assistant" as const,
              text: cursor ?? "recent",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        }),
      );
      const options = {
        repository,
        orchestrationEngine: engine,
        providerService: {
          importExternalThread: ({ threadId }: { threadId: string }) =>
            Effect.succeed({
              threadId,
              resumeCursor:
                provider === "codex" ? { threadId: "frozen-copy" } : { resume: "frozen-copy" },
            }),
          stopRuntimeSession: () => Effect.void,
        } as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        discover: async () => ({
          sourceHome,
          projects: [{ id: "source", title: "Source", roots: [process.cwd()] }],
          sessions: [
            {
              id: "original",
              projectId: "source",
              title: "Original",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: false,
            },
          ],
        }),
        readHistory,
      };
      const handlers = makeProjectImportHandlers(options);
      const project = (
        await runtime.runPromise(handlers.listProjectImports({ providers: [provider] }))
      ).projects[0]!;
      const imported = await runtime.runPromise(
        handlers.importProject({ projectKey: project.key, threadKey: project.threads[0]!.key }),
      );
      const threadId = imported.threadId!;
      // Conversations imported by the earlier native-copy importer keep paging older messages.
      const { lazy: _lazy, ...registered } = (await runtime.runPromise(
        repository.getHistory(threadId),
      ))!;
      const native = { ...registered, nativeId: "frozen-copy", cursor: "older" };
      await runtime.runPromise(repository.saveHistory(native));
      await runtime.runPromise(repository.saveHistory({ ...native, revision: 1 }));
      expect(await runtime.runPromise(handlers.loadProjectImportHistory({ threadId }))).toEqual({
        nextCursor: "1",
        messages: [],
      });
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const before = await runtime.runPromise(query.getThreadDetailById(threadId));
      const save = repository.saveHistory;
      repository.saveHistory = (state) =>
        state.revision === 2 ? Effect.die("interrupted page boundary") : save(state);
      await expect(
        runtime.runPromise(handlers.loadProjectImportHistory({ threadId, cursor: "1" })),
      ).rejects.toThrow("interrupted page boundary");
      repository.saveHistory = save;
      // Recreate handlers and rehydrate the model, preserving only durable state.
      await runtime.runPromise(engine.refreshCommandReadModel());
      const restarted = makeProjectImportHandlers(options);
      const older = await runtime.runPromise(
        restarted.loadProjectImportHistory({ threadId, cursor: "1" }),
      );
      expect(older).toMatchObject({ nextCursor: "2", messages: [{ text: "older" }] });
      expect(readHistory).toHaveBeenCalledTimes(1);
      const oldest = await runtime.runPromise(
        restarted.loadProjectImportHistory({ threadId, cursor: "2" }),
      );
      expect(oldest).toMatchObject({ nextCursor: null, messages: [{ text: "oldest" }] });
      // Reloading an earlier cached page cannot erase a later cached page.
      expect(
        await runtime.runPromise(restarted.loadProjectImportHistory({ threadId, cursor: "1" })),
      ).toEqual(older);
      expect(
        await runtime.runPromise(restarted.loadProjectImportHistory({ threadId, cursor: "2" })),
      ).toEqual(oldest);
      expect(readHistory).toHaveBeenCalledTimes(2);
      expect(await runtime.runPromise(query.getThreadDetailById(threadId))).toEqual(before);
      expect(await runtime.runPromise(restarted.loadProjectImportHistory({ threadId }))).toEqual({
        nextCursor: "1",
        messages: [],
      });
    } finally {
      await runtime.dispose();
    }
  },
);

it.each(["codex", "claudeAgent"] as const)(
  "keeps the messages an interrupted older %s import already copied, without duplicating them",
  async (provider) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const source = resolveProjectImportSources(DEFAULT_SERVER_SETTINGS, [provider])[0]!;
      const sourceHome = await resolveProjectImportSourceHome(source);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readImportedTranscript = vi.fn(async () => [
        { id: "m1", role: "user" as const, text: "Transcript message", createdAt },
      ]);
      const handlers = makeProjectImportHandlers({
        repository,
        orchestrationEngine: engine,
        providerService: {} as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        discover: async () => ({
          sourceHome,
          projects: [{ id: "source", title: "Source", roots: [process.cwd()] }],
          sessions: [
            {
              id: "original",
              projectId: "source",
              title: "Original",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: false,
            },
          ],
        }),
        readImportedTranscript,
      });
      const project = (
        await runtime.runPromise(handlers.listProjectImports({ providers: [provider] }))
      ).projects[0]!;
      const input = { projectKey: project.key, threadKey: project.threads[0]!.key };
      const complete = repository.complete;
      repository.complete = vi
        .fn(complete)
        .mockReturnValueOnce(Effect.die("old server interrupted"));
      await expect(runtime.runPromise(handlers.importProject(input))).rejects.toThrow(
        "old server interrupted",
      );
      repository.complete = complete;
      const origin = (await runtime.runPromise(repository.find(input.threadKey)))!;
      // The old importer committed its first messages under its own receipt before stopping.
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(`project-import:${origin.threadId}:messages:0`),
          threadId: origin.threadId,
          messages: [
            {
              messageId: MessageId.makeUnsafe(`import:${origin.threadId}:${provider}:0`),
              role: "assistant" as const,
              text: "Persisted full message",
              createdAt,
              updatedAt: createdAt,
            },
          ],
          createdAt,
        }),
      );
      await runtime.runPromise(engine.refreshCommandReadModel());
      // Clear the registration the interrupted attempt saved, as the old importer had none.
      await runtime.runPromise(
        repository.saveHistory({
          ...(await runtime.runPromise(repository.getHistory(origin.threadId)))!,
          lazy: { transcript: "pending", continuation: "pending" },
        }),
      );

      await runtime.runPromise(handlers.importProject(input));
      await runtime.runPromise(handlers.loadProjectImportHistory({ threadId: origin.threadId }));

      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const detail = await runtime.runPromise(query.getThreadDetailById(origin.threadId));
      expect(Option.getOrThrow(detail).messages.map((message) => message.text)).toEqual([
        "Persisted full message",
      ]);
      expect(readImportedTranscript).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  },
);
