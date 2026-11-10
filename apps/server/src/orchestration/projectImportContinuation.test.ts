import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type OrchestrationCommand,
  type ProviderForkThreadResult,
} from "@moss/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectImportHistoryState,
  ProjectImportOrigin,
  ProjectImportRepository,
} from "../persistence/projectImportRepository";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { makeImportedThreadContinuation } from "./projectImportContinuation";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";

const directories: string[] = [];
beforeEach(() => {
  // Keep every lookup inside the fixture home, never the machine's own Codex store.
  vi.stubEnv("CODEX_SQLITE_HOME", "");
  vi.stubEnv("CODEX_HOME", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CREATED_AT = "2026-11-01T08:00:00.000Z";
const threadId = ThreadId.makeUnsafe("imported-thread");

async function codexHome(rolloutInside: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "moss-import-continue-")));
  directories.push(root);
  const home = path.join(root, "codex-home");
  const sessions = rolloutInside
    ? path.join(home, "sessions", "2026", "11", "01")
    : path.join(root, "other-codex-home", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(home, { recursive: true });
  const rollout = path.join(sessions, "rollout-2026-11-01T08-00-00-codex-source.jsonl");
  await writeFile(
    rollout,
    [
      {
        timestamp: CREATED_AT,
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Earlier ask" }] },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const database = new DatabaseSync(path.join(home, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  database.prepare("INSERT INTO threads VALUES ('codex-source', ?)").run(rollout);
  database.close();
  return home;
}

function harness(input: { home: string; threadProvider?: "codex" | "claudeAgent" }) {
  const states = new Map<number, ProjectImportHistoryState>([
    [
      0,
      {
        provider: "codex",
        threadId,
        nativeId: "",
        providerInstanceId: "codex" as ProjectImportHistoryState["providerInstanceId"],
        sourceHome: input.home,
        sourceCwd: input.home,
        sourceCreatedAt: CREATED_AT,
        cursor: null,
        before: null,
        revision: 0,
        pending: null,
        lazy: { transcript: "pending", continuation: "pending" },
      },
    ],
  ]);
  const origin: ProjectImportOrigin = {
    sourceKey: "source",
    provider: "codex",
    sourceHome: input.home,
    externalId: "codex-source",
    projectId: "project" as ProjectImportOrigin["projectId"],
    threadId,
    status: "completed",
    createdAt: CREATED_AT,
  };
  const commands: OrchestrationCommand[] = [];
  const repository = {
    getHistory: () => Effect.sync(() => states.get(0)),
    saveHistory: (state: ProjectImportHistoryState) =>
      Effect.sync(() => void states.set(state.revision, state)),
    findByThread: () => Effect.succeed(origin),
    hasRuntimeBinding: () => Effect.succeed(false),
    getLegacyMessages: () => Effect.succeed([]),
  } as unknown as ProjectImportRepository;
  const importExternalThread = vi.fn(
    (_input: unknown): Effect.Effect<ProviderForkThreadResult, unknown> =>
      Effect.succeed({ threadId, resumeCursor: { threadId: "codex-copy" } }),
  );
  const stopRuntimeSession = vi.fn((_input: unknown) => Effect.void);
  const continuation = makeImportedThreadContinuation({
    repository,
    orchestrationEngine: {
      getReadModel: () =>
        Effect.succeed({
          threads: [
            {
              id: threadId,
              modelSelection: { provider: input.threadProvider ?? "codex", model: "gpt" },
              runtimeMode: "approval-required",
            },
          ],
        }),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineShape,
    providerService: {
      importExternalThread,
      stopRuntimeSession,
    } as unknown as ProviderServiceShape,
    serverSettings: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: input.home },
        },
      }),
    } as unknown as ServerSettingsShape,
    homeDir: path.dirname(input.home),
  });
  return { continuation, states, commands, importExternalThread, stopRuntimeSession };
}

describe("continuing an imported conversation", () => {
  it("loads the transcript, then makes the native copy once when the rollout is in the active home", async () => {
    const test = harness({ home: await codexHome(true) });

    await Effect.runPromise(test.continuation.prepare(threadId));
    await Effect.runPromise(test.continuation.prepare(threadId));

    const imported = test.commands.filter((command) => command.type === "thread.messages.import");
    expect(imported).toHaveLength(1);
    expect(imported[0]?.type === "thread.messages.import" && imported[0].messages[0]?.text).toBe(
      "Earlier ask",
    );
    expect(test.importExternalThread).toHaveBeenCalledTimes(1);
    expect(test.importExternalThread.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      provider: "codex",
      externalThreadId: "codex-source",
    });
    expect(test.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(test.states.get(0)?.lazy).toEqual({ transcript: "loaded", continuation: "native" });
  });

  it("continues from the copied transcript when the rollout lives in another Codex home", async () => {
    const test = harness({ home: await codexHome(false) });

    await Effect.runPromise(test.continuation.prepare(threadId));

    expect(test.importExternalThread).not.toHaveBeenCalled();
    expect(test.states.get(0)?.lazy).toEqual({ transcript: "loaded", continuation: "copied" });
  });

  it("continues from the copied transcript after the person switched agents", async () => {
    const test = harness({ home: await codexHome(true), threadProvider: "claudeAgent" });

    await Effect.runPromise(test.continuation.prepare(threadId));

    expect(test.importExternalThread).not.toHaveBeenCalled();
    expect(test.states.get(0)?.lazy?.continuation).toBe("copied");
  });

  it("falls back to the copied transcript when the native copy fails", async () => {
    const test = harness({ home: await codexHome(true) });
    test.importExternalThread.mockReturnValueOnce(Effect.fail(new Error("fork refused")));

    await Effect.runPromise(test.continuation.prepare(threadId));

    expect(test.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(test.states.get(0)?.lazy?.continuation).toBe("copied");
  });
});
