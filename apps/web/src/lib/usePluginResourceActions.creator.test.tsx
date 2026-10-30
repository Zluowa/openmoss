// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { resetComposerDraftStore } from "~/composerDraftStoreTestFixtures";
import { usePluginResourceActions } from "./usePluginResourceActions";

const dispatchDraftThread = vi.hoisted(() => vi.fn());
const ensureProjectId = vi.hoisted(() => vi.fn());
const handleNewThread = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({ enableAssistantStreaming: false }));

vi.mock("./draftThreadDispatch", () => ({
  dispatchDraftThread,
}));
vi.mock("./ensureProjectId", () => ({
  ensureProjectId,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread }),
}));
vi.mock("~/appSettings", () => ({
  getProviderInstanceOptions: () => [{ instanceId: "codex", provider: "codex" }],
  getProviderStartOptions: vi.fn(() => ({ codex: { binaryPath: "codex" } })),
  resolveAssistantDeliveryMode: (value: { enableAssistantStreaming: boolean }) =>
    value.enableAssistantStreaming ? "streaming" : "buffered",
  resolveNewConversationDefaultModelSelection: () => ({
    provider: "codex",
    instanceId: "codex",
    model: "gpt-5.6-sol",
  }),
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
  ensureProjectId.mockReset();
  handleNewThread.mockReset();
  localStorage.removeItem("moss-has-opened-plugin-creator-prefill-v1");
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
    expect(ensureProjectId).not.toHaveBeenCalled();
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(dispatchDraftThread).not.toHaveBeenCalled();
  });

  it("seeds the creator skill and dispatches into the explicit task workspace", async () => {
    const projectId = ProjectId.makeUnsafe("project-creator");
    const threadId = ThreadId.makeUnsafe("creator-thread");
    ensureProjectId.mockResolvedValue(projectId);
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
