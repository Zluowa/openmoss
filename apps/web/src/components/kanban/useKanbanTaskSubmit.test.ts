// FILE: useKanbanTaskSubmit.test.ts
// Purpose: Locks new-task draft-vs-start routing, ordering, and honest fallbacks.
// Layer: Kanban UI hook unit tests

import { ProjectId, ThreadId, type ServerProviderStatus } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
  }

  let slots: HookSlot[] = [];
  let cursor = 0;
  const events: string[] = [];

  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };

  return {
    events,
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
      events.length = 0;
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T) {
      return callback;
    },
    useRef<T>(initialValue: T) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value = { current: initialValue };
      }
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value = initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const resolved =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
        slot.value = resolved;
        events.push(`isCreating:${String(resolved)}`);
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastAdd: vi.fn(),
  refreshProviderStatuses: vi.fn(),
  createKanbanDraftTask: vi.fn(),
  createAndSendKanbanTask: vi.fn(),
  resolveProviderSendAvailabilityWithRefresh: vi.fn(),
  draftsByThreadId: {} as Record<string, unknown>,
}));
const localization = vi.hoisted(() => ({ locale: "en" as "en" | "zh-CN" }));
const translations = vi.hoisted(
  () =>
    ({
      en: {
        "kanban.newTask.saveDraftFailed": "Couldn't save the draft",
        "kanban.newTask.startFailed": "Couldn't start the task",
        "kanban.newTask.toast.addedToDrafts": "Task added to Drafts",
        "kanban.newTask.toast.started": "Task started",
        "kanban.newTask.toast.finishInChat": "Finish this task in the chat",
        "kanban.newTask.toast.worktreePending":
          "Worktree setup stays on the normal composer send path.",
        "kanban.newTask.toast.savedAsDraft": "The task was saved as a draft.",
        "kanban.newTask.toast.savedToDraftsFallback":
          "The task was saved to Drafts instead. Open it to send manually.",
        "kanban.newTask.toast.unexpectedError": "Unexpected error.",
        "kanban.newTask.toast.retry": "Please try again.",
        "provider.send.blocked.disabled": "This provider is disabled in Moss settings.",
        "provider.send.blocked.unauthenticated":
          "{provider} is not signed in. Open provider settings to sign in.",
        "provider.send.blocked.unavailable": "{provider} is unavailable right now.",
        "provider.send.blocked.statusLoading": "Provider status is still loading.",
        "provider.send.blocked.statusTimeout":
          "Provider status check timed out. Choose another available provider or try again.",
      },
      "zh-CN": {
        "kanban.newTask.saveDraftFailed": "无法保存草稿",
        "kanban.newTask.startFailed": "无法启动任务",
        "kanban.newTask.toast.addedToDrafts": "任务已添加到草稿",
        "kanban.newTask.toast.started": "任务已启动",
        "kanban.newTask.toast.finishInChat": "请在对话中完成此任务",
        "kanban.newTask.toast.worktreePending": "请继续通过常规消息输入框发送，以完成工作树设置。",
        "kanban.newTask.toast.savedAsDraft": "任务已存为草稿。",
        "kanban.newTask.toast.savedToDraftsFallback": "任务已改存到草稿。请打开后手动发送。",
        "kanban.newTask.toast.unexpectedError": "发生意外错误。",
        "kanban.newTask.toast.retry": "请重试。",
        "provider.send.blocked.disabled": "此服务商已在 Moss 设置中禁用。",
        "provider.send.blocked.unauthenticated": "{provider} 尚未登录。请打开服务商设置并登录。",
        "provider.send.blocked.unavailable": "{provider} 当前不可用。",
        "provider.send.blocked.statusLoading": "服务商状态仍在加载中。",
        "provider.send.blocked.statusTimeout": "服务商状态检查超时。请选择其他可用服务商或重试。",
      },
    }) as const,
);

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}));

