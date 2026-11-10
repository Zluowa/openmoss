import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ProjectId, ThreadId } from "@moss/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "./config.ts";
import {
  listRetentionArchivedRoots,
  restoreThreadsArchivedByRetention,
  THREAD_RETENTION_COMMAND_ID_PREFIX,
} from "./legacyThreadRetention.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const sweep = (id: string) => `${THREAD_RETENTION_COMMAND_ID_PREFIX}${id}`;

describe("conversations hidden by the removed age-based archiving", () => {
  it("finds what the sweep archived, one per archive, and nothing the person archived", () => {
    // Rows are the archived threads with the command behind each one's latest archive.
    const roots = listRetentionArchivedRoots([
      { threadId: "swept", parentThreadId: null, commandId: sweep("a") },
      // A subagent archived together with its parent comes back with it.
      { threadId: "swept-child", parentThreadId: "swept", commandId: sweep("a") },
      // Archived by its own sweep command under a parent that is still visible.
      { threadId: "orphan-swept", parentThreadId: "visible-parent", commandId: sweep("b") },
      { threadId: "by-person", parentThreadId: null, commandId: "archive-from-sidebar" },
      // Archived before archive commands were recorded.
      { threadId: "unknown", parentThreadId: null, commandId: null },
    ]);

    expect(roots).toEqual(["swept", "orphan-swept"]);
  });

  it("restores swept conversations once, durably, and leaves the person's archives alone", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-retention-restore-"));
    directories.push(stateDir);
    const dbPath = path.join(stateDir, "state.sqlite");
    const createdAt = "2026-09-01T00:00:00.000Z";
    const projectId = ProjectId.makeUnsafe("project-restore");
    const ids = {
      swept: ThreadId.makeUnsafe("thread-swept"),
      sweptThenKept: ThreadId.makeUnsafe("thread-swept-then-archived-by-person"),
      byPerson: ThreadId.makeUnsafe("thread-archived-by-person"),
    };

    let system = await createSystem(dbPath);
    try {
      await system.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project"),
        projectId,
        title: "Restore project",
        workspaceRoot: path.join(stateDir, "workspace"),
        defaultModelSelection: { instanceId: "codex", provider: "codex", model: "gpt-5-codex" },
        createdAt,
      });
      for (const threadId of Object.values(ids)) {
        await system.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-create-${threadId}`),
          threadId,
          projectId,
          title: threadId,
          modelSelection: { instanceId: "codex", provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      const archive = (threadId: ThreadId, commandId: string) =>
        system.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe(commandId),
          threadId,
        });
      await archive(ids.swept, `${THREAD_RETENTION_COMMAND_ID_PREFIX}one`);
      // Swept, brought back by the person, then archived by them on purpose.
      await archive(ids.sweptThenKept, `${THREAD_RETENTION_COMMAND_ID_PREFIX}two`);
      await system.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("cmd-person-restore"),
        threadId: ids.sweptThenKept,
      });
      await archive(ids.sweptThenKept, "cmd-person-archive-again");
      await archive(ids.byPerson, "cmd-person-archive");

      expect(await system.run(restoreThreadsArchivedByRetention(system.engine))).toBe(1);
      expect(await system.archived()).toEqual({
        [ids.swept]: false,
        [ids.sweptThenKept]: true,
        [ids.byPerson]: true,
      });

      // After a restart the restore is already done, and the projection agrees.
      await system.dispose();
      system = await createSystem(dbPath);
      expect(await system.run(restoreThreadsArchivedByRetention(system.engine))).toBe(0);
      expect(await system.archived()).toEqual({
        [ids.swept]: false,
        [ids.sweptThenKept]: true,
        [ids.byPerson]: true,
      });
    } finally {
      await system.dispose();
    }
  });
});

async function createSystem(dbPath: string) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ServerSettingsService.layerTest()),
      ),
    ),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "moss-retention-restore-test-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const run: typeof runtime.runPromise = (effect, options) => runtime.runPromise(effect, options);
  return {
    engine,
    run,
    dispatch: (command: Parameters<typeof engine.dispatch>[0]) => run(engine.dispatch(command)),
    /** Whether each thread is archived, by id. */
    archived: async () => {
      const model = await run(engine.getReadModel());
      return Object.fromEntries(
        model.threads.map((entry) => [entry.id, entry.archivedAt != null] as const),
      );
    },
    dispose: () => runtime.dispose(),
  };
}
