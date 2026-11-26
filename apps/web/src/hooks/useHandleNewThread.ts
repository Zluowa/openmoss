import {
  type ModelSelection,
  type PagesReadResult,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderKind,
  type SpaceId,
  ThreadId,
} from "@moss/contracts";
import type { SpaceArtifactKind } from "../components/space/spaceCanvasDockContract";
import { getDefaultModel } from "@moss/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useMemo, useRef } from "react";
import {
  getProviderInstanceOptions,
  newChatProviderInstanceIdFrom,
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  resolveNewConversationDefaultModelSelection,
  resolveSelectableProviderInstanceId,
  serverSettingsToAppSettings,
  useAppSettings,
} from "../appSettings";
import { prefetchModelsForNewThread } from "../lib/providerModelPrefetch";
import { createPastedTextDraft } from "../lib/composerPastedText";
import { hasActiveComposerSend } from "../lib/composerSendOwnership";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
  serverSettingsQueryOptions,
} from "../lib/serverReactQuery";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  composerDraftHasUnsentContent,
  composerThreadDraftIsPending,
  type ProjectDraftThread,
} from "../composerDraftDomain";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import {
  applyGroupWorkerRoutingDefaults,
  resolveGroupContainerThreadDefaults,
} from "../lib/groupWorkerRouting";
import {
  findProviderStatus,
  hasUsableProviderAccount,
  isProviderUsable,
} from "../lib/providerAvailability";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  resolveTerminalThreadCreationState,
  resolveInheritedThreadContext,
  resolveThreadBootstrapPlan,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import { promoteThreadCreate } from "../lib/threadCreatePromotion";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "../lib/stagedDraftNavigation";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { promoteCanvasDraftThread } from "../lib/canvasDraftThread";
import { createDraftThread } from "../lib/draftThreadCreate";
import { createDraftThreadWithoutTurn, dispatchDraftThread } from "../lib/draftThreadDispatch";
import {
  artifactAssistantThreadKey,
  pageAssistantThreads,
  sendPageAssistantTurn,
} from "../lib/pageAi/pageAssistantThread";
import {
  mossImagesComposerAttachments,
  mossImagesConversationPrompt,
  resolveMossImagesConversationSkill,
  type MossImagesConversationInput,
} from "../lib/mossImagesConversation";
import { toastManager } from "../components/ui/toast";
import { LocalizedError, localizedMessage } from "../lib/localizedError";
import type { MossLibraryItem } from "../components/MossLibrarySurface.logic";
import { readGeneratedImageContextFile } from "../lib/generatedImageContextMenu";
import { ensureHomeChatProject } from "../lib/chatProjects";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { formatComposerMentionToken } from "../lib/composerMentions";
import { getThreadFromState } from "../threadDerivation";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { setPendingSidebarPlacement } from "../pendingSidebarPlacement";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

const inFlightArtifactPrepare = new Map<string, Promise<ThreadId | null>>();

export interface NewThreadNavigationOptions {
  /**
   * Search params applied when the hook navigates to the created thread.
   * Lets callers keep view-level state (e.g. the editor workspace view)
   * across the route change; default navigation clears all search params.
   */
  search?: (previous: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Creates (or restores) the draft without changing the active page or the
   * main-window thread stack. Detached chat surfaces use this to prepare a
   * conversation while leaving the user's current task in place.
   */
  skipNavigation?: boolean;
  /** Replaces an intermediate landing route instead of leaving it in browser history. */
  replace?: boolean;
  /** Parks the previous unsent project draft instead of deleting its composer data. */
  preservePreviousDraft?: boolean;
}

export interface SpaceArtifactAssistantTarget {
  readonly kind: SpaceArtifactKind;
  readonly itemId: string;
  readonly title: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly sourceThreadId?: string | null | undefined;
  readonly revision?: number | null | undefined;
}

/**
 * 图像 and 资料空间 prepare their chat bare. The right dock's 画布 in a new chat passes
 * `listedAfterFirstSend`: that chat is listed once something is sent or drawn in it (N7-1).
 */
type CanvasThreadPreparation = { readonly listedAfterFirstSend?: true };

// Coordinator hand-off threads never mint through this hook, so every caller
// here is a user-initiated surface: a fresh chat draft minted inside a group
// container seeds from the group's workerRouting via the same helper the
// Groups new-chat path uses. Stored/route reuse paths keep the user's
// existing selections.
export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const { settings, serverSettings } = useAppSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const providerInstances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const resolveProviderForInstanceId = (instanceId: ProviderInstanceId) =>
    providerInstances.find((instance) => instance.instanceId === instanceId)?.provider ?? null;
  // An agent nothing picked a provider for opens on the default one (Moss while signed in).
  const defaultInstanceIdForProvider = (provider: ProviderKind) =>
    newChatProviderInstanceIdFrom(providerInstances, provider);
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverCwd = serverConfigQuery.data?.cwd ?? null;
  const providerStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const navigate = useNavigate();
  const router = useRouter();
  const { activeDraftThread, activeProjectId, activeThread, focusedThreadId, routeThreadId } =
    useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((store) => store.openTerminalThreadPage);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const imagesStartRef = useRef<Promise<void> | null>(null);

  const resolveNewConversationContext = (
    originThreadId?: string,
    fallbackProjectId?: ProjectId | null,
  ) => {
    const api = readNativeApi();
    const origin = originThreadId
      ? getThreadFromState(useStore.getState(), originThreadId as ThreadId)
      : undefined;
    const sourceThread = origin ?? activeThread;
    const sourceDraft = origin ? null : activeDraftThread;
    const projectId =
      sourceDraft?.projectId ?? sourceThread?.projectId ?? activeProjectId ?? fallbackProjectId;
    const project = useStore.getState().projects.find((entry) => entry.id === projectId);
    if (!api || !project || !useStore.getState().threadsHydrated)
      throw new LocalizedError("newThread.error.chooseFolder");
    const creation = resolveTerminalThreadCreationState({
      newChatRuntimeMode: useComposerDraftStore.getState().stickyRuntimeMode,
      activeDraftThread: sourceDraft,
      activeThread: sourceThread,
      draftThread: sourceDraft,
      draftComposerState:
        !origin && focusedThreadId
          ? (useComposerDraftStore.getState().draftsByThreadId[focusedThreadId] ?? null)
          : null,
      defaultProvider: settings.defaultProvider,
      projectId: project.id,
      options: resolveInheritedThreadContext({
        activeThread: sourceThread,
        activeDraftThread: sourceDraft,
      }),
      resolveProviderForInstanceId,
      defaultInstanceIdForProvider,
    });
    if (creation.envMode === "worktree" && !creation.worktreePath)
      throw new LocalizedError("newThread.error.folderNotReadySend");
    return { api, project, creation };
  };

