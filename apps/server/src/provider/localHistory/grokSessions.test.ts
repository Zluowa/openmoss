import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const project = path.join(os.tmpdir(), "fixture-grok-project");

async function writeSession(
  grokHome: string,
  id: string,
  files: { chat?: ReadonlyArray<Record<string, unknown>>; summary?: Record<string, unknown> },
) {
  const directory = path.join(grokHome, "sessions", encodeURIComponent(project), id);
  await fs.mkdir(directory, { recursive: true });
  if (files.chat) {
    await fs.writeFile(
      path.join(directory, "chat_history.jsonl"),
      files.chat.map((row) => JSON.stringify(row)).join("\n"),
    );
  }
  if (files.summary) {
    await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify(files.summary));
  }
}

describe("Grok local history", () => {
  it("discovers sessions from summary.json, falls back to the folder name, and reads the chat", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-grok-history-"));
    tempDirs.push(home);
    const grokHome = path.join(home, ".grok");
    const chat = [
      { type: "system", content: "system prompt is never imported" },
      { type: "user", content: [{ type: "text", text: "Fix the build" }] },
      { type: "reasoning", id: "r1", summary: [], encrypted_content: "x" },
      { type: "assistant", content: "Done." },
    ];
    await writeSession(grokHome, "session-a", {
      chat,
      summary: {
        info: { id: "session-a", cwd: project },
        session_summary: "Build fix",
        created_at: "2026-10-01T08:00:00.000Z",
        updated_at: "2026-10-01T09:00:00.000Z",
      },
    });
    await writeSession(grokHome, "session-b", { chat });
    await writeSession(grokHome, "session-empty", {
      chat: [{ type: "system", content: "no prompt yet" }],
    });

    const input = { homeDir: home, env: {} };
    const catalog = await LOCAL_HISTORY_READERS.grok.discover(input);
    const byId = new Map(catalog.sessions.map((session) => [session.id, session]));

    expect(catalog.sourceHome).toBe(grokHome);
    expect([...byId.keys()].toSorted()).toEqual(["session-a", "session-b"]);
    expect(byId.get("session-a")).toMatchObject({
      title: "Build fix",
      cwd: project,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    });
    expect(byId.get("session-b")).toMatchObject({ title: "Fix the build", cwd: project });
    const messages = await LOCAL_HISTORY_READERS.grok.readMessages({
      ...input,
      sessionId: "session-a",
    });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Fix the build" },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("uses GROK_HOME when it is set", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-grok-history-"));
    tempDirs.push(home);
    const custom = path.join(home, "grok-elsewhere");
    await writeSession(custom, "session-c", {
      chat: [{ type: "user", content: "Hello" }],
    });
    const catalog = await LOCAL_HISTORY_READERS.grok.discover({
      homeDir: home,
      env: { GROK_HOME: custom },
    });
    expect(catalog.sessions.map((session) => session.id)).toEqual(["session-c"]);
  });
});
