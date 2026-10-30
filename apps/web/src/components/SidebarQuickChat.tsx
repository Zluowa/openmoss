// FILE: SidebarQuickChat.tsx
// Purpose: Codex-parity sidebar Quick Chat trigger, recent-chat preview, and retained floating chat.
// Layer: Sidebar UI / compact conversation presentation

import type { ThreadId } from "@synara/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useComposerDraftStore } from "../composerDraftStore";
import { useQuickChatVisibilityStore } from "../quickChatVisibilityStore";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  HistoryIcon,
  PinFilledIcon,
  PlusIcon,
  XIcon,
} from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import { Button } from "./ui/button";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import ChatView from "./ChatView";
import {
  clampQuickChatWindowSize,
  formatQuickChatRelativeDate,
  QUICK_CHAT_EDGE_INSET,
  QUICK_CHAT_RECENT_LIMIT,
  QUICK_CHAT_SESSION_RETENTION_MS,
  QUICK_CHAT_TOOLBAR_HEIGHT,
  resolveQuickChatHoverSurface,
  resolveQuickChatWindowPosition,
  shouldRetainQuickChatSession,
  type QuickChatDockPosition,
  type QuickChatHoverSurface,
  type QuickChatItem,
  type QuickChatPosition,
  type QuickChatSize,
  type QuickChatViewport,
} from "./QuickChat.logic";
import { QUICK_CHAT_TOGGLE_EVENT } from "../lib/quickChatEvents";

const QUICK_CHAT_FIRST_USE_STORAGE_KEY = "has-opened-quick-chat-v1";
const QUICK_CHAT_PLACEMENT_STORAGE_KEY = "moss:quick-chat-placement-v1";
const QUICK_CHAT_WINDOW_ID = "sidebar-quick-chat-window";
const QUICK_CHAT_RECENT_ID = "sidebar-quick-chat-recent";
const QUICK_CHAT_COACHMARK_ID = "sidebar-quick-chat-coachmark";
const QUICK_CHAT_RECENT_DELAY_MS = 100;

const DEFAULT_LABELS = {
  chat: "Chat",
  recentChats: "Recent chats",
  searchChats: "Search chats",
  loading: "Loading chats…",
  empty: "No recent chats",
  untitled: "Untitled chat",
  newFeature: "NEW",
  newChat: "New chat",
  history: "History",
  backToChat: "Back to chat",
  attachToTask: "Attach to task",
  close: "Close Quick Chat",
  creating: "Starting chat…",
  createError: "Could not start a chat.",
  retry: "Retry",
  openInMain: "Open chat",
  resize: "Resize Quick Chat",
  welcomeTitle: "Ask quick questions with Chat",
  welcomeDescription: "Use the classic Chat experience to get answers and explore ideas.",
  welcomeHint: "Start a new chat or pick up a past ChatGPT conversation here.",
  viewChatHistory: "View chat history",
  coachmarkTitle: "Ask quick questions with Chat",
  coachmarkDescription:
    "Use the classic Chat experience and access your past ChatGPT conversations",
} as const;

export type SidebarQuickChatLabels = {
  [Key in keyof typeof DEFAULT_LABELS]: string;
};

export type QuickChatCreateResult = ThreadId | { readonly threadId: ThreadId } | null | undefined;

export interface SidebarQuickChatProps {
  /** Keep the retained window and global shortcut without a second panel navigation row. */
  readonly showTrigger?: boolean;
  /** Pass the full ordered Home-chat list; the collapsed preview caps itself at five. */
  readonly threads: readonly QuickChatItem[];
  readonly loading?: boolean;
  readonly active?: boolean;
  readonly shortcutLabel?: string | null;
  readonly initialThreadId?: ThreadId | null;
  readonly labels?: Partial<SidebarQuickChatLabels>;
  readonly onCreateDetached: () => QuickChatCreateResult | Promise<QuickChatCreateResult>;
  readonly canAttachToTask?: (threadId: ThreadId) => boolean;
  readonly onAttachToTask: (threadId: ThreadId) => void | Promise<void>;
  readonly onMarkVisited: (threadId: ThreadId) => void | Promise<void>;
  readonly onOpenChange?: (open: boolean) => void;
}

interface StoredQuickChatPlacement {
  readonly dock: QuickChatDockPosition;
  readonly size: QuickChatSize;
}

export type QuickChatResizeDirection = "n" | "ne" | "e" | "w" | "nw";

const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: QuickChatResizeDirection;
  readonly className: string;
  readonly cursor: string;
}> = [
  { direction: "n", className: "top-0 left-2 right-2 h-1", cursor: "cursor-n-resize" },
  { direction: "ne", className: "top-0 right-0 size-3", cursor: "cursor-ne-resize" },
  { direction: "e", className: "top-2 right-0 bottom-2 w-1", cursor: "cursor-e-resize" },
  { direction: "w", className: "top-2 bottom-2 left-0 w-1", cursor: "cursor-w-resize" },
  { direction: "nw", className: "top-0 left-0 size-3", cursor: "cursor-nw-resize" },
];