  const startLibraryConversation = async (
    items: readonly MossLibraryItem[],
    onOpen: () => void,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent()) throw new LocalizedError("newThread.error.accountChangedLibrary");
    const { project, creation } = resolveNewConversationContext(items[0]?.originationThreadId);
    const files = await Promise.all(
      items
        .filter((item) => item.kind === "image")
        .map(async (item) => {
          if (!item.thumbnailUrl) throw new LocalizedError("newThread.error.imageUnreadable");
          return readGeneratedImageContextFile({
            image: { src: item.thumbnailUrl, name: item.title },
            resolveImageUrl: ({ src }) => src,
            fetchCredentials: "include",
          });
        }),
    );
    if (!isCurrent()) throw new LocalizedError("newThread.error.accountChangedLibrary");
    const documents = items.filter((item) => item.kind !== "image");
    if (documents.some((item) => !item.path))
      throw new LocalizedError("newThread.error.fileNotSaved");
    const threadId = createDraftThread({
      projectId: project.id,
      prompt: documents.map((item) => formatComposerMentionToken(item.path!)).join("\n"),
      modelSelection: creation.modelSelection,
      runtimeMode: creation.runtimeMode,
      interactionMode: creation.interactionMode,
      envMode: creation.envMode,
      workingDirectory: creation.workingDirectory,
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setDraftThreadContext(threadId, {
      branch: creation.branch,
      worktreePath: creation.worktreePath,
    });
    draftStore.addImages(threadId, mossImagesComposerAttachments(files));
    draftStore.setMentions(
      threadId,
      documents.map((item) => ({ name: item.title, path: item.path! })),
    );
    openChatThreadPage(threadId);
    await navigate({ to: "/$threadId", params: { threadId } });
    onOpen();
  };

  const startPageConversation = async (
    document: PagesReadResult,
    onOpen: () => void,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent()) throw new LocalizedError("newThread.error.accountChangedPage");
    const { project, creation } = resolveNewConversationContext(
      document.page.sourceThreadId ?? undefined,
    );
    if ((project.spaceId ?? null) !== document.page.scopeSpaceId)
      throw new LocalizedError("newThread.error.pageWorkspaceMismatch");
    const threadId = createDraftThread({
      projectId: project.id,
      prompt: `请读取资料空间页面“${document.page.title}”（页面 ID：${document.page.id}，当前版本：${document.page.revision}），在这份页面的基础上继续工作。请用资料空间工具读取最新内容，需要修改时更新同一页面并保留版本记录。`,
      modelSelection: creation.modelSelection,
      runtimeMode: creation.runtimeMode,
      interactionMode: creation.interactionMode,
      envMode: creation.envMode,
      workingDirectory: creation.workingDirectory,
    });
    useComposerDraftStore.getState().setDraftThreadContext(threadId, {
      branch: creation.branch,
      worktreePath: creation.worktreePath,
    });
    openChatThreadPage(threadId);
    await navigate({ to: "/$threadId", params: { threadId } });
    onOpen();
  };

  /**
   * The agent a page sends work to: a page's 问 Moss is a new chat, so it starts on the one
   * default (Settings → 通用, resolved to its account instance such as the Moss lane), never on
   * whatever another surface picked last (WALK-1 D-2: the 图像 page's image model showed here).
   */
  const pageAgentSelection = (): ModelSelection =>
    resolveNewConversationDefaultModelSelection(settings);

  /**
   * Resolves a project matching a Space artifact (`scopeSpaceId`). Unlike general new-chat creation,
   * an artifact stays valid even if the user switched into Spaces before focusing a Space thread.
   */
  const resolveArtifactConversationProject = (
    scopeSpaceId: SpaceId | null,
    originThreadId?: string,
    fallbackLocalProjectId?: ProjectId | null,
  ) => {
    const state = useStore.getState();
    const origin = originThreadId
      ? getThreadFromState(state, originThreadId as ThreadId)
      : undefined;
    const originProject = origin
      ? state.projects.find((entry) => entry.id === origin.projectId)
      : undefined;
    if (origin && originProject && (originProject.spaceId ?? null) === scopeSpaceId) {
      return {
        ...resolveNewConversationContext(originThreadId, originProject.id),
      };
    }

    const activeCandidateId =
      activeDraftThread?.projectId ?? activeThread?.projectId ?? activeProjectId;
    const activeCandidate = activeCandidateId
      ? state.projects.find((entry) => entry.id === activeCandidateId)
      : undefined;
    const matchingProject =
      activeCandidate && (activeCandidate.spaceId ?? null) === scopeSpaceId
        ? activeCandidate
        : (state.projects.find((entry) => (entry.spaceId ?? null) === scopeSpaceId) ??
          (scopeSpaceId === null && fallbackLocalProjectId
            ? state.projects.find((entry) => entry.id === fallbackLocalProjectId)
            : undefined));
    if (!matchingProject) {
      throw new LocalizedError("newThread.error.pageWorkspaceMismatch");
    }

    const api = readNativeApi();
    if (!api || !state.threadsHydrated) {
      throw new LocalizedError("newThread.error.chooseFolder");
    }
    const inheritActive = activeCandidate?.id === matchingProject.id;
    const sourceThread = inheritActive ? activeThread : null;
    const sourceDraft = inheritActive ? activeDraftThread : null;
    const creation = resolveTerminalThreadCreationState({
      newChatRuntimeMode: useComposerDraftStore.getState().stickyRuntimeMode,
      activeDraftThread: sourceDraft,
      activeThread: sourceThread,
      draftThread: sourceDraft,
      draftComposerState:
        inheritActive && focusedThreadId
          ? (useComposerDraftStore.getState().draftsByThreadId[focusedThreadId] ?? null)
          : null,
      defaultProvider: settings.defaultProvider,
      projectId: matchingProject.id,
      options: inheritActive
        ? resolveInheritedThreadContext({
            activeThread: sourceThread,
            activeDraftThread: sourceDraft,
          })
        : undefined,
      resolveProviderForInstanceId,
      defaultInstanceIdForProvider,
    });
    if (creation.envMode === "worktree" && !creation.worktreePath) {
      throw new LocalizedError("newThread.error.folderNotReadySend");
    }
    return { api, project: matchingProject, creation };
  };

  /** Which agent a page AI action would use, or null when none is ready for this page. */
  const describePageAgent = (document: PagesReadResult) => {
    try {
      resolveArtifactConversationProject(
        document.page.scopeSpaceId,
        document.page.sourceThreadId ?? undefined,
      );
      return { modelSelection: pageAgentSelection() };
    } catch {
      return null;
    }
  };

