import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const project = path.join(os.tmpdir(), "fixture-gemini-project");

async function writeChat(
  projectDir: string,
  fileName: string,
  session: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.join(projectDir, "chats"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "chats", fileName), JSON.stringify(session));
}

describe("Gemini CLI local history", () => {
  it("discovers chats, resolves the project folder, and keeps the newest copy of a resumed chat", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-gemini-history-"));
    tempDirs.push(home);
    const tmp = path.join(home, ".gemini", "tmp");
    const marked = path.join(tmp, "fixture-project");
    await fs.mkdir(marked, { recursive: true });
    await fs.writeFile(path.join(marked, ".project_root"), `${project}\n`);
    const messages = [
      {
        id: "1",
        timestamp: "2026-10-01T08:00:01.000Z",
        type: "user",
        content: "Summarize the repo",
      },
      { id: "2", timestamp: "2026-10-01T08:00:02.000Z", type: "info", content: "not a message" },
      {
        id: "3",
        timestamp: "2026-10-01T08:00:03.000Z",
        type: "gemini",
        content: [{ text: "It is a fixture." }],
        thoughts: [{ subject: "hidden" }],
      },
    ];
    await writeChat(marked, "session-2026-10-01T08-00-abcdef12.json", {
      sessionId: "abcdef12-0000-4000-8000-000000000000",
      startTime: "2026-10-01T08:00:00.000Z",
      lastUpdated: "2026-10-01T08:00:03.000Z",
      messages: messages.slice(0, 1),
    });
    await writeChat(marked, "session-2026-10-02T08-00-abcdef12.json", {
      sessionId: "abcdef12-0000-4000-8000-000000000000",
      startTime: "2026-10-01T08:00:00.000Z",
      lastUpdated: "2026-10-02T08:00:00.000Z",
      messages,
    });
    // Older releases name the folder after a hash and leave no marker.
    await writeChat(path.join(tmp, "0f".repeat(32)), "session-2026-10-03T08-00-12345678.json", {
      sessionId: "12345678-0000-4000-8000-000000000000",
      startTime: "2026-10-03T08:00:00.000Z",
      lastUpdated: "2026-10-03T08:00:00.000Z",
      messages: [{ id: "1", type: "user", content: "Hello" }],
    });

    const input = { homeDir: home, env: {} };
    const catalog = await LOCAL_HISTORY_READERS.gemini.discover(input);
    const byId = new Map(catalog.sessions.map((session) => [session.id, session]));
    expect(catalog.sourceHome).toBe(path.join(home, ".gemini"));
    expect(byId.size).toBe(2);
    expect(byId.get("abcdef12-0000-4000-8000-000000000000")).toMatchObject({
      title: "Summarize the repo",
      cwd: project,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-02T08:00:00.000Z",
    });
    expect(byId.get("12345678-0000-4000-8000-000000000000")?.cwd).toBe(home);

    const read = await LOCAL_HISTORY_READERS.gemini.readMessages({
      ...input,
      sessionId: "abcdef12-0000-4000-8000-000000000000",
    });
    expect(read.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Summarize the repo" },
      { role: "assistant", text: "It is a fixture." },
    ]);
  });

  it("looks in the home GEMINI_CLI_HOME names, as Gemini CLI does", () => {
    const home = path.join(os.tmpdir(), "person");
    const custom = path.join(os.tmpdir(), "gemini-elsewhere");
    expect(LOCAL_HISTORY_READERS.gemini.sourceHome({ homeDir: home, env: {} })).toBe(
      path.join(home, ".gemini"),
    );
    expect(
      LOCAL_HISTORY_READERS.gemini.sourceHome({ homeDir: home, env: { GEMINI_CLI_HOME: custom } }),
    ).toBe(path.join(custom, ".gemini"));
  });
});
