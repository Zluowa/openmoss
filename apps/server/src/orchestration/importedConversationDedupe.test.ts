// FILE: importedConversationDedupe.test.ts
// Purpose: Prove the project import panel offers no conversation the workspace import's
//          chat sync already brought in, and that the project import's records are what
//          the chat sync checks.
// Layer: Orchestration import tests

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId } from "@moss/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeProjectImportRepository } from "../persistence/projectImportRepository";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { ServerSettingsService } from "../serverSettings.ts";
import { writeWorkspaceImportLedger } from "../workspaceImport/ledger";
import { listProjectImportedConversationKeys } from "./importedConversationKeys";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { makeProjectImportHandlers } from "./projectImportRoute";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeRuntime() {
  return ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "moss-import-dedupe-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

const SYNCED = "01a1b4fd-87cf-7020-ae06-aba42c742956";
const NOT_SYNCED = "01a1b505-5b4c-7962-8acd-639d35935427";
const createdAt = "2026-11-01T00:00:00.000Z";

it("does not offer a conversation the workspace chat sync already imported", async () => {
  const runtime = makeRuntime();
  const stateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-import-dedupe-state-"));
  tempDirs.push(stateDir);
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const repository = await runtime.runPromise(makeProjectImportRepository);
    const projectId = ProjectId.makeUnsafe("synced-project");
    const threadId = ThreadId.makeUnsafe("synced-thread");
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("dedupe-project"),
        projectId,
        title: "Synced",
        workspaceRoot: process.cwd(),
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("dedupe-thread"),
        threadId,
        projectId,
        title: "Synced chat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const ledgerEntry = (sessionId: string, thread: string) => ({
      threadId: thread,
      source: "codex" as const,
      sourceId: `codex:.codex/sessions/2026/11/01/rollout-2026-11-01T00-00-00-${sessionId}.jsonl`,
      title: "Synced chat",
      workingDirectory: process.cwd(),
      importedCount: 2,
      sourceUpdatedAt: createdAt,
      importedAt: createdAt,
      updatedAt: createdAt,
    });
    await writeWorkspaceImportLedger(stateDir, {
      version: 1,
      entries: {
        a: ledgerEntry(SYNCED, threadId),
        // Its thread was deleted, so the conversation is offered again.
        b: ledgerEntry(NOT_SYNCED, "deleted-thread"),
      },
    });
    const session = (id: string) => ({
      id,
      projectId: "source-project",
      title: `Conversation ${id.slice(-4)}`,
      cwd: process.cwd(),
      createdAt,
      updatedAt: createdAt,
      archived: false,
    });
    const handlers = makeProjectImportHandlers({
      repository,
      orchestrationEngine: engine,
      providerService: {} as ProviderServiceShape,
      providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
      serverSettings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as ServerSettingsShape,
      stateDir,
      discover: async () => ({
        sourceHome: "/codex",
        projects: [{ id: "source-project", title: "Source project", roots: [process.cwd()] }],
        sessions: [session(SYNCED), session(NOT_SYNCED)],
      }),
    });

    const catalog = await runtime.runPromise(handlers.listProjectImports({ providers: ["codex"] }));
    const threads = catalog.projects.flatMap((project) => project.threads);
    const byTitle = Object.fromEntries(threads.map((thread) => [thread.title, thread]));

    expect(byTitle[`Conversation ${SYNCED.slice(-4)}`]?.alreadyImported).toBe(true);
    expect(byTitle[`Conversation ${NOT_SYNCED.slice(-4)}`]?.alreadyImported).toBe(false);
  } finally {
    await runtime.dispose();
  }
});

it("lists conversations the project import registered for the chat sync to skip", async () => {
  const runtime = makeRuntime();
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const repository = await runtime.runPromise(makeProjectImportRepository);
    const handlers = makeProjectImportHandlers({
      repository,
      orchestrationEngine: engine,
      providerService: {} as ProviderServiceShape,
      providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
      serverSettings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as ServerSettingsShape,
      readImportedTranscript: async () => [],
      discover: async () => ({
        sourceHome: "/codex",
        projects: [{ id: "source-project", title: "Source project", roots: [process.cwd()] }],
        sessions: [
          {
            id: SYNCED.toUpperCase(),
            projectId: "source-project",
            title: "Registered",
            cwd: process.cwd(),
            createdAt,
            updatedAt: createdAt,
            archived: false,
          },
        ],
      }),
    });
    const catalog = await runtime.runPromise(handlers.listProjectImports({ providers: ["codex"] }));
    const project = catalog.projects[0]!;
    await runtime.runPromise(
      handlers.importProject({ projectKey: project.key, threadKey: project.threads[0]!.key }),
    );

    const keys = await runtime.runPromise(listProjectImportedConversationKeys(repository));

    // Keys are case-insensitive, matching the lower-case ids read from rollout names.
    expect(keys.has(`codex:${SYNCED}`)).toBe(true);
    expect(keys.has(`codex:${NOT_SYNCED}`)).toBe(false);
  } finally {
    await runtime.dispose();
  }
});
