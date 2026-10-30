// Exercises the bundled creator entry through real navigation and composer state.
import "../index.css";
import "./PluginLibrary.css";

import {
  ProjectId,
  ThreadId,
  type NativeApi,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSelectableProviderInstanceId } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { createDraftThread } from "~/lib/draftThreadCreate";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { draftNavigationSlotKey, runDraftNavigationOnce } from "~/lib/stagedDraftNavigation";
import { useStore } from "~/store";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
} from "~/test/browserHarness";
import { mountGeneratedPluginApp } from "~/test/generatedPluginLibraryBrowserHarness";
import { PluginLibraryNativeFixture } from "~/test/pluginLibraryBrowserHarness";

const PROJECT_ID = ProjectId.makeUnsafe("creator-workspace");
const NOW = "2026-10-10T00:00:00.000Z";
const CREATOR = {
  name: "moss-plugin-creator:plugin-creator",
  path: "/fixture/managed-codex/plugins/moss-plugin-creator/skills/plugin-creator/SKILL.md",
};
// The Skills page lists standalone skills only (a plugin's skills live on its
// page, as in Codex), so its Try now runs through a skill of the user's own.
const STANDALONE_SKILL = {
  name: "plugin-checklist",
  path: "/fixture/managed-codex/skills/plugin-checklist/SKILL.md",
};
const CREATOR_DOCUMENT = {
  contents: `---
name: plugin-creator
description: Create and validate a native plugin in the workspace.
---

# Moss Plugin Creator

Read the repository instructions and preserve existing work. Create the plugin's
.codex-plugin/plugin.json, skills/<skill-name>/SKILL.md, and README.md in the workspace.
Validate the plugin manifest and referenced skill files before installing it through
the native plugin catalog. Verify skill discovery after installation; writing files
alone does not complete installation.
`,
} satisfies Awaited<ReturnType<NativeApi["provider"]["readSkill"]>>;
const FIRST_USE_KEY = "moss-has-opened-plugin-creator-prefill-v1";
const ACCOUNT_B = "codex_work";
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  spaces: [],
  projects: [
    {
      id: PROJECT_ID,
      kind: "project",
      title: "Creator workspace",
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
  await mounted?.cleanup();
  mounted = undefined;
  vi.restoreAllMocks();
});

async function mountCreator(
  discovered = true,
  disabled = false,
  accountB?: { enabled: boolean; removed?: boolean },
) {
  await page.viewport(1280, 900);
  const fixture = new PluginLibraryNativeFixture();
  fixture.serverSettings = { ...fixture.serverSettings, onboardingCompletedAt: NOW };
  if (accountB) {
    fixture.serverSettings = {
      ...fixture.serverSettings,
      providerInstances: {
        ...fixture.serverSettings.providerInstances,
        codex: { driver: "codex", enabled: true, config: {} },
        [ACCOUNT_B]: {
          driver: "codex",
          enabled: accountB.enabled,
          config: { homePath: "/fixture/work-codex" },
        },
      },
    };
    if (accountB.removed) {
      fixture.serverSettings = {
        ...fixture.serverSettings,
        providerInstances: Object.fromEntries(
          Object.entries(fixture.serverSettings.providerInstances).filter(
            ([instanceId]) => instanceId !== ACCOUNT_B,
          ),
        ),
      };
    }
  }
  const currentSnapshot: OrchestrationShellSnapshot = accountB
    ? {
        ...snapshot,
        projects: snapshot.projects.map((project) => ({
          ...project,
          defaultModelSelection: {
            provider: "codex",
            instanceId: ACCOUNT_B,
            model: "gpt-5.6-sol",
          },
        })),
      }
    : snapshot;
  if (disabled)
    fixture.serverSettings = {
      ...fixture.serverSettings,
      skills: { ...fixture.serverSettings.skills, disabled: [CREATOR.name] },
    };
  if (discovered)
    fixture.discoveredSkills.push(
      {
        ...CREATOR,
        description: "Create and validate a native plugin in the workspace.",
        enabled: true,
        scope: "system",
        interface: { displayName: "Plugin Creator", shortDescription: "Create a plugin" },
      },
      {
        ...STANDALONE_SKILL,
        description: "Check a plugin before installing it.",
        enabled: true,
        scope: "user",
        interface: { displayName: "Plugin Checklist", shortDescription: "Check a plugin" },
      },
    );
  const commands: Array<Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]> = [];
  const skillCalls: Array<Parameters<NativeApi["provider"]["listSkills"]>[0]> = [];
  const readSkillCalls: Array<Parameters<NativeApi["provider"]["readSkill"]>[0]> = [];
  mounted = await mountGeneratedPluginApp({
    fixture,
    freshUser: true,
    initialEntries: ["/skills"],
    configureNativeApi(api) {
      const config = createBrowserTestServerConfig(NOW);
      acknowledgeStartupAnnouncementsForTest(config);
      api.server.getConfig = async () => config;
      const listSkills = api.provider.listSkills;
      api.provider.listSkills = async (input) => {
        skillCalls.push(input);
        return listSkills(input);
      };
      api.provider.readSkill = async (input) => {
        readSkillCalls.push(input);
        if (
          input.provider !== "codex" ||
          input.instanceId !== (accountB ? ACCOUNT_B : "codex") ||
          input.cwd !== "/repo/project" ||
          !fixture.discoveredSkills.some(
            (skill) => skill.name === input.name && skill.path === input.path,
          ) ||
          (input.path !== CREATOR.path && input.path !== STANDALONE_SKILL.path)
        ) {
          throw new Error("Skill is outside this fixture account's discovered catalog.");
        }
        return CREATOR_DOCUMENT;
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
      api.orchestration.getShellSnapshot = async () => currentSnapshot;
      const shellListeners = new Set<Parameters<NativeApi["orchestration"]["onShellEvent"]>[0]>();
      api.orchestration.onShellEvent = (listener) => {
        shellListeners.add(listener);
        return () => {
          shellListeners.delete(listener);
        };
      };
      api.orchestration.subscribeShell = async () => {
        for (const listener of shellListeners) {
          listener({ kind: "snapshot", snapshot: currentSnapshot });
        }
      };
      api.orchestration.getSnapshot = async () => ({
        snapshotSequence: currentSnapshot.snapshotSequence,
        spaces: currentSnapshot.spaces.map((space) => ({ ...space, deletedAt: null })),
        projects: currentSnapshot.projects.map((project) => ({ ...project, deletedAt: null })),
        threads: [],
        updatedAt: currentSnapshot.updatedAt,
      });
      api.orchestration.dispatchCommand = async (command) => {
        commands.push(command);
        throw new Error("Creator entry must remain an unsent draft; no agent turn is allowed.");
      };
    },
  });
  await expect.poll(() => useStore.getState().threadsHydrated).toBe(true);
  await expect
    .element(page.getByRole("button", { name: "GitHub", exact: true }).first())
    .toBeInTheDocument();
  return { commands, fixture, skillCalls, readSkillCalls, app: mounted };
}

