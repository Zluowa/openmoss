// FILE: seed-inline-visualization-fixture.ts
// Purpose: Seed an isolated Moss development home with visual-reply examples for browser review.
// Layer: Developer-only fixture

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { injectHtmlRenderBootstrap } from "../packages/shared/src/htmlRender.ts";

const THREAD_ID = "inline-visualization-fixture";
const WORKED_THREAD_ID = "inline-visualization-worked-fixture";
const TOOL_SUMMARY_THREAD_ID = "inline-visualization-tool-summary-fixture";
const PROJECT_ID = "inline-visualization-fixture-project";
const CODEX_THREAD_ID = "inline-visualization-native-thread";
const HTML_ATTACHMENT_ID = "inline-visualization-fixture-00000000-0000-4000-8000-000000000001";
const WORKED_ATTACHMENT_ID = "inline-visualization-worked-00000000-0000-4000-8000-000000000001";
const NOW = "2026-10-08T12:00:00.000Z";

function usage() {
  return [
    "Usage: bun scripts/seed-inline-visualization-fixture.ts --home-dir <isolated Moss home>",
    "",
    "The dev server must have initialized <home-dir>/dev/state.sqlite first, and must be stopped while this script runs.",
  ].join("\n");
}

function readHomeDir() {
  const index = process.argv.indexOf("--home-dir");
  const homeDir = index === -1 ? undefined : process.argv[index + 1];
  if (!homeDir || homeDir.startsWith("-")) throw new Error(usage());
  return path.resolve(homeDir);
}

