// @vitest-environment happy-dom
import { ProjectId, ThreadId } from "@moss/contracts";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptyThreadDraft,
  type ComposerFileAttachment,
  type PersistedComposerFileAttachment,
} from "../../composerDraftDomain";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import * as composerFileBlobStore from "../../lib/composerFileBlobStore";
import { translateZhCnPresentationText } from "../../localization/zhCN";
import type { Project, Thread } from "../../types";
import { toastManager } from "../ui/toast";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";
import { useChatTurnSubmission } from "./useChatTurnSubmission";

const mocks = vi.hoisted(() => ({
  stageUploadComposerAttachments: vi.fn(),
  executePreparedTurn: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/lib/workspaceEditorSession", () => ({
  flushWorkspaceEditors: vi.fn(async () => true),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: vi.fn(async () => undefined) },
  }),
}));

vi.mock("./ChatProviderSendControl", () => ({
  isChatComposerSubmitReady: () => true,
  runChatProviderSendPreflight: vi.fn(async () => ({ usable: true, status: "ready" })),
}));

vi.mock("./handleChatAutomationSend", () => ({
  handleChatAutomationSend: vi.fn(async () => false),
}));

vi.mock("./resolveChatPromptCaptures", () => ({
  resolveChatPromptCaptures: vi.fn(async (input: { composerImagesForSend: unknown[] }) => ({
    composerImagesForSend: input.composerImagesForSend,
  })),
}));

vi.mock("./prepareChatSendWorkspace", () => ({
  prepareChatSendWorkspace: vi.fn(
    async (input: { activeThread: Thread; activeProject: Project }) => ({
      threadIdForSend: input.activeThread.id,
      title: input.activeThread.title,
      targetProjectIdForSend: input.activeProject.id,
      targetProjectKindForSend: "project",
      targetProjectCwdForSend: "/workspace",
      targetProjectDefaultModelSelectionForSend: { provider: "codex", model: "gpt-5.4" },
      nextRuntimeModeForSend: "full-access",
      nextThreadEnvMode: "local",
      nextThreadBranch: null,
      nextThreadWorktreePath: null,
      nextThreadWorkingDirectory: "/workspace",
      nextAssociatedWorktreePath: null,
      nextAssociatedWorktreeBranch: null,
      nextAssociatedWorktreeRef: null,
      shouldResumeSettledLocalThread: false,
      currentActiveGitBranchForSend: null,
      baseBranchForWorktree: null,
      setupScriptForWorktree: null,
      worktreeSetupScriptName: null,
      worktreeCopiesLocalChanges: false,
    }),
  ),
}));

vi.mock("./useChatTurnExecution", () => ({
  useChatTurnExecution: () => mocks.executePreparedTurn,
}));

vi.mock("../../lib/composerSend", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/composerSend")>("../../lib/composerSend");
  return {
    ...actual,
    stageUploadComposerAttachments: (...args: unknown[]) =>
      mocks.stageUploadComposerAttachments(...args),
  };
});