  /**
   * Sends one turn from a page to the selected agent without leaving the page. The new
   * conversation keeps the work, and the page links to it from drafts and attribution.
   */
  const startPageAiTurn = (
    document: PagesReadResult,
    prompt: { readonly request: string; readonly context: string },
    isCurrent: () => boolean,
  ): Promise<ThreadId> => startPageChat(document, prompt, isCurrent);

  // Starts a new chat for a page turn. The request names it unless a title is given;
  // the page context travels as an attached text block.
  const startPageChat = async (
    document: PagesReadResult,
    prompt: { readonly request: string; readonly context: string },
    isCurrent: () => boolean,
    title?: string,
  ): Promise<ThreadId> => {
    const { project, creation, selection } = resolvePageChatContext(document, isCurrent);
    const threadId = createDraftThread({
      projectId: project.id,
      prompt: prompt.request,
      modelSelection: selection,
      runtimeMode: creation.runtimeMode,
      interactionMode: creation.interactionMode,
      envMode: creation.envMode,
      workingDirectory: creation.workingDirectory,
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setDraftThreadContext(threadId, {
      branch: creation.branch,
      worktreePath: creation.worktreePath,
    });
    draftStore.addPastedTexts(threadId, [
      createPastedTextDraft({
        id: `page-ai:${document.page.id}`,
        createdAt: new Date().toISOString(),
        text: prompt.context,
      }),
    ]);
    const dispatch = await dispatchDraftThread({
      threadId,
      projectId: project.id,
      thread: null,
      defaultProvider: selection.provider,
      assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
      providerOptions: getProviderStartOptions(
        settings,
        selection.instanceId ?? selection.provider,
      ),
      providerInstances,
      ...(title ? { title } : {}),
    });
    if (dispatch.kind === "error") throw new Error(dispatch.message);
    if (dispatch.kind === "unavailable")
      throw new LocalizedError("newThread.error.connectionUnavailable");
    if (dispatch.kind === "open-thread")
      throw new LocalizedError("newThread.error.folderNotReadySend");
    return threadId;
  };

  const resolvePageChatContext = (document: PagesReadResult, isCurrent: () => boolean) => {
    if (!isCurrent()) throw new LocalizedError("newThread.error.accountChangedPage");
    const { project, creation } = resolveArtifactConversationProject(
      document.page.scopeSpaceId,
      document.page.sourceThreadId ?? undefined,
    );
    return { project, creation, selection: pageAgentSelection() };
  };

  /** The page's assistant chat when it can take another turn, else null. */
  const reusablePageAssistantThread = (pageKey: string, projectId: ProjectId) => {
    const threadId = pageAssistantThreads.get(pageKey);
    if (!threadId) return null;
    const state = useStore.getState();
    const summary = state.sidebarThreadSummaryById[threadId];
    if (!summary) {
      // Not loaded yet is not gone: only forget a chat once threads are hydrated.
      if (state.threadsHydrated) pageAssistantThreads.forget(pageKey, threadId);
      return null;
    }
    if (summary.archivedAt || summary.projectId !== projectId) {
      pageAssistantThreads.forget(pageKey, threadId);
      return null;
    }
    // Something the person typed in that chat stays theirs; this turn goes to a new chat.
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    if (draft && composerDraftHasUnsentContent(draft)) return null;
    if (hasActiveComposerSend(threadId)) return null;
    return summary;
  };

  /**
   * Makes sure the page has its assistant chat, named after the page, without sending
   * anything, so its agent can start while the person is still typing. Resolves to the
   * chat, or null when it could not be made; the first send then makes it as usual.
   */
  const preparePageAssistant = async (
    document: PagesReadResult,
    isCurrent: () => boolean,
    pageKey: string,
    title: string,
  ): Promise<ThreadId | null> => {
    try {
      const { project, creation, selection } = resolvePageChatContext(document, isCurrent);
      const existing = reusablePageAssistantThread(pageKey, project.id);
      if (existing) return existing.id;
      // A remembered chat that can't take a turn right now is still the page's chat.
      if (pageAssistantThreads.get(pageKey)) return null;
      const threadId = createDraftThread({
        projectId: project.id,
        prompt: "",
        modelSelection: selection,
        runtimeMode: creation.runtimeMode,
        interactionMode: creation.interactionMode,
        envMode: creation.envMode,
        workingDirectory: creation.workingDirectory,
      });
      useComposerDraftStore.getState().setDraftThreadContext(threadId, {
        branch: creation.branch,
        worktreePath: creation.worktreePath,
      });
      const created = await createDraftThreadWithoutTurn({
        threadId,
        projectId: project.id,
        title,
        defaultProvider: selection.provider,
        providerInstances,
      });
      if (!created) return null;
      pageAssistantThreads.set(pageKey, threadId);
      return threadId;
    } catch {
      return null;
    }
  };

  /**
   * Sends a page turn to the page's assistant chat, making that chat (named after the
   * page) on first use. Falls back to a new chat when the assistant chat can't take it,
   * so a page action works whatever state that chat is in.
   */
  const startPageAssistantTurn = async (
    document: PagesReadResult,
    prompt: { readonly request: string; readonly context: string },
    isCurrent: () => boolean,
    pageKey: string,
    title: string,
  ) => {
    const { project, selection } = resolvePageChatContext(document, isCurrent);
    return sendPageAssistantTurn({
      pageKey,
      reusable: () => reusablePageAssistantThread(pageKey, project.id),
      sendToExisting: (summary) => {
        const draftStore = useComposerDraftStore.getState();
        draftStore.setPrompt(summary.id, prompt.request);
        draftStore.setModelSelection(summary.id, selection);
        draftStore.addPastedTexts(summary.id, [
          createPastedTextDraft({
            id: `page-ai:${document.page.id}`,
            createdAt: new Date().toISOString(),
            text: prompt.context,
          }),
        ]);
        return dispatchDraftThread({
          threadId: summary.id,
          projectId: project.id,
          thread: summary,
          defaultProvider: selection.provider,
          assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
          providerOptions: getProviderStartOptions(
            settings,
            selection.instanceId ?? selection.provider,
          ),
          providerInstances,
        });
      },
      discardUnsent: (threadId) => useComposerDraftStore.getState().clearComposerContent(threadId),
      startNewChat: () => startPageChat(document, prompt, isCurrent, title),
    });
  };

  /**
   * Resolves a project/creation context for any Space artifact (`page`, `slides`, `sheet`,
   * `design`, `dashboard`, `board`, `app`), falling back to the local Chats project when
   * opened directly from Home without a focused thread.
   */
  const resolveArtifactCompanionContext = async (
    target: SpaceArtifactAssistantTarget,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent()) throw new LocalizedError("newThread.error.accountChangedPage");
    let fallbackLocalProjectId: ProjectId | null = null;
    if (target.scopeSpaceId === null) {
      const state = useStore.getState();
      const hasLocalProject = state.projects.some((entry) => (entry.spaceId ?? null) === null);
      if (!hasLocalProject) {
        fallbackLocalProjectId = await ensureHomeChatProject(useWorkspacePathsStore.getState());
      }
    }
    const { project, creation } = resolveArtifactConversationProject(
      target.scopeSpaceId,
      target.sourceThreadId ?? undefined,
      fallbackLocalProjectId,
    );
    return { project, creation, selection: pageAgentSelection() };
  };

  /** Checks whether an AI lane is usable for this artifact without creating a conversation. */
  const describeArtifactAgent = (target: SpaceArtifactAssistantTarget) => {
    try {
      resolveArtifactConversationProject(target.scopeSpaceId, target.sourceThreadId ?? undefined);
      return { modelSelection: pageAgentSelection() };
    } catch {
      if (target.scopeSpaceId === null && readNativeApi() && useStore.getState().threadsHydrated) {
        return { modelSelection: pageAgentSelection() };
      }
      return null;
    }
  };

  const artifactThreadMatchesProject = (
    threadId: ThreadId,
    scopeSpaceId: SpaceId | null,
    keyToForget?: string,
  ): ThreadId | null => {
    const state = useStore.getState();
    const summary = state.sidebarThreadSummaryById[threadId];
    if (summary) {
      const project = state.projects.find((entry) => entry.id === summary.projectId);
      if (summary.archivedAt || !project || (project.spaceId ?? null) !== scopeSpaceId) {
        if (keyToForget) pageAssistantThreads.forget(keyToForget, threadId);
        return null;
      }
      return summary.id;
    }
    const draft = useComposerDraftStore.getState().draftThreadsByThreadId[threadId];
    if (draft) {
      const project = state.projects.find((entry) => entry.id === draft.projectId);
      if (project && (project.spaceId ?? null) === scopeSpaceId) {
        return threadId;
      }
    }
    if (state.threadsHydrated && keyToForget) {
      pageAssistantThreads.forget(keyToForget, threadId);
    }
    return null;
  };

  /** Resolves the remembered companion thread for any Space artifact if still alive in workspace. */
  const resolveExistingArtifactThread = (
    target: SpaceArtifactAssistantTarget,
    artifactKey?: string,
  ): ThreadId | null => {
    const key =
      artifactKey ??
      artifactAssistantThreadKey("default", target.scopeSpaceId, target.kind, target.itemId);
    const remembered = pageAssistantThreads.get(key);
    if (remembered) {
      const matched = artifactThreadMatchesProject(remembered, target.scopeSpaceId, key);
      if (matched) return matched;
    }
    if (target.sourceThreadId) {
      const sourceMatched = artifactThreadMatchesProject(
        target.sourceThreadId as ThreadId,
        target.scopeSpaceId,
      );
      if (sourceMatched) return sourceMatched;
    }
    return null;
  };

  /**
   * Ensures an artifact has a persistent companion conversation inside its workspace without
   * leaving the canvas or sending a turn yet.
   */
  const prepareArtifactAssistant = async (
    target: SpaceArtifactAssistantTarget,
    isCurrent: () => boolean,
    options?: { readonly key?: string; readonly title?: string },
  ): Promise<ThreadId | null> => {
    const key =
      options?.key ??
      artifactAssistantThreadKey("default", target.scopeSpaceId, target.kind, target.itemId);
    const existing = resolveExistingArtifactThread(target, key);
    if (existing) return existing;
    const inFlight = inFlightArtifactPrepare.get(key);
    if (inFlight) return inFlight;

    const flight = (async (): Promise<ThreadId | null> => {
      try {
        const { project, creation, selection } = await resolveArtifactCompanionContext(
          target,
          isCurrent,
        );
        const existingAfterResolve = reusablePageAssistantThread(key, project.id);
        if (existingAfterResolve) return existingAfterResolve.id;
        const remembered = pageAssistantThreads.get(key);
        if (remembered) {
          const alive = artifactThreadMatchesProject(remembered, target.scopeSpaceId, key);
          if (alive) return alive;
        }
        const threadId = createDraftThread({
          projectId: project.id,
          prompt: "",
          modelSelection: selection,
          runtimeMode: creation.runtimeMode,
          interactionMode: creation.interactionMode,
          envMode: creation.envMode,
          workingDirectory: creation.workingDirectory,
        });
        pageAssistantThreads.set(key, threadId);
        useComposerDraftStore.getState().setDraftThreadContext(threadId, {
          branch: creation.branch,
          worktreePath: creation.worktreePath,
        });
        const created = await createDraftThreadWithoutTurn({
          threadId,
          projectId: project.id,
          title: options?.title ?? target.title,
          defaultProvider: selection.provider,
          providerInstances,
        });
        if (!created) return threadId;
        return threadId;
      } catch {
        pageAssistantThreads.forget(key);
        return null;
      }
    })();

    inFlightArtifactPrepare.set(key, flight);
    void flight.finally(() => {
      if (inFlightArtifactPrepare.get(key) === flight) {
        inFlightArtifactPrepare.delete(key);
      }
    });
    return flight;
  };

  /**
   * Creates a temporary sidechat tab draft for the current Space artifact without overwriting
   * the primary artifact-bound conversation.
   */
  const createTemporaryArtifactSidechat = async (
    target: SpaceArtifactAssistantTarget,
    isCurrent: () => boolean,
    options?: { readonly title?: string },
  ): Promise<ThreadId | null> => {
    try {
      const { project, creation, selection } = await resolveArtifactCompanionContext(
        target,
        isCurrent,
      );
      const threadId = createDraftThread({
        projectId: project.id,
        prompt: "",
        modelSelection: selection,
        runtimeMode: creation.runtimeMode,
        interactionMode: creation.interactionMode,
        envMode: creation.envMode,
        workingDirectory: creation.workingDirectory,
      });
      useComposerDraftStore.getState().setDraftThreadContext(threadId, {
        branch: creation.branch,
        worktreePath: creation.worktreePath,
      });
      await createDraftThreadWithoutTurn({
        threadId,
        projectId: project.id,
        title: options?.title ?? `${target.title} · 临时对话`,
        defaultProvider: selection.provider,
        providerInstances,
      });
      return threadId;
    } catch {
      return null;
    }
  };

  /**
   * Sends a companion turn directly from an artifact canvas/pill/dock without navigating away
   * from the Space workspace.
   */
  const startArtifactAssistantTurn = async (
    target: SpaceArtifactAssistantTarget,
    prompt: { readonly request: string; readonly context: string },
    isCurrent: () => boolean,
    options?: {
      readonly key?: string;
      readonly threadId?: ThreadId | null;
      readonly title?: string;
    },
  ): Promise<{ threadId: ThreadId; baselineTurnId: string | null; reused: boolean }> => {
    const key =
      options?.key ??
      artifactAssistantThreadKey("default", target.scopeSpaceId, target.kind, target.itemId);
    const { project, creation, selection } = await resolveArtifactCompanionContext(
      target,
      isCurrent,
    );
    const draftStore = useComposerDraftStore.getState();

    const dispatchFreshThread = async (bindAsPrimary: boolean): Promise<ThreadId> => {
      const threadId = createDraftThread({
        projectId: project.id,
        prompt: prompt.request,
        modelSelection: selection,
        runtimeMode: creation.runtimeMode,
        interactionMode: creation.interactionMode,
        envMode: creation.envMode,
        workingDirectory: creation.workingDirectory,
      });
      draftStore.setDraftThreadContext(threadId, {
        branch: creation.branch,
        worktreePath: creation.worktreePath,
      });
      if (prompt.context.trim()) {
        draftStore.addPastedTexts(threadId, [
          createPastedTextDraft({
            id: `space-companion:${target.kind}:${target.itemId}`,
            createdAt: new Date().toISOString(),
            text: prompt.context,
          }),
        ]);
      }
      const dispatch = await dispatchDraftThread({
        threadId,
        projectId: project.id,
        thread: null,
        defaultProvider: selection.provider,
        assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
        providerOptions: getProviderStartOptions(
          settings,
          selection.instanceId ?? selection.provider,
        ),
        providerInstances,
        title: options?.title ?? target.title,
      });
      if (dispatch.kind === "error") throw new Error(dispatch.message);
      if (dispatch.kind === "unavailable") {
        throw new LocalizedError("newThread.error.connectionUnavailable");
      }
      if (dispatch.kind === "open-thread") {
        throw new LocalizedError("newThread.error.folderNotReadySend");
      }
      if (bindAsPrimary) {
        pageAssistantThreads.set(key, threadId);
      }
      return threadId;
    };

    if (options?.threadId) {
      const state = useStore.getState();
      const targetSummary = state.sidebarThreadSummaryById[options.threadId];
      const baselineTurnId = targetSummary?.latestTurn?.turnId ?? null;
      draftStore.setPrompt(options.threadId, prompt.request);
      draftStore.setModelSelection(options.threadId, selection);
      if (prompt.context.trim()) {
        draftStore.addPastedTexts(options.threadId, [
          createPastedTextDraft({
            id: `space-companion:${target.kind}:${target.itemId}`,
            createdAt: new Date().toISOString(),
            text: prompt.context,
          }),
        ]);
      }
      const dispatch = await dispatchDraftThread({
        threadId: options.threadId,
        projectId: project.id,
        thread: targetSummary ?? null,
        defaultProvider: selection.provider,
        assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
        providerOptions: getProviderStartOptions(
          settings,
          selection.instanceId ?? selection.provider,
        ),
        providerInstances,
        title: options?.title ?? target.title,
      });
      if (dispatch.kind === "dispatched") {
        return { threadId: options.threadId, baselineTurnId, reused: true };
      }
      if (dispatch.kind === "error" && dispatch.outcomeUnknown) {
        throw new Error(dispatch.message);
      }
      draftStore.clearComposerContent(options.threadId);
    }

    return sendPageAssistantTurn({
      pageKey: key,
      reusable: () => reusablePageAssistantThread(key, project.id),
      sendToExisting: (summary) => {
        draftStore.setPrompt(summary.id, prompt.request);
        draftStore.setModelSelection(summary.id, selection);
        if (prompt.context.trim()) {
          draftStore.addPastedTexts(summary.id, [
            createPastedTextDraft({
              id: `space-companion:${target.kind}:${target.itemId}`,
              createdAt: new Date().toISOString(),
              text: prompt.context,
            }),
          ]);
        }
        return dispatchDraftThread({
          threadId: summary.id,
          projectId: project.id,
          thread: summary,
          defaultProvider: selection.provider,
          assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
          providerOptions: getProviderStartOptions(
            settings,
            selection.instanceId ?? selection.provider,
          ),
          providerInstances,
        });
      },
      discardUnsent: (threadId) => useComposerDraftStore.getState().clearComposerContent(threadId),
      startNewChat: () => dispatchFreshThread(true),
    });
  };

  /** Starts the agent of a page's assistant chat ahead of a send. */
  const warmPageAssistant = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.session.warm",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  };

  /** Stops the agent of a page's assistant chat; the chat itself stays. */
  const releasePageAssistant = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  };

