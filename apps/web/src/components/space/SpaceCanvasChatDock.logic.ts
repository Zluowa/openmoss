// FILE: SpaceCanvasChatDock.logic.ts
// Purpose: Pure state helpers, PiP geometry clamping, snap detection, elapsed timer labels,
//          selection badges, host insets computation, and 500-entry LRU thread history for
//          the unified 3-state Portal SpaceCanvasChatDock.
// Layer: Space workspace UI (space-dock-chrome slice)

import type { SpaceId, ThreadId } from "@moss/contracts";

import {
  SPACE_DOCK_PERSIST_KEYS,
  type SpaceArtifactKind,
  type SpaceCanvasDockRequest,
  type SpaceCanvasDockState,
  type SpaceCanvasHostInsets,
  type SpaceCanvasSelectionContext,
} from "./spaceCanvasDockContract";

export interface SpaceDockPipSize {
  readonly width: number;
  readonly height: number;
}

export interface SpaceDockPipRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SpaceDockViewportMetrics {
  readonly width: number;
  readonly height: number;
  readonly topInsetPx?: number;
  readonly bottomInsetPx?: number;
  readonly minWidthPx?: number;
}

export type SpaceDockPipResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface SpaceDockRecentThreadEntry {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly artifactKey: string;
  readonly kind: SpaceArtifactKind;
  readonly itemId: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly updatedAt: number;
}

export interface SpaceDockFailureRecovery {
  readonly message: string;
  readonly retryRequest?: SpaceCanvasDockRequest | undefined;
  readonly threadId?: ThreadId | null | undefined;
}

/** Claude/ChatGPT exact PiP defaults and bounds. */
export const SPACE_DOCK_DEFAULT_PIP_SIZE: SpaceDockPipSize = { width: 560, height: 640 };
export const SPACE_DOCK_MIN_PIP_WIDTH_PX = 372;
export const SPACE_DOCK_UNTYPED_MIN_PIP_WIDTH_PX = 240;
export const SPACE_DOCK_MIN_PIP_HEIGHT_PX = 400;
export const SPACE_DOCK_PIP_MARGIN_PX = 16;
export const SPACE_DOCK_DEFAULT_TOP_INSET_PX = 44;
export const SPACE_DOCK_FOOT_BAR_ROOM_PX = 60;
export const SPACE_DOCK_RIGHT_SNAP_ZONE_PX = 80;
export const SPACE_DOCK_RIGHT_COLLAPSE_THRESHOLD_PX = 320;
export const SPACE_DOCK_TAB_CLOSE_LOCK_MS = 300;
export const SPACE_DOCK_RECENT_THREADS_LRU_LIMIT = 500;

const RECENT_THREADS_STORAGE_KEY = "moss.spaceCanvasDock.recentThreads.v1";

const ARTIFACT_KIND_LABELS: Record<SpaceArtifactKind, string> = {
  page: "文档",
  slides: "幻灯片",
  sheet: "电子表格",
  design: "设计",
  dashboard: "仪表盘",
  board: "白板",
  app: "应用",
};

export function spaceArtifactKindLabel(kind: SpaceArtifactKind): string {
  return ARTIFACT_KIND_LABELS[kind];
}

export function formatSpaceDockElapsedLabel(busy: boolean, elapsedSeconds: number): string {
  if (busy) {
    return `已处理 ${Math.max(0, Math.floor(elapsedSeconds))}秒`;
  }
  if (elapsedSeconds > 0) {
    return "已完成";
  }
  return "问 Moss";
}

export function formatSpaceDockTimerBadge(busy: boolean, elapsedSeconds: number): string | null {
  if (busy) {
    return `${Math.max(0, Math.floor(elapsedSeconds))}秒`;
  }
  if (elapsedSeconds > 0) {
    return "已完成";
  }
  return null;
}

