import { ThreadId, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import { useQuery } from "@tanstack/react-query";
import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  goBackInAppHistory,
  goForwardInAppHistory,
  resolveAppNavigationState,
} from "../appNavigation";
import { AppRailSlotProvider } from "../components/AppRail";
import { AppShellTopStrip } from "../components/AppShellTopStrip";
import { DesktopApplicationMenuBar } from "../components/DesktopApplicationMenuBar";
import { SidebarLeadingControlsDock } from "../components/SidebarHeaderNavigationControls";
import { resolveSelectableProviderInstanceId, useAppSettings } from "../appSettings";
import ShortcutsDialog from "../components/ShortcutsDialog";
import { RecentViewSwitcher } from "../components/RecentViewSwitcher";
import { shouldRenderTerminalWorkspace } from "../components/ChatView.logic";
import ThreadSidebar from "../components/Sidebar";
import { isElectron } from "../env";
import { matchesFixedShortcut } from "../fixedShortcuts";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useHandleNewGroupChat } from "../hooks/useHandleNewGroupChat";
import { useTemporaryThreadLifecycle } from "../hooks/useTemporaryThreadLifecycle";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useRecentViewSwitcher } from "../hooks/useRecentViewSwitcher";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "../lib/projectShortcutTargets";
import { resolveInheritedThreadContext } from "../lib/threadBootstrap";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { startFreshChatForActiveSurface } from "../lib/startContainerChat";
import { resolveGroupChatTargetProjectId } from "../components/SidebarGroupsSurface.logic";
import { isGroupContainerProject } from "../lib/groupProjects";
import { isOrdinarySpaceProject } from "../lib/spaces";
import {
  isKeyboardShortcutsHelpShortcut,
  isShortcutDispatchSuspended,
  resolveShortcutCommand,
} from "../keybindings";
import { useStore } from "../store";
import { createProjectLastActivityAtSelector } from "../storeSelectors";
import { useSpacesUiStore } from "../spacesUiStore";
import { railItemShowsPanel } from "../appRail.logic";
import { useRailShellStore } from "../railShellStore";
import {
  MOSS_CANVAS_CLOSE_EVENT,
  registerMossCanvasHost,
  sanitizeMossCanvasImageFocus,
  type MossCanvasImageFocus,
} from "../lib/mossCanvasBridge";
import { flushConversationImageEditors } from "../lib/conversationImageComposer";
import { openMossImagesOriginCanvas } from "../lib/mossImagesCanvasNavigation";
import { useRightDockStore } from "../rightDockStore";
import {
  MossImagesDestination,
  type MossImagesCanvasRequest,
} from "../components/MossImagesDestination";
import { ensureNativeApi } from "../nativeApi";
import { MossDataSpaceDestination } from "../components/MossDataSpaceDestination";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { onServerMaintenanceUpdated } from "../wsNativeApi";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { toastManager } from "~/components/ui/toast";
import {
  Sidebar,
  SIDEBAR_OFFCANVAS_MOTION_CLASS,
  SidebarInstanceProvider,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "~/components/ui/sidebar";
import type { SidebarResizableOptions } from "~/components/ui/sidebar";
import { cn, getNavigatorPlatform } from "~/lib/utils";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

// Single source of truth for the thread sidebar resize behavior. Shared by <Sidebar>
// and the detached content-seam <SidebarRail> (via SidebarInstanceProvider) so the
// drag handle keeps working even though the rail lives outside <Sidebar> (above the card).
const THREAD_SIDEBAR_RESIZABLE: SidebarResizableOptions = {
  minWidth: THREAD_SIDEBAR_MIN_WIDTH,
  shouldAcceptWidth: ({ nextWidth, wrapper }) =>
    wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
  storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
};
const MAINTENANCE_EVENT_STALE_MS = 5 * 60 * 1000;

type MaintenanceToastId = ReturnType<typeof toastManager.add>;

function ThreadRetentionMaintenanceToast() {
  const toastIdRef = useRef<MaintenanceToastId | null>(null);

  useEffect(() => {
    return onServerMaintenanceUpdated((event) => {
      if (event.type !== "maintenance" || event.payload.task !== "thread-retention") {
        return;
      }

      // `deletedCount` is the legacy wire name; retention now archives.
      const { state, deletedCount: archivedCount, totalCount, error } = event.payload;
      const eventMs = Date.parse(event.payload.at);
      const isStaleEvent = Number.isFinite(eventMs)
        ? Date.now() - eventMs > MAINTENANCE_EVENT_STALE_MS
        : false;
      if (isStaleEvent && toastIdRef.current === null) {
        return;
      }

      if (state === "started") {
        toastIdRef.current = toastManager.add({
          type: "loading",
          title: "Archiving old chats...",
          description: "Preparing background maintenance.",
          timeout: 0,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      if (state === "progress") {
        const toastId =
          toastIdRef.current ??
          toastManager.add({
            type: "loading",
            title: "Archiving old chats...",
            timeout: 0,
            data: { allowCrossThreadVisibility: true },
          });
        toastIdRef.current = toastId;
        toastManager.update(toastId, {
          type: "loading",
          title: "Archiving old chats...",
          description:
            totalCount && totalCount > 0
              ? `${archivedCount ?? 0} of ${totalCount} chats archived.`
              : `${archivedCount ?? 0} chats archived.`,
          timeout: 0,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      if (state === "failed") {
        const toastId = toastIdRef.current;
        toastIdRef.current = null;
        if (toastId) {
          toastManager.update(toastId, {
            type: "warning",
            title: "Chat maintenance paused",
            description: error ?? "Old chats will be retried later.",
            timeout: 6000,
            data: { allowCrossThreadVisibility: true },
          });
          return;
        }
        toastManager.add({
          type: "warning",
          title: "Chat maintenance paused",
          description: error ?? "Old chats will be retried later.",
          timeout: 6000,
          data: { allowCrossThreadVisibility: true },
        });
        return;
      }

      const toastId = toastIdRef.current;
      toastIdRef.current = null;
      if (!toastId) return;
      toastManager.update(toastId, {
        type: "success",
        title: "Old chats archived",
        description:
          archivedCount && archivedCount > 0
            ? `${archivedCount} old chats moved to Settings → Archived, where you can restore them.`
            : "No old chats needed archiving.",
        timeout: 3500,
        data: { allowCrossThreadVisibility: true },
      });
    });
  }, []);

  return null;
}

function resolveBrowserNavigationShortcut(
  event: KeyboardEvent,
  platform: string,
): "back" | "forward" | null {
  if (matchesFixedShortcut(event, "navigation.back", platform)) return "back";
  if (matchesFixedShortcut(event, "navigation.forward", platform)) return "forward";
  return null;
}

function isRecentViewSwitcherCommitKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

function ChatRouteGlobalShortcuts() {
  const navigate = useNavigate();
  const isGroupsRoute = useLocation({
    select: (location) =>
      location.pathname.startsWith("/hubs") ||
      location.pathname.startsWith("/groups") ||
      location.pathname.startsWith("/studio"),
  });
  const { toggleSidebar } = useSidebar();
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const {
    activeContextThreadId,
    activeDraftThread,
    activeProjectId,
    activeThread,
    handleNewThread,
    projects,
  } = useHandleNewThread();
  const {
    recentSwitcherState,
    recentViewEntries,
    openOrAdvanceRecentSwitcher,
    commitRecentSwitcherSelection,
    cancelRecentSwitcher,
  } = useRecentViewSwitcher({
    activeContextThreadId,
    activeDraftThread,
    projects,
  });
  const { handleNewChat } = useHandleNewChat();
  const { handleNewGroupChat } = useHandleNewGroupChat();
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const setLatestProjectId = useLatestProjectStore((state) => state.setLatestProjectId);
  const clearLatestProjectId = useLatestProjectStore((state) => state.clearLatestProjectId);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const selectProjectLastActivityAt = useMemo(() => createProjectLastActivityAtSelector(), []);
  const projectLastActivityAt = useStore(selectProjectLastActivityAt);
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  useTemporaryThreadLifecycle(activeContextThreadId);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const platform = getNavigatorPlatform();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const { settings } = useAppSettings();
  const activeThreadTerminalState = activeContextThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, activeContextThreadId)
    : null;
  const terminalOpen = activeThreadTerminalState?.terminalOpen ?? false;
  const activeProject =
    activeProjectId !== null
      ? (projects.find((project) => project.id === activeProjectId) ?? null)
      : null;
  const activeProjectScripts = activeProject?.kind === "project" ? activeProject.scripts : [];
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: activeThreadTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  // Shortcuts that target "a project" must stay inside the Space you are looking at, or
  // mod+alt+arrow would switch Space and the next new-thread shortcut would drop you back
  // out of it.
  const workspacePaths = useMemo(
    () => ({ homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot }),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, studioWorkspaceRoot],
  );
  const activeSpaceProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          isOrdinarySpaceProject(project, workspacePaths) &&
          (project.spaceId ?? null) === activeSpaceId,
      ),
    [activeSpaceId, projects, workspacePaths],
  );
  const groupProjects = useMemo(
    () => projects.filter((project) => isGroupContainerProject(project, workspacePaths)),
    [projects, workspacePaths],
  );
  const currentProjectId = resolveCurrentProjectTargetId(
    activeSpaceProjects,
    activeProject?.id ?? null,
  );
  // The remembered project is global, so it is unusable the moment you switch Space. Fall
  // back to this Space's most recently touched project rather than to nothing.
  const latestUsableProjectId = useMemo(
    () =>
      resolveLatestProjectTargetIdWithFallback(
        activeSpaceProjects,
        latestProjectId,
        projectLastActivityAt,
      ),
    [activeSpaceProjects, latestProjectId, projectLastActivityAt],
  );
  // Deliberately unscoped: the persisted id is only cleared once the project is gone from
  // the app entirely, not merely absent from the Space you happen to be in.
  const persistedLatestProjectStillExists = resolveLatestProjectTargetId(projects, latestProjectId);
  // A bare "new chat" on the Groups surface lands in the active (or first) group; with
  // no groups at all there is no implicit container — the /hubs empty state shows.
  const handleNewGroupChatForSurface = useCallback(
    (options?: { fresh?: boolean }) => {
      const targetProjectId = resolveGroupChatTargetProjectId({
        activeProject,
        groupProjects,
      });
      if (!targetProjectId) {
        return navigate({ to: "/hubs" }).then((): { ok: true; threadId: null } => ({
          ok: true,
          threadId: null,
        }));
      }
      return handleNewGroupChat(targetProjectId, options);
    },
    [activeProject, groupProjects, handleNewGroupChat, navigate],
  );
  const handleNewChatForActiveSurface = useCallback(
    () =>
      startFreshChatForActiveSurface({
        activeProject,
        isGroupsRoute,
        paths: workspacePaths,
        handleNewChat,
        handleNewGroupChat: handleNewGroupChatForSurface,
      }),
    [activeProject, handleNewChat, handleNewGroupChatForSurface, isGroupsRoute, workspacePaths],
  );

  useEffect(() => {
    if (!currentProjectId) {
      return;
    }
    setLatestProjectId(currentProjectId);
  }, [currentProjectId, setLatestProjectId]);

  useEffect(() => {
    if (threadsHydrated && latestProjectId && persistedLatestProjectStillExists === null) {
      clearLatestProjectId(latestProjectId);
    }
  }, [clearLatestProjectId, latestProjectId, persistedLatestProjectStillExists, threadsHydrated]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      // The shortcut recorder owns the keyboard while it is open, including the fixed
      // chords below that no keybinding lookup would catch.
      if (event.defaultPrevented || isShortcutDispatchSuspended()) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      };

      if (recentSwitcherState && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRecentSwitcher();
        return;
      }

      if (recentSwitcherState && isRecentViewSwitcherCommitKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        commitRecentSwitcherSelection();
        return;
      }

      if (isKeyboardShortcutsHelpShortcut(event, platform)) {
        event.preventDefault();
        event.stopPropagation();
        setShortcutsDialogOpen(true);
        return;
      }

      const appNavigationShortcut = isElectron
        ? resolveBrowserNavigationShortcut(event, platform)
        : null;
      if (appNavigationShortcut) {
        event.preventDefault();
        event.stopPropagation();
        const navigationState = resolveAppNavigationState();
        if (appNavigationShortcut === "back" && navigationState.canGoBack) {
          goBackInAppHistory();
        }
        if (appNavigationShortcut === "forward" && navigationState.canGoForward) {
          goForwardInAppHistory();
        }
        return;
      }

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, { context: shortcutContext });
      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }

      if (!command) return;

      if (command === "view.recent.next" || command === "view.recent.previous") {
        event.preventDefault();
        event.stopPropagation();
        // Ignore auto-repeat: holding Ctrl+Tab should not race-advance the selection.
        if (event.repeat) return;
        openOrAdvanceRecentSwitcher(command === "view.recent.next" ? "next" : "previous");
        return;
      }

      if (command === "chat.newChat" || command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void handleNewChatForActiveSurface();
        return;
      }

      if (command === "chat.newLatestProject") {
        if (!latestUsableProjectId) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(latestUsableProjectId);
        return;
      }

      if (command === "chat.newTerminal") {
        const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(target.projectId, {
          ...(target.inheritContext
            ? resolveInheritedThreadContext({ activeThread, activeDraftThread })
            : {}),
          entryPoint: "terminal",
        });
        return;
      }

      if (
        command === "chat.newClaude" ||
        command === "chat.newCodex" ||
        command === "chat.newCursor"
      ) {
        const provider =
          command === "chat.newClaude"
            ? "claudeAgent"
            : command === "chat.newCodex"
              ? "codex"
              : "cursor";
        const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const providerInstanceId = resolveSelectableProviderInstanceId(settings, provider);
          const providerAvailability = await resolveProviderSendAvailabilityWithRefresh({
            provider,
            instanceId: providerInstanceId,
            statuses: providerStatuses,
            refreshStatuses: () => refreshProviderStatuses({ silent: true }),
          });
          if (!providerAvailability.usable) {
            toastManager.add({
              type: "error",
              title: providerAvailability.unavailableReason,
            });
            return;
          }
          await handleNewThread(target.projectId, { provider });
        })();
        return;
      }

      if (command !== "chat.new") return;
      // Fall back to the most recent project when none is focused and let the
      // shared bootstrap apply that project's preferred environment.
      const target = resolveNewThreadTarget({ currentProjectId, latestUsableProjectId });
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void handleNewThread(target.projectId);
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [
    activeDraftThread,
    activeThread,
    cancelRecentSwitcher,
    clearSelection,
    commitRecentSwitcherSelection,
    currentProjectId,
    handleNewChatForActiveSurface,
    handleNewThread,
    keybindings,
    latestUsableProjectId,
    openOrAdvanceRecentSwitcher,
    platform,
    providerStatuses,
    refreshProviderStatuses,
    recentSwitcherState,
    selectedThreadIdsSize,
    settings,
    terminalOpen,
    terminalWorkspaceOpen,
    toggleSidebar,
  ]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "toggle-sidebar") {
        toggleSidebar();
        return;
      }
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, toggleSidebar]);

  return (
    <>
      <ShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
        keybindings={keybindings}
        projectScripts={activeProjectScripts}
        platform={platform}
        context={{
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          terminalWorkspaceOpen,
        }}
      />
      {recentSwitcherState ? (
        <RecentViewSwitcher
          entries={recentViewEntries}
          selectedIndex={recentSwitcherState.selectedIndex}
        />
      ) : null}
    </>
  );
}