  const startImagesConversation = (
    input: MossImagesConversationInput,
    onOpen: () => void,
  ): Promise<void> => {
    if (imagesStartRef.current) return imagesStartRef.current;
    const pending = (async () => {
      // The Images page is reachable with no chat open (e.g. straight from home).
      // Like 新对话, it then starts in the chats folder instead of failing with
      // 请先选择此会话的工作文件夹 (which the page used to show as an
      // unreachable image service).
      const homeProjectId = activeProjectId
        ? null
        : await ensureHomeChatProject(useWorkspacePathsStore.getState());
      const { api, project, creation } = resolveNewConversationContext(undefined, homeProjectId);
      if (!input.isCurrent()) throw new LocalizedError("newThread.error.accountChangedImages");
      const selection = input.modelSelection;
      const selectedInstanceId = selection.instanceId ?? selection.provider;
      if (
        resolveSelectableProviderInstanceId(settings, selection.provider, selectedInstanceId) !==
        selectedInstanceId
      )
        throw new LocalizedError("newThread.error.cliAccountChanged");
      const skill = await resolveMossImagesConversationSkill(input.modelId, async () => {
        if (selection.provider === "gemini") {
          return [];
        }
        const result = await api.provider.listSkills({
          provider: selection.provider,
          ...(selection.instanceId ? { instanceId: selection.instanceId } : {}),
          cwd: creation.worktreePath ?? creation.workingDirectory ?? project.cwd,
        });
        return result.skills;
      });
      if (!input.isCurrent()) throw new LocalizedError("newThread.error.accountChangedImages");
      const threadId = createDraftThread({
        projectId: project.id,
        prompt: mossImagesConversationPrompt(input, skill?.name),
        modelSelection: selection,
        runtimeMode: creation.runtimeMode,
        interactionMode: creation.interactionMode,
        envMode: creation.envMode,
        workingDirectory: creation.workingDirectory,
      });
      const draftStore = useComposerDraftStore.getState();
      draftStore.setDraftThreadContext(threadId, {
        branch: creation.branch,
        worktreePath: creation.worktreePath,
      });
      if (skill) draftStore.setSkills(threadId, [{ name: skill.name, path: skill.path }]);
      draftStore.addImages(threadId, mossImagesComposerAttachments(input.references));
      openChatThreadPage(threadId);
      await navigate({ to: "/$threadId", params: { threadId } });
      onOpen();
      if (!input.isCurrent()) return; // Preserve the unsent draft on an account change.
      const dispatch = await dispatchDraftThread({
        threadId,
        projectId: project.id,
        thread: null,
        defaultProvider: selection.provider,
        assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
        providerOptions: getProviderStartOptions(
          settings,
          selection.instanceId ?? selection.provider,
        ),
        providerInstances,
      });
      if (dispatch.kind === "error" || dispatch.kind === "unavailable")
        toastManager.add({
          type: "error",
          title:
            dispatch.kind === "error"
              ? dispatch.message
              : localizedMessage("newThread.error.connectionUnavailable"),
        });
    })();
    imagesStartRef.current = pending;
    void pending
      .finally(() => {
        if (imagesStartRef.current === pending) imagesStartRef.current = null;
      })
      .catch(() => undefined);
    return pending;
  };