const RESIZE_DIRECTIONS_BY_DOCK: Readonly<
  Record<QuickChatDockPosition, ReadonlySet<QuickChatResizeDirection>>
> = {
  center: new Set(["n", "ne", "e", "w", "nw"]),
  "bottom-left": new Set(["n", "ne", "e"]),
  "bottom-right": new Set(["n", "w", "nw"]),
};

export function quickChatResizeDirections(
  dock: QuickChatDockPosition,
): readonly QuickChatResizeDirection[] {
  const visibleDirections = RESIZE_DIRECTIONS_BY_DOCK[dock];
  return RESIZE_HANDLES.flatMap((handle) =>
    visibleDirections.has(handle.direction) ? [handle.direction] : [],
  );
}

export function shouldDisableQuickChatAttach(input: {
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: QuickChatItem | null;
  readonly attaching: boolean;
}): boolean {
  return input.activeThreadId === null || input.activeThread === null || input.attaching;
}

/**
 * Remove a detached Quick Chat only while it is still a local draft. Once the
 * orchestration thread exists, the draft is either marked as promoted or has
 * already been finalized, and the durable chat must be left untouched.
 */
export function discardUnpromotedQuickChatDraft(threadId: ThreadId | null): boolean {
  if (threadId === null) return false;
  const store = useComposerDraftStore.getState();
  const draftThread = store.draftThreadsByThreadId[threadId];
  if (!draftThread || draftThread.promotedTo !== undefined) return false;
  store.clearDraftThread(threadId);
  return true;
}

function readViewport(): QuickChatViewport {
  if (typeof window === "undefined") {
    return { width: 1_440, height: 900 };
  }
  return {
    width: Math.max(0, window.innerWidth),
    height: Math.max(0, window.innerHeight),
  };
}

function isDockPosition(value: unknown): value is QuickChatDockPosition {
  return value === "center" || value === "bottom-left" || value === "bottom-right";
}

function readStoredPlacement(): StoredQuickChatPlacement {
  const fallback = {
    dock: "bottom-right" as const,
    size: clampQuickChatWindowSize(undefined, readViewport()),
  };
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(QUICK_CHAT_PLACEMENT_STORAGE_KEY) ?? "null",
    ) as Partial<StoredQuickChatPlacement> | null;
    if (!parsed || !isDockPosition(parsed.dock)) {
      return fallback;
    }
    const size = parsed.size;
    if (!size || typeof size.width !== "number" || typeof size.height !== "number") {
      return fallback;
    }
    return {
      dock: parsed.dock,
      size: clampQuickChatWindowSize(size, readViewport()),
    };
  } catch {
    return fallback;
  }
}

function createdThreadId(result: QuickChatCreateResult): ThreadId | null {
  if (typeof result === "string") {
    return result as ThreadId;
  }
  return result?.threadId ?? null;
}

function clampDraggedPosition(
  position: QuickChatPosition,
  size: QuickChatSize,
  viewport: QuickChatViewport,
): QuickChatPosition {
  const maximumX = Math.max(
    QUICK_CHAT_EDGE_INSET,
    viewport.width - size.width - QUICK_CHAT_EDGE_INSET,
  );
  const minimumY = QUICK_CHAT_TOOLBAR_HEIGHT + QUICK_CHAT_EDGE_INSET;
  const maximumY = Math.max(minimumY, viewport.height - size.height - QUICK_CHAT_EDGE_INSET);
  return {
    x: Math.min(Math.max(position.x, QUICK_CHAT_EDGE_INSET), maximumX),
    y: Math.min(Math.max(position.y, minimumY), maximumY),
  };
}

