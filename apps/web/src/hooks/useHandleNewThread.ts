import {
  type ModelSelection,
  type PagesReadResult,
  type ProjectId,
  type ProviderInstanceId,
  ThreadId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startTransition, useCallback, useMemo, useRef } from "react";
import {
  getProviderInstanceOptions,
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  resolveSelectableProviderInstanceId,
  serverSettingsToAppSettings,
  useAppSettings,
} from "../appSettings";
import { prefetchModelsForNewThread } from "../lib/providerModelPrefetch";
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
  applyGroupWorkerRoutingDefaults,
  resolveGroupContainerThreadDefaults,
} from "../lib/groupWorkerRouting";
import {
  findProviderStatus,
  isProviderUsable,
  resolveAvailableProviderPreference,
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
import { dispatchDraftThread } from "../lib/draftThreadDispatch";
import {
  mossImagesComposerAttachments,
  mossImagesConversationPrompt,
  resolveMossImagesConversationSkill,
  type MossImagesConversationInput,
} from "../lib/mossImagesConversation";
import { toastManager } from "../components/ui/toast";
import type { MossLibraryItem } from "../components/MossLibrarySurface.logic";
import { readGeneratedImageContextFile } from "../lib/generatedImageContextMenu";
import { formatComposerMentionToken } from "../lib/composerMentions";
import { getThreadFromState } from "../threadDerivation";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { setPendingSidebarPlacement } from "../pendingSidebarPlacement";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

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

  const resolveNewConversationContext = (originThreadId?: string) => {
    const api = readNativeApi();
    const origin = originThreadId
      ? getThreadFromState(useStore.getState(), originThreadId as ThreadId)
      : undefined;
    const sourceThread = origin ?? activeThread;
    const sourceDraft = origin ? null : activeDraftThread;
    const projectId = sourceDraft?.projectId ?? sourceThread?.projectId ?? activeProjectId;
    const project = useStore.getState().projects.find((entry) => entry.id === projectId);
    if (!api || !project || !useStore.getState().threadsHydrated)
      throw new Error("请先选择此会话的工作文件夹。");
    const creation = resolveTerminalThreadCreationState({
      activeDraftThread: sourceDraft,
      activeThread: sourceThread,
      draftThread: sourceDraft,
      draftComposerState:
        !origin && focusedThreadId
          ? (useComposerDraftStore.getState().draftsByThreadId[focusedThreadId] ?? null)
          : null,
      defaultProvider: settings.defaultProvider,
      projectId: project.id,
      projectDefaultModelSelection: project.defaultModelSelection,
      options: resolveInheritedThreadContext({
        activeThread: sourceThread,
        activeDraftThread: sourceDraft,
      }),
      resolveProviderForInstanceId,
    });
    if (creation.envMode === "worktree" && !creation.worktreePath)
      throw new Error("工作文件夹尚未就绪，请稍后发送。");
    return { api, project, creation };
  };

  const startLibraryConversation = async (
    items: readonly MossLibraryItem[],
    onOpen: () => void,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent()) throw new Error("账号已变化，请重新打开资料库。");
    const { project, creation } = resolveNewConversationContext(items[0]?.originationThreadId);
    const files = await Promise.all(
      items
        .filter((item) => item.kind === "image")
        .map(async (item) => {
          if (!item.thumbnailUrl) throw new Error("图像暂时无法读取，请刷新资料库。");
          return readGeneratedImageContextFile({
            image: { src: item.thumbnailUrl, name: item.title },
            resolveImageUrl: ({ src }) => src,
            fetchCredentials: "include",
          });
        }),
    );
    if (!isCurrent()) throw new Error("账号已变化，请重新打开资料库。");
    const documents = items.filter((item) => item.kind !== "image");
    if (documents.some((item) => !item.path))
      throw new Error("此文件尚未保存到本地，请先导入文件。");
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
    if (!isCurrent()) throw new Error("账号已变化，请重新打开资料空间。");
    const { project, creation } = resolveNewConversationContext(
      document.page.sourceThreadId ?? undefined,
    );
    if ((project.spaceId ?? null) !== document.page.scopeSpaceId)
      throw new Error("请先选择与此页面相同工作区内的工作文件夹。");
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

  const startImagesConversation = (
    input: MossImagesConversationInput,
    onOpen: () => void,
  ): Promise<void> => {
    if (imagesStartRef.current) return imagesStartRef.current;
    const pending = (async () => {
      const { api, project, creation } = resolveNewConversationContext();
      if (!input.isCurrent()) throw new Error("账号已变化，请重新打开图像页面。");
      const selection = input.modelSelection;
      const selectedInstanceId = selection.instanceId ?? selection.provider;
      if (
        resolveSelectableProviderInstanceId(settings, selection.provider, selectedInstanceId) !==
        selectedInstanceId
      )
        throw new Error("所选 CLI 账号已变化，请重新选择后发送。");
      const skill = await resolveMossImagesConversationSkill(input.modelId, async () => {
        const result = await api.provider.listSkills({
          provider: selection.provider,
          ...(selection.instanceId ? { instanceId: selection.instanceId } : {}),
          cwd: creation.worktreePath ?? creation.workingDirectory ?? project.cwd,
        });
        return result.skills;
      });
      if (!input.isCurrent()) throw new Error("账号已变化，请重新打开图像页面。");
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
            dispatch.kind === "error" ? dispatch.message : "连接暂不可用，描述已保留在新会话。",
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
        projectDefaultProvider: project?.defaultModelSelection?.provider ?? null,
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
        sectionId: pending.sectionId as import("@synara/contracts").SidebarSectionId,
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

    const storedDraftThreadCandidate = getDraftThreadByProjectId(projectId, entryPoint);
    const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
      ? getDraftThread(focusedThreadId)
      : null;
    const storedDraftThread =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      !(storedDraftThreadCandidate && hasActiveComposerSend(storedDraftThreadCandidate.threadId)) &&
      storedDraftThreadCandidate?.isTemporary !== true
        ? storedDraftThreadCandidate
        : null;
    const latestActiveDraftThread: DraftThreadState | null =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      !(focusedThreadId && hasActiveComposerSend(focusedThreadId)) &&
      latestActiveDraftThreadCandidate?.isTemporary !== true
        ? latestActiveDraftThreadCandidate
        : null;
    const bootstrapPlan = resolveThreadBootstrapPlan({
      storedDraftThread,
      latestActiveDraftThread,
      entryPoint,
      projectId,
      routeThreadId: focusedThreadId,
    });
    // Read from the store at call time so post-sync sidebar flows can use the latest project defaults.
    const projectDefaultModelSelection =
      useStore.getState().projects.find((project) => project.id === projectId)
        ?.defaultModelSelection ?? null;
    const applyUsableStickyState = (threadId: ThreadId) => {
      applyStickyState(threadId);
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

      const fallbackProvider = resolveAvailableProviderPreference({
        preferredProvider: projectDefaultModelSelection?.provider ?? settings.defaultProvider,
        statuses: providerStatuses,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
      });
      if (!isProviderUsable(findProviderStatus(providerStatuses, fallbackProvider))) {
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
          projectModelSelection: projectDefaultModelSelection,
          defaultProvider: fallbackProvider,
          resolveProviderForInstanceId,
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
        activeDraftThread: activeDraftThreadSnapshot,
        activeThread: activeThreadSnapshot,
        defaultProvider: options?.provider ?? settings.defaultProvider,
        draftComposerState:
          useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
        draftThread,
        options: creationOptions,
        projectDefaultModelSelection,
        projectId,
        resolveProviderForInstanceId,
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
        const draftContextPatch = shouldPreserveStoredTerminalContext
          ? null
          : buildDraftThreadContextPatch(entryPoint, options);
        const creationOptions = shouldPreserveStoredTerminalContext ? undefined : options;
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
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
        const draftContextPatch = buildDraftThreadContextPatch(entryPoint, options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
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
          finalize: () =>
            setProjectDraftThreadId(projectId, threadId, {
              ...draftSeed,
              ...(navigation?.preservePreviousDraft === true
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
  const prepareActiveThreadForCanvas = useCallback(async (): Promise<ThreadId | null> => {
    if (activeThread) return activeThread.id;
    if (!activeDraftThread || !routeThreadId) return null;
    const api = readNativeApi();
    if (!api) throw new Error("画布连接暂不可用，请稍后重试。");
    const project = projects.find((entry) => entry.id === activeDraftThread.projectId);
    if (!project) throw new Error("工作文件夹尚未就绪，请稍后重试。");
    const creation = resolveTerminalThreadCreationState({
      activeDraftThread,
      activeThread: null,
      draftThread: activeDraftThread,
      draftComposerState: useComposerDraftStore.getState().draftsByThreadId[routeThreadId] ?? null,
      defaultProvider: settings.defaultProvider,
      projectId: activeDraftThread.projectId,
      projectDefaultModelSelection: project.defaultModelSelection,
      options: undefined,
      resolveProviderForInstanceId: (id) =>
        providerInstances.find((instance) => instance.instanceId === id)?.provider ?? null,
    });
    return promoteCanvasDraftThread(
      { threadId: routeThreadId, projectId: activeDraftThread.projectId, creation },
      api,
    );
  }, [
    activeThread,
    activeDraftThread,
    routeThreadId,
    projects,
    providerInstances,
    settings.defaultProvider,
  ]);

  return {
    startPageConversation,
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