  const handleNewThread = (
    projectId: ProjectId,
    options?: NewThreadOptions,
    navigation?: NewThreadNavigationOptions,
  ): Promise<ThreadId | null> => {
    const requestedProviderInstanceId = options?.providerInstanceId;
    const currentProviderSettings = () => {
      // The origin surface may unmount before a pending navigation settles.
      const latestServerSettings = queryClient.getQueryData(serverSettingsQueryOptions().queryKey);
      return latestServerSettings
        ? { ...settingsRef.current, ...serverSettingsToAppSettings(latestServerSettings) }
        : settingsRef.current;
    };
    // A resource discovered for one account must keep that account when opening its draft.
    const requestedInstanceIsSelectable = () => {
      if (requestedProviderInstanceId === undefined) return true;
      if (options?.provider === undefined) return false;
      const currentSettings = currentProviderSettings();
      return (
        getProviderInstanceOptions(currentSettings).some(
          (instance) =>
            instance.instanceId === requestedProviderInstanceId &&
            instance.provider === options.provider &&
            instance.driver === options.provider &&
            instance.enabled,
        ) &&
        resolveSelectableProviderInstanceId(
          currentSettings,
          options.provider,
          requestedProviderInstanceId,
        ) === requestedProviderInstanceId
      );
    };
    if (!requestedInstanceIsSelectable()) return Promise.resolve(null);
    // Project/thread targets are not authoritative until hydration completes. Read the
    // store at call time so a stale UI callback cannot mint a draft during hydration.
    if (!useStore.getState().threadsHydrated) {
      return Promise.resolve(null);
    }

    const entryPoint = options?.entryPoint ?? "chat";
    const defaultEnvMode =
      (entryPoint === "chat"
        ? useProjectEnvironmentStore.getState().envModeByProjectId[projectId]
        : undefined) ?? settings.defaultThreadEnvMode;
    if (entryPoint === "chat") {
      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByProjectId(projectId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      const project = useStore.getState().projects.find((candidate) => candidate.id === projectId);

      prefetchModelsForNewThread(queryClient, {
        settings,
        serverSettings: serverSettings ?? null,
        hiddenProviders: settings.hiddenProviders,
        providerOverride: options?.provider ?? null,
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectCwd: project?.cwd ?? null,
        draftWorktreePath: draftThread?.worktreePath ?? null,
        worktreePath: options?.worktreePath ?? null,
        hasExplicitWorktreePath: options?.worktreePath !== undefined,
        fresh: options?.fresh === true,
        envMode: options?.envMode ?? draftThread?.envMode ?? defaultEnvMode,
        serverCwd,
        providerStatuses,
        statusesReconciled: providerStatusesReconciled,
        providerOrder: settings.providerOrder,
        includeDroid: true,
      });
    }
    const wantsTemporaryThread = options?.temporary === true;
    const shouldSkipNavigation = navigation?.skipNavigation === true;
    const applyProviderOverride = (threadId: ThreadId) => {
      if (!options?.provider) {
        return;
      }
      const defaultModel = getDefaultModel(options.provider);
      if (!defaultModel) {
        return;
      }
      setModelSelection(threadId, {
        // A non-null default model implies a supported, non-retired provider.
        provider: options.provider as ModelSelection["provider"],
        instanceId: resolveSelectableProviderInstanceId(
          requestedProviderInstanceId === undefined ? settings : currentProviderSettings(),
          options.provider,
          requestedProviderInstanceId,
        ),
        model: defaultModel,
      });
    };
    // Puts back a composer draft that a draft-mapping change or the route swap removed. A
    // draft still present is newer than the snapshot (typed, sent, or re-selected while the
    // navigation settled) and must win, or the composer is rewritten mid-typing.
    const restoreComposerDraft = (
      threadId: ThreadId,
      draftState: ComposerThreadDraftState | null,
    ) => {
      if (!draftState) {
        return;
      }
      useComposerDraftStore.setState((state) => {
        if (state.draftsByThreadId[threadId] !== undefined) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: draftState,
          },
        };
      });
    };
    const activateThreadEntryPoint = (threadId: ThreadId) => {
      if (shouldSkipNavigation) {
        return;
      }
      if (entryPoint === "terminal") {
        openTerminalThreadPage(threadId, { terminalOnly: true });
        return;
      }
      openChatThreadPage(threadId);
    };
    const persistPendingSidebarPlacement = (threadId: ThreadId) => {
      const pending = options?.pendingSidebarPlacement;
      if (!pending) return;
      setPendingSidebarPlacement({
        threadId,
        sectionId: pending.sectionId as import("@moss/contracts").SidebarSectionId,
        sectionCreatedAt: pending.sectionCreatedAt,
      });
    };
    const {
      getDraftThread,
      getDraftThreadByProjectId,
      applyStickyState,
      clearDraftThread,
      registerDraftThread,
      setDraftThreadContext,
      setProjectDraftThreadId,
      setModelSelection,
    } = useComposerDraftStore.getState();
    const shouldForceFreshThread = options?.fresh === true;
    // Match Claude desktop's single-draft New chat flow: clicking New chat returns to
    // the project's existing chat draft (preserving typed text, attachments, and selected
    // toggles/models) rather than spawning duplicate empty drafts. Explicit fresh flows
    // (options.fresh === true) still mint a new draft and park the previous one.
    const findReusableOpenUnsentChatDraft = (): ProjectDraftThread | null => {
      if (entryPoint !== "chat") return null;
      const draftState = useComposerDraftStore.getState();
      const openTabIds = useOpenThreadTabsStore.getState().threadIds;
      for (const tabThreadId of openTabIds) {
        if (hasActiveComposerSend(tabThreadId)) continue;
        const candidate = draftState.draftThreadsByThreadId[tabThreadId];
        if (
          !candidate ||
          candidate.projectId !== projectId ||
          candidate.entryPoint !== "chat" ||
          candidate.promotedTo !== undefined
        ) {
          continue;
        }
        const composerDraft = draftState.draftsByThreadId[tabThreadId];
        if (composerDraft && composerThreadDraftIsPending(composerDraft)) {
          return { threadId: tabThreadId, ...candidate };
        }
      }
      return null;
    };

