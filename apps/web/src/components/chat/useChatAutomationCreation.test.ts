import {
  AutomationDefinition,
  ProjectId,
  ThreadId,
  WsRpcError,
  type AutomationCreateInput,
} from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  dispatch: vi.fn(),
  toast: vi.fn(),
  promote: vi.fn(),
  notes: vi.fn(),
  identity: "account-a",
}));
vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);
vi.mock("../../routes/-automations.shared", async () => ({
  ...(await import("../../lib/automationForm")),
  automationQueryKey: ["automations"],
}));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => {
    const identity = mocks.identity;
    return {
      identityKey: identity,
      isCurrent: () => mocks.identity === identity,
      transitioning: false,
    };
  },
}));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    automation: { create: mocks.create },
    orchestration: { dispatchCommand: mocks.dispatch },
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/projectInstructionsStore", () => ({
  useProjectInstructionsStore: {
    getState: () => ({ instructionsByProjectId: { "project-a": "Shared instructions" } }),
  },
  mergeProjectInstructionsIntoThreadNotes: () => "Shared instructions",
}));
vi.mock("~/pinnedMessages", () => ({ dispatchThreadNotes: mocks.notes }));
vi.mock("~/lib/threadCreatePromotion", () => ({ promoteThreadCreate: mocks.promote }));

import { formFromAutomationDraft } from "../../lib/automationForm";
import { reactHookHarness } from "../../test/reactHookHarness";
import { useChatAutomationCreation } from "./useChatAutomationCreation";

const threadId = ThreadId.makeUnsafe("chat-a");
const projectId = ProjectId.makeUnsafe("project-a");
const form = formFromAutomationDraft([{ id: projectId }], {
  name: "Update research",
  prompt: "Update the existing page",
  enabled: false,
  worktreeMode: "worktree",
});
function saved(input: AutomationCreateInput) {
  return Schema.decodeUnknownSync(AutomationDefinition)({
    ...input,
    id: "saved-automation",
    nextRunAt: null,
    targetThreadId: null,
    sourceThreadId: input.sourceThreadId ?? null,
    iterationCount: 0,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    archivedAt: null,
  });
}