vi.mock("~/localization", () => ({
  translateMoss: (locale: keyof typeof translations, key: keyof (typeof translations)["en"]) =>
    translations[locale][key],
  formatMossTranslation: (
    locale: keyof typeof translations,
    key: keyof (typeof translations)["en"],
    values: Record<string, string | number>,
  ) =>
    translations[locale][key].replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
      const value = values[name];
      return value == null ? match : String(value);
    }),
  useTranslation: () => ({
    locale: localization.locale,
    t: (key: keyof (typeof translations)["en"]) => translations[localization.locale][key],
  }),
}));

vi.mock("~/composerDraftStore", () => ({
  providerInstanceModelSelectionKey: (provider: string, instanceId: string) =>
    `${provider}:${instanceId}`,
  useComposerDraftStore: {
    getState: () => ({ draftsByThreadId: mocks.draftsByThreadId }),
  },
}));

vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => mocks.refreshProviderStatuses,
}));

vi.mock("~/lib/kanbanTaskCreate", () => ({
  createKanbanDraftTask: mocks.createKanbanDraftTask,
  createAndSendKanbanTask: mocks.createAndSendKanbanTask,
}));

vi.mock("~/lib/providerAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/providerAvailability")>()),
  resolveProviderSendAvailabilityWithRefresh: mocks.resolveProviderSendAvailabilityWithRefresh,
}));

import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const SCRATCH_THREAD_ID = ThreadId.makeUnsafe("scratch-thread");
const CREATED_THREAD_ID = ThreadId.makeUnsafe("created-thread");

function createInput(sendAsDraft: boolean) {
  const providerStatuses: ServerProviderStatus[] = [];
  return {
    selectedProjectId: PROJECT_ID,
    hasSendableContent: true,
    selectedProvider: "codex" as const,
    selectedProviderInstanceId: "codex",
    selectedModel: "gpt-5.3-codex",
    selectedModelSupportsAutoMode: undefined,
    taskPreview: "Ship the disclosure fix",
    trimmedPrompt: "Ship the disclosure fix",
    scratchThreadId: SCRATCH_THREAD_ID,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    envMode: "local" as const,
    sendAsDraft,
    defaultProvider: "codex" as const,
    assistantDeliveryMode: "streaming" as const,
    providerOptionsForDispatch: undefined,
    providerInstances: [{ instanceId: "codex", provider: "codex" as const }],
    providerStatuses,
    isPreparingImages: false,
    waitForPendingImages: vi.fn(async () => {
      reactHarness.events.push("wait-for-images");
    }),
    onOpenChange: vi.fn((open: boolean) => {
      reactHarness.events.push(`open:${String(open)}`);
    }),
  };
}

function render(input: ReturnType<typeof createInput>) {
  reactHarness.beginRender();
  return useKanbanTaskSubmit(input);
}

beforeEach(() => {
  reactHarness.reset();
  localization.locale = "en";
  mocks.navigate.mockReset().mockImplementation(() => {
    reactHarness.events.push("navigate");
  });
  mocks.toastAdd.mockReset().mockImplementation((toast: { title: string }) => {
    reactHarness.events.push(`toast:${toast.title}`);
  });
  mocks.refreshProviderStatuses.mockReset();
  mocks.createKanbanDraftTask.mockReset().mockImplementation(() => {
    reactHarness.events.push("save-draft");
    return CREATED_THREAD_ID;
  });
  mocks.createAndSendKanbanTask.mockReset().mockImplementation(async () => {
    reactHarness.events.push("dispatch");
    return { threadId: CREATED_THREAD_ID, result: { kind: "dispatched" as const } };
  });
  mocks.resolveProviderSendAvailabilityWithRefresh.mockReset().mockImplementation(async () => {
    reactHarness.events.push("check-availability");
    return {
      provider: "codex" as const,
      status: null,
      usable: true,
      unavailableReason: "Provider unavailable",
    };
  });
  mocks.draftsByThreadId = {};
});

