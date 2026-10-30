// FILE: workspaceImport.test.ts
// Purpose: Prove clean-room external-agent import copies skills, absorbs
//          only honor-able settings, syncs last-30-day chats without duplicates,
//          and never requires Codex binaries or unpacked asar.
// Layer: Server import tests

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, WORKSPACE_IMPORT_CHAT_WINDOW_MS } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { mossSkillsDir } from "../provider/skillsCatalog";
import { persistWorkspaceImportLedger, prepareWorkspaceImportApply } from "./apply";
import { planChatSync } from "./chatSync";
import { collectImportChats, inspectCodexChatInventory, readSourceSettings } from "./chats";
import { readWorkspaceImportLedger, workspaceImportLedgerKey } from "./ledger";
import { probeWorkspaceImport } from "./probe";
import {
  copyImportResources,
  discoverImportProjectRoots,
  discoverImportResources,
} from "./resources";
import { copyImportSkills, discoverImportSkills } from "./skills";
import { absorbHonorAbleSettings, sanitizeImportSettingsPatch } from "./settingsAbsorb";
import { isWithinWorkspaceImportWindow } from "./window";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeFile(path: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.writeFile(path, contents, "utf8");
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function seedClaudeHome(input: {
  readonly homeDir: string;
  readonly now: Date;
  readonly cwd: string;
}): Promise<void> {
  const encodedCwd = input.cwd.replaceAll("/", "-").replaceAll("\\", "-").replaceAll(":", "-");
  await writeFile(
    nodePath.join(input.homeDir, ".claude", "skills", "review-pr", "SKILL.md"),
    "---\nname: review-pr\ndescription: Review a pull request\n---\nReview the PR.\n",
  );
  await writeFile(
    nodePath.join(input.homeDir, ".claude", "settings.json"),
    JSON.stringify({
      theme: "dark",
      model: "claude-sonnet-5",
      locale: "en",
      stream: true,
      apiKey: "sk-secret",
      mcpServers: { github: {} },
    }),
  );
  await writeFile(
    nodePath.join(input.homeDir, ".claude", "projects", encodedCwd, "recent-session.jsonl"),
    [
      JSON.stringify({
        type: "summary",
        summary: "Recent Claude review",
      }),
      JSON.stringify({
        type: "user",
        cwd: input.cwd,
        timestamp: isoDaysAgo(input.now, 2),
        message: { role: "user", content: [{ type: "text", text: "Review the login change" }] },
        connectors: ["github"],
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: isoDaysAgo(input.now, 2),
        message: { role: "assistant", content: [{ type: "text", text: "I will review it." }] },
      }),
    ].join("\n"),
  );
  await writeFile(
    nodePath.join(input.homeDir, ".claude", "projects", encodedCwd, "old-session.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: input.cwd,
      timestamp: isoDaysAgo(input.now, 45),
      message: { role: "user", content: [{ type: "text", text: "Ancient Claude chat" }] },
    }),
  );
  const oldPath = nodePath.join(
    input.homeDir,
    ".claude",
    "projects",
    encodedCwd,
    "old-session.jsonl",
  );
  const oldTime = input.now.getTime() - 45 * 24 * 60 * 60 * 1000;
  await fs.utimes(oldPath, new Date(oldTime), new Date(oldTime));
}