describe("chat automation creation uses the shared durable request journal", () => {
  let input: Parameters<typeof useChatAutomationCreation>[0];
  const clearComposerInput = vi.fn();
  const resetAutomationDraftState = vi.fn();
  const render = () => {
    reactHookHarness.beginRender();
    return useChatAutomationCreation(input);
  };
  const create = () =>
    render().createAutomationFromForm({ form, warnings: [], acknowledgedWarningIds: new Set() });

  beforeEach(() => {
    reactHookHarness.reset();
    mocks.identity = "account-a";
    mocks.create
      .mockReset()
      .mockImplementation(async (value: AutomationCreateInput) => saved(value));
    mocks.dispatch.mockReset().mockResolvedValue(undefined);
    mocks.promote.mockReset().mockResolvedValue("created");
    mocks.notes.mockReset().mockResolvedValue(undefined);
    mocks.toast.mockReset();
    clearComposerInput.mockReset();
    resetAutomationDraftState.mockReset();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    input = {
      threadId,
      activeProject: { id: projectId } as never,
      automationDraftSubmittingRef: { current: false },
      isServerThread: true,
      activeThread: { id: threadId } as never,
      providerOptionsForDispatch: undefined,
      setIsAutomationDraftSubmitting: vi.fn(),
      queryClient: new QueryClient(),
      clearComposerInput,
      resetAutomationDraftState,
      activeThreadAssociatedWorktree: {
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
      },
      threadNotes: "",
      selectedModelSelection: form.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      automationDraftForm: form,
      automationDraftWarnings: [],
      acknowledgedAutomationWarnings: new Set(),
    };
  });
  afterEach(() => {
    reactHookHarness.unmount();
    input.queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("preserves the exact unknown request across closing and remounting before retry", async () => {
    mocks.create.mockRejectedValueOnce(new Error("Response lost"));
    expect(await create()).toBe(false);
    let state = render();
    expect(state.automationCreationPending?.requestId).toBeTruthy();
    expect(state.automationCreationPendingOpen).toBe(true);
    state.setAutomationCreationPendingOpen(false);
    reactHookHarness.unmount();
    state = render();
    expect(state.automationCreationPendingOpen).toBe(true);
    expect(await state.retryAutomationCreation()).toBe(true);
    expect(mocks.create.mock.calls[1]?.[0]).toEqual(mocks.create.mock.calls[0]?.[0]);
    expect(render().automationCreationPending).toBeNull();
    expect(clearComposerInput).toHaveBeenCalledTimes(1);
    expect(resetAutomationDraftState).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("blocks repeated submissions while the original create is pending", async () => {
    let release!: (value: AutomationDefinition) => void;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise<AutomationDefinition>((resolve) => {
          release = resolve;
        }),
    );
    const first = create();
    expect(await create()).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    release(saved(mocks.create.mock.calls[0]![0]));
    expect(await first).toBe(true);
    expect(clearComposerInput).toHaveBeenCalledTimes(1);
  });

  it("allows corrected settings only after the server's durable rejected receipt", async () => {
    mocks.create.mockRejectedValueOnce(
      new WsRpcError({
        code: "AUTOMATION_CREATE_REJECTED",
        message: "Provider unavailable",
        retryable: false,
      }),
    );
    expect(await create()).toBe(false);
    expect(render().automationCreationPending).toBeNull();
    expect(render().automationCreationError).toBe("Provider unavailable");
    expect(
      await render().createAutomationFromForm({
        form: { ...form, name: "Corrected task" },
        warnings: [],
        acknowledgedWarningIds: new Set(),
      }),
    ).toBe(true);
    expect(mocks.create.mock.calls[1]?.[0].requestId).not.toBe(
      mocks.create.mock.calls[0]?.[0].requestId,
    );
  });

  it("fences a late account result and retains the original account's request", async () => {
    let release!: (value: AutomationDefinition) => void;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise<AutomationDefinition>((resolve) => {
          release = resolve;
        }),
    );
    const first = create();
    mocks.identity = "account-b";
    render();
    release(saved(mocks.create.mock.calls[0]![0]));
    expect(await first).toBe(false);
    expect(clearComposerInput).not.toHaveBeenCalled();
    expect(resetAutomationDraftState).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.identity = "account-a";
    expect(render().automationCreationPending?.requestId).toBeTruthy();
  });

  it("does not send a queued creation after the real lock opens in another account", async () => {
    let unlock!: () => Promise<void>;
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, callback: () => Promise<unknown>) =>
          new Promise<unknown>((resolve, reject) => {
            unlock = async () => {
              try {
                resolve(await callback());
              } catch (error) {
                reject(error);
              }
            };
          }),
      },
    });
    const first = create();
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.identity = "account-b";
    render();
    await unlock();
    expect(await first).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.identity = "account-a";
    expect(render().automationCreationPending?.requestId).toBeTruthy();
  });

  it("does not promote a draft through a stale account callback", async () => {
    input.isServerThread = false;
    const stale = render();
    mocks.identity = "account-b";
    render();
    expect(
      await stale.prepareAutomationFormForCreate({
        ...form,
        mode: "heartbeat",
        targetThreadId: threadId,
      }),
    ).toBeNull();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it("does not write inherited thread notes after an account change during promotion", async () => {
    input.isServerThread = false;
    let release!: (value: string) => void;
    mocks.promote.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const preparation = render().prepareAutomationFormForCreate({
      ...form,
      mode: "heartbeat",
      targetThreadId: threadId,
    });
    expect(mocks.promote).toHaveBeenCalledTimes(1);
    mocks.identity = "account-b";
    render();
    release("created");
    expect(await preparation).toBeNull();
    expect(mocks.notes).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