    const primaryStoredDraftCandidate = getDraftThreadByProjectId(projectId, entryPoint);
    const primaryStoredDraftComposer = primaryStoredDraftCandidate
      ? useComposerDraftStore.getState().draftsByThreadId[primaryStoredDraftCandidate.threadId]
      : undefined;
    const primaryStoredDraftHasContent =
      primaryStoredDraftComposer !== undefined &&
      composerDraftHasUnsentContent(primaryStoredDraftComposer);
    const storedDraftThreadCandidate =
      entryPoint === "chat" && !primaryStoredDraftHasContent
        ? (findReusableOpenUnsentChatDraft() ?? primaryStoredDraftCandidate)
        : primaryStoredDraftCandidate;
    const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
      ? getDraftThread(focusedThreadId)
      : null;
    const storedDraftThread =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      !(storedDraftThreadCandidate && hasActiveComposerSend(storedDraftThreadCandidate.threadId))
        ? storedDraftThreadCandidate
        : null;
    const latestActiveDraftThread: DraftThreadState | null =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      !(focusedThreadId && hasActiveComposerSend(focusedThreadId))
        ? latestActiveDraftThreadCandidate
        : null;
    const bootstrapPlan = resolveThreadBootstrapPlan({
      storedDraftThread,
      latestActiveDraftThread,
      entryPoint,
      projectId,
      routeThreadId: focusedThreadId,
    });
    const applyUsableStickyState = (threadId: ThreadId) => {
      // New chats open on the one default agent (Settings → 通用); a chat that picked
      // another agent doesn't move it.
      applyStickyState(threadId, settings.defaultProvider);
      if (options?.provider || !hasReconciledServerProviderStatuses(queryClient)) {
        return;
      }

      const draft = useComposerDraftStore.getState().draftsByThreadId[threadId] ?? null;
      const stickyProviderInstanceId = draft?.activeProvider ?? null;
      const stickyProvider = stickyProviderInstanceId
        ? resolveProviderForInstanceId(stickyProviderInstanceId)
        : null;
      if (
        !stickyProvider ||
        isProviderUsable(
          findProviderStatus(providerStatuses, stickyProvider, stickyProviderInstanceId),
        )
      ) {
        return;
      }

      // Back to the one default, never to whichever other agent happens to be signed in.
      const fallbackProvider = settings.defaultProvider;
      if (!hasUsableProviderAccount(providerStatuses, fallbackProvider)) {
        return;
      }

      setModelSelection(
        threadId,
        resolvePreferredComposerModelSelection({
          draft: draft
            ? {
                modelSelectionByProvider: draft.modelSelectionByProvider,
                activeProvider: fallbackProvider,
              }
            : null,
          threadModelSelection: null,
          projectModelSelection: null,
          defaultProvider: fallbackProvider,
          resolveProviderForInstanceId,
          defaultInstanceIdForProvider,
        }),
      );
    };
    const activeThreadSnapshot = createActiveThreadSnapshot(activeThread, projectId);
    const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(activeDraftThread, projectId);
    const resolveCreationState = (
      targetThreadId: ThreadId,
      draftThread: DraftThreadState | null,
      creationOptions: NewThreadOptions | undefined,
    ) =>
      resolveTerminalThreadCreationState({
        newChatRuntimeMode: useComposerDraftStore.getState().stickyRuntimeMode,
        activeDraftThread: activeDraftThreadSnapshot,
        activeThread: activeThreadSnapshot,
        defaultProvider: options?.provider ?? settings.defaultProvider,
        draftComposerState:
          useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
        draftThread,
        options: creationOptions,
        projectId,
        resolveProviderForInstanceId,
        defaultInstanceIdForProvider,
      });
    // Terminal-first threads need a real orchestration thread immediately so
    // the sidebar can render them as durable rows instead of draft-only routes.
    const createTerminalThread = async (
      threadId: ThreadId,
      creationState: ReturnType<typeof resolveCreationState>,
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await promoteThreadCreate(
        {
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          title: "New terminal",
          modelSelection: creationState.modelSelection,
          runtimeMode: creationState.runtimeMode,
          interactionMode: creationState.interactionMode,
          envMode: creationState.envMode,
          branch: creationState.branch,
          worktreePath: creationState.worktreePath,
          workingDirectory: creationState.workingDirectory,
          lastKnownPr: creationState.lastKnownPr,
          createdAt: new Date().toISOString(),
        },
        api,
      );
    };
    if (bootstrapPlan.kind === "stored") {
      return (async (): Promise<ThreadId> => {
        if (wantsTemporaryThread) {
          markTemporaryThread(bootstrapPlan.threadId);
        }
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedStoredDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const shouldPreserveStoredTerminalContext =
          entryPoint === "terminal" && bootstrapPlan.draftThread.entryPoint === "terminal";
        const shouldPreserveUnsentChatContext =
          entryPoint === "chat" &&
          preservedComposerDraft !== null &&
          composerDraftHasUnsentContent(preservedComposerDraft);
        const draftContextPatch =
          shouldPreserveStoredTerminalContext || shouldPreserveUnsentChatContext
            ? null
            : buildDraftThreadContextPatch(entryPoint, options);
        const creationOptions = shouldPreserveStoredTerminalContext ? undefined : options;
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, {
          entryPoint,
          ...(entryPoint === "chat" ? { preservePreviousDraft: true } : {}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (focusedThreadId === bootstrapPlan.threadId || shouldSkipNavigation) {
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(
                bootstrapPlan.threadId,
                resolvedStoredDraftThread,
                creationOptions,
              ),
            );
          }
          return bootstrapPlan.threadId;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: bootstrapPlan.threadId },
          ...(navigation?.search ? { search: navigation.search } : {}),
          ...(navigation?.replace === true ? { replace: true } : {}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(
              bootstrapPlan.threadId,
              resolvedStoredDraftThread,
              creationOptions,
            ),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    if (bootstrapPlan.kind === "route") {
      return (async (): Promise<ThreadId> => {
        if (wantsTemporaryThread) {
          markTemporaryThread(bootstrapPlan.threadId);
        }
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedActiveDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const shouldPreserveUnsentChatContext =
          entryPoint === "chat" &&
          preservedComposerDraft !== null &&
          composerDraftHasUnsentContent(preservedComposerDraft);
        const draftContextPatch = shouldPreserveUnsentChatContext
          ? null
          : buildDraftThreadContextPatch(entryPoint, options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, {
          entryPoint,
          ...(entryPoint === "chat" ? { preservePreviousDraft: true } : {}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(bootstrapPlan.threadId, resolvedActiveDraftThread, options),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    const pendingNavigation = runDraftNavigationOnce(
      draftNavigationSlotKey(projectId, entryPoint),
      async (signal) => {
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const draftSeed = createFreshDraftThreadSeed({
          createdAt,
          entryPoint,
          options,
          defaultEnvMode,
          newChatRuntimeMode: useComposerDraftStore.getState().stickyRuntimeMode,
        });
        const containerDefaults = await resolveGroupContainerThreadDefaults({
          projectId,
          entryPoint,
        });
        // Account availability may have changed while preparing the destination.
        if (!requestedInstanceIsSelectable()) return null;
        const committed = await stageDraftNavigation({
          signal,
          // Keep the previous routed draft alive while the destination loads. Replacing the
          // project's primary slot earlier makes the route guard redirect the old URL to Home.
          stage: () => {
            if (wantsTemporaryThread) {
              markTemporaryThread(threadId);
            }
            registerDraftThread(threadId, { projectId, ...draftSeed });
            activateThreadEntryPoint(threadId);
            // Seed the draft from the sticky (last-used) selection so a new chat
            // reopens with the model and options used most recently.
            applyUsableStickyState(threadId);
            if (containerDefaults) {
              applyGroupWorkerRoutingDefaults({
                threadId,
                defaults: containerDefaults,
                providerStatuses: providerStatusesReconciled ? providerStatuses : [],
              });
            }
            applyProviderOverride(threadId);
          },
          // Mark the draft-landing navigation as a transition so the new route
          // subtree renders interruptibly and the browser can paint the chat
          // mount loader immediately instead of freezing on the synchronous commit.
          navigate: () =>
            new Promise<void>((resolve, reject) => {
              startTransition(() => {
                navigate({
                  to: "/$threadId",
                  params: { threadId },
                  ...(navigation?.search ? { search: navigation.search } : {}),
                  ...(navigation?.replace === true ? { replace: true } : {}),
                }).then(resolve, reject);
              });
            }),
          // TanStack resolves an older navigate() promise when a newer navigation supersedes it.
          // Verify the committed route before deleting the previous project draft.
          isDestinationActive: () =>
            router.state.location.pathname === `/${threadId}` && requestedInstanceIsSelectable(),
          // A chat draft this replaces keeps its unsent content (parked, on the Tasks board);
          // prefilled flows (创建插件 / 技能 / 应用) take the slot this way too.
          finalize: () =>
            setProjectDraftThreadId(projectId, threadId, {
              ...draftSeed,
              ...(navigation?.preservePreviousDraft === true || entryPoint === "chat"
                ? { preservePreviousDraft: true }
                : {}),
            }),
          rollback: () => {
            clearDraftThread(threadId);
            clearTerminalState(threadId);
            if (wantsTemporaryThread) {
              clearTemporaryThread(threadId);
            }
          },
        });
        if (!committed) {
          return null;
        }
        if (entryPoint === "terminal") {
          await createTerminalThread(
            threadId,
            resolveCreationState(threadId, getDraftThread(threadId), options),
          );
        }
        return threadId;
      },
    );
    if (requestedProviderInstanceId === undefined) return pendingNavigation;
    return pendingNavigation.then((threadId) => {
      if (threadId === null) return null;
      // A different account can own an in-flight navigation for this project slot.
      // Reject its result without rewriting or deleting that operation's draft.
      const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
      const selection = draft?.activeProvider
        ? draft.modelSelectionByProvider[draft.activeProvider]
        : getThreadFromState(useStore.getState(), threadId)?.modelSelection;
      return requestedInstanceIsSelectable() &&
        selection?.provider === options?.provider &&
        selection?.instanceId === requestedProviderInstanceId
        ? threadId
        : null;
    });
  };

  // Images needs the same durable conversation/folder identity as the composer,
  // but opening it must not send the unsent prompt or start a paid model turn.
  const prepareActiveThreadForCanvas = useCallback(
    async (options?: CanvasThreadPreparation): Promise<ThreadId | null> => {
      if (activeThread) return activeThread.id;
      if (!activeDraftThread || !routeThreadId) return null;
      const api = readNativeApi();
      if (!api) throw new LocalizedError("newThread.error.canvasUnavailable");
      const project = projects.find((entry) => entry.id === activeDraftThread.projectId);
      if (!project) throw new LocalizedError("newThread.error.folderNotReadyRetry");
      const creation = resolveTerminalThreadCreationState({
        activeDraftThread,
        activeThread: null,
        draftThread: activeDraftThread,
        draftComposerState:
          useComposerDraftStore.getState().draftsByThreadId[routeThreadId] ?? null,
        defaultProvider: settings.defaultProvider,
        projectId: activeDraftThread.projectId,
        options: undefined,
        resolveProviderForInstanceId: (id) =>
          providerInstances.find((instance) => instance.instanceId === id)?.provider ?? null,
        defaultInstanceIdForProvider: (provider) =>
          newChatProviderInstanceIdFrom(providerInstances, provider),
      });
      return promoteCanvasDraftThread(
        {
          threadId: routeThreadId,
          projectId: activeDraftThread.projectId,
          creation,
          ...(options?.listedAfterFirstSend ? { listedAfterFirstSend: true } : {}),
        },
        api,
      );
    },
    [
      activeThread,
      activeDraftThread,
      routeThreadId,
      projects,
      providerInstances,
      settings.defaultProvider,
    ],
  );

  return {
    startPageConversation,
    startPageAiTurn,
    startPageAssistantTurn,
    preparePageAssistant,
    prepareArtifactAssistant,
    startArtifactAssistantTurn,
    createTemporaryArtifactSidechat,
    resolveExistingArtifactThread,
    describeArtifactAgent,
    warmPageAssistant,
    releasePageAssistant,
    describePageAgent,
    startImagesConversation,
    startLibraryConversation,
    prepareActiveThreadForCanvas,
    activeDraftThread,
    activeProjectId,
    activeThread,
    activeContextThreadId: focusedThreadId,
    handleNewThread,
    projects,
    routeThreadId,
  };
}