function buildSubmissionInput(input: {
  threadId: ThreadId;
  projectId: ProjectId;
  prompt: string;
  clearComposerInput: (threadId: ThreadId) => void;
}): ChatTurnSubmissionInput {
  const activeThread = {
    id: input.threadId,
    projectId: input.projectId,
    title: "Test thread",
    session: null,
    latestTurn: null,
    messages: [],
    claudeCacheReview: null,
    sidechatExpiredAt: null,
  } as unknown as Thread;
  const activeProject = {
    id: input.projectId,
    name: "Workspace",
    cwd: "/workspace",
    kind: "project",
    additionalFolders: [],
  } as unknown as Project;
  const noop = vi.fn();
  const promptRef = { current: input.prompt };
  return {
    threadId: input.threadId,
    hasLiveTurn: false,
    lateComposerSendHandlersRef: {
      current: {
        send: vi.fn(async () => true),
        submitPlanFollowUp: vi.fn(async () => true),
        advanceActivePendingUserInput: vi.fn(() => false),
        handleStandaloneSlashCommand: vi.fn(async () => false),
      },
    },
    activeThread,
    isConnecting: false,
    sendPreflightInFlightRef: { current: false },
    sendInFlightRef: { current: false },
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    hasQueueableLiveTurn: false,
    clearComposerInput: input.clearComposerInput,
    scheduleComposerFocus: noop,
    activeProject,
    threadWorkspaceCwd: "/workspace",
    refreshProviderStatuses: vi.fn(async () => []) as never,
    isServerThread: true,
    hasNativeUserMessages: false,
    chatWorkspaceRoot: "/workspace",
    isHomeChatContainer: false,
    isGroupContainer: false,
    resolvedThreadWorktreePath: null,
    resolvedThreadWorkingDirectory: "/workspace",
    currentActiveGitBranch: null,
    isContainerLandingProject: false,
    syncServerShellSnapshot: noop,
    activeRootBranch: null,
    gitBranchSourceCwd: "/workspace",
    setStoreThreadError: noop,
    queryClient: new QueryClient(),
    isCenteredEmptyLanding: false,
    setEnvironmentPanelPreferenceOpen: noop,
    environmentPanelPreferenceOpen: null,
    setTailAnchor: noop,
    setThreadError: noop,
    setThreadSendFailure: noop,
    setComposerHighlightedItemId: noop,
    setStoreThreadWorkspace: noop,
    createWorktreeMutation: { mutateAsync: vi.fn() } as never,
    isLocalDraftThread: false,
    threadNotes: "",
    setSettledThreadBranchWarningDismissedThreadId: noop,
    setQueuedSteerGate: noop,
    planSidebarDismissedForTurnRef: { current: null },
    setPlanSidebarOpen: noop,
    settings: {
      computerControlEnabled: false,
      followUpBehavior: "queue",
      environmentPanelDefaultOpen: false,
    } as never,
    isSendBusy: false,
    worktreeSetupResolutionRef: { current: null },
    setWorktreeSetupPendingAction: noop,
    beginLocalDispatch: noop,
    clearLocalDispatchWorktreeSetup: noop,
    armLocalDispatchAckFallback: noop,
    failLocalDispatchWorktreeSetup: noop,
    scheduleFailedWorktreeSetupDispatchReset: noop,
    resetLocalDispatch: noop,
    isVoiceTranscribing: false,
    waitForPendingComposerImages: vi.fn(async () => undefined),
    activePendingProgress: null,
    activePendingUserInputKey: null,
    pendingUserInputAnswersByRequestIdRef: { current: {} },
    setPendingUserInputAnswersByRequestId: noop,
    composerEditorRef: { current: null },
    promptRef,
    composerImages: [],
    composerFiles: [],
    composerAssistantSelections: [],
    composerBrowserAnnotations: [],
    composerFileComments: [],
    composerTerminalContexts: [],
    composerPastedTexts: [],
    composerPullRequestContexts: [],
    restoredQueuedSourceProposedPlanRef: { current: null },
    enqueueQueuedComposerTurn: noop,
    setComposerDraftPrompt: noop,
    setComposerTrigger: noop,
    clearProjectDraftThreadId: noop,
    setDraftThreadContext: noop,
    promptHistoryNavigationRef: { current: { index: -1 } } as never,
    applyingPromptHistoryNavigationRef: { current: false },
    expectedPromptHistoryPromptRef: { current: null },
    clearComposerDraftContent: noop,
    setComposerDraftInteractionMode: noop,
    setComposerCursor: noop,
    setRestoredQueuedSourceProposedPlan: noop,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerAssistantSelectionsRef: { current: [] },
    composerBrowserAnnotationsRef: { current: [] },
    composerFileCommentsRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPastedTextsRef: { current: [] },
    composerPullRequestContextsRef: { current: [] },
    setPrompt: noop,
    addComposerImagesToDraft: noop,
    addComposerFilesToDraft: noop,
    addComposerAssistantSelectionToDraft: noop,
    addComposerDraftBrowserAnnotations: noop,
    addComposerFileCommentToDraft: noop,
    addComposerTerminalContextsToDraft: noop,
    addComposerPastedTextsToDraft: noop,
    addComposerPullRequestContextsToDraft: noop,
    selectedComposerSkillsRef: { current: [] },
    selectedComposerMentionsRef: { current: [] },
    updateSelectedComposerSkills: noop,
    updateSelectedComposerMentions: noop,
    selectedProvider: "codex",
    selectedModel: "gpt-5.4",
    selectedPromptEffort: null,
    turnDispatchSettings: {
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      providerOptions: undefined,
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      computerControlMode: "off",
      enableComputerControl: false,
    } as never,
    computerControlChangeSequence: { current: 0 },
    setComposerDraftComputerControlMode: noop,
    pendingAutomationConversationRef: { current: null },
    setPendingAutomationConversation: noop,
    pendingAutomationConversation: null,
    activeThreadIdRef: { current: input.threadId },
    hasLiveTurnRef: { current: false },
    automationProjects: [],
    setAutomationDraftWarningContext: noop,
    setAutomationDraftForm: noop,
    setAutomationDraftWarnings: noop,
    setAcknowledgedAutomationWarnings: noop,
    setAutomationDraftOpen: noop,
    armTranscriptAutoFollow: noop,
    tailAnchorScrollInFlightRef: { current: false },
    prepareAutomationFormForCreate: noop as never,
    createAutomationFromForm: noop as never,
    providerStatuses: [],
    isPreparingWorktree: false,
    serverSettings: null,
    mossQuotaAccountIdentity: null,
    mossQuotaAccountIdentityRef: { current: null },
    mossQuotaAccountTransitionPendingRef: { current: false },
    rememberCustomBinaryPathForDispatch: noop,
    setOptimisticUserMessages: noop,
    runProjectScript: vi.fn(async () => undefined) as never,
    persistThreadSettingsForNextTurn: vi.fn(async () => undefined),
    onSendBlocked: noop,
    onSendUnblocked: noop,
  };
}

