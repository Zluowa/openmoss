// FILE: t3codeV54ImportFixture.ts
// Purpose: A T3 Code v54 database as `homeMigration.ts` imports it: real schema, invented rows.
// Layer: Persistence test fixture

import type { DatabaseSync } from "node:sqlite";

import { T3CODE_IMPORT_DESCRIPTOR } from "./MigrationLineage.ts";

const SCHEMA_STATEMENTS = [
  'CREATE TABLE "effect_sql_migrations" ( migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL )',
  "CREATE TABLE orchestration_events ( sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT, causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL, payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL )",
  "CREATE TABLE orchestration_command_receipts ( command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, accepted_at TEXT NOT NULL, result_sequence INTEGER NOT NULL, status TEXT NOT NULL, error TEXT )",
  "CREATE TABLE checkpoint_diff_blobs ( thread_id TEXT NOT NULL, from_turn_count INTEGER NOT NULL, to_turn_count INTEGER NOT NULL, diff TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (thread_id, from_turn_count, to_turn_count) )",
  "CREATE TABLE provider_session_runtime ( thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, adapter_key TEXT NOT NULL, runtime_mode TEXT NOT NULL DEFAULT 'full-access', status TEXT NOT NULL, last_seen_at TEXT NOT NULL, resume_cursor_json TEXT, runtime_payload_json TEXT , provider_instance_id TEXT)",
  "CREATE TABLE projection_projects ( project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT , default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT, auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT)",
  "CREATE TABLE projection_threads ( thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT, latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, pinned_at TEXT, pin_order_key TEXT, linked_pull_request_json TEXT, unsettled_at TEXT, branch_pull_request_json TEXT, active_order_key TEXT, title_state_json TEXT, auto_settle_disabled_at TEXT)",
  "CREATE TABLE projection_thread_messages ( message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL , attachments_json TEXT, context_json TEXT)",
  "CREATE TABLE projection_thread_activities ( activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL , sequence INTEGER)",
  "CREATE TABLE projection_thread_sessions ( thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT, provider_session_id TEXT, provider_thread_id TEXT, active_turn_id TEXT, last_error TEXT, updated_at TEXT NOT NULL , runtime_mode TEXT NOT NULL DEFAULT 'full-access', provider_instance_id TEXT)",
  "CREATE TABLE projection_turns ( row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT, pending_message_id TEXT, assistant_message_id TEXT, state TEXT NOT NULL, requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, checkpoint_turn_count INTEGER, checkpoint_ref TEXT, checkpoint_status TEXT, checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT, UNIQUE (thread_id, turn_id), UNIQUE (thread_id, checkpoint_turn_count) )",
  "CREATE TABLE projection_pending_approvals ( request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, status TEXT NOT NULL, decision TEXT, created_at TEXT NOT NULL, resolved_at TEXT )",
  "CREATE TABLE projection_state ( projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL )",
  "CREATE TABLE projection_thread_proposed_plans ( plan_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, plan_markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL , implemented_at TEXT, implementation_thread_id TEXT)",
  "CREATE TABLE auth_pairing_links ( id TEXT PRIMARY KEY, credential TEXT NOT NULL UNIQUE, method TEXT NOT NULL, scopes TEXT NOT NULL, subject TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT , proof_key_thumbprint TEXT)",
  "CREATE TABLE auth_sessions ( session_id TEXT PRIMARY KEY, subject TEXT NOT NULL, scopes TEXT NOT NULL, method TEXT NOT NULL, client_label TEXT, client_ip_address TEXT, client_user_agent TEXT, client_device_type TEXT NOT NULL DEFAULT 'unknown', client_os TEXT, client_browser TEXT, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_connected_at TEXT, revoked_at TEXT , client_surface TEXT, client_app_version TEXT)",
  "CREATE TABLE projection_thread_pull_requests ( thread_id TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL, source TEXT NOT NULL, linked_at TEXT NOT NULL, snapshot_json TEXT, stack_json TEXT, PRIMARY KEY (thread_id, host, repository, number) )",
  "CREATE TABLE pull_request_files_viewed ( provider TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, viewer TEXT NOT NULL, path TEXT NOT NULL, revision TEXT, viewed_at TEXT NOT NULL, PRIMARY KEY (provider, host, repository, number, viewer, path) ) WITHOUT ROWID",
  "CREATE UNIQUE INDEX idx_orch_events_stream_version ON orchestration_events(aggregate_kind, stream_id, stream_version)",
  "CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind, stream_id, sequence)",
  "CREATE INDEX idx_orch_events_command_id ON orchestration_events(command_id)",
  "CREATE INDEX idx_orch_events_correlation_id ON orchestration_events(correlation_id)",
  "CREATE INDEX idx_orch_command_receipts_aggregate ON orchestration_command_receipts(aggregate_kind, aggregate_id)",
  "CREATE INDEX idx_orch_command_receipts_sequence ON orchestration_command_receipts(result_sequence)",
  "CREATE INDEX idx_checkpoint_diff_blobs_thread_to_turn ON checkpoint_diff_blobs(thread_id, to_turn_count)",
  "CREATE INDEX idx_provider_session_runtime_status ON provider_session_runtime(status)",
  "CREATE INDEX idx_provider_session_runtime_provider ON provider_session_runtime(provider_name)",
  "CREATE INDEX idx_projection_projects_updated_at ON projection_projects(updated_at)",
  "CREATE INDEX idx_projection_threads_project_id ON projection_threads(project_id)",
  "CREATE INDEX idx_projection_thread_messages_thread_created ON projection_thread_messages(thread_id, created_at)",
  "CREATE INDEX idx_projection_thread_activities_thread_created ON projection_thread_activities(thread_id, created_at)",
  "CREATE INDEX idx_projection_thread_sessions_provider_session ON projection_thread_sessions(provider_session_id)",
  "CREATE INDEX idx_projection_turns_thread_requested ON projection_turns(thread_id, requested_at)",
  "CREATE INDEX idx_projection_turns_thread_checkpoint_completed ON projection_turns(thread_id, checkpoint_turn_count, completed_at)",
  "CREATE INDEX idx_projection_pending_approvals_thread_status ON projection_pending_approvals(thread_id, status)",
  "CREATE INDEX idx_projection_thread_activities_thread_sequence ON projection_thread_activities(thread_id, sequence)",
  "CREATE INDEX idx_projection_thread_proposed_plans_thread_created ON projection_thread_proposed_plans(thread_id, created_at)",
  "CREATE INDEX idx_projection_threads_project_archived_at ON projection_threads(project_id, archived_at)",
  "CREATE INDEX idx_projection_projects_workspace_root_deleted_at ON projection_projects(workspace_root, deleted_at)",
  "CREATE INDEX idx_projection_threads_project_deleted_created ON projection_threads(project_id, deleted_at, created_at)",
  "CREATE INDEX idx_provider_session_runtime_instance ON provider_session_runtime(provider_instance_id)",
  "CREATE INDEX idx_projection_thread_sessions_instance ON projection_thread_sessions(provider_instance_id)",
  "CREATE INDEX idx_projection_thread_activities_thread_sequence_created_id ON projection_thread_activities(thread_id, sequence, created_at, activity_id)",
  "CREATE INDEX idx_projection_thread_messages_thread_created_id ON projection_thread_messages(thread_id, created_at, message_id)",
  "CREATE INDEX idx_projection_threads_shell_active ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id)",
  "CREATE INDEX idx_projection_threads_shell_archived ON projection_threads(deleted_at, archived_at, project_id, thread_id)",
  "CREATE INDEX idx_auth_pairing_links_active ON auth_pairing_links(revoked_at, consumed_at, expires_at)",
  "CREATE INDEX idx_auth_sessions_active ON auth_sessions(revoked_at, expires_at, issued_at)",
  "CREATE INDEX idx_projection_turns_thread_keyset ON projection_turns(thread_id, requested_at, turn_id)",
  "CREATE INDEX idx_projection_thread_pull_requests_pr ON projection_thread_pull_requests(host, repository, number)",
] as const;

