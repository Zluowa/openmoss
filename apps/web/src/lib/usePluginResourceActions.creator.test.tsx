// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@moss/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resetComposerDraftStore } from "~/composerDraftStoreTestFixtures";
import { usePluginResourceActions } from "./usePluginResourceActions";

const dispatchDraftThread = vi.hoisted(() => vi.fn());
const ensureHomeChatProject = vi.hoisted(() => vi.fn());
const handleNewThread = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({ enableAssistantStreaming: false }));
const DEFAULT_INSTANCES = [{ instanceId: "codex", provider: "codex" }];
const providerInstances = vi.hoisted(() => ({
  current: [{ instanceId: "codex", provider: "codex" }] as Array<{
    instanceId: string;
    provider: string;
    newChatDefault?: true;
  }>,
}));

vi.mock("./draftThreadDispatch", () => ({
  dispatchDraftThread,
}));
vi.mock("./chatProjects", () => ({
  ensureHomeChatProject,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread }),
}));
vi.mock("~/appSettings", () => ({
  getProviderInstanceOptions: () => providerInstances.current,
  newChatProviderInstanceIdFrom: (
    instances: ReadonlyArray<{ instanceId: string; provider: string; newChatDefault?: true }>,
    provider: string,
  ) =>
    instances.find((instance) => instance.provider === provider && instance.newChatDefault)
      ?.instanceId,
  getProviderStartOptions: vi.fn(() => ({ codex: { binaryPath: "codex" } })),
  resolveAssistantDeliveryMode: (value: { enableAssistantStreaming: boolean }) =>
    value.enableAssistantStreaming ? "streaming" : "buffered",
  useAppSettings: () => ({ settings }),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

const CREATOR = {
  name: "plugin-creator",
  path: "/managed/plugin-creator/SKILL.md",
};

afterEach(() => {
  cleanup();
  resetComposerDraftStore();
  dispatchDraftThread.mockReset();
  ensureHomeChatProject.mockReset();
  handleNewThread.mockReset();
  localStorage.removeItem("moss-has-opened-plugin-creator-prefill-v1");
  localStorage.removeItem("moss-has-opened-skill-creator-prefill-v1");
  providerInstances.current = DEFAULT_INSTANCES;
});

describe("Account a request-only chat opens on", () => {
  it("keeps New chat's account (Moss while signed in), not the library's discovery login", async () => {
    // Settings' Plugins page discovers with the local Codex login; New chat uses Moss.
    providerInstances.current = [
      { instanceId: "codex", provider: "codex" },
      { instanceId: "codex_moss", provider: "codex", newChatDefault: true },
    ];
    ensureHomeChatProject.mockResolvedValue(ProjectId.makeUnsafe("home-chat"));
    registerDraftOnNewThread(ThreadId.makeUnsafe("lane-thread"));
    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: null,
        provider: "codex",
        instanceId: "codex",
        cwd: null,
      }),
    );
    await act(async () => {
      await result.current.createViaCreator("plugin", CREATOR, { prompt: "帮我创建一个插件" });
    });
    await act(async () => {
      await result.current.startChatWithPrompt("帮我做一个记账小应用");
    });
    expect(handleNewThread.mock.calls.map((call) => call[1])).toEqual([
      { provider: "codex", providerInstanceId: "codex_moss", fresh: true },
      { provider: "codex", providerInstanceId: "codex_moss", fresh: true },
    ]);
  });
});