export function formatSpaceDockSelectionSummary(
  selection: SpaceCanvasSelectionContext | null,
): string | null {
  if (!selection) return null;
  const parts: string[] = [];
  if (selection.sheetName && selection.range) {
    parts.push(`${selection.sheetName} · ${selection.range}`);
  } else if (selection.range) {
    parts.push(`区域 ${selection.range}`);
  }
  if (selection.slideIds && selection.slideIds.length > 0) {
    parts.push(`已选 ${selection.slideIds.length} 页幻灯片`);
  }
  if (selection.elementIds && selection.elementIds.length > 0) {
    parts.push(`已选 ${selection.elementIds.length} 个元素`);
  }
  if (selection.boardIds && selection.boardIds.length > 0) {
    parts.push(`已选 ${selection.boardIds.length} 个画板对象`);
  }
  if (selection.anchorBlockId) {
    parts.push("已定位段落");
  }
  if (selection.summary?.trim()) {
    parts.push(selection.summary.trim());
  } else if (selection.quote?.trim()) {
    const snippet = selection.quote.trim().replace(/\s+/g, " ");
    parts.push(snippet.length > 36 ? `${snippet.slice(0, 36)}…` : snippet);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function buildSpaceDockCompanionContext(
  target: {
    readonly kind: SpaceArtifactKind;
    readonly itemId: string;
    readonly title: string;
    readonly scopeSpaceId: SpaceId | null;
    readonly revision?: number | null | undefined;
  },
  selection: SpaceCanvasSelectionContext | null,
  extraContext?: string | null,
): string {
  const lines = [
    "[space-canvas-companion]",
    `kind: ${target.kind} (${spaceArtifactKindLabel(target.kind)})`,
    `itemId: ${target.itemId}`,
    `title: ${target.title}`,
    `scopeSpaceId: ${target.scopeSpaceId ?? "local"}`,
  ];
  if (target.revision !== undefined && target.revision !== null) {
    lines.push(`revision: ${target.revision}`);
  }
  if (selection?.anchorBlockId) {
    lines.push(`anchorBlockId: ${selection.anchorBlockId}`);
  }
  if (selection?.sheetName) {
    lines.push(`sheetName: ${selection.sheetName}`);
  }
  if (selection?.range) {
    lines.push(`range: ${selection.range}`);
  }
  if (selection?.slideIds?.length) {
    lines.push(`slideIds: ${selection.slideIds.join(", ")}`);
  }
  if (selection?.elementIds?.length) {
    lines.push(`elementIds: ${selection.elementIds.join(", ")}`);
  }
  if (selection?.boardIds?.length) {
    lines.push(`boardIds: ${selection.boardIds.join(", ")}`);
  }
  if (selection?.quote?.trim()) {
    lines.push(`quote: ${selection.quote.trim()}`);
  }
  if (selection?.summary?.trim()) {
    lines.push(`summary: ${selection.summary.trim()}`);
  }
  if (extraContext?.trim()) {
    lines.push("", extraContext.trim());
  }
  return lines.join("\n");
}

export function clampSpaceDockPipRect(
  rect: Partial<SpaceDockPipRect>,
  viewport: SpaceDockViewportMetrics,
): SpaceDockPipRect {
  const margin = SPACE_DOCK_PIP_MARGIN_PX;
  const topFloor = (viewport.topInsetPx ?? SPACE_DOCK_DEFAULT_TOP_INSET_PX) + margin;
  const bottomMargin = (viewport.bottomInsetPx ?? SPACE_DOCK_FOOT_BAR_ROOM_PX) + margin;
  const safeViewportWidth = Math.max(viewport.width, 320);
  const safeViewportHeight = Math.max(viewport.height, 360);

  const requestedMinWidth = viewport.minWidthPx ?? SPACE_DOCK_MIN_PIP_WIDTH_PX;
  const maxWidth = Math.max(
    Math.min(requestedMinWidth, safeViewportWidth - margin * 2),
    Math.floor(safeViewportWidth * 0.5),
  );
  const minWidth = Math.min(requestedMinWidth, maxWidth);

  const maxHeight = Math.max(
    240,
    safeViewportHeight - (viewport.topInsetPx ?? SPACE_DOCK_DEFAULT_TOP_INSET_PX) - 32,
  );
  const minHeight = Math.min(SPACE_DOCK_MIN_PIP_HEIGHT_PX, maxHeight);

  const width = Math.max(
    minWidth,
    Math.min(maxWidth, Math.round(rect.width ?? SPACE_DOCK_DEFAULT_PIP_SIZE.width)),
  );
  const height = Math.max(
    minHeight,
    Math.min(maxHeight, Math.round(rect.height ?? SPACE_DOCK_DEFAULT_PIP_SIZE.height)),
  );

  const defaultLeft = Math.max(margin, safeViewportWidth - width - margin);
  const defaultTop = Math.max(topFloor, safeViewportHeight - height - bottomMargin);

  const maxLeft = Math.max(margin, safeViewportWidth - width - margin);
  const maxTop = Math.max(topFloor, safeViewportHeight - height - margin);

  const left = Math.max(margin, Math.min(maxLeft, Math.round(rect.left ?? defaultLeft)));
  const top = Math.max(topFloor, Math.min(maxTop, Math.round(rect.top ?? defaultTop)));

  return { left, top, width, height };
}

export function applySpaceDockPipResize(
  startRect: SpaceDockPipRect,
  edge: SpaceDockPipResizeEdge,
  dx: number,
  dy: number,
  viewport: SpaceDockViewportMetrics,
): SpaceDockPipRect {
  let { left, top, width, height } = startRect;
  const right = startRect.left + startRect.width;
  const bottom = startRect.top + startRect.height;

  if (edge.includes("e")) {
    width = startRect.width + dx;
  }
  if (edge.includes("w")) {
    const tentativeWidth = startRect.width - dx;
    const clampedForLeft = clampSpaceDockPipRect(
      { left, top, width: tentativeWidth, height },
      viewport,
    );
    width = clampedForLeft.width;
    left = right - width;
  }
  if (edge.includes("s")) {
    height = startRect.height + dy;
  }
  if (edge.includes("n")) {
    const tentativeHeight = startRect.height - dy;
    const clampedForTop = clampSpaceDockPipRect(
      { left, top, width, height: tentativeHeight },
      viewport,
    );
    height = clampedForTop.height;
    top = bottom - height;
  }

  return clampSpaceDockPipRect({ left, top, width, height }, viewport);
}

export function isNearSpaceDockRightSnapZone(input: {
  readonly rectRightPx: number;
  readonly containerWidthPx: number;
  readonly pointerClientX?: number | undefined;
  readonly containerRightPx?: number | undefined;
}): boolean {
  if (input.containerWidthPx <= 0) return false;
  if (input.pointerClientX !== undefined && input.containerRightPx !== undefined) {
    if (input.containerRightPx - input.pointerClientX <= SPACE_DOCK_RIGHT_SNAP_ZONE_PX) {
      return true;
    }
  }
  return input.containerWidthPx - input.rectRightPx <= 12;
}

export function computeSpaceDockHostInsets(input: {
  readonly state: SpaceCanvasDockState;
  readonly showCollapsedPill: boolean;
  readonly collapsedPillHeightPx?: number;
  readonly pipRect?: SpaceDockPipRect | null;
  readonly containerWidthPx?: number;
  readonly dockedWidthPx?: number;
}): SpaceCanvasHostInsets {
  if (input.state === "docked") {
    // Docked RightDock participates in flex layout flow (`sidebar-gap`), so <main> shrinks directly.
    return {
      bottomInsetPx: 0,
      rightInsetPx: Math.max(0, Math.round(input.dockedWidthPx ?? 0)),
    };
  }
  if (input.state === "pip") {
    const pipWidth = input.pipRect?.width ?? SPACE_DOCK_DEFAULT_PIP_SIZE.width;
    return {
      bottomInsetPx: 0,
      rightInsetPx: Math.max(0, Math.min(360, Math.round(pipWidth))),
    };
  }
  if (!input.showCollapsedPill) {
    return { bottomInsetPx: 0, rightInsetPx: 0 };
  }
  return {
    bottomInsetPx: Math.max(52, Math.round((input.collapsedPillHeightPx ?? 40) + 16)),
    rightInsetPx: 0,
  };
}

export function readPersistedSpaceDockMode(): SpaceCanvasDockState {
  if (typeof window === "undefined") return "collapsed";
  try {
    const raw = window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.mode);
    if (raw === "collapsed" || raw === "pip" || raw === "docked") {
      return raw;
    }
  } catch {
    // Ignore storage failures in sandboxed contexts.
  }
  return "collapsed";
}

export function writePersistedSpaceDockMode(state: SpaceCanvasDockState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.mode, state);
  } catch {
    // Ignore storage failures.
  }
}