const T0 = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-01T08:05:00.000Z";
const MODEL_SELECTION = JSON.stringify({ instanceId: "codex", model: "gpt-fixture" });
const TITLE_STATE = JSON.stringify({ needsRefinement: false, source: "user", version: "1" });

export const T3CODE_V54_FIXTURE_COUNTS = {
  projection_projects: 2,
  projection_threads: 3,
  projection_thread_messages: 6,
  projection_thread_activities: 1,
  projection_thread_sessions: 1,
  projection_turns: 1,
  provider_session_runtime: 3,
  orchestration_command_receipts: 2,
  auth_sessions: 1,
} as const;

export const T3CODE_V54_FIXTURE_MESSAGE = {
  threadId: "fixture-thread-1",
  messageId: "fixture-message-2",
  text: "固定测试回复：迁移后这段文字必须完整。",
} as const;

/** Creates the schema and tracker through `highWaterMark`, then the invented rows. */
export function seedT3CodeV54Import(database: DatabaseSync, highWaterMark = 54): void {
  for (const statement of SCHEMA_STATEMENTS) database.exec(statement);
  const tracker = database.prepare(
    "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
  );
  for (const [id, name] of T3CODE_IMPORT_DESCRIPTOR) {
    if (id <= highWaterMark) tracker.run(id, name);
  }

  const project = database.prepare(
    `INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, auto_pull)
     VALUES (?, ?, ?, '[]', ?, ?, 0)`,
  );
  project.run("fixture-project-1", "Fixture Alpha", "/fixture/alpha", T0, T0);
  project.run("fixture-project-2", "Fixture Beta", "/fixture/beta", T0, T0);

  const thread = database.prepare(
    `INSERT INTO projection_threads
      (thread_id, project_id, title, latest_turn_id, created_at, updated_at, runtime_mode, interaction_mode,
       model_selection_json, latest_user_message_at, settled_override, settled_at, title_state_json)
     VALUES (?, ?, ?, ?, ?, ?, 'full-access', 'default', ?, ?, ?, ?, ?)`,
  );
  thread.run(
    "fixture-thread-1",
    "fixture-project-1",
    "第一个固定对话",
    "fixture-turn-1",
    T0,
    T1,
    MODEL_SELECTION,
    T0,
    null,
    null,
    TITLE_STATE,
  );
  thread.run(
    "fixture-thread-2",
    "fixture-project-1",
    "Settled fixture thread",
    null,
    T0,
    T1,
    MODEL_SELECTION,
    T0,
    "settled",
    T1,
    TITLE_STATE,
  );
  thread.run(
    "fixture-thread-3",
    "fixture-project-2",
    "Third fixture thread",
    null,
    T0,
    T1,
    MODEL_SELECTION,
    T0,
    null,
    T1,
    TITLE_STATE,
  );

  const message = database.prepare(
    `INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, '[]')`,
  );
  message.run(
    "fixture-message-1",
    "fixture-thread-1",
    "fixture-turn-1",
    "user",
    "固定测试问题",
    T0,
    T0,
  );
  message.run(
    T3CODE_V54_FIXTURE_MESSAGE.messageId,
    T3CODE_V54_FIXTURE_MESSAGE.threadId,
    "fixture-turn-1",
    "assistant",
    T3CODE_V54_FIXTURE_MESSAGE.text,
    T1,
    T1,
  );
  message.run(
    "fixture-message-3",
    "fixture-thread-2",
    null,
    "user",
    "Fixture question two",
    T0,
    T0,
  );
  message.run(
    "fixture-message-4",
    "fixture-thread-2",
    null,
    "assistant",
    "Fixture answer two",
    T1,
    T1,
  );
  message.run(
    "fixture-message-5",
    "fixture-thread-3",
    null,
    "user",
    "Fixture question three",
    T0,
    T0,
  );
  message.run(
    "fixture-message-6",
    "fixture-thread-3",
    null,
    "assistant",
    "Fixture answer three",
    T1,
    T1,
  );

  database
    .prepare(
      `INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
       VALUES ('fixture-activity-1', 'fixture-thread-1', NULL, 'info', 'fixture.note', 'Fixture note', '{}', ?)`,
    )
    .run(T1);
  database
    .prepare(
      `INSERT INTO projection_thread_sessions
        (thread_id, status, provider_name, updated_at, runtime_mode, provider_instance_id)
       VALUES ('fixture-thread-1', 'stopped', 'codex', ?, 'full-access', 'codex')`,
    )
    .run(T1);
  database
    .prepare(
      `INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
       VALUES ('fixture-thread-1', 'fixture-turn-1', 'fixture-message-1', 'fixture-message-2', 'completed', ?, ?, ?, '[]')`,
    )
    .run(T0, T0, T1);

  const runtime = database.prepare(
    `INSERT INTO provider_session_runtime
      (thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json, provider_instance_id)
     VALUES (?, ?, ?, 'full-access', 'stopped', ?, '{}', '{}', ?)`,
  );
  runtime.run("fixture-thread-1", "codex", "codex", T1, "codex");
  runtime.run("fixture-thread-2", "claudeAgent", "claudeAgent", T1, "claudeAgent");
  runtime.run("fixture-thread-3", "codex", "codex", T1, "codex");

  const receipt = database.prepare(
    `INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status)
     VALUES (?, 'thread', 'fixture-thread-1', ?, ?, 'accepted')`,
  );
  receipt.run("fixture-command-1", T0, 3);
  receipt.run("fixture-command-2", T1, 4);

  database
    .prepare(
      `INSERT INTO auth_sessions
        (session_id, subject, scopes, method, client_device_type, issued_at, expires_at, client_surface)
       VALUES ('fixture-session', 'fixture-subject', '[]', 'bearer-session-token', 'desktop', ?, '2099-01-01T00:00:00.000Z', 'desktop')`,
    )
    .run(T0);

  const event = database.prepare(
    `INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, correlation_id, actor_kind, payload_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'client', ?, '{}')`,
  );
  const events: ReadonlyArray<readonly [string, string, string, Record<string, unknown>]> = [
    [
      "project",
      "fixture-project-1",
      "project.created",
      {
        projectId: "fixture-project-1",
        title: "Fixture Alpha",
        workspaceRoot: "/fixture/alpha",
        defaultModelSelection: null,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    [
      "project",
      "fixture-project-2",
      "project.created",
      {
        projectId: "fixture-project-2",
        title: "Fixture Beta",
        workspaceRoot: "/fixture/beta",
        defaultModelSelection: null,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.created",
      {
        threadId: "fixture-thread-1",
        projectId: "fixture-project-1",
        title: "第一个固定对话",
        modelSelection: { instanceId: "codex", model: "gpt-fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.message-sent",
      {
        threadId: "fixture-thread-1",
        messageId: "fixture-message-1",
        role: "user",
        text: "固定测试问题",
        turnId: null,
        streaming: false,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.turn-start-requested",
      {
        threadId: "fixture-thread-1",
        messageId: "fixture-message-1",
        modelSelection: { instanceId: "codex", model: "gpt-fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "固定",
        createdAt: T0,
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.session-set",
      {
        threadId: "fixture-thread-1",
        session: {
          threadId: "fixture-thread-1",
          status: "stopped",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: T1,
        },
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.message-sent",
      {
        threadId: "fixture-thread-1",
        messageId: T3CODE_V54_FIXTURE_MESSAGE.messageId,
        role: "assistant",
        text: T3CODE_V54_FIXTURE_MESSAGE.text,
        turnId: "fixture-turn-1",
        streaming: false,
        createdAt: T1,
        updatedAt: T1,
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.activity-appended",
      {
        threadId: "fixture-thread-1",
        activity: {
          id: "fixture-activity-1",
          tone: "info",
          kind: "fixture.note",
          summary: "Fixture note",
          payload: {},
          turnId: null,
          createdAt: T1,
        },
      },
    ],
    [
      "thread",
      "fixture-thread-1",
      "thread.meta-updated",
      {
        threadId: "fixture-thread-1",
        title: "第一个固定对话",
        titleState: { needsRefinement: false, source: "user", version: "1" },
        updatedAt: T1,
      },
    ],
    [
      "thread",
      "fixture-thread-2",
      "thread.settled",
      { threadId: "fixture-thread-2", settledAt: T1, updatedAt: T1 },
    ],
  ];
  const versions = new Map<string, number>();
  events.forEach(([kind, stream, type, payload], index) => {
    const version = (versions.get(stream) ?? 0) + 1;
    versions.set(stream, version);
    event.run(
      `fixture-event-${index + 1}`,
      kind,
      stream,
      version,
      type,
      T1,
      `fixture-command-${index + 1}`,
      `fixture-correlation-${index + 1}`,
      JSON.stringify(payload),
    );
  });

  const projectors = [
    "projection.attachment-cleanup",
    "projection.checkpoints",
    "projection.pending-approvals",
    "projection.projects",
    "projection.thread-activities",
    "projection.thread-messages",
    "projection.thread-proposed-plans",
    "projection.thread-sessions",
    "projection.thread-turns",
    "projection.threads",
  ];
  const state = database.prepare(
    "INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?)",
  );
  for (const projector of projectors) state.run(projector, events.length, T1);
}