function columns(database: Database, table: string) {
  return new Set(
    database
      .query<{ readonly name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
}

/** Insert only columns that exist in the current migration, keeping this fixture durable across schema additions. */
function insert(
  database: Database,
  table: string,
  values: Readonly<Record<string, string | number | null>>,
) {
  const known = columns(database, table);
  const entries = Object.entries(values).filter(([name]) => known.has(name));
  if (entries.length === 0)
    throw new Error(`No recognized columns for ${table}. Is the database migrated?`);
  const fields = entries.map(([name]) => name).join(", ");
  const placeholders = entries.map(() => "?").join(", ");
  database
    .query(`INSERT INTO ${table} (${fields}) VALUES (${placeholders})`)
    .run(...entries.map(([, value]) => value));
}

function runGit(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return new TextDecoder().decode(result.stdout).trim();
  throw new Error(
    `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
  );
}

function checkpointRef(threadId: string, turnCount: number) {
  return `refs/moss/checkpoints/${Buffer.from(threadId).toString("base64url")}/turn/${String(turnCount)}`;
}

/**
 * A real checkpointed workspace lets the browser check invoke the same
 * checkpoint-revert command a reader invokes from the transcript. The refs
 * deliberately describe identical trees: this fixture verifies reply pruning,
 * not a made-up file change.
 */
function createRevertFixtureWorkspace(homeDir: string) {
  const workspace = path.join(homeDir, "inline-visualization-revert-workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "README.md"), "Inline visualization revert fixture.\n");
  runGit(workspace, ["init", "--initial-branch=main"]);
  runGit(workspace, ["config", "user.email", "fixture@moss.local"]);
  runGit(workspace, ["config", "user.name", "Moss visual fixture"]);
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "fixture baseline"]);
  const baseline = runGit(workspace, ["rev-parse", "HEAD"]);
  for (const turnCount of [0, 1, 2]) {
    runGit(workspace, ["update-ref", checkpointRef(WORKED_THREAD_ID, turnCount), baseline]);
  }
  return workspace;
}

/**
 * This is the exact bootstrap injection performed by HtmlRender.prepare before
 * the attachment store writes an html_render page. Keeping the deterministic
 * fixture's attachment id lets the browser runner address it while still
 * exercising the real pre-first-paint theme transport.
 */
function preparedHtmlRenderFixture(title: string, description: string) {
  return injectHtmlRenderBootstrap(`<!doctype html>
<html>
  <head>
    <title>${title}</title>
    <style>
      /* Real html_render pages leave their outer document transparent. */
      body { background: transparent; color: var(--foreground); font-family: var(--font-sans); }
      main { padding: 24px; }
      h2 { margin: 0 0 8px; color: var(--primary); font-size: 20px; }
      p { margin: 0; color: var(--muted-foreground); }
      .rule { height: 3px; margin: 16px 0; border-radius: var(--radius); background: var(--chart-1); }
    </style>
  </head>
  <body>
    <main>
      <h2>${title}</h2>
      <p>${description}</p>
      <div class="rule"></div>
      <p>Colors intentionally come from the documented html_render theme variables.</p>
    </main>
  </body>
</html>`);
}

function main() {
  const homeDir = readHomeDir();
  const stateDir = path.join(homeDir, "dev");
  const databasePath = path.join(stateDir, "state.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(
      `${databasePath} does not exist. Start and stop the isolated dev server once, then run this seed again.`,
    );
  }
  // The fixture never starts an agent. Codex supplies the native-marker page;
  // Claude's restart-session rollback clears a persisted cursor while the real
  // checkpoint reactor removes the visual-reply turn. Keep every other local
  // provider disabled so their binary probes cannot affect this browser check.
  const settingsPath = path.join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      settings?: {
        enableProviderUpdateChecks?: boolean;
        onboardingCompletedAt?: string | null;
        providers?: Record<string, { enabled?: boolean }>;
      };
    };
    if (settings.settings) {
      settings.settings.enableProviderUpdateChecks = false;
      // The visual check opens a pre-existing fixture rather than exercising
      // first-run setup. Persist the server-side marker as well as the
      // browser-profile markers in the runner so startup onboarding cannot
      // obscure an evidence screenshot.
      settings.settings.onboardingCompletedAt = NOW;
      for (const [provider, value] of Object.entries(settings.settings.providers ?? {})) {
        value.enabled = provider === "codex" || provider === "claudeAgent";
      }
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }

  const revertWorkspace = createRevertFixtureWorkspace(homeDir);
  const visualizationsDir = path.join(
    homeDir,
    "codex-home-overlay",
    "visualizations",
    "2026",
    "10",
    "08",
    CODEX_THREAD_ID,
  );
  mkdirSync(visualizationsDir, { recursive: true });
  const d3Path = path.join(visualizationsDir, "d3-fixture.html");
  const missingPath = path.join(visualizationsDir, "missing-fixture.html");
  const oversizedPath = path.join(visualizationsDir, "oversized-fixture.html");
  writeFileSync(
    d3Path,
    `<div id="chart" style="padding:16px">Loading D3 fixture…</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
  const data = [4, 9, 6, 12, 10];
  const svg = d3.select("#chart").html("").append("svg").attr("viewBox", "0 0 520 220").style("max-width", "100%");
  const x = d3.scaleBand().domain(d3.range(data.length)).range([36, 510]).padding(.2);
  const y = d3.scaleLinear().domain([0, 14]).range([188, 16]);
  svg.selectAll("rect").data(data).join("rect").attr("x", (_, i) => x(i)).attr("y", y).attr("width", x.bandwidth()).attr("height", d => 188-y(d)).attr("fill", "#22a06b");
  svg.append("text").attr("x", 16).attr("y", 16).attr("font-weight", 700).text("Local D3 visualization");
</script>`,
  );
  writeFileSync(
    oversizedPath,
    "<!-- oversized visual fixture -->\n".padEnd(2 * 1024 * 1024 + 1, "x"),
  );

  const attachmentsDir = path.join(stateDir, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  writeFileSync(
    path.join(attachmentsDir, `${HTML_ATTACHMENT_ID}.html`),
    preparedHtmlRenderFixture(
      "T3 html_render fixture",
      "This prepared html_render page follows Moss’s live light and dark theme.",
    ),
  );
  writeFileSync(
    path.join(attachmentsDir, `${WORKED_ATTACHMENT_ID}.html`),
    preparedHtmlRenderFixture(
      "Worked-for fixture",
      "The published page belongs below the settled work disclosure.",
    ),
  );

  const database = new Database(databasePath, { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.transaction(() => {
      // This is intentionally idempotent and only removes this exact fixture.
      for (const table of [
        "message_text_segments",
        "message_text_chunks",
        "projection_thread_activities",
        "projection_thread_messages",
        "projection_thread_sessions",
        "projection_turns",
        "projection_threads",
      ]) {
        database.query(`DELETE FROM ${table} WHERE thread_id = ?`).run(THREAD_ID);
        database.query(`DELETE FROM ${table} WHERE thread_id = ?`).run(WORKED_THREAD_ID);
        database.query(`DELETE FROM ${table} WHERE thread_id = ?`).run(TOOL_SUMMARY_THREAD_ID);
      }
      database
        .query("DELETE FROM provider_session_runtime WHERE thread_id = ?")
        .run(WORKED_THREAD_ID);
      database.query("DELETE FROM projection_projects WHERE project_id = ?").run(PROJECT_ID);

      insert(database, "projection_projects", {
        project_id: PROJECT_ID,
        title: "Inline visualization fixture",
        workspace_root: revertWorkspace,
        scripts_json: "[]",
        kind: "project",
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
      });
      insert(database, "projection_threads", {
        thread_id: THREAD_ID,
        project_id: PROJECT_ID,
        title: "Inline visualization fixture",
        model: "gpt-5.4",
        model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        env_mode: "local",
        creation_source: "provider_native",
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
      });
      for (const threadId of [WORKED_THREAD_ID]) {
        insert(database, "projection_threads", {
          thread_id: threadId,
          project_id: PROJECT_ID,
          title: "Worked-for visual fixture",
          model: "gpt-5.4",
          model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
          runtime_mode: "full-access",
          interaction_mode: "default",
          env_mode: "local",
          creation_source: "provider_native",
          created_at: NOW,
          updated_at: NOW,
          deleted_at: null,
        });
        insert(database, "projection_thread_sessions", {
          thread_id: threadId,
          status: "ready",
          // The transcript remains a normal Codex conversation. Its runtime
          // binding below is Claude's restart-session implementation solely
          // because it can clear the synthetic cursor without launching an
          // agent when the real checkpoint reactor performs the revert.
          provider_name: "codex",
          provider_instance_id: "codex",
          provider_session_id: `${threadId}-provider-session`,
          provider_thread_id: `${threadId}-provider-thread`,
          updated_at: NOW,
        });
      }
      insert(database, "projection_threads", {
        thread_id: TOOL_SUMMARY_THREAD_ID,
        project_id: PROJECT_ID,
        title: "Localized tool-summary fixture",
        model: "gpt-5.4",
        model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        env_mode: "local",
        creation_source: "provider_native",
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
      });
      // Claude's restart-session rollback clears this persisted cursor without
      // launching an agent. That keeps this isolated browser fixture entirely
      // local while the CheckpointReactor performs its real thread revert.
      insert(database, "provider_session_runtime", {
        thread_id: WORKED_THREAD_ID,
        provider_name: "claudeAgent",
        provider_instance_id: "claudeAgent",
        adapter_key: "claudeAgent",
        runtime_mode: "full-access",
        status: "stopped",
        last_seen_at: NOW,
        resume_cursor_json: JSON.stringify({ sessionId: "fixture-revert-session" }),
        runtime_payload_json: JSON.stringify({ providerInstanceId: "claudeAgent" }),
      });
      insert(database, "projection_thread_sessions", {
        thread_id: THREAD_ID,
        status: "ready",
        provider_name: "codex",
        provider_instance_id: "codex",
        provider_session_id: "fixture-provider-session",
        provider_thread_id: CODEX_THREAD_ID,
        updated_at: NOW,
      });
      insert(database, "projection_thread_sessions", {
        thread_id: TOOL_SUMMARY_THREAD_ID,
        status: "ready",
        provider_name: "codex",
        provider_instance_id: "codex",
        provider_session_id: `${TOOL_SUMMARY_THREAD_ID}-provider-session`,
        provider_thread_id: `${TOOL_SUMMARY_THREAD_ID}-provider-thread`,
        updated_at: NOW,
      });
      insert(database, "projection_thread_messages", {
        thread_id: THREAD_ID,
        message_id: "codex-d3",
        turn_id: "fixture-turn",
        role: "assistant",
        text: `Here is a local D3 visualization from a Codex marker.\n\n\uE200visualize\uE202${JSON.stringify({ path: d3Path, mode: "wide", title: "D3 fixture" })}\uE201`,
        is_streaming: 0,
        source: "native",
        sequence: 1,
        created_at: NOW,
        updated_at: NOW,
      });
      insert(database, "projection_thread_messages", {
        thread_id: TOOL_SUMMARY_THREAD_ID,
        message_id: "tool-summary-request",
        turn_id: null,
        role: "user",
        text: "Seed the localized tool-summary fixture.",
        is_streaming: 0,
        source: "native",
        sequence: 1,
        created_at: NOW,
        updated_at: NOW,
      });
      for (let index = 1; index <= 13; index += 1) {
        insert(database, "projection_thread_activities", {
          activity_id: `tool-summary-command-${String(index)}`,
          thread_id: TOOL_SUMMARY_THREAD_ID,
          turn_id: "tool-summary-turn",
          tone: "tool",
          kind: "tool.completed",
          summary: `Ran command ${String(index)}`,
          payload_json: JSON.stringify({
            itemType: "command_execution",
            data: {
              toolCallId: `tool-summary-command-${String(index)}`,
              command: `printf command-${String(index)}`,
            },
          }),
          sequence: index + 1,
          created_at: NOW,
        });
      }
      insert(database, "projection_thread_activities", {
        activity_id: "tool-summary-html-render",
        thread_id: TOOL_SUMMARY_THREAD_ID,
        turn_id: "tool-summary-turn",
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool call",
        payload_json: JSON.stringify({
          itemType: "mcp_tool_call",
          detail: "Moss__html_render — source file: mcp-render.json",
          data: {
            toolCallId: "tool-summary-html-render",
            toolName: "Moss__html_render — source file: mcp-render.json",
            input: { title: "2026 经营看板", html: "<main></main>", height: 480 },
          },
        }),
        sequence: 15,
        created_at: NOW,
      });
      insert(database, "projection_thread_messages", {
        thread_id: TOOL_SUMMARY_THREAD_ID,
        message_id: "tool-summary-answer",
        turn_id: "tool-summary-turn",
        role: "assistant",
        text: "The localized tool-summary fixture is complete.",
        is_streaming: 0,
        source: "native",
        sequence: 16,
        created_at: NOW,
        updated_at: NOW,
      });
      insert(database, "projection_turns", {
        thread_id: TOOL_SUMMARY_THREAD_ID,
        turn_id: "tool-summary-turn",
        pending_message_id: "tool-summary-request",
        assistant_message_id: "tool-summary-answer",
        state: "completed",
        requested_at: NOW,
        started_at: NOW,
        completed_at: NOW,
        checkpoint_turn_count: 1,
        checkpoint_ref: checkpointRef(TOOL_SUMMARY_THREAD_ID, 1),
        checkpoint_status: "ready",
        checkpoint_files_json: "[]",
      });
      insert(database, "projection_thread_messages", {
        thread_id: THREAD_ID,
        message_id: "t3-html-render",
        turn_id: "fixture-turn",
        role: "assistant",
        text: "The T3 html_render fixture is published immediately below.",
        is_streaming: 0,
        source: "native",
        sequence: 2,
        created_at: "2026-10-08T12:00:01.000Z",
        updated_at: "2026-10-08T12:00:01.000Z",
      });
      insert(database, "projection_thread_activities", {
        activity_id: "t3-html-render-activity",
        thread_id: THREAD_ID,
        turn_id: "fixture-turn",
        tone: "info",
        kind: "html-render.published",
        summary: "已创建可视化",
        payload_json: JSON.stringify({
          htmlRender: {
            attachmentId: HTML_ATTACHMENT_ID,
            title: "T3 html_render fixture",
            height: 260,
          },
        }),
        sequence: 3,
        created_at: "2026-10-08T12:00:02.000Z",
      });
      insert(database, "projection_thread_messages", {
        thread_id: THREAD_ID,
        message_id: "oversized-codex-marker",
        turn_id: "fixture-turn",
        role: "assistant",
        text: `This oversized source must show the unavailable fallback.\n\nvisualize${JSON.stringify({ path: oversizedPath, title: "Oversized fixture" })}`,
        is_streaming: 0,
        source: "native",
        sequence: 4,
        created_at: "2026-10-08T12:00:03.000Z",
        updated_at: "2026-10-08T12:00:03.000Z",
      });
      insert(database, "projection_thread_messages", {
        thread_id: THREAD_ID,
        message_id: "missing-codex-marker",
        turn_id: "fixture-turn",
        role: "assistant",
        text: `This missing source must show the unavailable fallback.\n\nvisualize${JSON.stringify({ path: missingPath, title: "Missing fixture" })}`,
        is_streaming: 0,
        source: "native",
        sequence: 5,
        created_at: "2026-10-08T12:00:04.000Z",
        updated_at: "2026-10-08T12:00:04.000Z",
      });
      // Keep scroll room below the final fallback. This lets the browser
      // evidence runner bring each expanded card fully above the floating
      // composer without changing the behavior under test.
      insert(database, "projection_thread_messages", {
        thread_id: THREAD_ID,
        message_id: "inline-visualization-fixture-tail",
        turn_id: "fixture-turn",
        role: "assistant",
        text: "End of inline visualization fixture.",
        is_streaming: 0,
        source: "native",
        sequence: 6,
        created_at: "2026-10-08T12:00:05.000Z",
        updated_at: "2026-10-08T12:00:05.000Z",
      });
      insert(database, "projection_thread_messages", {
        thread_id: WORKED_THREAD_ID,
        message_id: "retained-request",
        turn_id: null,
        role: "user",
        text: "Keep this earlier message after reverting the visual reply.",
        is_streaming: 0,
        source: "native",
        sequence: 1,
        created_at: "2026-10-08T12:00:00.000Z",
        updated_at: "2026-10-08T12:00:00.000Z",
      });
      insert(database, "projection_thread_messages", {
        thread_id: WORKED_THREAD_ID,
        message_id: "retained-answer",
        turn_id: "retained-turn",
        role: "assistant",
        text: "This earlier assistant reply must remain after the real revert.",
        is_streaming: 0,
        source: "native",
        sequence: 2,
        created_at: "2026-10-08T12:00:01.000Z",
        updated_at: "2026-10-08T12:00:01.000Z",
      });
      insert(database, "projection_turns", {
        thread_id: WORKED_THREAD_ID,
        turn_id: "retained-turn",
        pending_message_id: "retained-request",
        assistant_message_id: "retained-answer",
        state: "completed",
        requested_at: "2026-10-08T12:00:00.000Z",
        started_at: "2026-10-08T12:00:00.000Z",
        completed_at: "2026-10-08T12:00:01.000Z",
        checkpoint_turn_count: 1,
        checkpoint_ref: checkpointRef(WORKED_THREAD_ID, 1),
        checkpoint_status: "ready",
        checkpoint_files_json: JSON.stringify([
          { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        ]),
      });
      insert(database, "projection_thread_messages", {
        thread_id: WORKED_THREAD_ID,
        message_id: "worked-request",
        turn_id: null,
        role: "user",
        text: "Render the worked-for fixture.",
        is_streaming: 0,
        source: "native",
        sequence: 3,
        created_at: "2026-10-08T12:00:02.000Z",
        updated_at: "2026-10-08T12:00:02.000Z",
      });
      insert(database, "projection_thread_activities", {
        activity_id: "worked-html-render-start",
        thread_id: WORKED_THREAD_ID,
        turn_id: "worked-turn",
        tone: "tool",
        kind: "tool.started",
        summary: "Render HTML",
        payload_json: JSON.stringify({
          data: { toolCallId: "worked-html-render", toolName: "html_render", input: {} },
        }),
        sequence: 4,
        created_at: "2026-10-08T12:00:03.000Z",
      });
      insert(database, "projection_thread_activities", {
        activity_id: "worked-html-render-page",
        thread_id: WORKED_THREAD_ID,
        turn_id: "worked-turn",
        tone: "info",
        kind: "html-render.published",
        summary: "Worked-for fixture",
        payload_json: JSON.stringify({
          htmlRender: {
            attachmentId: WORKED_ATTACHMENT_ID,
            title: "Worked-for fixture",
            height: 260,
          },
        }),
        sequence: 5,
        created_at: "2026-10-08T12:00:04.000Z",
      });
      insert(database, "projection_thread_activities", {
        activity_id: "worked-html-render-completed",
        thread_id: WORKED_THREAD_ID,
        turn_id: "worked-turn",
        tone: "tool",
        kind: "tool.completed",
        summary: "Render HTML",
        payload_json: JSON.stringify({
          data: {
            toolCallId: "worked-html-render",
            toolName: "Moss__html_render — source file: /tmp/page.json",
            input: {},
          },
        }),
        sequence: 6,
        created_at: "2026-10-08T12:00:05.000Z",
      });
      insert(database, "projection_turns", {
        thread_id: WORKED_THREAD_ID,
        turn_id: "worked-turn",
        pending_message_id: "worked-request",
        assistant_message_id: "worked-answer",
        state: "completed",
        requested_at: "2026-10-08T12:00:02.000Z",
        started_at: "2026-10-08T12:00:02.000Z",
        completed_at: "2026-10-08T12:00:06.000Z",
        checkpoint_turn_count: 2,
        checkpoint_ref: checkpointRef(WORKED_THREAD_ID, 2),
        checkpoint_status: "ready",
        checkpoint_files_json: JSON.stringify([
          { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        ]),
      });
      insert(database, "projection_thread_messages", {
        thread_id: WORKED_THREAD_ID,
        message_id: "worked-answer",
        turn_id: "worked-turn",
        role: "assistant",
        text: "The render is ready.",
        is_streaming: 0,
        source: "native",
        sequence: 7,
        created_at: "2026-10-08T12:00:06.000Z",
        updated_at: "2026-10-08T12:00:06.000Z",
      });
    })();
  } finally {
    database.close();
  }
  process.stdout.write(`Seeded ${THREAD_ID} in ${databasePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