describe("useChatTurnSubmission pending persisted files", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    mocks.stageUploadComposerAttachments.mockReset();
    mocks.stageUploadComposerAttachments.mockResolvedValue({
      attachments: [],
      commit: vi.fn(),
      cleanup: vi.fn(async () => undefined),
      runWithDispatch: vi.fn(async (dispatch: (attachments: unknown[]) => Promise<unknown>) =>
        dispatch([]),
      ),
    });
    mocks.executePreparedTurn.mockReset();
    mocks.executePreparedTurn.mockResolvedValue(true);
    mocks.toastAdd.mockReset();
    vi.spyOn(toastManager, "add").mockImplementation(mocks.toastAdd as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hydrates unhydrated persisted files on live send (including file-only drafts)", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-send-hydrate");
    const projectId = ProjectId.makeUnsafe("project-live-send");
    const persistedFirst: PersistedComposerFileAttachment = {
      id: "pending-1",
      name: "alpha.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      blobKey: `${threadId}:pending-1`,
    };
    const persistedSecond: PersistedComposerFileAttachment = {
      id: "pending-2",
      name: "beta.md",
      mimeType: "text/markdown",
      sizeBytes: 4,
      blobKey: `${threadId}:pending-2`,
    };
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          persistedFiles: [persistedFirst, persistedSecond],
        },
      },
    });
    const firstFile = new File(["alpha"], "alpha.txt", { type: "text/plain" });
    const secondFile = new File(["beta"], "beta.md", { type: "text/markdown" });
    vi.spyOn(composerFileBlobStore, "readComposerFileBlob").mockImplementation(async (key) => {
      if (key === persistedFirst.blobKey) return firstFile;
      if (key === persistedSecond.blobKey) return secondFile;
      return null;
    });

    const clearComposerInput = vi.fn();
    const { result } = renderHook(() =>
      useChatTurnSubmission(
        buildSubmissionInput({ threadId, projectId, prompt: "", clearComposerInput }),
      ),
    );

    const sent = await result.current.onSend();
    expect(sent).toBe(true);
    expect(mocks.toastAdd).not.toHaveBeenCalled();

    const stagedInput = mocks.stageUploadComposerAttachments.mock.calls[0]?.[0] as {
      files?: ComposerFileAttachment[];
    };
    expect(stagedInput.files?.map((entry) => [entry.id, entry.file])).toEqual([
      ["pending-1", firstFile],
      ["pending-2", secondFile],
    ]);
    const executionInput = mocks.executePreparedTurn.mock.calls[0]?.[0] as {
      composerFilesSnapshot?: ComposerFileAttachment[];
    };
    expect(executionInput.composerFilesSnapshot?.map((entry) => [entry.id, entry.file])).toEqual([
      ["pending-1", firstFile],
      ["pending-2", secondFile],
    ]);
  });

  it("aborts live send with a localized error and preserves the draft when a persisted file blob is missing", async () => {
    const threadId = ThreadId.makeUnsafe("thread-live-send-missing");
    const projectId = ProjectId.makeUnsafe("project-live-send");
    const persisted: PersistedComposerFileAttachment = {
      id: "missing-1",
      name: "lost.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      blobKey: `${threadId}:missing-1`,
    };
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [threadId]: {
          ...createEmptyThreadDraft(),
          prompt: "Please summarize this file",
          persistedFiles: [persisted],
        },
      },
    });
    vi.spyOn(composerFileBlobStore, "readComposerFileBlob").mockResolvedValue(null);

    const clearComposerInput = vi.fn();
    const { result } = renderHook(() =>
      useChatTurnSubmission(
        buildSubmissionInput({
          threadId,
          projectId,
          prompt: "Please summarize this file",
          clearComposerInput,
        }),
      ),
    );

    const sent = await result.current.onSend();
    expect(sent).toBe(false);
    expect(clearComposerInput).not.toHaveBeenCalled();
    expect(mocks.stageUploadComposerAttachments).not.toHaveBeenCalled();
    expect(mocks.executePreparedTurn).not.toHaveBeenCalled();
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not restore saved files",
      description: "Retry or remove them before sending.",
    });
    const toastArg = mocks.toastAdd.mock.calls[0]?.[0] as { title: string; description: string };
    expect(translateZhCnPresentationText(toastArg.title)).toBe("无法恢复已保存的文件");
    expect(translateZhCnPresentationText(toastArg.description)).toBe("请重试，或在发送前移除。");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedFiles).toEqual([
      persisted,
    ]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "Please summarize this file",
    );
  });
});