export function readPersistedSpaceDockPipSize(): SpaceDockPipSize {
  if (typeof window === "undefined") return SPACE_DOCK_DEFAULT_PIP_SIZE;
  try {
    const raw = window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.pipSize);
    if (!raw) return SPACE_DOCK_DEFAULT_PIP_SIZE;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { width?: unknown }).width === "number" &&
      typeof (parsed as { height?: unknown }).height === "number"
    ) {
      return {
        width: Math.max(SPACE_DOCK_UNTYPED_MIN_PIP_WIDTH_PX, (parsed as { width: number }).width),
        height: Math.max(SPACE_DOCK_MIN_PIP_HEIGHT_PX, (parsed as { height: number }).height),
      };
    }
  } catch {
    // Ignore malformed storage values.
  }
  return SPACE_DOCK_DEFAULT_PIP_SIZE;
}

export function writePersistedSpaceDockPipSize(size: SpaceDockPipSize): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SPACE_DOCK_PERSIST_KEYS.pipSize,
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
    );
  } catch {
    // Ignore storage failures.
  }
}

export function readSkipSidechatCloseConfirmation(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.skipCloseConfirm) === "true";
  } catch {
    return false;
  }
}

export function writeSkipSidechatCloseConfirmation(skip: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (skip) {
      window.localStorage.setItem(SPACE_DOCK_PERSIST_KEYS.skipCloseConfirm, "true");
    } else {
      window.localStorage.removeItem(SPACE_DOCK_PERSIST_KEYS.skipCloseConfirm);
    }
  } catch {
    // Ignore storage failures.
  }
}

