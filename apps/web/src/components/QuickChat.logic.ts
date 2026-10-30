// FILE: QuickChat.logic.ts
// Purpose: Codex-parity ordering, recency, retention, and floating-window geometry for Quick Chat.
// Layer: Pure web UI logic (no React or browser-global reads)

import type { ProjectId, ThreadId } from "@synara/contracts";

import { hasLiveLatestTurn } from "../session-logic";
import type { SidebarThreadSummary } from "../types";

export const QUICK_CHAT_RECENT_LIMIT = 5;
export const QUICK_CHAT_SESSION_RETENTION_MS = 7 * 60 * 1_000;
export const QUICK_CHAT_MIN_SIZE = 400;
export const QUICK_CHAT_EDGE_INSET = 16;
export const QUICK_CHAT_TOOLBAR_HEIGHT = 46;
export const QUICK_CHAT_DEFAULT_SIZE = Object.freeze({ width: 560, height: 640 });

export type QuickChatDockPosition = "center" | "bottom-left" | "bottom-right";
export type QuickChatHoverSurface = "coachmark" | "recent";

export interface QuickChatSize {
  readonly width: number;
  readonly height: number;
}

export interface QuickChatViewport {
  readonly width: number;
  readonly height: number;
}

export interface QuickChatPosition {
  readonly x: number;
  readonly y: number;
}

export interface QuickChatItem {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly updatedAt: string;
  readonly isPinned: boolean;
  readonly unread: boolean;
  readonly streaming: boolean;
}

/**
 * Codex uses first-open state, not sidebar width, to choose the hover surface.
 * The NUX coachmark is replaced permanently by recent conversations after the
 * first Quick Chat open.
 */
export function resolveQuickChatHoverSurface(hasOpenedQuickChat: boolean): QuickChatHoverSurface {
  return hasOpenedQuickChat ? "recent" : "coachmark";
}

function timestampMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function quickChatUpdatedAt(thread: SidebarThreadSummary): string {
  return thread.updatedAt ?? thread.createdAt;
}

function isQuickChatUnread(thread: SidebarThreadSummary): boolean {
  if (!thread.latestTurn) {
    return false;
  }

  // Completed turns expose their own authoritative timestamp. Interrupted/error
  // turns can lack completedAt, in which case the thread update is the durable
  // read-model boundary. A live turn stays represented by `streaming`, not unread.
  const activityAt =
    thread.latestTurn.completedAt ??
    (hasLiveLatestTurn(thread.latestTurn, thread.session) ? null : thread.updatedAt);
  const activityAtMs = timestampMs(activityAt);
  if (!Number.isFinite(activityAtMs)) {
    return false;
  }

  const lastVisitedAtMs = timestampMs(thread.lastVisitedAt);
  return !Number.isFinite(lastVisitedAtMs) || activityAtMs > lastVisitedAtMs;
}

function isQuickChatStreaming(thread: SidebarThreadSummary): boolean {
  if (thread.hasLiveTailWork || thread.session?.status === "connecting") {
    return true;
  }
  return (
    thread.session?.status === "running" &&
    (thread.latestTurn === null || hasLiveLatestTurn(thread.latestTurn, thread.session))
  );
}

/**
 * Orders the already Home-chat-filtered thread summaries exactly as the Quick
 * Chat recent list needs them: explicit pin order first, then newest activity.
 */
export function buildQuickChatItems(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly pinnedThreadIds: readonly (ThreadId | string)[];
  readonly limit?: number;
}): QuickChatItem[] {
  const threadById = new Map<string, SidebarThreadSummary>();
  for (const thread of input.threads) {
    const previous = threadById.get(thread.id);
    if (
      !previous ||
      timestampMs(quickChatUpdatedAt(thread)) > timestampMs(quickChatUpdatedAt(previous))
    ) {
      threadById.set(thread.id, thread);
    }
  }

  const orderedPinnedIds: string[] = [];
  const pinnedIdSet = new Set<string>();
  for (const threadId of input.pinnedThreadIds) {
    if (!pinnedIdSet.has(threadId) && threadById.has(threadId)) {
      pinnedIdSet.add(threadId);
      orderedPinnedIds.push(threadId);
    }
  }

  const pinnedThreads = orderedPinnedIds.flatMap((threadId) => {
    const thread = threadById.get(threadId);
    return thread ? [thread] : [];
  });
  const unpinnedThreads = [...threadById.values()]
    .filter((thread) => !pinnedIdSet.has(thread.id))
    .toSorted((left, right) => {
      const recencyDelta =
        timestampMs(quickChatUpdatedAt(right)) - timestampMs(quickChatUpdatedAt(left));
      return recencyDelta === 0 ? left.id.localeCompare(right.id) : recencyDelta;
    });

  const requestedLimit = input.limit ?? QUICK_CHAT_RECENT_LIMIT;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 0;
  return [...pinnedThreads, ...unpinnedThreads].slice(0, limit).map((thread) => ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    updatedAt: quickChatUpdatedAt(thread),
    isPinned: pinnedIdSet.has(thread.id),
    unread: isQuickChatUnread(thread),
    streaming: isQuickChatStreaming(thread),
  }));
}