function registerDraftOnNewThread(threadId: ThreadId) {
  handleNewThread.mockImplementation(async (id: ProjectId) => {
    useComposerDraftStore.getState().registerDraftThread(threadId, {
      projectId: id,
      envMode: "local",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    return threadId;
  });
}

describe("Creator chat project", () => {
  it("opens in a Home chat when no project is focused, never a project from the server folder", async () => {
    const home = ProjectId.makeUnsafe("home-chat");
    const threadId = ThreadId.makeUnsafe("creator-home-thread");
    ensureHomeChatProject.mockResolvedValue(home);
    registerDraftOnNewThread(threadId);
    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: null,
        provider: "codex",
        instanceId: "codex",
        // The server's own working folder (dev checkout / install folder).
        cwd: "C:/DevTemp/moss-wt/owner-dev",
      }),
    );

    let started = false;
    await act(async () => {
      started = await result.current.createViaCreator("plugin", CREATOR, {
        prompt: "帮我创建一个插件",
      });
    });

    expect(started).toBe(true);
    expect(ensureHomeChatProject).toHaveBeenCalledTimes(1);
    expect(handleNewThread).toHaveBeenCalledWith(home, {
      provider: "codex",
      providerInstanceId: "codex",
      fresh: true,
    });
  });

  it("uses the focused project when there is one", async () => {
    const projectId = ProjectId.makeUnsafe("focused-project");
    registerDraftOnNewThread(ThreadId.makeUnsafe("creator-project-thread"));
    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: projectId,
        provider: "codex",
        instanceId: "codex",
        cwd: "/repo/project",
      }),
    );
    await act(async () => {
      await result.current.createViaCreator("plugin", CREATOR);
    });
    expect(ensureHomeChatProject).not.toHaveBeenCalled();
    expect(handleNewThread.mock.calls[0]?.[0]).toBe(projectId);
  });

  it("seeds the skill creator with the localized first-use request", async () => {
    const threadId = ThreadId.makeUnsafe("skill-creator-thread");
    ensureHomeChatProject.mockResolvedValue(ProjectId.makeUnsafe("home-chat"));
    registerDraftOnNewThread(threadId);
    const skillCreator = { name: "skill-creator", path: "/managed/skill-creator/SKILL.md" };
    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: null,
        provider: "codex",
        instanceId: "codex",
        cwd: null,
      }),
    );
    await act(async () => {
      await result.current.createViaCreator("skill", skillCreator, {
        firstUsePrompt: "帮我创建一个技能",
      });
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "/skill-creator 帮我创建一个技能",
      skills: [skillCreator],
    });
  });
});

describe("explicit Creator dispatch", () => {
  it("fails closed before project or provider work for an unsafe workspace", async () => {
    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: ProjectId.makeUnsafe("project-creator"),
        provider: "codex",
        instanceId: "codex",
        cwd: "/repo/project",
      }),
    );

    await expect(
      result.current.createViaCreatorAndDispatch("plugin", CREATOR, {
        taskWorkspace: "relative/workspace",
      }),
    ).resolves.toBeNull();
    expect(ensureHomeChatProject).not.toHaveBeenCalled();
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(dispatchDraftThread).not.toHaveBeenCalled();
  });

  it("seeds the creator skill and dispatches into the explicit task workspace", async () => {
    const projectId = ProjectId.makeUnsafe("project-creator");
    const threadId = ThreadId.makeUnsafe("creator-thread");
    handleNewThread.mockImplementation(async (id: typeof projectId) => {
      useComposerDraftStore.getState().registerDraftThread(threadId, {
        projectId: id,
        envMode: "local",
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      return threadId;
    });
    dispatchDraftThread.mockResolvedValue({ kind: "dispatched" });

    const { result } = renderHook(() =>
      usePluginResourceActions({
        activeProjectId: projectId,
        provider: "codex",
        instanceId: "codex",
        cwd: "/repo/project",
      }),
    );

    let action!: Awaited<ReturnType<typeof result.current.createViaCreatorAndDispatch>>;
    await act(async () => {
      action = await result.current.createViaCreatorAndDispatch("plugin", CREATOR, {
        taskWorkspace: "/tmp/moss-creator-task",
        prompt: "Create the bounded test plugin now",
      });
    });

    expect(action).toEqual({ threadId, dispatch: { kind: "dispatched" } });
    expect(handleNewThread).toHaveBeenCalledWith(projectId, {
      provider: "codex",
      providerInstanceId: "codex",
      workingDirectory: "/tmp/moss-creator-task",
      envMode: "local",
      fresh: true,
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "/plugin-creator Create the bounded test plugin now",
      skills: [CREATOR],
    });
    expect(dispatchDraftThread).toHaveBeenCalledWith({
      threadId,
      projectId,
      thread: null,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
      providerOptions: { codex: { binaryPath: "codex" } },
      providerInstances: [{ instanceId: "codex", provider: "codex" }],
    });
  });
});