let recentThreadsCache: SpaceDockRecentThreadEntry[] | null = null;

export function readSpaceDockRecentThreads(): SpaceDockRecentThreadEntry[] {
  if (recentThreadsCache) return recentThreadsCache;
  if (typeof window === "undefined") {
    recentThreadsCache = [];
    return recentThreadsCache;
  }
  try {
    const raw = window.localStorage.getItem(RECENT_THREADS_STORAGE_KEY);
    if (!raw) {
      recentThreadsCache = [];
      return recentThreadsCache;
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      recentThreadsCache = parsed
        .filter(
          (entry): entry is SpaceDockRecentThreadEntry =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as SpaceDockRecentThreadEntry).threadId === "string" &&
            typeof (entry as SpaceDockRecentThreadEntry).artifactKey === "string",
        )
        .slice(0, SPACE_DOCK_RECENT_THREADS_LRU_LIMIT);
      return recentThreadsCache;
    }
  } catch {
    // Ignore malformed storage values.
  }
  recentThreadsCache = [];
  return recentThreadsCache;
}

export function recordSpaceDockRecentThread(
  entry: SpaceDockRecentThreadEntry,
): SpaceDockRecentThreadEntry[] {
  const existing = readSpaceDockRecentThreads().filter((item) => item.threadId !== entry.threadId);
  const next = [entry, ...existing].slice(0, SPACE_DOCK_RECENT_THREADS_LRU_LIMIT);
  recentThreadsCache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(RECENT_THREADS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }
  return next;
}

export function resetSpaceDockLogicForTests(): void {
  recentThreadsCache = null;
}

function stringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Structural comparison for Dock selection context so equivalent re-emissions never loop. */
export function areSpaceDockSelectionsEqual(
  a: SpaceCanvasSelectionContext | null,
  b: SpaceCanvasSelectionContext | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.itemId === b.itemId &&
    a.title === b.title &&
    (a.anchorBlockId ?? null) === (b.anchorBlockId ?? null) &&
    (a.sheetName ?? null) === (b.sheetName ?? null) &&
    (a.range ?? null) === (b.range ?? null) &&
    (a.quote ?? null) === (b.quote ?? null) &&
    (a.summary ?? null) === (b.summary ?? null) &&
    stringArraysEqual(a.slideIds, b.slideIds) &&
    stringArraysEqual(a.elementIds, b.elementIds) &&
    stringArraysEqual(a.boardIds, b.boardIds)
  );
}
