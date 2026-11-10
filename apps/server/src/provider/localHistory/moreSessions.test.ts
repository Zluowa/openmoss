// Fixture tests for the Devin CLI, Hermes, Antigravity, ZCode and Kimi Code readers.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS, UNREADABLE_HISTORY_COUNTERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-more-history-"));
  tempDirs.push(home);
  return home;
}

const project = path.join(os.tmpdir(), "fixture-more-project");

describe("Devin CLI local history", () => {
  it("reads the main chain of a session and skips hidden sessions", async () => {
    const home = await fakeHome();
    const appData = path.join(home, "AppData", "Roaming");
    const dir =
      process.platform === "win32"
        ? path.join(appData, "Devin", "cli")
        : path.join(home, ".local", "share", "devin", "cli");
    await fs.mkdir(dir, { recursive: true });
    const database = new DatabaseSync(path.join(dir, "sessions.db"));
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT,
        model TEXT, agent_mode TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
        created_at INTEGER NOT NULL);
    `);
    const session = database.prepare(
      "INSERT INTO sessions VALUES (?, ?, 'b', 'm', 'a', ?, ?, ?, ?, ?)",
    );
    session.run("dev-1", project, 1_790_000_000_000, 1_790_000_300_000, "Add tests", 4, 0);
    session.run("dev-hidden", project, 1, 2, null, null, 1);
    const node = database.prepare(
      "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    node.run(
      "dev-1",
      1,
      null,
      JSON.stringify({ role: "user", content: "Write a test" }),
      1_790_000_001_000,
    );
    node.run(
      "dev-1",
      2,
      1,
      JSON.stringify({ role: "assistant", content: "First try" }),
      1_790_000_002_000,
    );
    // The person edited the answer: node 3 branches from node 1 and node 4 continues it.
    node.run(
      "dev-1",
      3,
      1,
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Better try" }] }),
      1_790_000_003_000,
    );
    node.run(
      "dev-1",
      4,
      3,
      JSON.stringify({ message: { role: "user", content: "Thanks" } }),
      1_790_000_004_000,
    );
    node.run("dev-hidden", 1, null, JSON.stringify({ role: "user", content: "hidden" }), 1);
    database.close();

    const input = { homeDir: home, env: { APPDATA: appData } };
    const reader = LOCAL_HISTORY_READERS.devin;
    const catalog = await reader.discover(input);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({ id: "dev-1", title: "Add tests", cwd: project }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "dev-1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Write a test" },
      { role: "assistant", text: "Better try" },
      { role: "user", text: "Thanks" },
    ]);
  });
});

describe("Hermes local history", () => {
  it("joins compression children into one conversation and keeps only visible messages", async () => {
    const home = await fakeHome();
    const hermesHome = path.join(home, "hermes-data");
    await fs.mkdir(hermesHome, { recursive: true });
    const database = new DatabaseSync(path.join(hermesHome, "state.db"));
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT,
        started_at REAL NOT NULL, ended_at REAL, title TEXT, cwd TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0, _compressed_summary INTEGER NOT NULL DEFAULT 0);
    `);
    const session = database.prepare("INSERT INTO sessions VALUES (?, 'cli', ?, ?, NULL, ?, ?)");
    session.run("root", null, 1_790_000_000, "Plan the trip", project);
    session.run("child", "root", 1_790_000_500, null, project);
    const message = database.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp, active, compacted, _compressed_summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    message.run("root", "user", "Plan a trip", 1_790_000_001, 1, 0, 0);
    message.run("root", "assistant", "Where to?", 1_790_000_002, 1, 0, 0);
    message.run("root", "tool", "tool output", 1_790_000_003, 1, 0, 0);
    message.run("child", "assistant", "Summary of earlier turns", 1_790_000_501, 1, 0, 1);
    message.run("child", "user", "Kyoto", 1_790_000_502, 1, 0, 0);
    message.run("child", "assistant", "rolled back", 1_790_000_503, 0, 0, 0);
    database.close();

    const input = { homeDir: home, env: { HERMES_HOME: hermesHome } };
    const reader = LOCAL_HISTORY_READERS.hermes;
    const catalog = await reader.discover(input);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({ id: "root", title: "Plan the trip", cwd: project }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "root" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Plan a trip" },
      { role: "assistant", text: "Where to?" },
      { role: "user", text: "Kyoto" },
    ]);
  });
});

describe("Antigravity local history", () => {
  it("reads CLI transcripts and only counts the app's encrypted conversations", async () => {
    const home = await fakeHome();
    const logs = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conv-1",
      ".system_generated",
      "logs",
    );
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(
      path.join(logs, "transcript.jsonl"),
      [
        { step_index: 0, type: "USER_INPUT", content: "Draw a chart" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          thinking: "x",
          tool_calls: [{ name: "run_command" }],
        },
        { step_index: 2, type: "PLANNER_RESPONSE", content: "Here is the chart." },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const encrypted = path.join(home, ".gemini", "antigravity", "conversations");
    await fs.mkdir(encrypted, { recursive: true });
    await fs.writeFile(path.join(encrypted, "a.pb"), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(encrypted, "b.pb"), Buffer.from([4, 5, 6]));

    const input = { homeDir: home, env: {} };
    const reader = LOCAL_HISTORY_READERS.antigravity;
    const catalog = await reader.discover(input);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({ id: "conv-1", title: "Draw a chart", cwd: home }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "conv-1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Draw a chart" },
      { role: "assistant", text: "Here is the chart." },
    ]);
    await expect(UNREADABLE_HISTORY_COUNTERS.antigravity.count(input)).resolves.toBe(2);
    expect(UNREADABLE_HISTORY_COUNTERS.antigravity.reason).toBe("encrypted");
  });
});