async function seedCursorHome(input: {
  readonly homeDir: string;
  readonly now: Date;
  readonly cwd: string;
}): Promise<void> {
  await writeFile(
    nodePath.join(input.homeDir, ".cursor", "skills", "ship-notes", "SKILL.md"),
    "---\nname: ship-notes\ndescription: Write ship notes\n---\nWrite the notes.\n",
  );
  await writeFile(
    nodePath.join(input.homeDir, ".config", "Cursor", "User", "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark+",
      "cursor.general.defaultModel": "auto",
      locale: "zh-CN",
      "cursor.general.enableStreaming": false,
      "cursor.apiKey": "cursor-secret",
    }),
  );
  await writeFile(
    nodePath.join(input.homeDir, ".cursor", "chats", "recent-cursor.json"),
    JSON.stringify({
      id: "cursor-recent",
      title: "Recent Cursor fix",
      cwd: input.cwd,
      updatedAt: isoDaysAgo(input.now, 1),
      connectors: ["linear"],
      messages: [
        {
          role: "user",
          text: "Fix the sidebar",
          createdAt: isoDaysAgo(input.now, 1),
        },
        {
          role: "assistant",
          text: "Updated the sidebar spacing.",
          createdAt: isoDaysAgo(input.now, 1),
        },
      ],
    }),
  );
  await writeFile(
    nodePath.join(input.homeDir, ".cursor", "chats", "old-cursor.json"),
    JSON.stringify({
      id: "cursor-old",
      title: "Old Cursor chat",
      cwd: input.cwd,
      updatedAt: isoDaysAgo(input.now, 40),
      messages: [{ role: "user", text: "Too old", createdAt: isoDaysAgo(input.now, 40) }],
    }),
  );
  const oldPath = nodePath.join(input.homeDir, ".cursor", "chats", "old-cursor.json");
  const oldTime = input.now.getTime() - 40 * 24 * 60 * 60 * 1000;
  await fs.utimes(oldPath, new Date(oldTime), new Date(oldTime));
}

