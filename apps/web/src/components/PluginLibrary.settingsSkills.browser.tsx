// Owner feedback 2026-11-11 (screenshots 32, 33) on Settings › 插件 › 技能:
// - the 「其他 CLI 的技能」 import block sat on top of the list; it now lives in 添加 ▾;
// - a skill's detail opened shrunk over a see-through Settings window;
// - an existing skill with a Chinese name read 「无法读取此技能的说明」.
import "../index.css";
import "./PluginLibrary.css";

import { ProjectId, type NativeApi, type OrchestrationShellSnapshot } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeSettings, openSettings } from "~/settingsDialogStore";
import { useStore } from "~/store";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
} from "~/test/browserHarness";
import { mountGeneratedPluginApp } from "~/test/generatedPluginLibraryBrowserHarness";
import { PluginLibraryNativeFixture } from "~/test/pluginLibraryBrowserHarness";

const SHOTS = "__screenshots__/settings-owner-r6";
const PROJECT_ID = ProjectId.makeUnsafe("owner-dev");
const NOW = "2026-11-11T00:00:00.000Z";
const SKIN_SKILL = {
  name: "dst-home-skins",
  path: "E:\\Codex\\home\\skills\\dst-home-skins\\SKILL.md",
  description: "制作饥荒联机版 DST 家园主题外观包。",
  enabled: true,
  scope: "user" as const,
  interface: {
    displayName: "饥荒家园主题皮肤",
    shortDescription: "批量制作火把、火堆、木牌、箱子与冰箱等原创外观，保留原有玩法与数值",
  },
};
const SKIN_DOCUMENT = `---
name: dst-home-skins
description: 制作饥荒联机版 DST 家园主题外观包，为火把、火堆、木牌、箱子、冰箱等批量设计原创皮肤。
---

# 饥荒家园主题皮肤

先盘点原版贴图和动画，再为每个物件画一套原创外观。只改外观，不改玩法与数值。
`;
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  spaces: [],
  projects: [
    {
      id: PROJECT_ID,
      kind: "project",
      title: "owner-dev",
      workspaceRoot: "/repo/owner-dev",
      defaultModelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  threads: [],
  updatedAt: NOW,
};

function skillProbe() {
  const source = (name: string, skillCount: number, present = true) => ({
    source: name,
    present,
    skillCount,
    honorAbleSettingCount: 0,
    chatCount: 0,
    olderChatCount: 0,
  });
  return {
    requiresSourceChoice: false,
    // The owner's machine on 2026-11-11: Claude 3, Cursor 28, Codex 20, Grok 2.
    sources: [
      source("claude", 3),
      source("cursor", 28),
      source("codex", 20),
      source("grok", 2),
      source("opencode", 0, false),
    ],
  };
}

let mounted: Awaited<ReturnType<typeof mountGeneratedPluginApp>> | undefined;
let backdropArt: HTMLElement | undefined;

afterEach(async () => {
  closeSettings();
  await mounted?.cleanup();
  mounted = undefined;
  backdropArt?.remove();
  backdropArt = undefined;
  vi.restoreAllMocks();
});

async function mountSettingsSkills() {
  await page.viewport(1280, 860);
  const fixture = new PluginLibraryNativeFixture();
  fixture.serverSettings = { ...fixture.serverSettings, onboardingCompletedAt: NOW };
  fixture.discoveredSkills.push(SKIN_SKILL, {
    name: "dst-atlas",
    path: "E:\\Codex\\home\\skills\\dst-atlas\\SKILL.md",
    description: "查询饥荒联机版及本地模组的物品配方、获取方式、用途与玩法",
    enabled: true,
    scope: "user",
    interface: { displayName: "饥荒联机版图鉴" },
  });
  const readSkillCalls: Array<Parameters<NativeApi["provider"]["readSkill"]>[0]> = [];
  mounted = await mountGeneratedPluginApp({
    fixture,
    freshUser: true,
    locale: "zh-CN",
    initialEntries: ["/skills"],
    configureNativeApi(api) {
      const config = createBrowserTestServerConfig(NOW);
      acknowledgeStartupAnnouncementsForTest(config);
      api.server.getConfig = async () => config;
      api.server.probeWorkspaceImport = async () =>
        skillProbe() as unknown as Awaited<ReturnType<NativeApi["server"]["probeWorkspaceImport"]>>;
      api.provider.readSkill = async (input) => {
        readSkillCalls.push(input);
        return { contents: SKIN_DOCUMENT };
      };
      api.projects.discoverScripts = async () => ({ targets: [] });
      api.orchestration.getShellSnapshot = async () => snapshot;
      const shellListeners = new Set<Parameters<NativeApi["orchestration"]["onShellEvent"]>[0]>();
      api.orchestration.onShellEvent = (listener) => {
        shellListeners.add(listener);
        return () => {
          shellListeners.delete(listener);
        };
      };
      api.orchestration.subscribeShell = async () => {
        for (const listener of shellListeners) listener({ kind: "snapshot", snapshot });
      };
      api.orchestration.getSnapshot = async () => ({
        snapshotSequence: snapshot.snapshotSequence,
        spaces: [],
        projects: snapshot.projects.map((project) => ({ ...project, deletedAt: null })),
        threads: [],
        updatedAt: snapshot.updatedAt,
      });
    },
  });
  await expect.poll(() => useStore.getState().threadsHydrated).toBe(true);
  // A busy picture behind Settings, like the owner's chat image: any see-through shows.
  backdropArt = document.createElement("div");
  backdropArt.setAttribute("aria-hidden", "true");
  backdropArt.style.cssText =
    "position:fixed;inset:0;z-index:40;pointer-events:none;background:repeating-linear-gradient(45deg,#e9a23b 0 40px,#7a4b1c 40px 80px)";
  document.body.append(backdropArt);
  openSettings({ section: "plugins" });
  const dialog = page.getByTestId("settings-dialog");
  await expect.element(dialog, { timeout: 15_000 }).toBeVisible();
  await userEvent.click(page.getByTestId("plugin-manage-tab-skills"));
  await expect.element(dialog.getByText("饥荒家园主题皮肤", { exact: true })).toBeVisible();
  return { dialog, readSkillCalls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe("Settings › 插件 › 技能 (owner feedback 2026-11-11)", () => {
  it("keeps the list clean; other CLIs' skills are imported from 添加 ▾", async () => {
    const { dialog } = await mountSettingsSkills();
    await settle();
    await page.screenshot({ path: `${SHOTS}/32-skills-tab.png` });
    await userEvent.click(dialog.getByRole("button", { name: "添加", exact: true }));
    await settle();
    await page.screenshot({ path: `${SHOTS}/32-add-menu.png` });
    expect(dialog.getByText("其他 CLI 的技能", { exact: true }).elements()).toHaveLength(0);
    const importEntry = page.getByRole("menuitem", { name: "从其他 CLI 导入…" });
    await expect.element(importEntry).toBeVisible();

    await userEvent.click(importEntry);
    const importView = page.getByRole("dialog", { name: "从其他 CLI 导入技能" });
    await expect.element(importView).toBeVisible();
    for (const [label, count] of [
      ["Claude Code", 3],
      ["Cursor", 28],
      ["Codex", 20],
      ["Grok", 2],
    ] as const) {
      await expect.element(importView.getByText(label, { exact: true })).toBeVisible();
      await expect.element(importView.getByText(`${count} 个技能`, { exact: true })).toBeVisible();
    }
    await expect.element(importView.getByRole("button", { name: "全部导入（53）" })).toBeVisible();
    await settle();
    await page.screenshot({ path: `${SHOTS}/32-import-view.png` });
  });

  it("opens a Chinese skill's detail at full size over an opaque Settings, with its SKILL.md body", async () => {
    const { dialog, readSkillCalls } = await mountSettingsSkills();
    const settingsPopup = page.getByTestId("settings-dialog");
    await settle();
    const before = settingsPopup.element().getBoundingClientRect();

    await userEvent.click(dialog.getByText("饥荒家园主题皮肤", { exact: true }));
    const detail = page.getByRole("dialog", { name: /饥荒家园主题皮肤/u });
    await expect.element(detail).toBeVisible();
    await settle();
    await page.screenshot({ path: `${SHOTS}/33-skill-detail.png` });
    await expect
      .element(
        detail.getByText(
          "先盘点原版贴图和动画，再为每个物件画一套原创外观。只改外观，不改玩法与数值。",
        ),
      )
      .toBeVisible();
    expect(
      detail.getByText("无法读取此技能的说明。请刷新技能目录或重试。").elements(),
    ).toHaveLength(0);
    expect(readSkillCalls.at(-1)).toMatchObject({ name: "dst-home-skins", path: SKIN_SKILL.path });

    // Settings behind keeps its size and stays opaque, under the detail's own overlay.
    const after = settingsPopup.element().getBoundingClientRect();
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.top).toBeCloseTo(before.top, 0);
    expect(getComputedStyle(settingsPopup.element()).opacity).toBe("1");
    expect(document.querySelectorAll('[data-slot="dialog-backdrop"]').length).toBe(2);
  });
});
