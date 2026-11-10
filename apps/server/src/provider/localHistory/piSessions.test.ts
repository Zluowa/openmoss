import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_HISTORY_READERS } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "moss-pi-history-"));
  tempDirs.push(home);
  return home;
}

async function writeSession(
  agentDir: string,
  workspace: string,
  fileName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
) {
  const directory = path.join(agentDir, "sessions", workspace);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, fileName),
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
}

const project = path.join(os.tmpdir(), "fixture-project");

describe("Pi-format local history", () => {
  it("discovers Pi sessions with their folder, name, and model, and reads the visible branch", async () => {
    const home = await fakeHome();
    const agentDir = path.join(home, ".pi", "agent");
    await writeSession(agentDir, "--fixture-project--", "2026-10-01T08-00-00-000Z_s-1.jsonl", [
      {
        type: "session",
        version: 3,
        id: "s-1",
        timestamp: "2026-10-01T08:00:00.000Z",
        cwd: project,
      },
      { type: "model_change", id: "e1", parentId: null, provider: "acme", modelId: "fast-1" },
      { type: "session_info", id: "e2", parentId: "e1", name: "Fixture task" },
      {
        type: "message",
        id: "u1",
        parentId: "e2",
        timestamp: "2026-10-01T08:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "First prompt" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-10-01T08:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "toolCall", name: "read" },
            { type: "text", text: "Abandoned answer" },
          ],
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      },
      // The person rewound to the first prompt and took another branch.
      {
        type: "message",
        id: "a2",
        parentId: "u1",
        timestamp: "2026-10-01T08:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Kept answer" }] },
      },
    ]);
    // A session that never got a prompt has nothing to import.
    await writeSession(agentDir, "--fixture-project--", "2026-10-02T08-00-00-000Z_s-2.jsonl", [
      { type: "session", id: "s-2", timestamp: "2026-10-02T08:00:00.000Z", cwd: project },
    ]);

    const reader = LOCAL_HISTORY_READERS.pi;
    const input = { homeDir: home, env: {} };
    const catalog = await reader.discover(input);

    expect(catalog.sourceHome).toBe(agentDir);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({
        id: "s-1",
        title: "Fixture task",
        cwd: project,
        createdAt: "2026-10-01T08:00:00.000Z",
        archived: false,
        model: "acme/fast-1",
      }),
    ]);
    const messages = await reader.readMessages({ ...input, sessionId: "s-1" });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "First prompt" },
      { role: "assistant", text: "Kept answer" },
    ]);
  });

  it("reads Oh My Pi sessions from its own profile folder and honors PI_CODING_AGENT_DIR for Pi", async () => {
    const home = await fakeHome();
    const custom = path.join(home, "custom-pi");
    await writeSession(path.join(home, ".omp", "agent"), "--w--", "t_omp-1.jsonl", [
      { type: "session", id: "omp-1", cwd: project },
      { type: "model_change", model: "acme/omp-model" },
      {
        type: "message",
        message: {
          role: "user",
          content: "<system-reminder>\ninjected context\n</system-reminder>\nPrompt in Oh My Pi",
        },
      },
    ]);
    await writeSession(custom, "--w--", "t_pi-9.jsonl", [
      { type: "session", id: "pi-9", cwd: project },
      { type: "message", message: { role: "user", content: "Prompt in Pi" } },
    ]);

    const omp = await LOCAL_HISTORY_READERS.omp.discover({ homeDir: home, env: {} });
    expect(omp.sessions.map((session) => [session.id, session.title, session.model])).toEqual([
      ["omp-1", "Prompt in Oh My Pi", "acme/omp-model"],
    ]);
    const pi = await LOCAL_HISTORY_READERS.pi.discover({
      homeDir: home,
      env: { PI_CODING_AGENT_DIR: custom },
    });
    expect(pi.sessions.map((session) => session.id)).toEqual(["pi-9"]);
  });

  it("finds sessions in a folder chosen by environment, by settings, or with ~", async () => {
    const home = await fakeHome();
    const agentDir = path.join(home, ".pi", "agent");
    const fromEnv = path.join(home, "pi-sessions-env");
    const fromSettings = path.join(home, "pi-sessions-settings");
    const writeFlat = async (directory: string, id: string) => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `2026-10-01T08-00-00-000Z_${id}.jsonl`),
        [
          { type: "session", id, cwd: project },
          { type: "message", message: { role: "user", content: `Prompt ${id}` } },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
    };
    await writeFlat(fromEnv, "in-env");
    await writeFlat(fromSettings, "in-settings");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: "~/pi-sessions-settings" }),
    );

    const viaSettings = await LOCAL_HISTORY_READERS.pi.discover({ homeDir: home, env: {} });
    expect(viaSettings.sessions.map((session) => session.id)).toEqual(["in-settings"]);
    // The environment wins over settings, as in Pi itself, and `~` means the person's home.
    const viaEnv = await LOCAL_HISTORY_READERS.pi.discover({
      homeDir: home,
      env: { PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions-env" },
    });
    expect(viaEnv.sessions.map((session) => session.id)).toEqual(["in-env"]);
    await expect(
      LOCAL_HISTORY_READERS.pi.readMessages({
        homeDir: home,
        env: { PI_CODING_AGENT_SESSION_DIR: fromEnv },
        sessionId: "in-env",
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "Prompt in-env" })]);
  });

  it("reports a missing conversation instead of importing an empty one", async () => {
    const home = await fakeHome();
    await expect(
      LOCAL_HISTORY_READERS.pi.readMessages({ homeDir: home, env: {}, sessionId: "gone" }),
    ).rejects.toThrow("no longer on this computer");
  });
});
