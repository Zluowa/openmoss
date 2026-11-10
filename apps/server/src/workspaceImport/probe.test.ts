// FILE: probe.test.ts
// Purpose: Prove the import probe answers inside its deadline when one source is
//          slow or broken, marks that source incomplete instead of failing, and
//          that counting chats gives the same numbers as the full parse.
// Layer: Server import tests

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const chatsControl = vi.hoisted(() => ({
  hang: new Set<string>(),
  fail: new Set<string>(),
}));

vi.mock("./chats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chats")>();
  return {
    ...actual,
    collectImportChats: (input: Parameters<typeof actual.collectImportChats>[0]) => {
      if (chatsControl.hang.has(input.source)) return new Promise<never>(() => {});
      if (chatsControl.fail.has(input.source)) {
        return Promise.reject(new Error("WebSocket RPC server.workspaceImport.probe timed out"));
      }
      return actual.collectImportChats(input);
    },
  };
});

const { collectImportChats } = await import("./chats");
const { probeWorkspaceImport } = await import("./probe");
const { discoverImportResources } = await import("./resources");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  chatsControl.hang.clear();
  chatsControl.fail.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFile(path: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.writeFile(path, contents, "utf8");
}

const now = new Date("2026-11-11T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

async function seedHome(): Promise<{ homeDir: string; codexHome: string; workspace: string }> {
  const homeDir = await makeTempDir("moss-import-probe-home-");
  const codexHome = nodePath.join(homeDir, ".codex");
  const workspace = nodePath.join(homeDir, "work", "alpha");
  await fs.mkdir(workspace, { recursive: true });
  const projectDir = nodePath.join(homeDir, ".claude", "projects", "alpha");
  const turn = (type: "user" | "assistant", text: string, days: number) =>
    JSON.stringify({
      type,
      cwd: workspace,
      timestamp: daysAgo(days),
      message: { role: type, content: [{ type: "text", text }] },
    });
  await writeFile(
    nodePath.join(projectDir, "recent.jsonl"),
    [
      turn("user", "Rotate sk-live-abcdefghijklmnopqrstuvwx for me", 2),
      turn("assistant", "Done.", 2),
    ].join("\n"),
  );
  await writeFile(nodePath.join(projectDir, "old.jsonl"), turn("user", "Old question", 45));
  await writeFile(
    nodePath.join(projectDir, "empty.jsonl"),
    JSON.stringify({ type: "user", timestamp: daysAgo(1), message: { content: [] } }),
  );
  await writeFile(
    nodePath.join(homeDir, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\n---\napi_key = sk-live-abcdefghijklmnopqrstuvwx\n",
  );
  await writeFile(
    nodePath.join(codexHome, "sessions", "2026", "11", "10", "rollout.jsonl"),
    [
      JSON.stringify({
        timestamp: daysAgo(1),
        type: "session_meta",
        payload: { cwd: workspace, id: "s-1" },
      }),
      JSON.stringify({
        timestamp: daysAgo(1),
        type: "event_msg",
        payload: { type: "user_message", message: "Ship it" },
      }),
    ].join("\n"),
  );
  return { homeDir, codexHome, workspace };
}

function probeContext(home: { homeDir: string; codexHome: string }) {
  return {
    homeDir: home.homeDir,
    mossCwd: home.homeDir,
    platform: "linux" as const,
    env: { CODEX_HOME: home.codexHome },
    now,
    currentSettings: DEFAULT_SERVER_SETTINGS,
  };
}

describe("probeWorkspaceImport", () => {
  it("answers within the step deadline and marks a source whose chats never finish", async () => {
    const home = await seedHome();
    chatsControl.hang.add("claude");
    const events: { source: string; timedOutSteps: readonly string[] }[] = [];
    const started = performance.now();

    const result = await probeWorkspaceImport({
      ...probeContext(home),
      stepTimeoutMs: 200,
      onSourceProbed: (event) => events.push(event),
    });

    expect(performance.now() - started).toBeLessThan(5_000);
    const claude = result.sources.find((source) => source.source === "claude");
    expect(claude).toMatchObject({ present: true, incomplete: true, chatCount: 0 });
    // Steps that did finish still count.
    expect(claude?.categoryCounts?.agents).toBe(1);
    const codex = result.sources.find((source) => source.source === "codex");
    expect(codex).toMatchObject({ present: true, chatCount: 1 });
    expect(codex).not.toHaveProperty("incomplete");
    expect(events.find((event) => event.source === "claude")?.timedOutSteps).toEqual(["chats"]);
    expect(events).toHaveLength(result.sources.length);
  });

  it("keeps the other sources when one source's step throws", async () => {
    const home = await seedHome();
    chatsControl.fail.add("claude");
    const failed: string[] = [];

    const result = await probeWorkspaceImport({
      ...probeContext(home),
      onSourceProbed: (event) =>
        failed.push(...event.failedSteps.map((step) => event.source + ":" + step)),
    });

    expect(result.sources.find((source) => source.source === "claude")).toMatchObject({
      present: true,
      incomplete: true,
    });
    expect(result.sources.find((source) => source.source === "codex")?.chatCount).toBe(1);
    expect(failed).toEqual(["claude:chats"]);
  });
});

describe("tools-only probe", () => {
  it("skips the chat and project scan and still reports configuration", async () => {
    const home = await seedHome();
    // Would time the probe out if it ran.
    chatsControl.hang.add("claude");

    const result = await probeWorkspaceImport({
      ...probeContext(home),
      stepTimeoutMs: 200,
      toolsOnly: true,
    });

    const claude = result.sources.find((source) => source.source === "claude");
    expect(claude).toMatchObject({ present: true, chatCount: 0, olderChatCount: 0 });
    expect(claude).not.toHaveProperty("incomplete");
    expect(claude?.categoryCounts).toMatchObject({ agents: 1, chats: 0, projects: 0 });
    // Codex has only a session file here, so without chats there is nothing to show.
    expect(result.sources.find((source) => source.source === "codex")?.present).toBe(false);
  });
});

describe("count-only reading", () => {
  it("counts the same chats and projects as the full parse, without message text", async () => {
    const home = await seedHome();
    const input = {
      source: "claude" as const,
      homeDir: home.homeDir,
      platform: "linux" as const,
      now,
      fallbackCwd: home.homeDir,
    };

    const full = await collectImportChats(input);
    const counted = await collectImportChats({ ...input, countOnly: true });

    expect(full.chats).toHaveLength(1);
    expect(counted.chats.length).toBe(full.chats.length);
    expect(counted.olderChatCount).toBe(full.olderChatCount);
    expect(counted.chats.map((chat) => chat.workingDirectory)).toEqual(
      full.chats.map((chat) => chat.workingDirectory),
    );
    // The full parse redacts; counting never keeps the text at all.
    expect(full.chats[0]?.messages[0]?.text).toContain("[REDACTED]");
    expect(JSON.stringify(counted.chats)).not.toContain("sk-live");
  });

  it("counts resources without reading them for secrets", async () => {
    const home = await seedHome();
    const input = { source: "claude" as const, homeDir: home.homeDir, platform: "linux" as const };

    const full = await discoverImportResources(input);
    const counted = await discoverImportResources({ ...input, countOnly: true });

    expect(counted.counts).toEqual(full.counts);
    expect(full.resources[0]?.sensitive).toBe(true);
    expect(counted.resources[0]).not.toHaveProperty("sensitive");
  });
});
