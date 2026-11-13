// FILE: ProjectionSnapshotQuery.undecodableRows.test.ts
// Purpose: Proves one projection row that does not decode is skipped and logged by the
//          whole-database readers instead of stopping the server from starting.
// Layer: Orchestration projection query test

import { ThreadId } from "@moss/contracts";
import { Cause, Effect, Exit, Layer, Logger, References } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { formatDesktopFatalExitReport } from "../../desktopFatalExit.ts";
import { toThreadSnapshotRpcError } from "../../wsRpc.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

interface CapturedLog {
  readonly level: string;
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const NOW = "2026-11-13T09:00:00.000Z";
const GOOD_MODEL = '{"provider":"codex","model":"gpt-5"}';
const SKIP_MESSAGE =
  "skipped projection rows that could not be read; they stay in the database unchanged";

async function runOnFreshDatabase<A, E>(
  effect: Effect.Effect<A, E, ProjectionSnapshotQuery | SqlClient.SqlClient>,
): Promise<{ readonly value: A; readonly logs: ReadonlyArray<CapturedLog> }> {
  const logs: CapturedLog[] = [];
  const logger = Logger.make(({ message, logLevel, fiber }) => {
    const parts = Array.isArray(message) ? message : [message];
    logs.push({
      level: logLevel,
      message: parts.map(String).join(" "),
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );
  const value = await Effect.runPromise(
    effect.pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  return { value, logs };
}

const skipWarnings = (logs: ReadonlyArray<CapturedLog>, table?: string) =>
  logs.filter(
    (log) =>
      log.level === "Warn" &&
      log.message === SKIP_MESSAGE &&
      (table === undefined || log.annotations.table === table),
  );

const insertProject = (sql: SqlClient.SqlClient, projectId: string, scriptsJson = "[]") =>
  sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, ${projectId}, ${`/tmp/${projectId}`}, ${scriptsJson}, ${NOW}, ${NOW})`;

const insertThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  projectId: string,
  modelSelectionJson: string | null = GOOD_MODEL,
) =>
  sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, ${`Private title of ${threadId}`}, ${modelSelectionJson}, ${NOW}, ${NOW})`;

/** Two good threads and one bad one, in one good project. */
const seedThreadsWithOneBad = (badModelSelectionJson: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertProject(sql, "project-a");
    yield* insertThread(sql, "thread-good-1", "project-a");
    yield* insertThread(sql, "thread-bad", "project-a", badModelSelectionJson);
    yield* insertThread(sql, "thread-good-2", "project-a");
  });

const readAllWholeDatabaseReaders = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  return {
    command: yield* query.getCommandReadModel(),
    shell: yield* query.getShellSnapshot(),
    snapshot: yield* query.getSnapshot(),
  };
});

describe("ProjectionSnapshotQuery with a row that does not decode", () => {
  it("skips a thread whose model selection is NULL, keeps the rest and leaves the row alone", async () => {
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        yield* seedThreadsWithOneBad(null);
        const readers = yield* readAllWholeDatabaseReaders;
        const sql = yield* SqlClient.SqlClient;
        const stored = yield* sql<{ readonly modelSelection: string | null }>`
          SELECT model_selection_json AS "modelSelection"
          FROM projection_threads WHERE thread_id = 'thread-bad'`;
        return { ...readers, stored };
      }),
    );

    for (const model of [value.command, value.shell, value.snapshot]) {
      expect(model.threads.map((thread) => thread.id)).toEqual(["thread-good-1", "thread-good-2"]);
      expect(model.projects.map((project) => project.id)).toEqual(["project-a"]);
    }
    expect(value.stored).toEqual([{ modelSelection: null }]);

    const warnings = skipWarnings(logs, "projection_threads");
    expect(warnings.map((log) => log.annotations.reader)).toEqual([
      "getCommandReadModel",
      "getShellSnapshot",
      "getSnapshot",
    ]);
    for (const warning of warnings) {
      expect(warning.annotations.skippedRowCount).toBe(1);
      expect(warning.annotations.rows).toBe(
        'thread-bad: Expected string, got null at ["modelSelection"]',
      );
    }
    expect(JSON.stringify(logs)).not.toContain("Private title");
  });

  it("skips a thread whose model selection is JSON but not a model selection", async () => {
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        yield* seedThreadsWithOneBad("42");
        return yield* readAllWholeDatabaseReaders;
      }),
    );

    for (const model of [value.command, value.shell, value.snapshot]) {
      expect(model.threads.map((thread) => thread.id)).toEqual(["thread-good-1", "thread-good-2"]);
    }
    const warnings = skipWarnings(logs, "projection_threads");
    expect(warnings).toHaveLength(3);
    expect(String(warnings[0]?.annotations.rows)).toMatch(/^thread-bad: /u);
  });

  it("logs a reader's skipped rows once, not on every read", async () => {
    const { logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        yield* seedThreadsWithOneBad(null);
        const query = yield* ProjectionSnapshotQuery;
        for (let index = 0; index < 3; index += 1) {
          yield* query.getShellSnapshot();
          yield* query.getCommandReadModel();
        }
      }),
    );
    expect(skipWarnings(logs).map((log) => log.annotations.reader)).toEqual([
      "getShellSnapshot",
      "getCommandReadModel",
    ]);
  });

  it("logs nothing when every row decodes", async () => {
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-a");
        yield* insertThread(sql, "thread-1", "project-a");
        yield* insertThread(sql, "thread-2", "project-a");
        return yield* readAllWholeDatabaseReaders;
      }),
    );
    expect(value.command.threads).toHaveLength(2);
    expect(skipWarnings(logs)).toEqual([]);
  });

  it("skips a project that does not decode together with its threads", async () => {
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-good");
        yield* insertProject(sql, "project-bad", "not json");
        yield* insertThread(sql, "thread-in-good", "project-good");
        yield* insertThread(sql, "thread-in-bad", "project-bad");
        const readers = yield* readAllWholeDatabaseReaders;
        const stored = yield* sql<{ readonly scripts: string }>`
          SELECT scripts_json AS "scripts" FROM projection_projects WHERE project_id = 'project-bad'`;
        return { ...readers, stored };
      }),
    );

    for (const model of [value.command, value.shell, value.snapshot]) {
      expect(model.projects.map((project) => project.id)).toEqual(["project-good"]);
      expect(model.threads.map((thread) => thread.id)).toEqual(["thread-in-good"]);
    }
    expect(value.stored).toEqual([{ scripts: "not json" }]);
    const projectWarning = skipWarnings(logs, "projection_projects")[0];
    expect(projectWarning?.annotations.rows).toMatch(/^project-bad: /u);
    expect(String(projectWarning?.annotations.rows)).not.toContain("not json");
    expect(skipWarnings(logs, "projection_threads")[0]?.annotations.rows).toBe(
      "thread-in-bad: its project project-bad could not be read",
    );
  });

  it("skips one undecodable row in each thread child table without dropping its thread", async () => {
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-a");
        yield* insertThread(sql, "thread-good", "project-a");
        yield* insertThread(sql, "thread-odd", "project-a");
        yield* sql`INSERT INTO projection_spaces
          (space_id, name, icon, sort_order, created_at, updated_at, deleted_at)
          VALUES ('space-good', 'Good', 'bag', 0, ${NOW}, ${NOW}, NULL),
                 ('space-bad', 'Bad', 'bag', 'not a number', ${NOW}, ${NOW}, NULL)`;
        yield* sql`INSERT INTO projection_thread_sessions
          (thread_id, status, provider_name, runtime_mode, updated_at)
          VALUES ('thread-good', 'ready', 'codex', 'full-access', ${NOW}),
                 ('thread-odd', 'not-a-status', 'codex', 'full-access', ${NOW})`;
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, state, requested_at, assistant_message_id, checkpoint_files_json)
          VALUES ('thread-good', 'turn-good', 'completed', ${NOW}, NULL, '[]'),
                 ('thread-odd', 'turn-odd', 'completed', ${NOW}, '   ', '[]')`;
        yield* sql`INSERT INTO projection_thread_proposed_plans
          (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
          VALUES ('plan-good', 'thread-good', 'turn-good', '# Plan', ${NOW}, ${NOW}),
                 ('plan-bad', 'thread-odd', 'turn-odd', '   ', ${NOW}, ${NOW})`;
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES ('revert-good', 'thread-good', 'turn-good', 'info', 'checkpoint.revert.started',
                  'Reverting', '{}', ${NOW}),
                 ('revert-bad', 'thread-odd', 'turn-odd', 'info', 'checkpoint.revert.started',
                  'Reverting', 'not json', ${NOW})`;
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('message-good', 'thread-good', 'turn-good', 'user', 'hello', 0, ${NOW}, ${NOW}),
                 ('message-bad', 'thread-odd', 'turn-odd', 'not-a-role', 'secret words', 0, ${NOW}, ${NOW})`;
        return yield* readAllWholeDatabaseReaders;
      }),
    );

    for (const model of [value.command, value.shell, value.snapshot]) {
      expect(model.spaces.map((space) => space.id)).toEqual(["space-good"]);
      expect(model.threads.map((thread) => thread.id)).toEqual(["thread-good", "thread-odd"]);
      const [good, odd] = model.threads;
      expect(good?.session?.status).toBe("ready");
      expect(good?.latestTurn?.turnId).toBe("turn-good");
      expect(odd?.session).toBeNull();
      expect(odd?.latestTurn).toBeNull();
    }
    expect(value.command.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-good"]);
    expect(value.command.threads[1]?.proposedPlans).toEqual([]);
    expect(value.command.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "revert-good",
    ]);
    expect(value.command.threads[1]?.activities).toEqual([]);
    expect(value.snapshot.threads[0]?.messages.map((message) => message.id)).toEqual([
      "message-good",
    ]);
    expect(value.snapshot.threads[1]?.messages).toEqual([]);

    const skippedIds = (table: string) =>
      [...new Set(skipWarnings(logs, table).map((log) => String(log.annotations.rows)))].map(
        (rows) => rows.split(":")[0],
      );
    expect(skippedIds("projection_spaces")).toEqual(["space-bad"]);
    expect(skippedIds("projection_thread_sessions")).toEqual(["thread-odd"]);
    expect(skippedIds("projection_turns")).toEqual(["thread-odd/turn-odd"]);
    expect(skippedIds("projection_thread_proposed_plans")).toEqual(["plan-bad"]);
    expect(skippedIds("projection_thread_activities")).toEqual(["revert-bad"]);
    expect(skippedIds("projection_thread_messages")).toEqual(["message-bad"]);
    expect(JSON.stringify(logs)).not.toContain("secret words");
  });

  it("never puts a value from a wrongly typed column into a log line, an error or a crash report", async () => {
    const secret = "sk-live-0123456789abcdefSECRET";
    const { value, logs } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-a");
        yield* insertThread(sql, "thread-good", "project-a");
        yield* insertThread(sql, "thread-secret", "project-a");
        // A number column holding text: SQLite keeps it, the decoder rejects it.
        yield* sql`UPDATE projection_threads SET is_pinned = ${secret}
          WHERE thread_id = 'thread-secret'`;
        const readers = yield* readAllWholeDatabaseReaders;
        const query = yield* ProjectionSnapshotQuery;
        const detail = yield* Effect.exit(
          query.getThreadDetailById(ThreadId.makeUnsafe("thread-secret")),
        );
        return { ...readers, detail };
      }),
    );

    expect(value.command.threads.map((thread) => thread.id)).toEqual(["thread-good"]);
    expect(skipWarnings(logs, "projection_threads")[0]?.annotations.rows).toBe(
      'thread-secret: Expected number, got string at ["isPinned"]',
    );
    expect(Exit.isFailure(value.detail)).toBe(true);
    const texts = [JSON.stringify(logs)];
    if (Exit.isFailure(value.detail)) {
      texts.push(
        Cause.pretty(value.detail.cause),
        // What the desktop backend would write to stderr, and so to the desktop
        // log's lastError= line and the copied details, if this failed startup.
        formatDesktopFatalExitReport(value.detail.cause),
      );
    }
    for (const text of texts) {
      expect(text).not.toContain("sk-live-");
    }
  });

  it("keeps a thread the full readers cannot read out of the shell, and says so", async () => {
    const { value } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-a");
        yield* insertThread(sql, "thread-good", "project-a");
        // Only the full row reads pinned messages: the shell alone would list it.
        yield* insertThread(sql, "thread-full-row-broken", "project-a");
        yield* sql`UPDATE projection_threads SET pinned_messages_json = 'not json'
          WHERE thread_id = 'thread-full-row-broken'`;
        yield* insertThread(sql, "thread-null-model", "project-a", null);
        // A broken row that was already deleted is nobody's loss: no notice.
        yield* insertThread(sql, "thread-deleted-broken", "project-a", null);
        yield* sql`UPDATE projection_threads SET deleted_at = ${NOW}
          WHERE thread_id = 'thread-deleted-broken'`;
        const query = yield* ProjectionSnapshotQuery;
        const shellBeforeStartup = yield* query.getShellSnapshot();
        // At startup the engine loads the command read model before any client.
        const command = yield* query.getCommandReadModel();
        const shell = yield* query.getShellSnapshot();
        return { shellBeforeStartup, command, shell };
      }),
    );

    expect(value.command.threads.map((thread) => thread.id)).toEqual(["thread-good"]);
    expect(value.shell.threads.map((thread) => thread.id)).toEqual(["thread-good"]);
    expect(value.shell.unreadableThreads).toEqual([
      { id: "thread-null-model", reason: 'Expected string, got null at ["modelSelection"]' },
      {
        id: "thread-full-row-broken",
        reason: expect.stringMatching(/ at \["pinnedMessages"\]$/u),
      },
    ]);
    // Without a full read first, the shell can only report what it reads itself.
    expect(value.shellBeforeStartup.threads.map((thread) => thread.id).toSorted()).toEqual([
      "thread-full-row-broken",
      "thread-good",
    ]);
  });

  it("adds nothing to the shell when every row decodes", async () => {
    const { value } = await runOnFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject(sql, "project-a");
        yield* insertThread(sql, "thread-1", "project-a");
        const query = yield* ProjectionSnapshotQuery;
        yield* query.getCommandReadModel();
        return yield* query.getShellSnapshot();
      }),
    );
    expect(value.unreadableThreads).toBeUndefined();
  });

  it("gives a thread client a terminal answer for an unreadable thread instead of a retryable error", async () => {
    const { value } = await runOnFreshDatabase(
      Effect.gen(function* () {
        yield* seedThreadsWithOneBad(null);
        const query = yield* ProjectionSnapshotQuery;
        return yield* Effect.exit(
          query.getThreadDetailSnapshotById(ThreadId.makeUnsafe("thread-bad")),
        );
      }),
    );
    expect(Exit.isFailure(value)).toBe(true);
    if (Exit.isFailure(value)) {
      const failure = value.cause.reasons.find((reason) => reason._tag === "Fail");
      const error = toThreadSnapshotRpcError(
        "thread-bad",
        failure?._tag === "Fail" ? failure.error : undefined,
      );
      expect(error.code).toBe("THREAD_SNAPSHOT_NOT_FOUND");
      expect(error.retryable).toBe(false);
    }
  });
});