async function openCreator() {
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  await userEvent.click(page.getByText("Create plugin", { exact: true }));
  await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
  const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat");
  expect(draft).not.toBeNull();
  return draft!;
}

describe("bundled Plugin Creator entry", () => {
  it.each(["creator", "try-now"] as const)(
    "keeps account B from skill discovery in the fresh %s draft when account A is default",
    async (entry) => {
      const { app, commands, fixture, skillCalls, readSkillCalls } = await mountCreator(
        true,
        false,
        {
          enabled: true,
        },
      );
      expect(
        resolveSelectableProviderInstanceId(
          {
            codexAccounts: [],
            codexHomePath: "",
            selectedCodexAccountId: "default",
            providerInstances: fixture.serverSettings.providerInstances,
          },
          "codex",
        ),
      ).toBe("codex");
      if (entry === "creator") {
        await openCreator();
      } else {
        await userEvent.click(
          page
            .getByRole("navigation", { name: "Customize", exact: true })
            .getByRole("button", { name: "Skills", exact: true }),
        );
        await userEvent.click(
          page
            .getByTestId("skills-installed-grid")
            .getByRole("button", { name: "Plugin Checklist", exact: true })
            .first(),
        );
        await expect
          .element(page.getByTestId("skill-detail-body"))
          .toHaveTextContent("Validate the plugin manifest and referenced skill files");
        expect(readSkillCalls).toContainEqual({
          provider: "codex",
          instanceId: ACCOUNT_B,
          cwd: "/repo/project",
          name: STANDALONE_SKILL.name,
          path: STANDALONE_SKILL.path,
        });
        await userEvent.click(page.getByTestId("skill-detail-try-now"));
        await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      }
      const draft = useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat");
      expect(draft).not.toBeNull();
      await expect.poll(() => app.router.state.location.pathname).toBe(`/${draft!.threadId}`);
      await expect
        .poll(
          () => useComposerDraftStore.getState().draftsByThreadId[draft!.threadId]?.activeProvider,
        )
        .toBe(ACCOUNT_B);
      const composer = useComposerDraftStore.getState().draftsByThreadId[draft!.threadId]!;
      expect(composer.modelSelectionByProvider[ACCOUNT_B]).toMatchObject({
        provider: "codex",
        instanceId: ACCOUNT_B,
      });
      expect(composer.skills).toEqual([entry === "creator" ? CREATOR : STANDALONE_SKILL]);
      expect(
        skillCalls.some((input) => input.provider === "codex" && input.instanceId === ACCOUNT_B),
      ).toBe(true);
      expect(commands).toEqual([]);
    },
  );

  it.each(["disabled", "removed"] as const)(
    "rejects an explicitly %s account B before registering a Creator draft",
    async (availability) => {
      const { app, commands } = await mountCreator(true, false, {
        enabled: availability !== "disabled",
        removed: availability === "removed",
      });
      const addToast = vi.spyOn(toastManager, "add");
      await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
      await userEvent.click(page.getByText("Create plugin", { exact: true }));
      await expect
        .poll(() => addToast.mock.calls.some(([toast]) => toast.type === "error"))
        .toBe(true);
      expect(app.router.state.location.pathname).toBe("/skills");
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat"),
      ).toBeNull();
      expect(useComposerDraftStore.getState().draftThreadsByThreadId).toEqual({});
      expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
      expect(commands).toEqual([]);
    },
  );

  it("rejects a disabled default account B when every Codex account is disabled", async () => {
    const { app, commands } = await mountCreator(true, false, { enabled: true });
    const addToast = vi.spyOn(toastManager, "add");
    await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
    const action = page.getByText("Create plugin", { exact: true }).element() as HTMLElement;
    const queryClient = app.router.options.context.queryClient;
    const settingsKey = serverSettingsQueryOptions().queryKey;
    const currentSettings = queryClient.getQueryData(settingsKey)!;
    const unavailableSettings = {
      ...currentSettings,
      providers: {
        ...currentSettings.providers,
        codex: {
          ...currentSettings.providers.codex,
          accounts: [
            { id: "work", label: "Work", homePath: "/fixture/work-codex", shadowHomePath: "" },
          ],
          selectedAccountId: "work",
        },
      },
      providerInstances: {
        ...currentSettings.providerInstances,
        codex: { driver: "codex", enabled: false, config: {} },
        [ACCOUNT_B]: { driver: "codex", enabled: false, config: {} },
      },
    };
    // The selectable resolver retains its default ID even when that ID is disabled.
    expect(
      resolveSelectableProviderInstanceId(
        {
          codexAccounts: unavailableSettings.providers.codex.accounts,
          codexHomePath: unavailableSettings.providers.codex.homePath,
          selectedCodexAccountId: unavailableSettings.providers.codex.selectedAccountId,
          providerInstances: unavailableSettings.providerInstances,
        },
        "codex",
        ACCOUNT_B,
      ),
    ).toBe(ACCOUNT_B);
    queryClient.setQueryData(settingsKey, unavailableSettings);
    // Exercise the already rendered action before a settings re-render replaces its callback.
    action.click();
    await expect
      .poll(() => addToast.mock.calls.some(([toast]) => toast.type === "error"))
      .toBe(true);
    expect(app.router.state.location.pathname).toBe("/skills");
    expect(useComposerDraftStore.getState().draftThreadsByThreadId).toEqual({});
    expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
    expect(commands).toEqual([]);
  });

  it("rolls back account B if it becomes disabled while draft navigation is settling", async () => {
    const { app, commands } = await mountCreator(true, false, { enabled: true });
    const addToast = vi.spyOn(toastManager, "add");
    let releaseNavigation!: () => void;
    const navigationHeld = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    let destinationReached = false;
    const navigate = app.router.navigate;
    const navigateSpy = vi.spyOn(app.router, "navigate").mockImplementation(async (options) => {
      await navigate(options);
      if (options.to === "/$threadId") {
        destinationReached = true;
        await navigationHeld;
      }
    });
    try {
      await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
      await userEvent.click(page.getByText("Create plugin", { exact: true }));
      await expect.poll(() => destinationReached).toBe(true);
      const [draftId] = Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId);
      expect(draftId).toBeDefined();
      const threadId = ThreadId.makeUnsafe(draftId!);
      expect(app.router.state.location.pathname).toBe(`/${threadId}`);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]!.activeProvider).toBe(
        ACCOUNT_B,
      );
      const queryClient = app.router.options.context.queryClient;
      const settingsKey = serverSettingsQueryOptions().queryKey;
      queryClient.setQueryData(settingsKey, (settings) => ({
        ...settings!,
        providerInstances: {
          ...settings!.providerInstances,
          [ACCOUNT_B]: {
            ...settings!.providerInstances[ACCOUNT_B]!,
            enabled: false,
          },
        },
      }));
      releaseNavigation();
      await expect
        .poll(() => addToast.mock.calls.some(([toast]) => toast.type === "error"))
        .toBe(true);
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat"),
      ).toBeNull();
      expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
      expect(commands).toEqual([]);
    } finally {
      releaseNavigation();
      navigateSpy.mockRestore();
    }
  });

  it("does not prefill account B into account A's coalesced project draft", async () => {
    const { commands } = await mountCreator(true, false, { enabled: true });
    const addToast = vi.spyOn(toastManager, "add");
    const accountAThreadId = createDraftThread({
      projectId: PROJECT_ID,
      prompt: "Keep account A's unsent work",
      modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
    });
    useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT_ID, accountAThreadId);
    const accountADraft = useComposerDraftStore.getState().draftsByThreadId[accountAThreadId];
    let releaseAccountA!: () => void;
    const accountAHeld = new Promise<void>((resolve) => {
      releaseAccountA = resolve;
    });
    const accountAOperation = runDraftNavigationOnce(
      draftNavigationSlotKey(PROJECT_ID, "chat"),
      async () => {
        await accountAHeld;
        return accountAThreadId;
      },
    );
    try {
      await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
      await userEvent.click(page.getByText("Create plugin", { exact: true }));
      releaseAccountA();
      await expect(accountAOperation).resolves.toBe(accountAThreadId);
      await expect
        .poll(() => addToast.mock.calls.some(([toast]) => toast.type === "error"))
        .toBe(true);
      expect(useComposerDraftStore.getState().getDraftThread(accountAThreadId)).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[accountAThreadId]).toEqual(
        accountADraft,
      );
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toEqual([
        accountAThreadId,
      ]);
      expect(
        useComposerDraftStore.getState().getDraftThreadByProjectId(PROJECT_ID, "chat")?.threadId,
      ).toBe(accountAThreadId);
      expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
      expect(commands).toEqual([]);
    } finally {
      releaseAccountA();
      await accountAOperation;
    }
  });

  it("opens a fresh chat with the namespaced skill and Codex's request every time, keeping its reference through composer edits", async () => {
    const { app, commands } = await mountCreator();
    const first = await openCreator();
    await expect.poll(() => app.router.state.location.pathname).toBe(`/${first.threadId}`);
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[first.threadId]?.activeProvider)
      .toBe("codex");
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[first.threadId]?.skills)
      .toEqual([CREATOR]);
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[first.threadId]?.prompt)
      .toBe("/moss-plugin-creator:plugin-creator help me create a plugin");
    const editor = page.getByTestId("composer-editor");
    await expect.element(editor).toHaveTextContent("help me create a plugin");
    expect(editor.element().querySelector('[contenteditable="false"]')).toHaveTextContent(
      /Plugin Creator/i,
    );

    // A real editor change runs the reference reconciliation that previously
    // dropped skills when callers supplied a reference without its chip token.
    await userEvent.click(editor);
    await userEvent.keyboard("{End} for release notes");
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[first.threadId]?.prompt)
      .toContain("for release notes");
    expect(useComposerDraftStore.getState().draftsByThreadId[first.threadId]?.skills).toEqual([
      CREATOR,
    ]);
    // Codex's Create plugin always asks for a plugin; no first-use state is kept.
    expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();

    await app.router.navigate({ to: "/skills" });
    await expect
      .element(page.getByRole("button", { name: "Add", exact: true }))
      .toBeInTheDocument();
    const second = await openCreator();
    expect(second.threadId).not.toBe(first.threadId);
    await expect.poll(() => app.router.state.location.pathname).toBe(`/${second.threadId}`);
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[second.threadId]?.skills)
      .toEqual([CREATOR]);
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[second.threadId]?.prompt)
      .toBe("/moss-plugin-creator:plugin-creator help me create a plugin");
    await expect
      .element(page.getByTestId("composer-editor"))
      .toHaveTextContent("help me create a plugin");
    expect(commands).toEqual([]);
  });

  it("does not offer an unavailable creator as a working action", async () => {
    const { app, commands } = await mountCreator(false);
    await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
    const action = page.getByText("Create plugin", { exact: true });
    await expect.element(action).toBeInTheDocument();
    expect(action.element().closest('[role="menuitem"]')).toHaveAttribute("aria-disabled", "true");
    expect(app.router.state.location.pathname).toBe("/skills");
    expect(commands).toEqual([]);
    expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
  });

  it("does not offer a disabled creator as a working action", async () => {
    const { app, commands } = await mountCreator(true, true);
    await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
    const action = page.getByText("Create plugin", { exact: true });
    await expect.element(action).toBeInTheDocument();
    expect(action.element().closest('[role="menuitem"]')).toHaveAttribute("aria-disabled", "true");
    expect(app.router.state.location.pathname).toBe("/skills");
    expect(commands).toEqual([]);
    expect(localStorage.getItem(FIRST_USE_KEY)).toBeNull();
  });
});
