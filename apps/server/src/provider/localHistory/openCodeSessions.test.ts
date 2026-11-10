import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const project = path.join(os.tmpdir(), "fixture-opencode-project");

async function openCodeDatabase(): Promise<{ home: string; database: DatabaseSync }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-opencode-history-"));
  tempDirs.push(home);
  const dataDir = path.join(home, ".local", "share", "opencode");
  await fs.mkdir(dataDir, { recursive: true });
  return { home, database: new DatabaseSync(path.join(dataDir, "opencode.db")) };
}

describe("OpenCode local history", () => {
  it("reads the current session_v2 store, skipping subagent sessions and non-text parts", async () => {
    const { home, database } = await openCodeDatabase();
    database.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
        directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER,
        time_archived INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const insertSession = database.prepare(
      "INSERT INTO session_v2 VALUES (?, 'p', ?, 's', ?, ?, '1', ?, ?, ?)",
    );
    insertSession.run(
      "ses_main",
      null,
      project,
      "Main task",
      1_790_000_000_000,
      1_790_000_100_000,
      null,
    );
    insertSession.run(
      "ses_child",
      "ses_main",
      project,
      "Subagent",
      1_790_000_000_000,
      1_790_000_100_000,
      null,
    );
    insertSession.run(
      "ses_old",
      null,
      project,
      "Archived task",
      1_780_000_000_000,
      1_780_000_100_000,
      1_780_000_200_000,
    );
    const insertMessage = database.prepare(
      "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertMessage.run(
      "m1",
      "ses_main",
      "user",
      1,
      1_790_000_001_000,
      1_790_000_001_000,
      JSON.stringify({ text: "Add a test" }),
    );
    insertMessage.run(
      "m2",
      "ses_main",
      "model-switched",
      2,
      1_790_000_001_500,
      1_790_000_001_500,
      JSON.stringify({}),
    );
    insertMessage.run(
      "m3",
      "ses_main",
      "assistant",
      3,
      1_790_000_002_000,
      1_790_000_002_000,
      JSON.stringify({
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "tool", tool: "bash" },
          { type: "text", text: "Added it." },
        ],
      }),
    );
    insertMessage.run(
      "m4",
      "ses_child",
      "user",
      1,
      1_790_000_003_000,
      1_790_000_003_000,
      JSON.stringify({ text: "child" }),
    );
    insertMessage.run(
      "m5",
      "ses_old",
      "user",
      1,
      1_780_000_001_000,
      1_780_000_001_000,
      JSON.stringify({ text: "old" }),
    );
    database.close();

    const input = { homeDir: home, env: {} };
    const catalog = await LOCAL_HISTORY_READERS.opencode.discover(input);
    expect(catalog.sessions.map((s) => [s.id, s.title, s.archived]).toSorted()).toEqual([
      ["ses_main", "Main task", false],
      ["ses_old", "Archived task", true],
    ]);
    expect(catalog.sessions.find((s) => s.id === "ses_main")).toMatchObject({
      cwd: project,
      createdAt: new Date(1_790_000_000_000).toISOString(),
      updatedAt: new Date(1_790_000_100_000).toISOString(),
    });
    const messages = await LOCAL_HISTORY_READERS.opencode.readMessages({
      ...input,
      sessionId: "ses_main",
    });
    expect(messages).toEqual([
      {
        id: "m1",
        role: "user",
        text: "Add a test",
        createdAt: new Date(1_790_000_001_000).toISOString(),
      },
      {
        id: "m3",
        role: "assistant",
        text: "Added it.",
        createdAt: new Date(1_790_000_002_000).toISOString(),
      },
    ]);
  });

  it("reads the earlier session/message/part store", async () => {
    const { home, database } = await openCodeDatabase();
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
        directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    database
      .prepare(
        "INSERT INTO session VALUES ('ses_1', 'p', NULL, 's', ?, 'Legacy task', '1', 10, 20)",
      )
      .run(project);
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, 'ses_1', ?, ?, ?)");
    insertMessage.run(
      "msg_1",
      1_700_000_000_000,
      1_700_000_000_000,
      JSON.stringify({ role: "user" }),
    );
    insertMessage.run(
      "msg_2",
      1_700_000_001_000,
      1_700_000_001_000,
      JSON.stringify({ role: "assistant" }),
    );
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, 'ses_1', 0, 0, ?)");
    insertPart.run("prt_1", "msg_1", JSON.stringify({ type: "text", text: "Explain this" }));
    insertPart.run(
      "prt_2",
      "msg_1",
      JSON.stringify({ type: "text", text: "injected", synthetic: true }),
    );
    insertPart.run("prt_3", "msg_2", JSON.stringify({ type: "reasoning", text: "thinking" }));
    insertPart.run("prt_4", "msg_2", JSON.stringify({ type: "text", text: "It works like this." }));
    database.close();

    const input = { homeDir: home, env: {} };
    const catalog = await LOCAL_HISTORY_READERS.opencode.discover(input);
    expect(catalog.sessions.map((s) => [s.id, s.title, s.archived])).toEqual([
      ["ses_1", "Legacy task", false],
    ]);
    const messages = await LOCAL_HISTORY_READERS.opencode.readMessages({
      ...input,
      sessionId: "ses_1",
    });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Explain this" },
      { role: "assistant", text: "It works like this." },
    ]);
  });

  it("finds nothing when OpenCode has never run", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-opencode-history-"));
    tempDirs.push(home);
    await expect(
      LOCAL_HISTORY_READERS.opencode.discover({ homeDir: home, env: {} }),
    ).resolves.toEqual({
      sourceHome: path.join(home, ".local", "share", "opencode"),
      projects: [],
      sessions: [],
    });
  });
});