/** Keeps a closed detached session warm for seven minutes, matching Codex. */
export function shouldRetainQuickChatSession(
  closedAt: string | number | Date | null,
  nowMs = Date.now(),
): boolean {
  if (closedAt === null) {
    return true;
  }
  const closedAtMs =
    typeof closedAt === "number"
      ? closedAt
      : closedAt instanceof Date
        ? closedAt.getTime()
        : Date.parse(closedAt);
  if (!Number.isFinite(closedAtMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return nowMs - closedAtMs <= QUICK_CHAT_SESSION_RETENTION_MS;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Codex reserves 16px above and below plus a 46px toolbar, caps width to half
 * the viewport, and lowers the 400px minimum when the viewport is smaller.
 */
export function clampQuickChatWindowSize(
  size: QuickChatSize | undefined,
  viewport: QuickChatViewport,
): QuickChatSize {
  const requestedSize = size ?? QUICK_CHAT_DEFAULT_SIZE;
  const viewportWidth = finiteNonNegative(viewport.width);
  const viewportHeight = finiteNonNegative(viewport.height);
  const maximumWidth = viewportWidth / 2;
  const maximumHeight = Math.max(
    0,
    viewportHeight - QUICK_CHAT_EDGE_INSET * 2 - QUICK_CHAT_TOOLBAR_HEIGHT,
  );
  const minimumWidth = Math.min(QUICK_CHAT_MIN_SIZE, maximumWidth);
  const minimumHeight = Math.min(QUICK_CHAT_MIN_SIZE, maximumHeight);

  return {
    width: clamp(finiteNonNegative(requestedSize.width), minimumWidth, maximumWidth),
    height: clamp(finiteNonNegative(requestedSize.height), minimumHeight, maximumHeight),
  };
}

/** Returns the undragged anchor point for the three Codex dock positions. */
export function resolveQuickChatWindowPosition(
  dock: QuickChatDockPosition,
  size: QuickChatSize,
  viewport: QuickChatViewport,
): QuickChatPosition {
  if (dock === "center") {
    return {
      x: Math.round((viewport.width - size.width) / 2),
      y: Math.round((viewport.height - size.height) / 2),
    };
  }

  return {
    x:
      dock === "bottom-left"
        ? QUICK_CHAT_EDGE_INSET
        : viewport.width - size.width - QUICK_CHAT_EDGE_INSET,
    y: viewport.height - size.height - QUICK_CHAT_EDGE_INSET,
  };
}

function localCalendarDayDifference(now: Date, then: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const otherDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  return Math.round((today.getTime() - otherDay.getTime()) / 86_400_000);
}

/** Today / Yesterday / 2–6d / localized short month + day. */
export function formatQuickChatRelativeDate(
  iso: string,
  nowMs = Date.now(),
  locale?: string | readonly string[],
): string {
  const then = new Date(iso);
  const now = new Date(nowMs);
  if (Number.isNaN(then.getTime()) || Number.isNaN(now.getTime())) {
    return "";
  }

  const days = localCalendarDayDifference(now, then);
  const localeList = typeof locale === "string" ? [locale] : (locale ?? []);
  const isSimplifiedChinese = localeList.some((value) => value.toLowerCase().startsWith("zh"));
  if (days === 0) {
    return isSimplifiedChinese ? "今天" : "Today";
  }
  if (days === 1) {
    return isSimplifiedChinese ? "昨天" : "Yesterday";
  }
  if (days > 1 && days < 7) {
    return isSimplifiedChinese ? `${days}天前` : `${days}d`;
  }
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(then);
}

/**
 * Quick Chat mounts a full ChatView off the browser route. Like dock sidechat,
 * its active thread needs a detail lease or the transcript stays loading/blank
 * after promote + settle while the URL remains on another thread.
 */
export function resolveVisibleQuickChatThreadIds(input: {
  readonly windowOpen: boolean;
  readonly activeThreadId: ThreadId | null;
  readonly hostThreadIds?: readonly ThreadId[];
}): ThreadId[] {
  if (!input.windowOpen || input.activeThreadId === null) {
    return [];
  }
  if (input.hostThreadIds?.includes(input.activeThreadId)) {
    return [];
  }
  return [input.activeThreadId];
}