function nearestDockPosition(
  position: QuickChatPosition,
  size: QuickChatSize,
  viewport: QuickChatViewport,
): QuickChatDockPosition {
  const docks: readonly QuickChatDockPosition[] = ["center", "bottom-left", "bottom-right"];
  let nearest: QuickChatDockPosition = "center";
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const dock of docks) {
    const candidate = resolveQuickChatWindowPosition(dock, size, viewport);
    const distance = (candidate.x - position.x) ** 2 + (candidate.y - position.y) ** 2;
    if (distance < nearestDistance) {
      nearest = dock;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function resizedQuickChatSize(
  direction: QuickChatResizeDirection,
  start: QuickChatSize,
  deltaX: number,
  deltaY: number,
  viewport: QuickChatViewport,
  dock: QuickChatDockPosition,
): QuickChatSize {
  // A centered window stays centered while it is resized, so its size must change
  // by twice the pointer delta for the grabbed edge to track the pointer. Bottom
  // docks expose only the edge opposite their anchor and therefore use 1:1 deltas.
  const dockScale = dock === "center" ? 2 : 1;
  const widthDelta = direction.includes("e")
    ? deltaX * dockScale
    : direction.includes("w")
      ? -deltaX * dockScale
      : 0;
  const heightDelta = direction.includes("n") ? -deltaY * dockScale : 0;
  return clampQuickChatWindowSize(
    { width: start.width + widthDelta, height: start.height + heightDelta },
    viewport,
  );
}

function firstUseAlreadyOpened(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(QUICK_CHAT_FIRST_USE_STORAGE_KEY) === "true";
  } catch {
    return true;
  }
}

export function SidebarQuickChat({
  threads,
  showTrigger = true,
  loading = false,
  active = false,
  shortcutLabel = null,
  initialThreadId = null,
  labels: labelOverrides,
  onCreateDetached,
  canAttachToTask,
  onAttachToTask,
  onMarkVisited,
  onOpenChange,
}: SidebarQuickChatProps) {
  const { state: sidebarState } = useSidebar();
  const { locale } = useTranslation();
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const recentPanelRef = useRef<HTMLDivElement | null>(null);
  const coachmarkRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const recentOpenTimerRef = useRef<number | null>(null);
  const recentCloseTimerRef = useRef<number | null>(null);
  const creationPromiseRef = useRef<Promise<ThreadId | null> | null>(null);
  const [windowOpen, setWindowOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openHoverSurface, setOpenHoverSurface] = useState<QuickChatHoverSurface | null>(null);
  const [recentPosition, setRecentPosition] = useState({ left: 0, top: 0 });
  const [coachmarkPosition, setCoachmarkPosition] = useState({ left: 0, top: 0 });
  const [activeThreadId, setActiveThreadId] = useState<ThreadId | null>(initialThreadId);
  const activeThreadIdRef = useRef<ThreadId | null>(initialThreadId);
  activeThreadIdRef.current = activeThreadId;

  useEffect(() => {
    useQuickChatVisibilityStore.getState().setVisibility({
      windowOpen,
      activeThreadId,
    });
  }, [activeThreadId, windowOpen]);

  useEffect(() => {
    return () => {
      useQuickChatVisibilityStore.getState().clearVisibility();
    };
  }, []);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [placement, setPlacement] = useState(readStoredPlacement);
  const [viewport, setViewport] = useState(readViewport);
  const [draggedPosition, setDraggedPosition] = useState<QuickChatPosition | null>(null);
  const [showFirstUse, setShowFirstUse] = useState(() => !firstUseAlreadyOpened());
  const [showWelcome, setShowWelcome] = useState(showFirstUse);
  const recentOpen = openHoverSurface === "recent";
  const coachmarkOpen = openHoverSurface === "coachmark";

  const recentThreads = threads.slice(0, QUICK_CHAT_RECENT_LIMIT);
  const size = clampQuickChatWindowSize(placement.size, viewport);
  const anchoredPosition = resolveQuickChatWindowPosition(placement.dock, size, viewport);
  const position = draggedPosition ?? anchoredPosition;
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const activeTitle = activeThread?.title.trim() || labels.newChat;
  const attachDisabledByState = shouldDisableQuickChatAttach({
    activeThreadId,
    activeThread,
    attaching,
  });
  const attachDisabled =
    attachDisabledByState ||
    (activeThreadId !== null && !(canAttachToTask?.(activeThreadId) ?? true));
  const resizeDirections = RESIZE_DIRECTIONS_BY_DOCK[placement.dock];

  const clearRecentTimers = useCallback(() => {
    if (recentOpenTimerRef.current !== null) {
      window.clearTimeout(recentOpenTimerRef.current);
      recentOpenTimerRef.current = null;
    }
    if (recentCloseTimerRef.current !== null) {
      window.clearTimeout(recentCloseTimerRef.current);
      recentCloseTimerRef.current = null;
    }
  }, []);

  const scheduleHoverSurfaceOpen = useCallback(() => {
    if (recentCloseTimerRef.current !== null) {
      window.clearTimeout(recentCloseTimerRef.current);
      recentCloseTimerRef.current = null;
    }
    if (recentOpenTimerRef.current !== null) return;
    recentOpenTimerRef.current = window.setTimeout(() => {
      recentOpenTimerRef.current = null;
      setOpenHoverSurface(resolveQuickChatHoverSurface(!showFirstUse));
    }, QUICK_CHAT_RECENT_DELAY_MS);
  }, [showFirstUse]);

  const scheduleHoverSurfaceClose = useCallback(() => {
    if (recentOpenTimerRef.current !== null) {
      window.clearTimeout(recentOpenTimerRef.current);
      recentOpenTimerRef.current = null;
    }
    if (recentCloseTimerRef.current !== null) return;
    recentCloseTimerRef.current = window.setTimeout(() => {
      recentCloseTimerRef.current = null;
      setOpenHoverSurface(null);
    }, QUICK_CHAT_RECENT_DELAY_MS);
  }, []);

  const closeHoverSurfaceImmediately = useCallback(() => {
    clearRecentTimers();
    setOpenHoverSurface(null);
  }, [clearRecentTimers]);

  const markFirstUseOpened = useCallback(() => {
    if (!showFirstUse) return;
    setShowFirstUse(false);
    setOpenHoverSurface(null);
    try {
      window.localStorage.setItem(QUICK_CHAT_FIRST_USE_STORAGE_KEY, "true");
    } catch {
      // A blocked storage backend should never block the chat itself.
    }
  }, [showFirstUse]);

  const createNewDetachedChat = useCallback(
    async (preserveWelcome = false): Promise<ThreadId | null> => {
      setHistoryOpen(false);
      if (!preserveWelcome) {
        setShowWelcome(false);
      }
      if (creationPromiseRef.current) {
        return creationPromiseRef.current;
      }
      setCreating(true);
      setCreateFailed(false);
      const request = Promise.resolve(onCreateDetached())
        .then((result) => {
          const threadId = createdThreadId(result);
          if (!threadId) {
            setCreateFailed(true);
            return null;
          }
          const previousThreadId = activeThreadIdRef.current;
          if (previousThreadId !== threadId) {
            discardUnpromotedQuickChatDraft(previousThreadId);
          }
          activeThreadIdRef.current = threadId;
          setActiveThreadId(threadId);
          setClosedAt(null);
          void onMarkVisited(threadId);
          return threadId;
        })
        .catch(() => {
          setCreateFailed(true);
          return null;
        })
        .finally(() => {
          setCreating(false);
          creationPromiseRef.current = null;
        });
      creationPromiseRef.current = request;
      return request;
    },
    [onCreateDetached, onMarkVisited],
  );

  const openQuickChat = useCallback(() => {
    closeHoverSurfaceImmediately();
    if (showFirstUse) {
      setShowWelcome(true);
    }
    markFirstUseOpened();
    setWindowOpen(true);
    setClosedAt(null);
    setHistoryOpen(false);
    onOpenChange?.(true);
    if (activeThreadId) {
      void onMarkVisited(activeThreadId);
      return;
    }
    void createNewDetachedChat(true);
  }, [
    activeThreadId,
    closeHoverSurfaceImmediately,
    createNewDetachedChat,
    markFirstUseOpened,
    onMarkVisited,
    onOpenChange,
    showFirstUse,
  ]);

  const closeQuickChat = useCallback(
    (restoreFocus = false) => {
      setWindowOpen(false);
      setHistoryOpen(false);
      setClosedAt(Date.now());
      onOpenChange?.(false);
      if (restoreFocus) {
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [onOpenChange],
  );

  const toggleQuickChat = useCallback(() => {
    if (windowOpen) {
      closeQuickChat();
      return;
    }
    openQuickChat();
  }, [closeQuickChat, openQuickChat, windowOpen]);

  useEffect(() => {
    const handleToggleRequest = () => toggleQuickChat();
    window.addEventListener(QUICK_CHAT_TOGGLE_EVENT, handleToggleRequest);
    return () => window.removeEventListener(QUICK_CHAT_TOGGLE_EVENT, handleToggleRequest);
  }, [toggleQuickChat]);

  const selectThreadInWindow = useCallback(
    (threadId: ThreadId) => {
      const previousThreadId = activeThreadIdRef.current;
      if (previousThreadId !== threadId) {
        discardUnpromotedQuickChatDraft(previousThreadId);
      }
      activeThreadIdRef.current = threadId;
      setActiveThreadId(threadId);
      setClosedAt(null);
      setHistoryOpen(false);
      setShowWelcome(false);
      void onMarkVisited(threadId);
    },
    [onMarkVisited],
  );

  const openRecentThreadInWindow = useCallback(
    (threadId: ThreadId) => {
      closeHoverSurfaceImmediately();
      markFirstUseOpened();
      const previousThreadId = activeThreadIdRef.current;
      if (previousThreadId !== threadId) {
        discardUnpromotedQuickChatDraft(previousThreadId);
      }
      activeThreadIdRef.current = threadId;
      setActiveThreadId(threadId);
      setClosedAt(null);
      setHistoryOpen(false);
      setShowWelcome(false);
      setWindowOpen(true);
      onOpenChange?.(true);
      void onMarkVisited(threadId);
    },
    [closeHoverSurfaceImmediately, markFirstUseOpened, onMarkVisited, onOpenChange],
  );

  const attachCurrentThread = useCallback(() => {
    if (!activeThreadId || attachDisabled) return;
    setAttaching(true);
    void Promise.resolve(onAttachToTask(activeThreadId))
      .then(() => closeQuickChat())
      .catch(() => undefined)
      .finally(() => setAttaching(false));
  }, [activeThreadId, attachDisabled, closeQuickChat, onAttachToTask]);

  const handleConversationActivity = useCallback(() => {
    setShowWelcome(false);
  }, []);

  const focusFirstRecentItem = useCallback(() => {
    setOpenHoverSurface("recent");
    window.requestAnimationFrame(() => {
      recentPanelRef.current
        ?.querySelector<HTMLElement>("[data-quick-chat-recent-focusable='true']")
        ?.focus();
    });
  }, []);

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!showFirstUse && (event.key === "ArrowDown" || event.key === "ArrowRight")) {
        event.preventDefault();
        clearRecentTimers();
        focusFirstRecentItem();
        return;
      }
      if (event.key === "Escape" && openHoverSurface !== null) {
        event.preventDefault();
        closeHoverSurfaceImmediately();
      }
    },
    [
      clearRecentTimers,
      closeHoverSurfaceImmediately,
      focusFirstRecentItem,
      openHoverSurface,
      showFirstUse,
    ],
  );

  const handleRecentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHoverSurfaceImmediately();
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const focusable = Array.from(
        recentPanelRef.current?.querySelectorAll<HTMLElement>(
          "[data-quick-chat-recent-focusable='true']",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      event.preventDefault();
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? focusable.length - 1
            : event.key === "ArrowUp"
              ? (currentIndex - 1 + focusable.length) % focusable.length
              : (currentIndex + 1) % focusable.length;
      focusable[nextIndex]?.focus();
    },
    [closeHoverSurfaceImmediately],
  );

  const handleWindowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      closeQuickChat(true);
    },
    [closeQuickChat, historyOpen],
  );

  const releasePointerInteraction = useCallback(() => {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
  }, []);

  const startHeaderDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("[data-quick-chat-window-control]")) return;
      event.preventDefault();
      releasePointerInteraction();
      const pointerId = event.pointerId;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startPosition = position;
      let latestPosition = startPosition;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latestPosition = clampDraggedPosition(
          {
            x: startPosition.x + moveEvent.clientX - startPointer.x,
            y: startPosition.y + moveEvent.clientY - startPointer.y,
          },
          size,
          viewport,
        );
        setDraggedPosition(latestPosition);
      };
      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        setPlacement((current) => ({
          ...current,
          dock: nearestDockPosition(latestPosition, size, viewport),
        }));
        setDraggedPosition(null);
        releasePointerInteraction();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.userSelect = previousUserSelect;
      };
      pointerCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [position, releasePointerInteraction, size, viewport],
  );

  const startResize = useCallback(
    (direction: QuickChatResizeDirection, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      releasePointerInteraction();
      const pointerId = event.pointerId;
      const startPointer = { x: event.clientX, y: event.clientY };
      const startSize = size;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const nextSize = resizedQuickChatSize(
          direction,
          startSize,
          moveEvent.clientX - startPointer.x,
          moveEvent.clientY - startPointer.y,
          viewport,
          placement.dock,
        );
        setPlacement((current) => ({ ...current, size: nextSize }));
      };
      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        releasePointerInteraction();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        document.body.style.userSelect = previousUserSelect;
      };
      pointerCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [placement.dock, releasePointerInteraction, size, viewport],
  );

  const resizeWithKeyboard = useCallback(
    (direction: QuickChatResizeDirection, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const deltaX = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0;
      const deltaY = event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0;
      setPlacement((current) => ({
        ...current,
        size: resizedQuickChatSize(direction, current.size, deltaX, deltaY, viewport, current.dock),
      }));
    },
    [viewport],
  );

  useEffect(() => {
    return () => {
      clearRecentTimers();
      releasePointerInteraction();
    };
  }, [clearRecentTimers, releasePointerInteraction]);

  useEffect(() => {
    const handleResize = () => {
      const nextViewport = readViewport();
      setViewport(nextViewport);
      setPlacement((current) => ({
        ...current,
        size: clampQuickChatWindowSize(current.size, nextViewport),
      }));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        QUICK_CHAT_PLACEMENT_STORAGE_KEY,
        JSON.stringify({
          dock: placement.dock,
          size: { width: size.width, height: size.height },
        }),
      );
    } catch {
      // Window persistence is an enhancement; the floating chat remains usable without it.
    }
  }, [placement.dock, size.height, size.width]);

  useEffect(() => {
    if (windowOpen || closedAt === null || activeThreadId === null) return;
    const remainingMs = Math.max(0, QUICK_CHAT_SESSION_RETENTION_MS - (Date.now() - closedAt) + 1);
    const timeout = window.setTimeout(() => {
      if (!shouldRetainQuickChatSession(closedAt)) {
        discardUnpromotedQuickChatDraft(activeThreadId);
        activeThreadIdRef.current = null;
        setActiveThreadId(null);
        setClosedAt(null);
      }
    }, remainingMs);
    return () => window.clearTimeout(timeout);
  }, [activeThreadId, closedAt, windowOpen]);

  useLayoutEffect(() => {
    if (!recentOpen) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = 288;
      const panelHeight = recentPanelRef.current?.offsetHeight ?? 280;
      setRecentPosition({
        left: Math.min(window.innerWidth - panelWidth - 8, rect.right + 8),
        top: Math.min(Math.max(8, rect.top), window.innerHeight - panelHeight - 8),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [recentOpen, sidebarState]);

  useLayoutEffect(() => {
    if (!coachmarkOpen) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = coachmarkRef.current?.offsetWidth ?? 256;
      const panelHeight = coachmarkRef.current?.offsetHeight ?? 112;
      setCoachmarkPosition({
        left: Math.min(window.innerWidth - panelWidth - 8, rect.right + 16),
        top: Math.min(Math.max(8, rect.top), window.innerHeight - panelHeight - 8),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [coachmarkOpen, sidebarState]);

  const recentCard =
    recentOpen && !showFirstUse && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={recentPanelRef}
            id={QUICK_CHAT_RECENT_ID}
            role="menu"
            aria-label={labels.recentChats}
            data-testid="quick-chat-recent-card"
            className="fixed z-[100] w-72 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] p-1 text-[var(--color-text-foreground)] shadow-lg [-webkit-app-region:no-drag]"
            style={recentPosition}
            onKeyDown={handleRecentKeyDown}
            onMouseEnter={() => {
              clearRecentTimers();
              setOpenHoverSurface("recent");
            }}
            onMouseLeave={scheduleHoverSurfaceClose}
            onFocusCapture={() => {
              clearRecentTimers();
              setOpenHoverSurface("recent");
            }}
            onBlurCapture={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              scheduleHoverSurfaceClose();
            }}
          >
            <div className="px-2 py-1.5 text-ui-sm font-medium text-muted-foreground">
              {labels.recentChats}
            </div>
            {loading ? (
              <div className="flex min-h-16 items-center gap-2 px-2 py-3 text-ui-sm text-muted-foreground">
                <ThreadRunningSpinner />
                <span>{labels.loading}</span>
              </div>
            ) : recentThreads.length === 0 ? (
              <div className="px-2 py-3 text-ui-sm text-muted-foreground">{labels.empty}</div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {recentThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    role="menuitem"
                    data-quick-chat-recent-focusable="true"
                    data-testid={`quick-chat-recent-${thread.id}`}
                    className="group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60"
                    onClick={() => openRecentThreadInWindow(thread.id)}
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      {thread.streaming ? (
                        <ThreadRunningSpinner />
                      ) : thread.isPinned ? (
                        <PinFilledIcon aria-hidden="true" className="size-3" />
                      ) : (
                        <ChatBubbleIcon aria-hidden="true" className="size-4" />
                      )}
                      {thread.unread && !thread.streaming ? (
                        <span
                          aria-label="Unread"
                          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info"
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {thread.title.trim() ? (
                        <span data-translation-skip="true">{thread.title.trim()}</span>
                      ) : (
                        labels.untitled
                      )}
                    </span>
                    <span className="shrink-0 text-ui-2xs text-muted-foreground">
                      {formatQuickChatRelativeDate(thread.updatedAt, Date.now(), locale)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  const firstUseCoachmark =
    coachmarkOpen && showFirstUse && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={coachmarkRef}
            id={QUICK_CHAT_COACHMARK_ID}
            role="status"
            data-testid="quick-chat-first-use-coachmark"
            className="fixed z-[100] w-64 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] p-3 text-[var(--color-text-foreground)] shadow-lg [-webkit-app-region:no-drag]"
            style={coachmarkPosition}
            onMouseEnter={() => {
              clearRecentTimers();
              setOpenHoverSurface("coachmark");
            }}
            onMouseLeave={scheduleHoverSurfaceClose}
          >
            <div className="mb-2 inline-flex rounded-md bg-info/12 px-1.5 py-0.5 text-ui-timestamp font-semibold tracking-wide text-info">
              {labels.newFeature}
            </div>
            <p className="text-ui-sm font-semibold leading-5">{labels.coachmarkTitle}</p>
            <p className="mt-1 text-ui-sm leading-4 text-muted-foreground">
              {labels.coachmarkDescription}
            </p>
          </div>,
          document.body,
        )
      : null;

  const quickChatWindow =
    windowOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={windowRef}
            id={QUICK_CHAT_WINDOW_ID}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${QUICK_CHAT_WINDOW_ID}-title`}
            data-testid="quick-chat-window"
            data-quick-chat-dock={placement.dock}
            data-quick-chat-thread-id={activeThreadId ?? undefined}
            data-quick-chat-shortcut-owner="true"
            className="fixed z-40 flex overflow-hidden rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-foreground)] shadow-2xl [-webkit-app-region:no-drag]"
            style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
            onKeyDown={handleWindowKeyDown}
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <header
                data-testid="quick-chat-window-header"
                className="relative flex h-[46px] shrink-0 cursor-move select-none items-center gap-1 border-[color:var(--color-border-light)] border-b px-2"
                onPointerDown={startHeaderDrag}
              >
                {historyOpen ? (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="chrome"
                      data-quick-chat-window-control
                      onClick={() => setHistoryOpen(false)}
                    >
                      <ArrowLeftIcon aria-hidden="true" className="size-4" />
                      <span>{labels.backToChat}</span>
                    </Button>
                    <div
                      id={`${QUICK_CHAT_WINDOW_ID}-title`}
                      className="min-w-0 flex-1 truncate px-1 text-ui-lg font-medium"
                    >
                      {labels.history}
                    </div>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="chrome"
                      data-quick-chat-window-control
                      aria-label={labels.close}
                      title={labels.close}
                      onClick={() => closeQuickChat(true)}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="chrome"
                        data-quick-chat-window-control
                        aria-label={labels.newChat}
                        title={labels.newChat}
                        disabled={creating}
                        onClick={() => void createNewDetachedChat()}
                      >
                        {creating ? <ThreadRunningSpinner /> : <PlusIcon aria-hidden="true" />}
                      </Button>
                      <span
                        aria-hidden="true"
                        className="mx-0.5 h-4 w-px shrink-0 bg-[var(--color-border-light)]"
                      />
                      <button
                        id={`${QUICK_CHAT_WINDOW_ID}-title`}
                        type="button"
                        data-quick-chat-window-control
                        className="group/title flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-ui-lg font-medium outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60"
                        title={activeTitle}
                        onClick={() => {
                          setShowWelcome(false);
                          setHistoryOpen(true);
                        }}
                      >
                        <span className="truncate">{activeTitle}</span>
                        <ChevronDownIcon
                          aria-hidden="true"
                          className="size-3 shrink-0 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
                        />
                      </button>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {showWelcome ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="chrome"
                          data-quick-chat-window-control
                          onClick={() => {
                            setShowWelcome(false);
                            setHistoryOpen(true);
                          }}
                        >
                          <HistoryIcon aria-hidden="true" className="size-4" />
                          <span>{labels.recentChats}</span>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="xs"
                          variant="chrome-outline"
                          data-quick-chat-window-control
                          disabled={attachDisabled}
                          onClick={attachCurrentThread}
                        >
                          {attaching ? (
                            <ThreadRunningSpinner />
                          ) : (
                            <ArrowUpRightIcon aria-hidden="true" className="size-4" />
                          )}
                          <span>{labels.attachToTask}</span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="chrome"
                        data-quick-chat-window-control
                        aria-label={labels.close}
                        title={labels.close}
                        onClick={() => closeQuickChat(true)}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </div>
                  </>
                )}
              </header>

              <section
                aria-label={labels.history}
                aria-hidden={!historyOpen}
                data-testid="quick-chat-history"
                hidden={!historyOpen}
                inert={historyOpen ? undefined : true}
                className={cn(
                  "min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-background-surface)] p-2",
                  historyOpen ? "flex" : "hidden",
                )}
              >
                <button
                  type="button"
                  className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-ui-sm font-medium outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60"
                  disabled={creating}
                  onClick={() => void createNewDetachedChat()}
                >
                  {creating ? (
                    <ThreadRunningSpinner />
                  ) : (
                    <PlusIcon aria-hidden="true" className="size-4" />
                  )}
                  <span>{labels.newChat}</span>
                </button>
                <div className="my-1 h-px shrink-0 bg-[var(--color-border-light)]" />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {loading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-ui-sm text-muted-foreground">
                      <ThreadRunningSpinner />
                      <span>{labels.loading}</span>
                    </div>
                  ) : threads.length === 0 ? (
                    <div className="px-2 py-3 text-ui-sm text-muted-foreground">{labels.empty}</div>
                  ) : (
                    threads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        aria-pressed={thread.id === activeThreadId}
                        className={cn(
                          "flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60",
                          thread.id === activeThreadId &&
                            "bg-[var(--color-background-elevated-secondary)]",
                        )}
                        onClick={() => selectThreadInWindow(thread.id)}
                      >
                        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                          {thread.streaming ? (
                            <ThreadRunningSpinner />
                          ) : thread.isPinned ? (
                            <PinFilledIcon aria-hidden="true" className="size-3" />
                          ) : (
                            <ChatBubbleIcon aria-hidden="true" className="size-4" />
                          )}
                          {thread.unread && !thread.streaming ? (
                            <span
                              aria-label="Unread"
                              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info"
                            />
                          ) : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {thread.title.trim() ? (
                            <span data-translation-skip="true">{thread.title.trim()}</span>
                          ) : (
                            labels.untitled
                          )}
                        </span>
                        <span className="shrink-0 text-ui-2xs text-muted-foreground">
                          {formatQuickChatRelativeDate(thread.updatedAt, Date.now(), locale)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </section>
              <div
                aria-hidden={historyOpen}
                data-testid="quick-chat-active"
                hidden={historyOpen}
                inert={historyOpen ? true : undefined}
                className={cn(
                  "relative min-h-0 flex-1 overflow-hidden",
                  historyOpen ? "hidden" : "flex",
                )}
              >
                {activeThreadId ? (
                  <ChatView
                    key={activeThreadId}
                    threadId={activeThreadId}
                    paneScopeId={`quick-chat:${activeThreadId}`}
                    presentationMode="quick-chat"
                    rightDockOpenOverride={false}
                    onConversationActivity={handleConversationActivity}
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground">
                    {creating ? <ThreadRunningSpinner className="size-4" /> : null}
                    <p>
                      {creating
                        ? labels.creating
                        : createFailed
                          ? labels.createError
                          : labels.empty}
                    </p>
                    {createFailed ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary-outline"
                        onClick={() => void createNewDetachedChat()}
                      >
                        {labels.retry}
                      </Button>
                    ) : null}
                  </div>
                )}
                {showWelcome ? (
                  <div
                    data-testid="quick-chat-welcome"
                    className="absolute inset-x-0 top-0 bottom-36 z-20 flex items-center justify-center overflow-y-auto bg-[var(--color-background-surface)] px-8 py-5 text-center"
                  >
                    <div className="flex max-w-sm flex-col items-center">
                      <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-foreground">
                        <ChatBubbleIcon aria-hidden="true" className="size-5" />
                      </span>
                      <h2 className="text-base font-semibold leading-6">{labels.welcomeTitle}</h2>
                      <p className="mt-2 text-ui-sm leading-5 text-muted-foreground">
                        {labels.welcomeDescription}
                      </p>
                      <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">
                        {labels.welcomeHint}
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary-outline"
                        className="mt-4"
                        onClick={() => {
                          setShowWelcome(false);
                          setHistoryOpen(true);
                        }}
                      >
                        <HistoryIcon aria-hidden="true" className="size-4" />
                        <span>{labels.viewChatHistory}</span>
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {RESIZE_HANDLES.filter((handle) => resizeDirections.has(handle.direction)).map(
              (handle) => (
                <button
                  key={handle.direction}
                  type="button"
                  aria-label={`${labels.resize} ${handle.direction.toUpperCase()}`}
                  data-testid={`quick-chat-resize-${handle.direction}`}
                  className={cn(
                    "absolute z-40 border-0 bg-transparent p-0 opacity-0 outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring/70",
                    handle.className,
                    handle.cursor,
                  )}
                  onPointerDown={(event) => startResize(handle.direction, event)}
                  onKeyDown={(event) => resizeWithKeyboard(handle.direction, event)}
                />
              ),
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {showTrigger ? (
        <SidebarMenuItem
          data-testid="sidebar-quick-chat"
          onMouseEnter={scheduleHoverSurfaceOpen}
          onMouseLeave={scheduleHoverSurfaceClose}
        >
          <SidebarMenuButton
            ref={triggerRef}
            size="sm"
            isActive={active || windowOpen}
            aria-pressed={windowOpen}
            aria-controls={windowOpen ? QUICK_CHAT_WINDOW_ID : undefined}
            aria-describedby={
              recentOpen
                ? QUICK_CHAT_RECENT_ID
                : coachmarkOpen
                  ? QUICK_CHAT_COACHMARK_ID
                  : undefined
            }
            aria-haspopup="dialog"
            aria-keyshortcuts={!showFirstUse ? "ArrowDown ArrowRight" : undefined}
            className={cn(
              "group/sidebar-quick-chat",
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              active || windowOpen
                ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
            )}
            onClick={toggleQuickChat}
            onKeyDown={handleTriggerKeyDown}
            onFocus={scheduleHoverSurfaceOpen}
            onBlur={(event) => {
              if (recentPanelRef.current?.contains(event.relatedTarget as Node | null)) return;
              scheduleHoverSurfaceClose();
            }}
          >
            <SidebarLeadingIcon size="sm" tone="text-inherit">
              <CentralIcon aria-hidden="true" name="bubble-plus" className="size-4" />
              {showFirstUse ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info ring-2 ring-[var(--color-background-sidebar)]"
                />
              ) : null}
            </SidebarLeadingIcon>
            <span className="truncate">{labels.chat}</span>
            {showFirstUse ? (
              <span
                role="status"
                data-testid="quick-chat-new-coachmark"
                className="ml-auto rounded-md bg-info/12 px-1.5 py-0.5 text-ui-timestamp font-semibold tracking-wide text-info group-data-[collapsible=icon]:hidden"
              >
                {labels.newFeature}
              </span>
            ) : shortcutLabel ? (
              <kbd className="ml-auto text-ui-2xs text-muted-foreground opacity-0 group-hover/sidebar-quick-chat:opacity-100 group-focus-visible/sidebar-quick-chat:opacity-100 group-data-[collapsible=icon]:hidden">
                {shortcutLabel}
              </kbd>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      {recentCard}
      {firstUseCoachmark}
      {quickChatWindow}
    </>
  );
}