function ChatRouteLayout() {
  const navigate = useNavigate();
  const router = useRouter();
  const {
    activeThread,
    activeContextThreadId,
    activeProjectId,
    projects,
    prepareActiveThreadForCanvas,
    startImagesConversation,
    startLibraryConversation,
    startPageConversation,
  } = useHandleNewThread();
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const voiceProject = projects.find(
    (project) =>
      project.id ===
      (activeProjectId ?? resolveLatestProjectTargetIdWithFallback(projects, latestProjectId)),
  );
  const isEditorView = useLocation({
    select: (location) => (location.search as { view?: unknown }).view === "editor",
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useIsMobile();
  // Kanban, Pull requests, and Automations take the full width; the panel
  // (Home/Spaces lists) only shows for the items that own one. Forced closed like the
  // editor view, so the route header takes over the toggle and traffic-light gutter.
  const railActiveItem = useRailShellStore((store) => store.activeItem);
  const railPanelView = useRailShellStore((store) => store.panelView);
  const selectRailPanelItem = useRailShellStore((store) => store.selectPanelItem);
  const railHidesPanel = !railItemShowsPanel(railActiveItem);
  // Moss destination surfaces (Images workspace / Library 资料库): the rail opens them
  // through the canvas bridge and they replace the route column, exactly like the
  // pre-merge Moss shell.
  const [destinationSurface, setDestinationSurface] = useState<"images" | "library" | null>(null);
  const originNavigationVersion = useRef(0);
  const [canvasRequest, setCanvasRequest] = useState<MossImagesCanvasRequest | null>(null);
  const consumeCanvasRequest = useCallback(() => setCanvasRequest(null), []);
  const activeCanvasThread = useRef(activeThread?.id ?? null);
  activeCanvasThread.current = activeThread?.id ?? null;
  const canvasLeaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const pendingCanvasDestination = useRef<"images" | "library" | null>(null);
  const registerCanvasLeaveGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    canvasLeaveGuard.current = guard;
  }, []);
  // Images keeps its own panel toggle (its top chrome dispatches moss-sidebar-toggle);
  // every other destination hides the chat panel outright.
  const [imagesSidebarVisible, setImagesSidebarVisible] = useState(false);
  const isDestinationSurface = destinationSurface !== null;
  const resolvedSidebarOpen =
    isEditorView || railHidesPanel
      ? false
      : isDestinationSurface
        ? destinationSurface === "images" && imagesSidebarVisible
        : sidebarOpen;
  const clearDestinationSurface = useCallback(() => {
    originNavigationVersion.current += 1;
    pendingCanvasDestination.current = null;
    setDestinationSurface(null);
    setCanvasRequest(null);
    // The rail's active item returns to the panel so exactly one rail item is active.
    selectRailPanelItem(railPanelView);
  }, [railPanelView, selectRailPanelItem]);
  const closeDestinationSurface = useCallback(async () => {
    originNavigationVersion.current += 1;
    if (await (canvasLeaveGuard.current?.() ?? Promise.resolve(true))) clearDestinationSurface();
  }, [clearDestinationSurface]);
  const openThreadCanvas = useCallback(
    async (id: string, image?: MossCanvasImageFocus) => {
      if (id !== activeCanvasThread.current) return;
      originNavigationVersion.current += 1;
      if (
        !(await (canvasLeaveGuard.current?.() ?? Promise.resolve(true))) ||
        !(await flushConversationImageEditors(id)) ||
        id !== activeCanvasThread.current
      )
        return;
      clearDestinationSurface();
      useRightDockStore.getState().openPane(ThreadId.makeUnsafe(id), {
        kind: "canvas",
        ...(image ? { canvasImage: image } : {}),
      });
    },
    [clearDestinationSurface],
  );
  const openOriginCanvas = useCallback(
    (
      id: string,
      image: MossCanvasImageFocus,
      isCurrent: () => boolean,
      beginNavigation: () => void,
    ) => {
      const version = ++originNavigationVersion.current;
      const railSelectionVersion = useRailShellStore.getState().selectionVersion;
      return openMossImagesOriginCanvas({
        threadId: id,
        image,
        isCurrent: () =>
          version === originNavigationVersion.current &&
          railSelectionVersion === useRailShellStore.getState().selectionVersion &&
          isCurrent(),
        beginNavigation,
        beforeLeave: () => canvasLeaveGuard.current?.() ?? Promise.resolve(true),
        flushCurrent: () =>
          activeContextThreadId
            ? flushConversationImageEditors(activeContextThreadId)
            : Promise.resolve(true),
        navigate: async (threadId) => {
          await navigate({ to: "/$threadId", params: { threadId }, search: {} });
          return router.state.location.pathname === `/${threadId}`;
        },
        openChat: (threadId) =>
          useTerminalStateStore.getState().openChatThreadPage(ThreadId.makeUnsafe(threadId)),
        openCanvas: (threadId, canvasImage) =>
          useRightDockStore.getState().openPane(ThreadId.makeUnsafe(threadId), {
            kind: "canvas",
            canvasImage,
          }),
        onOpened: clearDestinationSurface,
      });
    },
    [activeContextThreadId, clearDestinationSurface, navigate, router],
  );
  useEffect(() => {
    return registerMossCanvasHost((detail) => {
      if (detail.surface === "canvas") {
        const id = detail.threadId ?? activeCanvasThread.current;
        if (!id || id !== activeCanvasThread.current) return false;
        void openThreadCanvas(id, sanitizeMossCanvasImageFocus(detail.image));
        return true;
      }
      if (detail.surface === "images" || detail.surface === "library") {
        originNavigationVersion.current += 1;
        const next = detail.surface;
        // Content links bypass Sidebar's onSelect. Keep the rail in sync so its
        // destination reconciliation does not immediately dismiss the new surface.
        useRailShellStore.getState().selectRouteItem(next);
        if (destinationSurface !== null && next !== destinationSurface) {
          pendingCanvasDestination.current = next;
          void (canvasLeaveGuard.current?.() ?? Promise.resolve(true)).then((saved) => {
            if (pendingCanvasDestination.current !== next) return;
            pendingCanvasDestination.current = null;
            if (saved) setDestinationSurface(next);
            else useRailShellStore.getState().selectRouteItem(destinationSurface);
          });
        } else {
          pendingCanvasDestination.current = null;
          setDestinationSurface(next);
        }
        return true;
      }
      return false;
    });
  }, [destinationSurface, openThreadCanvas]);
  useEffect(
    () =>
      ensureNativeApi().orchestration.onDomainEvent((event) => {
        if (
          event.type !== "thread.activity-appended" ||
          event.payload.threadId !== activeCanvasThread.current ||
          event.payload.activity.kind !== "canvas.open.requested"
        )
          return;
        const value: unknown = event.payload.activity.payload;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const payload = value as Record<string, unknown>;
        if (payload.source !== "moss-mcp-canvas") return;
        void openThreadCanvas(
          String(event.payload.threadId),
          sanitizeMossCanvasImageFocus({
            jobId: payload.jobId,
            imageIndex: payload.imageIndex,
            action: "canvas",
          }),
        );
      }),
    [openThreadCanvas],
  );
  useEffect(() => {
    const onClose = () => {
      void closeDestinationSurface();
    };
    window.addEventListener(MOSS_CANVAS_CLOSE_EVENT, onClose);
    return () => window.removeEventListener(MOSS_CANVAS_CLOSE_EVENT, onClose);
  }, [closeDestinationSurface]);
  // Leaving the destination from anywhere else (another rail item, a thread, a route
  // change that reconciles the rail) closes the surface with it.
  useEffect(() => {
    if (!destinationSurface || railActiveItem === destinationSurface) return;
    if (pendingCanvasDestination.current === railActiveItem) return;
    let cancelled = false;
    void (canvasLeaveGuard.current?.() ?? Promise.resolve(true)).then((saved) => {
      if (cancelled) return;
      if (saved) setDestinationSurface(null);
      else useRailShellStore.getState().selectRouteItem(destinationSurface);
    });
    return () => {
      cancelled = true;
    };
  }, [destinationSurface, railActiveItem]);
  // Images top chrome owns the same split-panel affordance as the desktop shell. Keep
  // it event-based so the destination stays decoupled from Sidebar internals.
  useEffect(() => {
    const onToggleSidebar = () => {
      if (destinationSurface === "images") {
        setImagesSidebarVisible((visible) => !visible);
        return;
      }
      setSidebarOpen((open) => !open);
    };
    window.addEventListener("moss-sidebar-toggle", onToggleSidebar);
    return () => window.removeEventListener("moss-sidebar-toggle", onToggleSidebar);
  }, [destinationSurface]);
  useEffect(() => {
    if (destinationSurface !== "images") setImagesSidebarVisible(false);
  }, [destinationSurface]);
  // Toggling the panel open on a full-width route brings back the current panel item.
  const handleSidebarOpenChange = useCallback(
    (open: boolean) => {
      if (open && railHidesPanel) {
        selectRailPanelItem(railPanelView);
      }
      if (destinationSurface === "images") {
        setImagesSidebarVisible(open);
        return;
      }
      setSidebarOpen(open);
    },
    [railHidesPanel, railPanelView, selectRailPanelItem, destinationSurface],
  );
  // ThreadSidebar owns the existing rail actions and portals them into the fixed
  // desktop slot. The project panel can collapse without taking the rail with it.
  const [railSlot, setRailSlot] = useState<HTMLDivElement | null>(null);
  // The route column slides with the panel; the leading controls dock needs it to stay put.
  const [routeColumn, setRouteColumn] = useState<HTMLDivElement | null>(null);

  // The thread sidebar always lives on the left; the right dock is a separate surface.
  // It fills its clipping wrapper and sits on the panel tone.
  const sidebarElement = (
    <Sidebar
      side="left"
      collapsible="offcanvas"
      // Match the right dock's soft drawer slide (shared token) instead of the
      // shell's default `ease-linear`. Applied to the container + gap in lockstep.
      className={cn("h-full text-foreground", SIDEBAR_OFFCANVAS_MOTION_CLASS)}
      gapClassName={SIDEBAR_OFFCANVAS_MOTION_CLASS}
      transparentSurface
      resizable={THREAD_SIDEBAR_RESIZABLE}
    >
      <ThreadSidebar />
    </Sidebar>
  );

  // Chat column shell. The content-seam rail is the resize hit-area for the seam —
  // the visible straight divider + depth shadow live on the route surface (see
  // `.chat-content-card` in index.css). It sits OUTSIDE <Sidebar> so it stacks above
  // the card, so SidebarInstanceProvider re-supplies the same resize config/side it
  // would have gotten inside <Sidebar> (otherwise dragging to resize stops working).
  // `data-sidebar-side` on the provider selects the seam geometry.
  const mainContentShell = (
    <div
      ref={setRouteColumn}
      data-moss-destination-frame={isDestinationSurface ? "true" : undefined}
      className="relative flex h-svh min-h-0 min-w-0 flex-1"
    >
      <div aria-hidden className="app-rail-header-divider" />
      {isEditorView || isDestinationSurface ? null : (
        <SidebarInstanceProvider side="left" resizable={THREAD_SIDEBAR_RESIZABLE}>
          <SidebarRail placement="content-seam" />
        </SidebarInstanceProvider>
      )}
      {destinationSurface === "images" ? (
        <MossImagesDestination
          openCanvasInConversation
          threadId={activeThread?.id ?? null}
          contextThreadId={activeContextThreadId}
          onOpenOriginCanvas={openOriginCanvas}
          voiceProject={voiceProject}
          prepareThread={prepareActiveThreadForCanvas}
          onStartConversation={(input) => startImagesConversation(input, clearDestinationSurface)}
          onClose={clearDestinationSurface}
          onLeaveGuardChange={registerCanvasLeaveGuard}
          canvasRequest={canvasRequest}
          onCanvasRequestConsumed={consumeCanvasRequest}
        />
      ) : destinationSurface === "library" ? (
        <MossDataSpaceDestination
          onClose={closeDestinationSurface}
          threadId={activeThread?.id ?? null}
          prepareThread={prepareActiveThreadForCanvas}
          onCanvasLeaveGuardChange={registerCanvasLeaveGuard}
          onStartConversation={(items, isCurrent) =>
            startLibraryConversation(items, clearDestinationSurface, isCurrent)
          }
          onStartPageConversation={(document, isCurrent) =>
            startPageConversation(document, clearDestinationSurface, isCurrent)
          }
        />
      ) : (
        <Outlet />
      )}
    </div>
  );

  // The left column keeps the window-chrome strip above the fixed icon rail and
  // offcanvas project panel. The route column keeps its header on the shell band.
  // The panel wrapper clips its slide at the rail, leaving navigation available.
  // The strip height reaches CSS as a variable (see index.css).
  return (
    <SidebarProvider
      defaultOpen
      open={resolvedSidebarOpen}
      onOpenChange={handleSidebarOpenChange}
      className="h-svh overflow-hidden bg-[var(--app-rail-shell-background)]"
      style={{ "--app-top-strip-height": `${CHAT_SURFACE_HEADER_HEIGHT_PX}px` } as CSSProperties}
      data-sidebar-side="left"
      data-sidebar-layout="rail"
      data-moss-destination-shell={isDestinationSurface ? "true" : undefined}
    >
      <ThreadRetentionMaintenanceToast />
      {isDestinationSurface && <DesktopApplicationMenuBar />}
      <ChatRouteGlobalShortcuts />
      <AppRailSlotProvider value={railSlot}>
        <SidebarLeadingControlsDock routeColumn={routeColumn} railSlot={railSlot}>
          {isMobile ? (
            // Phones show the sidebar as a sheet that carries its own rail (see ThreadSidebar),
            // so the shell keeps no left column.
            sidebarElement
          ) : (
            <div className="flex min-h-0 shrink-0 flex-col">
              <AppShellTopStrip />
              <div className="flex min-h-0 flex-1">
                <div ref={setRailSlot} className="flex shrink-0" />
                <div className="app-rail-panel relative flex min-h-0 shrink-0 overflow-hidden [contain:paint]">
                  {sidebarElement}
                </div>
              </div>
            </div>
          )}
          {mainContentShell}
        </SidebarLeadingControlsDock>
      </AppRailSlotProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
