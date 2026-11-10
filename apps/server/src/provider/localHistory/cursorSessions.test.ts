import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-cursor-history-"));
  tempDirs.push(home);
  return home;
}

const project = path.join(os.tmpdir(), "fixture-cursor-project");
const reader = LOCAL_HISTORY_READERS.cursor;

function hex(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}

describe("Cursor CLI local history", () => {
  it("reads chats from store.db, dropping injected context and unwrapping the prompt", async () => {
    const home = await fakeHome();
    const directory = path.join(home, ".cursor", "chats", "0123abcd", "chat-1");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "meta.json"),
      JSON.stringify({
        title: "Fix login",
        createdAtMs: 1_790_000_000_000,
        updatedAtMs: 1_790_000_100_000,
      }),
    );
    const database = new DatabaseSync(path.join(directory, "store.db"));
    database.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
    );
    database
      .prepare("INSERT INTO meta VALUES ('0', ?)")
      .run(hex({ agentId: "chat-1", workspacePath: project }));
    const insert = database.prepare("INSERT INTO blobs VALUES (?, ?)");
    insert.run("b0", Buffer.from(JSON.stringify({ role: "system", content: "system prompt" })));
    insert.run(
      "b1",
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [
            { type: "text", text: `<user_info>\nWorkspace Path: ${project}\n</user_info>` },
          ],
        }),
      ),
    );
    insert.run("b2", Buffer.from([0x0a, 0x20, 0x01, 0x02])); // protobuf link node
    insert.run(
      "b3",
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "<user_query>\nWhy does login fail?\n</user_query>" }],
          createdAt: 1_790_000_001_000,
        }),
      ),
    );
    insert.run(
      "b4",
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "reasoning", text: "hidden" },
            { type: "tool-call", toolName: "read" },
            { type: "text", text: "The token expired." },
          ],
        }),
      ),
    );
    insert.run(
      "b5",
      Buffer.from(JSON.stringify({ role: "tool", content: [{ type: "tool-result" }] })),
    );
    database.close();

    const input = { homeDir: home, env: {} };
    const catalog = await reader.discover(input);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({
        id: "cli:chat-1",
        title: "Fix login",
        cwd: project,
        createdAt: new Date(1_790_000_000_000).toISOString(),
        updatedAt: new Date(1_790_000_100_000).toISOString(),
      }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "cli:chat-1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Why does login fail?" },
      { role: "assistant", text: "The token expired." },
    ]);
  });
});

describe("Cursor app local history", () => {
  it("reads composer bubbles and finds the folder, never touching other tables", async () => {
    const home = await fakeHome();
    const appData = path.join(home, "AppData", "Roaming");
    const userDir =
      process.platform === "win32"
        ? path.join(appData, "Cursor", "User")
        : process.platform === "darwin"
          ? path.join(home, "Library", "Application Support", "Cursor", "User")
          : path.join(home, ".config", "Cursor", "User");
    await fs.mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await fs.mkdir(path.join(userDir, "workspaceStorage", "ws1"), { recursive: true });
    await fs.writeFile(
      path.join(userDir, "workspaceStorage", "ws1", "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(project).href }),
    );
    const database = new DatabaseSync(path.join(userDir, "globalStorage", "state.vscdb"));
    database.exec(`
      CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
        lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, value TEXT);
    `);
    const put = database.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    put.run(
      "composerData:comp-1",
      JSON.stringify({
        composerId: "comp-1",
        name: "Refactor parser",
        createdAt: 1_790_000_000_000,
        lastUpdatedAt: 1_790_000_200_000,
        fullConversationHeadersOnly: [
          { bubbleId: "x1", type: 1 },
          { bubbleId: "x2", type: 2 },
          { bubbleId: "x3", type: 2 },
        ],
      }),
    );
    put.run("bubbleId:comp-1:x1", JSON.stringify({ type: 1, text: "Split the parser" }));
    put.run("bubbleId:comp-1:x2", JSON.stringify({ type: 2, text: "" })); // tool-only bubble
    put.run("bubbleId:comp-1:x3", JSON.stringify({ type: 2, text: "Done, see parse.ts" }));
    // An empty draft is not a conversation.
    put.run(
      "composerData:comp-draft",
      JSON.stringify({ composerId: "comp-draft", createdAt: 1, fullConversationHeadersOnly: [] }),
    );
    database
      .prepare("INSERT INTO composerHeaders VALUES ('comp-1', 'ws1', 1, 2, 1, 0, ?)")
      .run(JSON.stringify({ composerId: "comp-1" }));
    database.close();

    const input = { homeDir: home, env: { APPDATA: appData } };
    const catalog = await reader.discover(input);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({
        id: "app:comp-1",
        title: "Refactor parser",
        cwd: project,
        archived: true,
        updatedAt: new Date(1_790_000_200_000).toISOString(),
      }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "app:comp-1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Split the parser" },
      { role: "assistant", text: "Done, see parse.ts" },
    ]);
  });
});