describe("useKanbanTaskSubmit", () => {
  it("saves Draft-mode tasks without checking availability or dispatching", async () => {
    const input = createInput(true);
    const result = render(input);

    await result.handleCreate();

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images",
      "save-draft",
      "toast:Task added to Drafts",
      "isCreating:false",
      "open:false",
    ]);
    expect(mocks.createKanbanDraftTask).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProviderSendAvailabilityWithRefresh).not.toHaveBeenCalled();
    expect(mocks.createAndSendKanbanTask).not.toHaveBeenCalled();
    expect(render(input).isCreating).toBe(false);
  });

  it("localizes Draft and immediate-start success toasts in zh-CN", async () => {
    localization.locale = "zh-CN";
    const draftInput = createInput(true);

    await render(draftInput).handleCreate();

    expect(mocks.toastAdd).toHaveBeenLastCalledWith({
      type: "success",
      title: "任务已添加到草稿",
      description: "Ship the disclosure fix",
    });

    mocks.toastAdd.mockClear();
    const startInput = createInput(false);
    await render(startInput).handleCreate();

    expect(mocks.toastAdd).toHaveBeenLastCalledWith({
      type: "success",
      title: "任务已启动",
      description: "Ship the disclosure fix",
    });
  });

  it("checks availability, enters loading state, and dispatches when Draft mode is off", async () => {
    const input = createInput(false);
    const result = render(input);

    await result.handleCreate();
    await vi.waitFor(() => expect(input.onOpenChange).toHaveBeenCalledWith(false));

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images",
      "check-availability",
      "dispatch",
      "toast:Task started",
      "isCreating:false",
      "open:false",
    ]);
    expect(mocks.createKanbanDraftTask).not.toHaveBeenCalled();
    expect(mocks.createAndSendKanbanTask).toHaveBeenCalledTimes(1);
    expect(render(input).isCreating).toBe(false);
  });

  it("keeps the dialog open and skips dispatch when the provider is unavailable", async () => {
    mocks.resolveProviderSendAvailabilityWithRefresh.mockImplementation(async () => {
      reactHarness.events.push("check-availability");
      return {
        provider: "codex" as const,
        status: null,
        usable: false,
        unavailableReason: "Codex is not authenticated yet.",
      };
    });
    const input = createInput(false);
    const result = render(input);

    await result.handleCreate();

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images",
      "check-availability",
      "toast:Provider status is still loading.",
      "isCreating:false",
    ]);
    expect(mocks.createKanbanDraftTask).not.toHaveBeenCalled();
    expect(mocks.createAndSendKanbanTask).not.toHaveBeenCalled();
    expect(input.onOpenChange).not.toHaveBeenCalled();
    expect(render(input).isCreating).toBe(false);
  });

  it("preserves the worktree fallback by closing and opening the created chat", async () => {
    mocks.createAndSendKanbanTask.mockImplementation(async () => {
      reactHarness.events.push("dispatch");
      return {
        threadId: CREATED_THREAD_ID,
        result: { kind: "open-thread" as const, reason: "worktree-pending" as const },
      };
    });
    const input = createInput(false);
    const result = render(input);

    await result.handleCreate();
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledTimes(1));

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images",
      "check-availability",
      "dispatch",
      "toast:Finish this task in the chat",
      "isCreating:false",
      "open:false",
      "navigate",
    ]);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: CREATED_THREAD_ID },
    });
  });

  it("localizes the worktree open-thread fallback in zh-CN", async () => {
    localization.locale = "zh-CN";
    mocks.createAndSendKanbanTask.mockResolvedValue({
      threadId: CREATED_THREAD_ID,
      result: { kind: "open-thread" as const, reason: "worktree-pending" as const },
    });
    const input = createInput(false);

    await render(input).handleCreate();

    expect(mocks.toastAdd).toHaveBeenLastCalledWith({
      type: "info",
      title: "请在对话中完成此任务",
      description: "请继续通过常规消息输入框发送，以完成工作树设置。",
    });
  });

  it("does not expose dispatch-result diagnostics when the created task falls back to Drafts", async () => {
    mocks.createAndSendKanbanTask.mockResolvedValue({
      threadId: CREATED_THREAD_ID,
      result: {
        kind: "error" as const,
        message: "EPERM: operation not permitted, open 'C:\\Users\\alice\\.codex\\state.json'",
      },
    });
    const input = createInput(false);

    await render(input).handleCreate();

    expect(mocks.toastAdd).toHaveBeenLastCalledWith({
      type: "error",
      title: "Couldn't start the task",
      description: "The task was saved to Drafts instead. Open it to send manually.",
    });
    const renderedToasts = JSON.stringify(mocks.toastAdd.mock.calls);
    expect(renderedToasts).not.toContain("EPERM");
    expect(renderedToasts).not.toContain("alice");
    expect(renderedToasts).not.toContain("state.json");
    expect(input.onOpenChange).not.toHaveBeenCalled();
    expect(render(input).isCreating).toBe(false);
  });

  it("recovers from image preparation rejection and allows the same dialog to retry", async () => {
    const input = createInput(true);
    input.waitForPendingImages
      .mockRejectedValueOnce(
        new Error("EPERM: operation not permitted, open 'C:\\Users\\alice\\image.png'"),
      )
      .mockImplementationOnce(async () => {
        reactHarness.events.push("wait-for-images:retry");
      });
    const firstResult = render(input);

    await firstResult.handleCreate();

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "toast:Couldn't save the draft",
      "isCreating:false",
    ]);
    expect(mocks.createKanbanDraftTask).not.toHaveBeenCalled();
    expect(mocks.resolveProviderSendAvailabilityWithRefresh).not.toHaveBeenCalled();
    expect(mocks.createAndSendKanbanTask).not.toHaveBeenCalled();
    expect(input.onOpenChange).not.toHaveBeenCalled();
    expect(input.waitForPendingImages).toHaveBeenCalledTimes(1);
    expect(mocks.toastAdd).toHaveBeenNthCalledWith(1, {
      type: "error",
      title: "Couldn't save the draft",
      description: "Please try again.",
    });
    const renderedToasts = JSON.stringify(mocks.toastAdd.mock.calls);
    expect(renderedToasts).not.toContain("EPERM");
    expect(renderedToasts).not.toContain("alice");
    expect(renderedToasts).not.toContain("image.png");
    expect(render(input).isCreating).toBe(false);
    expect(render(input).canCreate).toBe(true);

    reactHarness.events.length = 0;
    await render(input).handleCreate();

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images:retry",
      "save-draft",
      "toast:Task added to Drafts",
      "isCreating:false",
      "open:false",
    ]);
    expect(input.waitForPendingImages).toHaveBeenCalledTimes(2);
    expect(mocks.createKanbanDraftTask).toHaveBeenCalledTimes(1);
    expect(mocks.createAndSendKanbanTask).not.toHaveBeenCalled();
  });

  it("blocks and localizes a durable managed-provider error without leaking paths", async () => {
    localization.locale = "zh-CN";
    const { resolveProviderSendAvailabilityWithRefresh } = await vi.importActual<
      typeof import("~/lib/providerAvailability")
    >("~/lib/providerAvailability");
    mocks.resolveProviderSendAvailabilityWithRefresh.mockImplementation(
      resolveProviderSendAvailabilityWithRefresh,
    );
    const durableError: ServerProviderStatus = {
      provider: "codex",
      instanceId: "codex_moss",
      driver: "codex",
      displayName: "Moss",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt: "2026-08-12T00:00:00.000Z",
      message: "EPERM: operation not permitted, open 'C:\\Users\\alice\\.codex\\state.json'",
    };
    const input = {
      ...createInput(false),
      selectedProviderInstanceId: "codex_moss",
      providerInstances: [{ instanceId: "codex_moss", provider: "codex" as const }],
      providerStatuses: [durableError],
    };

    await render(input).handleCreate();

    expect(reactHarness.events).toEqual([
      "isCreating:true",
      "wait-for-images",
      "toast:Moss 当前不可用。",
      "isCreating:false",
    ]);
    const renderedToasts = JSON.stringify(mocks.toastAdd.mock.calls);
    expect(renderedToasts).not.toContain("EPERM");
    expect(renderedToasts).not.toContain("alice");
    expect(renderedToasts).not.toContain("state.json");
    expect(mocks.refreshProviderStatuses).not.toHaveBeenCalled();
    expect(mocks.createKanbanDraftTask).not.toHaveBeenCalled();
    expect(mocks.createAndSendKanbanTask).not.toHaveBeenCalled();
    expect(input.onOpenChange).not.toHaveBeenCalled();
    expect(render(input).isCreating).toBe(false);
  });
});