describe("workspace import", () => {
  it("copies Claude and Cursor skills into the Moss skill library", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-home-");
    const mossBaseDir = await makeTempDir("moss-import-base-");
    const cwd = "/tmp/import-workspace";
    await seedClaudeHome({ homeDir, now, cwd });
    await seedCursorHome({ homeDir, now, cwd });

    const prepared = await prepareWorkspaceImportApply({
      sources: ["claude", "cursor"],
      homeDir,
      mossBaseDir,
      mossCwd: cwd,
      stateDir: nodePath.join(mossBaseDir, "userdata"),
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      existingThreadIds: new Set(),
      createThreadId: () => crypto.randomUUID(),
    });

    const library = mossSkillsDir(mossBaseDir);
    await expect(
      fs.readFile(nodePath.join(library, "review-pr", "SKILL.md"), "utf8"),
    ).resolves.toContain("Review the PR.");
    await expect(
      fs.readFile(nodePath.join(library, "ship-notes", "SKILL.md"), "utf8"),
    ).resolves.toContain("Write the notes.");
    expect(prepared.result.skills.map((skill) => skill.name).toSorted()).toEqual([
      "review-pr",
      "ship-notes",
    ]);
    expect(prepared.result.skills.every((skill) => skill.action === "copied")).toBe(true);
  });

  it("absorbs only honor-able settings and never patches account, payment, or routing", () => {
    const absorbed = absorbHonorAbleSettings({
      source: "claude",
      raw: {
        theme: "dark",
        model: "claude-sonnet-5",
        stream: false,
        apiKey: "sk-secret",
        mcpServers: { github: {} },
        mossPay: { plan: "pro" },
        account: { phone: "13800000000" },
      },
      current: DEFAULT_SERVER_SETTINGS,
    });

    expect(absorbed.clientPreferences.theme).toBe("dark");
    expect(absorbed.patch.enableAssistantStreaming).toBe(false);
    expect(absorbed.patch.providers?.claudeAgent?.customModels).toContain("claude-sonnet-5");
    expect(absorbed.patch.providers?.codex).toBeUndefined();
    expect(absorbed.patch.providerInstances).toBeUndefined();
    expect(absorbed.patch.textGenerationModelSelection).toBeUndefined();
    expect(
      absorbed.changes.some((change) => change.key === "apiKey" && change.action === "skipped"),
    ).toBe(true);
    expect(
      absorbed.changes.some((change) => change.key === "mcpServers" && change.action === "skipped"),
    ).toBe(true);
    expect(
      absorbed.changes.some((change) => change.key === "mossPay" && change.action === "skipped"),
    ).toBe(true);
    expect(
      sanitizeImportSettingsPatch({
        providers: { codex: { customModels: ["gpt-5.5"] } },
        providerInstances: { codex_moss: { driver: "codex", config: {} } },
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.5" },
        enableAssistantStreaming: true,
      }),
    ).toEqual({ enableAssistantStreaming: true });
  });

  it("preserves a catalog-new Codex model as a safe custom model", () => {
    const absorbed = absorbHonorAbleSettings({
      source: "codex",
      raw: { model: "gpt-6-astra", model_reasoning_effort: "ultra" },
      current: DEFAULT_SERVER_SETTINGS,
    });

    expect(absorbed.patch.providers?.codex?.customModels).toContain("gpt-6-astra");
    expect(absorbed.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "model", action: "applied" }),
        expect.objectContaining({ key: "model_reasoning_effort", action: "skipped" }),
      ]),
    );
    expect(absorbed.patch.textGenerationModelSelection).toBeUndefined();
  });

  it("absorbs models when current.providers lacks the target provider", () => {
    const current = structuredClone(DEFAULT_SERVER_SETTINGS);
    // Simulate a partial settings document where the provider slot is missing.
    // @ts-expect-error intentional hole for null-safety coverage
    delete current.providers.codex;

    const absorbed = absorbHonorAbleSettings({
      source: "codex",
      raw: { model: "gpt-6-astra" },
      current,
    });

    expect(absorbed.patch.providers?.codex?.customModels).toContain("gpt-6-astra");
    expect(
      absorbed.changes.some((change) => change.key === "model" && change.action === "applied"),
    ).toBe(true);
  });

  it("imports only chats from the last 30 days with title and working directory", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-chats-");
    const mossBaseDir = await makeTempDir("moss-import-chats-base-");
    const cwd = nodePath.resolve("/tmp/import-workspace");
    await seedClaudeHome({ homeDir, now, cwd });
    await seedCursorHome({ homeDir, now, cwd });

    const prepared = await prepareWorkspaceImportApply({
      sources: ["claude", "cursor"],
      homeDir,
      mossBaseDir,
      mossCwd: cwd,
      stateDir: nodePath.join(mossBaseDir, "userdata"),
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      existingThreadIds: new Set(),
      createThreadId: () => crypto.randomUUID(),
    });

    expect(prepared.result.chats.map((chat) => chat.title).toSorted()).toEqual([
      "Recent Claude review",
      "Recent Cursor fix",
    ]);
    expect(prepared.result.chats.every((chat) => chat.workingDirectory === cwd)).toBe(true);
    expect(prepared.result.chats.every((chat) => chat.action === "created")).toBe(true);
    expect(prepared.result.skippedOlderChatCount).toBe(2);
    expect([...prepared.result.connectors].toSorted()).toEqual(["github", "linear"]);
    expect(now.getTime() - WORKSPACE_IMPORT_CHAT_WINDOW_MS).toBeLessThan(
      new Date("2026-07-20T12:00:00.000Z").getTime(),
    );
  });

  it("re-imports the same chats into the existing threads instead of duplicating them", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-dedup-");
    const mossBaseDir = await makeTempDir("moss-import-dedup-base-");
    const cwd = "/tmp/import-workspace";
    await seedClaudeHome({ homeDir, now, cwd });
    await seedCursorHome({ homeDir, now, cwd });
    const stateDir = nodePath.join(mossBaseDir, "userdata");
    let created = 0;
    const first = await prepareWorkspaceImportApply({
      sources: ["claude", "cursor"],
      homeDir,
      mossBaseDir,
      mossCwd: cwd,
      stateDir,
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      existingThreadIds: new Set(),
      createThreadId: () => {
        created += 1;
        return `thread-${created}`;
      },
    });
    await persistWorkspaceImportLedger(stateDir, first.ledger);

    const second = await prepareWorkspaceImportApply({
      sources: ["claude", "cursor"],
      homeDir,
      mossBaseDir,
      mossCwd: cwd,
      stateDir,
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      existingThreadIds: new Set(first.result.chats.map((chat) => chat.threadId)),
      createThreadId: () => {
        created += 1;
        return `thread-${created}`;
      },
    });

    expect(first.result.chats).toHaveLength(2);
    expect(second.result.chats).toHaveLength(2);
    expect(second.result.chats.map((chat) => chat.threadId).toSorted()).toEqual(
      first.result.chats.map((chat) => chat.threadId).toSorted(),
    );
    expect(second.result.chats.every((chat) => chat.action === "unchanged")).toBe(true);
    expect(created).toBe(2);
    expect(
      second.ledger.entries[workspaceImportLedgerKey("cursor", "cursor-recent")]?.threadId,
    ).toBe(first.result.chats.find((chat) => chat.source === "cursor")?.threadId);
  });

  it("asks which source to use when both Claude Code and Cursor have data", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-probe-");
    const cwd = "/tmp/import-workspace";
    await seedClaudeHome({ homeDir, now, cwd });
    await seedCursorHome({ homeDir, now, cwd });

    const probe = await probeWorkspaceImport({
      homeDir,
      mossCwd: cwd,
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
    });

    expect(probe.requiresSourceChoice).toBe(true);
    expect(probe.sources.filter((source) => source.present).map((source) => source.source)).toEqual(
      ["claude", "cursor"],
    );
  });

  it("returns an empty probe when neither source has local data", async () => {
    const homeDir = await makeTempDir("moss-import-empty-");
    const probe = await probeWorkspaceImport({
      homeDir,
      mossCwd: "/tmp/empty",
      platform: "linux",
      now: new Date("2026-08-17T12:00:00.000Z"),
      currentSettings: DEFAULT_SERVER_SETTINGS,
    });

    expect(probe.requiresSourceChoice).toBe(false);
    expect(probe.sources.every((source) => source.present === false)).toBe(true);
    expect(probe.sources.every((source) => source.chatCount === 0)).toBe(true);
  });

  it("plans a new thread when a previously imported thread no longer exists", () => {
    const chat = {
      source: "claude" as const,
      sourceId: "session-1",
      title: "Review",
      workingDirectory: "/tmp/project",
      updatedAt: "2026-08-16T00:00:00.000Z",
      messages: [{ role: "user" as const, text: "Hi", createdAt: "2026-08-16T00:00:00.000Z" }],
      connectors: [],
    };
    const plan = planChatSync({
      chats: [chat],
      ledger: {
        version: 1,
        entries: {
          "claude:session-1": {
            threadId: "missing-thread",
            source: "claude",
            sourceId: "session-1",
            title: "Review",
            workingDirectory: "/tmp/project",
            importedCount: 1,
            sourceUpdatedAt: "2026-08-16T00:00:00.000Z",
            importedAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
        },
      },
      existingThreadIds: new Set(),
      nowIso: "2026-08-17T00:00:00.000Z",
      createThreadId: () => "new-thread",
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]?.action).toBe("created");
    expect(plan[0]?.threadId).toBe("new-thread");
  });

  it("detects Codex, Grok, and OpenCode homes without importing credentials", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-multi-agent-home-");
    const mossBaseDir = await makeTempDir("moss-import-multi-agent-base-");
    const codexHome = nodePath.join(homeDir, "codex-home");
    const grokHome = nodePath.join(homeDir, "grok-home");
    const openCodeHome = nodePath.join(homeDir, "opencode-home");
    await writeFile(
      nodePath.join(codexHome, "config.toml"),
      'model = "gpt-5.5"\ntheme = "dark"\napi_key = "do-not-read"\n',
    );
    await writeFile(nodePath.join(codexHome, "skills", "ship", "SKILL.md"), "# Ship\n");
    await writeFile(
      nodePath.join(codexHome, "sessions", "one.jsonl"),
      [
        JSON.stringify({ role: "user", text: "Ship it", timestamp: isoDaysAgo(now, 1) }),
        JSON.stringify({ role: "assistant", text: "Done", timestamp: isoDaysAgo(now, 1) }),
      ].join("\n"),
    );
    await writeFile(
      nodePath.join(grokHome, "config.json"),
      JSON.stringify({ model: "grok-4.6", theme: "light" }),
    );
    await writeFile(
      nodePath.join(openCodeHome, "config.json"),
      JSON.stringify({ model: "openai/gpt-5", locale: "zh-CN" }),
    );
    await writeFile(
      nodePath.join(openCodeHome, "chats", "recent.json"),
      JSON.stringify({
        id: "open-code-recent",
        title: "OpenCode task",
        updatedAt: isoDaysAgo(now, 2),
        messages: [{ role: "user", text: "Review this" }],
      }),
    );

    const probe = await probeWorkspaceImport({
      homeDir,
      mossCwd: "/tmp/multi-agent",
      platform: "linux",
      env: {
        CODEX_HOME: codexHome,
        GROK_HOME: grokHome,
        OPENCODE_CONFIG_DIR: openCodeHome,
      },
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      stateDir: nodePath.join(mossBaseDir, "userdata"),
    });
    expect(probe.sources.find((source) => source.source === "codex")?.present).toBe(true);
    expect(probe.sources.find((source) => source.source === "grok")?.present).toBe(true);
    expect(probe.sources.find((source) => source.source === "opencode")?.present).toBe(true);

    const codexSettings = await readSourceSettings({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
    });
    const absorbed = absorbHonorAbleSettings({
      source: "codex",
      raw: codexSettings,
      current: DEFAULT_SERVER_SETTINGS,
    });
    expect(absorbed.patch.providers?.codex?.customModels).toContain("gpt-5.5");
    expect(absorbed.changes.some((change) => change.key === "api_key")).toBe(true);

    const chats = await collectImportChats({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
      now,
      fallbackCwd: "/tmp/multi-agent",
    });
    expect(chats.chats.map((chat) => chat.title)).toContain("Ship it");
    const resources = await discoverImportResources({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
    });
    expect(resources.counts.agents).toBe(0);
    expect(resources.resources).toEqual([]);
  });

  it("parses the on-disk Codex session envelope without importing control records", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-codex-session-home-");
    const codexHome = nodePath.join(homeDir, ".codex");
    const workspace = nodePath.join(homeDir, "projects", "alpha-workspace");
    await fs.mkdir(workspace, { recursive: true });
    await writeFile(
      nodePath.join(codexHome, "sessions", "2026", "08", "17", "session.jsonl"),
      [
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "session_meta",
          payload: { cwd: workspace, id: "codex-session-1" },
        }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "event_msg",
          payload: { type: "user_message", message: "Review the import flow" },
        }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found the import flow." }],
          },
        }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "token_count",
          payload: { total_token_usage: { input_tokens: 12 } },
        }),
      ].join("\n"),
    );

    const result = await collectImportChats({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
      now,
      fallbackCwd: nodePath.join(homeDir, "fallback"),
    });

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]).toMatchObject({
      source: "codex",
      title: "Review the import flow",
      workingDirectory: await fs.realpath(workspace),
    });
    expect(result.chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "Review the import flow" }),
      expect.objectContaining({ role: "assistant", text: "I found the import flow." }),
    ]);
  });

  it("streams Codex sessions larger than the generic chat limit", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-codex-large-home-");
    const codexHome = nodePath.join(homeDir, ".codex");
    const sessionsDir = nodePath.join(codexHome, "sessions", "2026", "08", "17");
    const filler = "x".repeat(9 * 1024 * 1024);
    const sessionPath = nodePath.join(sessionsDir, "large-session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "token_count", payload: { filler } }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "session_meta",
          payload: { cwd: homeDir, id: "large-session" },
        }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "event_msg",
          payload: { type: "user_message", message: "Import the large session" },
        }),
        JSON.stringify({
          timestamp: isoDaysAgo(now, 1),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Imported without buffering the file." }],
          },
        }),
      ].join("\n"),
    );

    const result = await collectImportChats({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
      now,
      fallbackCwd: homeDir,
    });

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "Import the large session" }),
      expect.objectContaining({ role: "assistant", text: "Imported without buffering the file." }),
    ]);
  });

  it("does not apply the 64 MiB aggregate cap to Codex sessions", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-codex-batch-home-");
    const codexHome = nodePath.join(homeDir, ".codex");
    const sessionsDir = nodePath.join(codexHome, "sessions", "2026", "08", "17");
    const filler = "y".repeat(9 * 1024 * 1024);
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        await writeFile(
          nodePath.join(sessionsDir, `batch-${index}.jsonl`),
          [
            JSON.stringify({
              timestamp: isoDaysAgo(now, index + 1),
              type: "session_meta",
              payload: { cwd: homeDir, id: `batch-${index}` },
            }),
            JSON.stringify({
              timestamp: isoDaysAgo(now, index + 1),
              type: "event_msg",
              payload: { type: "user_message", message: `Batch session ${index}` },
            }),
            JSON.stringify({ type: "token_count", payload: { filler } }),
          ].join("\n"),
        );
      }),
    );

    const result = await collectImportChats({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
      now,
      fallbackCwd: homeDir,
    });

    expect(result.chats).toHaveLength(8);
    expect(result.chats.map((chat) => chat.title)).toEqual(
      expect.arrayContaining(Array.from({ length: 8 }, (_, index) => `Batch session ${index}`)),
    );
    await expect(
      inspectCodexChatInventory({
        homeDir,
        platform: "linux",
        env: { CODEX_HOME: codexHome },
        now,
      }),
    ).resolves.toMatchObject({ chatCount: 8, olderChatCount: 0 });
  });

  it("probes a Codex session when an oversized leading record hides the message from the prefix", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-codex-probe-tail-home-");
    const codexHome = nodePath.join(homeDir, ".codex");
    const sessionsDir = nodePath.join(codexHome, "sessions", "2026", "08", "17");
    await writeFile(
      nodePath.join(sessionsDir, "tail-window.jsonl"),
      [
        JSON.stringify({ type: "token_count", payload: { filler: "z".repeat(9 * 1024 * 1024) } }),
        JSON.stringify({
          type: "session_meta",
          timestamp: now.toISOString(),
          payload: { cwd: homeDir, id: "tail-window" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now.toISOString(),
          payload: { type: "user_message", message: "Message after the leading tool record" },
        }),
      ].join("\n"),
    );

    await expect(
      inspectCodexChatInventory({
        homeDir,
        platform: "linux",
        env: { CODEX_HOME: codexHome },
        now,
      }),
    ).resolves.toMatchObject({ chatCount: 1, olderChatCount: 0 });
  });

  it("uses transcript cwd metadata to recover Claude projects whose encoded names contain hyphens", async () => {
    const homeDir = await makeTempDir("moss-import-project-home-");
    const project = nodePath.join(homeDir, "work", "api-client-v2");
    await fs.mkdir(project, { recursive: true });
    await writeFile(
      nodePath.join(homeDir, ".claude", "projects", "-broken-encoding", "session.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: project,
        timestamp: "2026-08-16T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      }),
    );

    await expect(
      discoverImportProjectRoots({
        source: "claude",
        homeDir,
        platform: "linux",
        fallbackCwd: nodePath.join(homeDir, "fallback"),
      }),
    ).resolves.toContain(await fs.realpath(project));
  });

  it("quarantines credential-bearing resources and never follows a source symlink", async () => {
    const homeDir = await makeTempDir("moss-import-resource-home-");
    const destinationRoot = await makeTempDir("moss-import-resource-destination-");
    const safePath = nodePath.join(homeDir, ".claude", "agents", "reviewer.md");
    const secretPath = nodePath.join(homeDir, ".claude", "agents", "settings.json");
    await writeFile(safePath, "# Reviewer\n");
    await writeFile(secretPath, JSON.stringify({ apiKey: "sk-12345678901234567890" }));
    const outside = nodePath.join(homeDir, "outside.txt");
    await writeFile(outside, "outside\n");
    const symlinkPath = nodePath.join(homeDir, ".claude", "agents", "linked.md");
    try {
      await fs.symlink(outside, symlinkPath);
    } catch {
      // Symlinks may be unavailable on a restricted filesystem; the regular
      // file assertions below still verify the content guard.
    }

    const inventory = await discoverImportResources({
      source: "claude",
      homeDir,
      platform: "linux",
    });
    const copies = await copyImportResources({
      resources: inventory.resources,
      destinationRoot,
      selectedCategories: new Set(["agents"]),
    });

    expect(copies.find((item) => item.name === "settings.json")).toMatchObject({
      action: "skipped",
      quarantined: true,
      reviewRequired: true,
    });
    expect(copies.find((item) => item.name === "reviewer.md")).toMatchObject({
      action: "copied",
      quarantined: true,
      reviewRequired: false,
    });
    await expect(
      fs.readFile(nodePath.join(destinationRoot, "claude", "agents", "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("detects JSON-quoted credential keys in otherwise ordinary resource files", async () => {
    const homeDir = await makeTempDir("workspace-import-json-secret-home-");
    const resourcePath = nodePath.join(homeDir, ".claude", "hooks", "settings.json");
    await fs.mkdir(nodePath.dirname(resourcePath), { recursive: true });
    await writeFile(resourcePath, JSON.stringify({ apiKey: "ordinary-looking-secret-value" }));

    const inventory = await discoverImportResources({
      source: "claude",
      homeDir,
      platform: process.platform,
    });
    const result = await copyImportResources({
      resources: inventory.resources,
      destinationRoot: nodePath.join(homeDir, ".moss", "imports"),
      selectedCategories: new Set(["hooks"]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.action).toBe("skipped");
    expect(result[0]?.quarantined).toBe(true);
  });

  it("namespaces a conflicting skill without overwriting the existing Moss skill", async () => {
    const homeDir = await makeTempDir("moss-import-skill-home-");
    const mossBaseDir = await makeTempDir("moss-import-skill-base-");
    await writeFile(
      nodePath.join(homeDir, ".claude", "skills", "review", "SKILL.md"),
      "# Claude review\n",
    );
    await writeFile(
      nodePath.join(mossSkillsDir(mossBaseDir), "review", "SKILL.md"),
      "# Existing Moss review\n",
    );
    const discovered = await discoverImportSkills({
      source: "claude",
      homeDir,
      platform: "linux",
    });
    const result = await copyImportSkills({ skills: discovered, mossBaseDir });
    expect(result[0]).toMatchObject({ action: "copied", destinationName: "claude-review" });
    await expect(
      fs.readFile(nodePath.join(mossSkillsDir(mossBaseDir), "review", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Existing Moss review\n");
    await expect(
      fs.readFile(nodePath.join(mossSkillsDir(mossBaseDir), "claude-review", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Claude review\n");
  });

  it("keeps same-named skills from different sources instead of silently dropping one", async () => {
    const homeDir = await makeTempDir("moss-import-skill-sources-home-");
    const mossBaseDir = await makeTempDir("moss-import-skill-sources-base-");
    await writeFile(
      nodePath.join(homeDir, ".claude", "skills", "review", "SKILL.md"),
      "# Claude\n",
    );
    await writeFile(
      nodePath.join(homeDir, ".cursor", "skills", "review", "SKILL.md"),
      "# Cursor\n",
    );
    const [claude, cursor] = await Promise.all([
      discoverImportSkills({ source: "claude", homeDir, platform: "linux" }),
      discoverImportSkills({ source: "cursor", homeDir, platform: "linux" }),
    ]);
    const result = await copyImportSkills({ skills: [...claude, ...cursor], mossBaseDir });
    expect(result.filter((item) => item.action === "copied")).toHaveLength(2);
    await expect(
      fs.readFile(nodePath.join(mossSkillsDir(mossBaseDir), "review", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Claude\n");
    await expect(
      fs.readFile(nodePath.join(mossSkillsDir(mossBaseDir), "cursor-review", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Cursor\n");
  });

  it("redacts credential-shaped values before chat text reaches Moss threads", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-chat-secret-home-");
    await writeFile(
      nodePath.join(homeDir, ".cursor", "chats", "secret.json"),
      JSON.stringify({
        id: "secret-chat",
        title: "Credentials",
        updatedAt: isoDaysAgo(now, 1),
        messages: [
          {
            role: "user",
            text: "apiKey=sk-12345678901234567890 Bearer abcdefghijklmnop",
            createdAt: isoDaysAgo(now, 1),
          },
        ],
      }),
    );
    const result = await collectImportChats({
      source: "cursor",
      homeDir,
      platform: "linux",
      now,
      fallbackCwd: homeDir,
    });
    expect(result.chats[0]?.messages[0]?.text).toBe("apiKey=[REDACTED] [REDACTED]");
    expect(result.chats[0]?.messages[0]?.text).not.toContain("12345678901234567890");
  });

  it("scans the full bounded resource file, not only its first 128 KiB", async () => {
    const homeDir = await makeTempDir("moss-import-resource-long-home-");
    const destinationRoot = await makeTempDir("moss-import-resource-long-destination-");
    const longSecret = `${"safe ".repeat(30_000)}apiKey=sk-12345678901234567890`;
    await writeFile(nodePath.join(homeDir, ".claude", "agents", "long.md"), longSecret);
    const inventory = await discoverImportResources({
      source: "claude",
      homeDir,
      platform: "linux",
    });
    const copies = await copyImportResources({
      resources: inventory.resources,
      destinationRoot,
      selectedCategories: new Set(["agents"]),
    });
    expect(copies.find((item) => item.name === "long.md")).toMatchObject({
      action: "skipped",
      quarantined: true,
      reviewRequired: true,
    });
  });

  it("does not treat future-dated transcripts as recent chats", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    expect(
      isWithinWorkspaceImportWindow({
        now,
        timestamp: new Date("2026-08-18T12:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("marks a source present when it only has a project folder", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-project-only-home-");
    const project = nodePath.join(homeDir, "projects", "only-project");
    const codexHome = nodePath.join(homeDir, ".codex");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(nodePath.join(codexHome, "projects"), { recursive: true });
    await fs.rename(project, nodePath.join(codexHome, "projects", "only-project"));
    const probe = await probeWorkspaceImport({
      homeDir,
      mossCwd: nodePath.join(homeDir, "fallback"),
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
    });
    expect(probe.sources.find((source) => source.source === "codex")).toMatchObject({
      present: true,
      projectCount: 1,
    });
  });

  it("imports existing Codex project index entries", async () => {
    const homeDir = await makeTempDir("moss-import-codex-project-index-home-");
    const codexHome = nodePath.join(homeDir, ".codex");
    const first = nodePath.join(homeDir, "work", "first");
    const second = nodePath.join(homeDir, "work", "second");
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    await writeFile(
      nodePath.join(codexHome, "config.toml"),
      `[projects.${JSON.stringify(first)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(second)}]\ntrust_level = "trusted"\n`,
    );

    const roots = await discoverImportProjectRoots({
      source: "codex",
      homeDir,
      platform: "linux",
      env: { CODEX_HOME: codexHome },
      fallbackCwd: nodePath.join(homeDir, "fallback"),
    });

    expect(roots).toEqual(
      expect.arrayContaining([await fs.realpath(first), await fs.realpath(second)]),
    );
  });

  it("honors an explicit empty category selection", async () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const homeDir = await makeTempDir("moss-import-empty-categories-home-");
    const mossBaseDir = await makeTempDir("moss-import-empty-categories-base-");
    await seedClaudeHome({ homeDir, now, cwd: nodePath.join(homeDir, "workspace") });
    const prepared = await prepareWorkspaceImportApply({
      sources: ["claude"],
      homeDir,
      mossBaseDir,
      mossCwd: nodePath.join(homeDir, "workspace"),
      stateDir: nodePath.join(mossBaseDir, "userdata"),
      platform: "linux",
      now,
      currentSettings: DEFAULT_SERVER_SETTINGS,
      existingThreadIds: new Set(),
      createThreadId: () => "unused",
      categories: [],
    });
    expect(prepared.result.skills).toEqual([]);
    expect(prepared.result.chats).toEqual([]);
    expect(prepared.projectRoots).toEqual([]);
  });

  it("rekeys legacy Claude Code ledger aliases to the canonical source key", async () => {
    const stateDir = await makeTempDir("moss-import-ledger-alias-");
    const entry = {
      threadId: "thread-1",
      source: "claude-code",
      sourceId: "session-1",
      title: "Review",
      workingDirectory: "/tmp/project",
      importedCount: 1,
      sourceUpdatedAt: "2026-08-16T00:00:00.000Z",
      importedAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    };
    await writeFile(
      nodePath.join(stateDir, "workspace-import-ledger.json"),
      JSON.stringify({ version: 1, entries: { "claude-code:session-1": entry } }),
    );
    const ledger = await readWorkspaceImportLedger(stateDir);
    expect(ledger.entries[workspaceImportLedgerKey("claude", "session-1")]).toMatchObject({
      source: "claude",
    });
    expect(ledger.entries["claude-code:session-1"]).toBeUndefined();
  });
});
