// Acceptance 2026-11-11: after a cold start, Settings › Plugins showed 「正在加载…」 for over
// three minutes, the Plugins and Skills counts stayed blank and every Create entry was
// disabled. Here the agent's plugin and skill lists never answer at all.
import "../index.css";
import "./PluginLibrary.css";

import { ProjectId, type NativeApi, type OrchestrationShellSnapshot } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "~/composerDraftStore";
import { closeSettings, openSettings, settingsDialogStore } from "~/settingsDialogStore";
import { useStore } from "~/store";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
} from "~/test/browserHarness";
import { mountGeneratedPluginApp } from "~/test/generatedPluginLibraryBrowserHarness";
import { PluginLibraryNativeFixture } from "~/test/pluginLibraryBrowserHarness";

// The real limits are tens of seconds; the behaviour is the same with short ones.
vi.mock("~/lib/requestTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/requestTimeout")>()),
  PLUGIN_LIST_REQUEST_TIMEOUT_MS: 250,
  SKILL_LIST_REQUEST_TIMEOUT_MS: 250,
  COMPOSER_CAPABILITIES_REQUEST_TIMEOUT_MS: 250,
}));

const PROJECT_ID = ProjectId.makeUnsafe("never-resolves-workspace");
const NOW = "2026-11-11T00:00:00.000Z";
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  spaces: [],
  projects: [
    {
      id: PROJECT_ID,
      kind: "project",
      title: "Workspace",
      workspaceRoot: "/repo/project",
      defaultModelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  threads: [],
  updatedAt: NOW,
};

let mounted: Awaited<ReturnType<typeof mountGeneratedPluginApp>> | undefined;

afterEach(async () => {
  closeSettings();
  await mounted?.cleanup();
  mounted = undefined;
  vi.restoreAllMocks();
});

async function mountWithListsThatNeverAnswer() {
  await page.viewport(1280, 900);
  const fixture = new PluginLibraryNativeFixture();
  fixture.serverSettings = { ...fixture.serverSettings, onboardingCompletedAt: NOW };
  const pluginCalls: Array<Parameters<NativeApi["provider"]["listPlugins"]>[0]> = [];
  const skillCalls: Array<Parameters<NativeApi["provider"]["listSkills"]>[0]> = [];
  const commands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> = [];
  mounted = await mountGeneratedPluginApp({
    fixture,
    freshUser: true,
    initialEntries: ["/skills"],
    configureNativeApi(api) {
      const config = createBrowserTestServerConfig(NOW);
      acknowledgeStartupAnnouncementsForTest(config);
      api.server.getConfig = async () => config;
      // A Codex app-server that never starts: the requests are sent and never answered.
      api.provider.listPlugins = (input) => {
        pluginCalls.push(input);
        return new Promise(() => {});
      };
      api.provider.listSkills = (input) => {
        skillCalls.push(input);
        return new Promise(() => {});
      };
      api.projects.discoverScripts = async () => ({ targets: [] });
      api.git = {
        ...api.git,
        listBranches: async () => ({ branches: [], isRepo: false, hasOriginRemote: false }),
        status: async () => ({
          branch: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          upstreamBranch: null,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      };
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
      api.orchestration.dispatchCommand = async (command) => {
        commands.push(command);
        throw new Error("Create must open an unsent draft; no agent turn is allowed.");
      };
    },
  });
  await expect.poll(() => useStore.getState().threadsHydrated).toBe(true);
  return { pluginCalls, skillCalls, commands };
}

describe("Settings › Plugins when the plugin list never answers", () => {
  it("keeps Create usable, then shows a retry state instead of loading forever", async () => {
    const { pluginCalls, skillCalls, commands } = await mountWithListsThatNeverAnswer();
    openSettings({ section: "plugins" });
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect.element(dialog).toBeVisible();
    await expect.poll(() => pluginCalls.length).toBeGreaterThan(0);
    await expect.poll(() => skillCalls.length).toBeGreaterThan(0);

    // While nothing has answered, every Create entry already works.
    await userEvent.click(dialog.getByRole("button", { name: "Add", exact: true }));
    for (const name of ["Create plugin", "Create app", "Create skill"]) {
      await expect
        .element(page.getByRole("menuitem", { name }))
        .not.toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.keyboard("{Escape}");

    // The plugin list gives up and says so, with Retry, instead of 「正在加载…」 forever.
    const pluginsUnavailable = dialog.getByText("The plugin list didn't load.", { exact: true });
    await expect.element(pluginsUnavailable, { timeout: 15_000 }).toBeVisible();
    expect(dialog.getByText("Loading…", { exact: true }).elements()).toHaveLength(0);
    const callsBeforeRetry = pluginCalls.length;
    await userEvent.click(dialog.getByRole("button", { name: "Retry", exact: true }));
    await expect.poll(() => pluginCalls.length).toBeGreaterThan(callsBeforeRetry);
    await expect.element(pluginsUnavailable, { timeout: 15_000 }).toBeVisible();

    await userEvent.click(page.getByTestId("plugin-manage-tab-skills"));
    await expect
      .element(dialog.getByText("The skill list didn't load.", { exact: true }), {
        timeout: 15_000,
      })
      .toBeVisible();
    expect(page.getByTestId("plugin-manage-tab-skills-loading").elements()).toHaveLength(0);

    // Create skill still opens its chat with the request, though the creator skill was
    // never listed.
    await userEvent.click(dialog.getByRole("button", { name: "Add", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Create skill" }));
    await expect.poll(() => settingsDialogStore.getState().isOpen).toBe(false);
    await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat");
    expect(draft).not.toBeNull();
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[draft!.threadId]?.prompt)
      .toBe("help me create a skill");
    expect(commands).toEqual([]);
  });
});