describe("ZCode local history", () => {
  it("reads interactive sessions and leaves out prompts the agent added itself", async () => {
    const home = await fakeHome();
    const dbDir = path.join(home, ".zcode", "cli", "db");
    await fs.mkdir(dbDir, { recursive: true });
    const database = new DatabaseSync(path.join(dbDir, "db.sqlite"));
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
        directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER, task_type TEXT NOT NULL DEFAULT 'interactive', time_deleted INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT, sequence INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT, sequence INTEGER);
    `);
    const session = database.prepare(
      "INSERT INTO session VALUES (?, 'p', NULL, 's', ?, ?, '1', 10, 20, NULL, ?, ?)",
    );
    session.run("z1", project, "Main", "interactive", null);
    session.run("z-side", project, "Side chat", "selection_side_chat", null);
    session.run("z-deleted", project, "Deleted", "interactive", 30);
    const message = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)");
    const part = database.prepare("INSERT INTO part VALUES (?, ?, ?, 0, 0, ?, ?)");
    for (const id of ["z-side", "z-deleted"]) {
      message.run(`${id}-m`, id, 1, 1, JSON.stringify({ role: "user" }), 1);
      part.run(`${id}-p`, `${id}-m`, id, JSON.stringify({ type: "text", text: "x" }), 1);
    }
    message.run("m2", "z1", 2, 2, JSON.stringify({ role: "assistant" }), 3);
    message.run("m1", "z1", 1, 1, JSON.stringify({ role: "user" }), 1);
    message.run(
      "m-bg",
      "z1",
      1,
      1,
      JSON.stringify({ role: "user", synthetic: true, visibility: "model-only" }),
      2,
    );
    part.run("p2", "m2", "z1", JSON.stringify({ type: "text", text: "Answer" }), 2);
    part.run("p1", "m1", "z1", JSON.stringify({ type: "text", text: "Question" }), 1);
    part.run(
      "p-bg",
      "m-bg",
      "z1",
      JSON.stringify({ type: "text", text: "background task done" }),
      1,
    );
    database.close();

    const input = { homeDir: home, env: {} };
    const reader = LOCAL_HISTORY_READERS.zcode;
    const catalog = await reader.discover(input);
    expect(catalog.sessions.map((s) => [s.id, s.title, s.projectId])).toEqual([
      ["z1", "Main", null],
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "z1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Answer" },
    ]);
  });
});

describe("ZCode chats without a folder", () => {
  it("folds ZCode's default and draft chat folders into one project", async () => {
    const home = await fakeHome();
    const dbDir = path.join(home, ".zcode", "cli", "db");
    await fs.mkdir(dbDir, { recursive: true });
    const database = new DatabaseSync(path.join(dbDir, "db.sqlite"));
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
        directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
    `);
    const workspace = path.join(home, ".zcode", "workspace");
    const session = database.prepare(
      "INSERT INTO session VALUES (?, 'p', NULL, 's', ?, ?, '1', 10, 20)",
    );
    session.run(
      "d1",
      path.join(workspace, "draft-1c5872a7-56b1-4e0c-b1f6-723944bba010"),
      "Draft one",
    );
    session.run("d2", path.join(workspace, "default"), "Default chat");
    session.run("p1", project, "Real project");
    for (const id of ["d1", "d2", "p1"]) {
      database
        .prepare("INSERT INTO message VALUES (?, ?, 1, 1, ?)")
        .run(`${id}-m`, id, JSON.stringify({ role: "user" }));
    }
    database.close();

    const catalog = await LOCAL_HISTORY_READERS.zcode.discover({ homeDir: home, env: {} });
    const id = `chats:${workspace}`;
    expect(catalog.projects).toEqual([{ id, title: "ZCode chats", roots: [workspace] }]);
    expect(Object.fromEntries(catalog.sessions.map((s) => [s.id, s.projectId]))).toEqual({
      d1: id,
      d2: id,
      p1: null,
    });

    // The recorded folders are matched by layout, so a moved or copied store still groups.
    const elsewhere = await fakeHome();
    await fs.cp(path.join(home, ".zcode"), path.join(elsewhere, ".zcode"), { recursive: true });
    const moved = await LOCAL_HISTORY_READERS.zcode.discover({ homeDir: elsewhere, env: {} });
    expect(moved.projects.map((project) => project.roots)).toEqual([[workspace]]);
  });
});

describe("Kimi Code", () => {
  it("counts sessions it can't read yet", async () => {
    const home = await fakeHome();
    const kimiHome = path.join(home, "kimi");
    for (const session of ["s1", "s2"]) {
      const dir = path.join(kimiHome, "sessions", "workdir-key", session);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "state.json"), "{}");
    }
    await fs.mkdir(path.join(kimiHome, "sessions", "workdir-key", "not-a-session"), {
      recursive: true,
    });
    await expect(
      UNREADABLE_HISTORY_COUNTERS.kimi.count({ homeDir: home, env: { KIMI_CODE_HOME: kimiHome } }),
    ).resolves.toBe(2);
    await expect(UNREADABLE_HISTORY_COUNTERS.kimi.count({ homeDir: home, env: {} })).resolves.toBe(
      0,
    );
  });
});
