// FILE: mcpAppDockRegistry.ts
// Purpose: Memory-only bridge between a live MCP App host and the existing
// RightDock surfaces. No resource, tool, credential, or transport data is
// retained here.

import { useSyncExternalStore } from "react";

export type McpAppDisplayMode = "inline" | "fullscreen";
export type McpAppNavigationDelta = -1 | 1;

const MCP_APP_DOCK_REQUEST_TIMEOUT_MS = 2_000;
const MCP_APP_DOCK_MAX_TITLE_LENGTH = 120;
const MCP_APP_DOCK_MAX_ID_LENGTH = 48;

export interface McpAppDockEntrySnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly displayMode: McpAppDisplayMode;
  /** Desired mode while frame geometry application is deferred. */
  readonly requestedDisplayMode: McpAppDisplayMode | null;
  readonly selected: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly navigate: (delta: McpAppNavigationDelta) => void;
}

export interface McpAppDockEntryRegistration {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  /** Apply placement against a geometry target; this never reparents the live frame. */
  readonly getInlineContainer: () => HTMLElement | null;
  readonly layoutFrameTo: (
    container: HTMLElement,
    displayMode: McpAppDisplayMode,
  ) => Promise<boolean> | boolean;
  readonly navigate?: (delta: McpAppNavigationDelta) => void;
  /** Keep the stable portal wrapper hidden while this entry is inactive. */
  readonly setFrameVisibility?: (visible: boolean) => void;
  readonly onUnregistered?: () => void;
}

export interface McpAppDockHost {
  /** Open the existing RightDock and select the requested transient entry. */
  readonly open: (entryId: string) => void;
  /** Remove a transient entry from the visible RightDock without re-entering it. */
  readonly hide: (entryId: string) => void;
}

interface PendingTransition {
  readonly mode: McpAppDisplayMode;
  readonly promise: Promise<boolean>;
  readonly resolve: (applied: boolean) => void;
  readonly token: number;
  startFrame: TransitionFrame | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

type TransitionFrame =
  | { readonly kind: "raf"; readonly id: number }
  | { readonly kind: "timeout"; readonly id: ReturnType<typeof setTimeout> };

interface InternalEntry extends McpAppDockEntryRegistration {
  readonly navigate: (delta: McpAppNavigationDelta) => void;
  title: string;
  displayMode: McpAppDisplayMode;
  requestedDisplayMode: McpAppDisplayMode | null;
  canGoBack: boolean;
  canGoForward: boolean;
  sidePanelHost: HTMLElement | null;
  dockVisible: boolean;
  pending: PendingTransition | null;
  transitionToken: number;
}

const entries = new Map<string, InternalEntry>();
const hosts = new Map<string, McpAppDockHost>();
const selectedEntryByThread = new Map<string, string | null>();
const listeners = new Set<() => void>();
const snapshotsByThread = new Map<string, readonly McpAppDockEntrySnapshot[]>();

function boundedTitle(value: string, fallback: string): string {
  const title = value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MCP_APP_DOCK_MAX_TITLE_LENGTH);
  return title.length > 0 ? title : fallback;
}

export function resolveMcpAppDockTitle(
  appName: string | undefined,
  actionName: string | undefined,
  toolName: string,
): string {
  const toolFallback = boundedTitle(toolName, "MCP App");
  const actionFallback = boundedTitle(actionName ?? "", toolFallback);
  return boundedTitle(appName ?? "", actionFallback);
}

function boundedId(value: string): string {
  const id = value.replace(/[^a-z\d_-]/giu, "-").slice(0, MCP_APP_DOCK_MAX_ID_LENGTH);
  return id.length > 0 ? id : "mcp-app-unknown";
}

// FNV-1a is sufficient for a bounded UI identity here. Two independent 32-bit
// lanes keep the opaque id stable without retaining the resource URI.
function hashLane(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

export function makeMcpAppDockEntryId(
  threadId: string,
  callId: string,
  resourceUri: string,
): string {
  const identity = `${threadId}\u0000${callId}\u0000${resourceUri}`;
  const first = hashLane(identity, 2_166_136_261).toString(16).padStart(8, "0");
  const second = hashLane(identity, 2_166_136_261 ^ 0x9e3779b9)
    .toString(16)
    .padStart(8, "0");
  return boundedId(`mcp-app-${first}${second}`);
}

function invalidate(threadId: string): void {
  snapshotsByThread.delete(threadId);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function cancelTransitionFrame(frame: TransitionFrame): void {
  if (frame.kind === "raf") {
    if (typeof window !== "undefined") window.cancelAnimationFrame(frame.id);
  } else {
    clearTimeout(frame.id);
  }
}

function clearPendingTimers(pending: PendingTransition): void {
  if (pending.startFrame !== null) {
    cancelTransitionFrame(pending.startFrame);
    pending.startFrame = null;
  }
  if (pending.deadlineTimer !== null) {
    clearTimeout(pending.deadlineTimer);
    pending.deadlineTimer = null;
  }
}

function resolvePending(entry: InternalEntry, applied: boolean): void {
  const pending = entry.pending;
  entry.pending = null;
  if (!pending) return;
  clearPendingTimers(pending);
  pending.resolve(applied);
}

function cancelPending(entry: InternalEntry): void {
  entry.transitionToken += 1;
  resolvePending(entry, false);
}

function snapshotFor(entry: InternalEntry, selectedId: string | null): McpAppDockEntrySnapshot {
  return {
    id: entry.id,
    threadId: entry.threadId,
    title: entry.title,
    displayMode: entry.displayMode,
    requestedDisplayMode: entry.requestedDisplayMode,
    selected: selectedId === entry.id,
    canGoBack: entry.canGoBack,
    canGoForward: entry.canGoForward,
    navigate: (delta) => navigateMcpAppDockEntry(entry.id, delta),
  };
}

function shouldShowFrame(entry: InternalEntry, selectedId: string | null): boolean {
  if (entry.requestedDisplayMode === "fullscreen") {
    return entry.displayMode === "fullscreen" && entry.dockVisible && selectedId === entry.id;
  }
  if (entry.displayMode === "fullscreen") return entry.dockVisible && selectedId === entry.id;
  return true;
}

function syncFrameVisibility(threadId: string): void {
  const selectedId = selectedEntryByThread.get(threadId) ?? null;
  for (const entry of entries.values()) {
    if (entry.threadId !== threadId) continue;
    try {
      entry.setFrameVisibility?.(shouldShowFrame(entry, selectedId));
    } catch {
      // Visibility is best-effort during card unmount; registry state remains authoritative.
    }
  }
}

function selectReplacementAfterExit(entry: InternalEntry): void {
  if (selectedEntryByThread.get(entry.threadId) !== entry.id) return;
  const replacement = [...entries.values()].find(
    (candidate) =>
      candidate !== entry &&
      candidate.threadId === entry.threadId &&
      (candidate.displayMode === "fullscreen" || candidate.requestedDisplayMode !== null),
  );
  selectedEntryByThread.set(entry.threadId, replacement?.id ?? null);
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  notify();
}

export function getMcpAppDockEntries(threadId: string): readonly McpAppDockEntrySnapshot[] {
  const cached = snapshotsByThread.get(threadId);
  if (cached) return cached;
  const selectedId = selectedEntryByThread.get(threadId) ?? null;
  const snapshot = Object.freeze(
    [...entries.values()]
      .filter(
        (entry) =>
          entry.threadId === threadId &&
          (entry.displayMode === "fullscreen" || entry.requestedDisplayMode !== null),
      )
      .map((entry) => snapshotFor(entry, selectedId)),
  );
  snapshotsByThread.set(threadId, snapshot);
  return snapshot;
}

export function subscribeMcpAppDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMcpAppDockEntries(threadId: string): readonly McpAppDockEntrySnapshot[] {
  return useSyncExternalStore(
    subscribeMcpAppDock,
    () => getMcpAppDockEntries(threadId),
    () => getMcpAppDockEntries(threadId),
  );
}

export function registerMcpAppDockHost(threadId: string, host: McpAppDockHost): () => void {
  hosts.set(threadId, host);
  invalidate(threadId);
  notify();
  return () => {
    if (hosts.get(threadId) !== host) return;
    hosts.delete(threadId);
  };
}

export function selectMcpAppDockEntry(threadId: string, entryId: string | null): void {
  const selected = entryId && entries.get(entryId)?.threadId === threadId ? entryId : null;
  if ((selectedEntryByThread.get(threadId) ?? null) === selected) return;
  selectedEntryByThread.set(threadId, selected);
  syncFrameVisibility(threadId);
  invalidate(threadId);
  notify();
}

function unregisterEntry(entry: InternalEntry): void {
  if (entries.get(entry.id) !== entry) return;
  cancelPending(entry);
  try {
    entry.setFrameVisibility?.(false);
  } catch {
    // The card may already be unmounting; removal remains idempotent.
  }
  entries.delete(entry.id);
  entry.requestedDisplayMode = null;
  entry.sidePanelHost = null;
  if (selectedEntryByThread.get(entry.threadId) === entry.id) {
    selectedEntryByThread.set(entry.threadId, null);
  }
  entry.onUnregistered?.();
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  hosts.get(entry.threadId)?.hide(entry.id);
  notify();
}

export function registerMcpAppDockEntry(input: McpAppDockEntryRegistration): () => Promise<void> {
  const id = boundedId(input.id);
  const previous = entries.get(id);
  const entry: InternalEntry =
    previous && previous.threadId === input.threadId
      ? Object.assign(previous, {
          title: boundedTitle(input.title, "MCP App"),
          getInlineContainer: input.getInlineContainer,
          layoutFrameTo: input.layoutFrameTo,
          navigate: input.navigate ?? previous.navigate,
          setFrameVisibility: input.setFrameVisibility,
          onUnregistered: input.onUnregistered,
        })
      : {
          ...input,
          id,
          title: boundedTitle(input.title, "MCP App"),
          displayMode: "inline",
          requestedDisplayMode: null,
          canGoBack: false,
          canGoForward: false,
          sidePanelHost: null,
          dockVisible: true,
          pending: null,
          transitionToken: 0,
          navigate: input.navigate ?? (() => undefined),
        };

  entries.set(entry.id, entry);
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  notify();

  return async () => unregisterEntry(entry);
}

export function updateMcpAppDockEntryTitle(entryId: string, title: string): void {
  const entry = entries.get(boundedId(entryId));
  if (!entry) return;
  const nextTitle = boundedTitle(title, "MCP App");
  if (entry.title === nextTitle) return;
  entry.title = nextTitle;
  invalidate(entry.threadId);
  notify();
}

export function updateMcpAppDockEntryNavigation(
  entryId: string,
  canGoBack: boolean,
  canGoForward: boolean,
): void {
  const entry = entries.get(boundedId(entryId));
  if (!entry || (entry.canGoBack === canGoBack && entry.canGoForward === canGoForward)) return;
  entry.canGoBack = canGoBack;
  entry.canGoForward = canGoForward;
  invalidate(entry.threadId);
  notify();
}

export function navigateMcpAppDockEntry(entryId: string, delta: McpAppNavigationDelta): void {
  if (delta !== -1 && delta !== 1) return;
  const entry = entries.get(boundedId(entryId));
  if (!entry) return;
  if (delta === -1 ? !entry.canGoBack : !entry.canGoForward) return;
  entry.navigate(delta);
}

export function setMcpAppDockEntryVisibility(entryId: string, visible: boolean): void {
  const entry = entries.get(boundedId(entryId));
  if (!entry || entry.dockVisible === visible) return;
  entry.dockVisible = visible;
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  notify();
}

function transitionPromise(entry: InternalEntry, mode: McpAppDisplayMode): Promise<boolean> {
  if (entry.pending?.mode === mode) return entry.pending.promise;
  cancelPending(entry);
  const token = ++entry.transitionToken;
  let resolveTransition!: (applied: boolean) => void;
  const pending: PendingTransition = {
    mode,
    promise: new Promise<boolean>((resolve) => {
      resolveTransition = resolve;
    }),
    resolve: (applied) => resolveTransition(applied),
    token,
    startFrame: null,
    deadlineTimer: null,
    running: false,
  };
  schedulePendingRun(entry, pending);
  pending.deadlineTimer = setTimeout(() => {
    if (entry.pending !== pending || entry.transitionToken !== token) return;
    entry.requestedDisplayMode = null;
    entry.displayMode = "inline";
    syncFrameVisibility(entry.threadId);
    invalidate(entry.threadId);
    notify();
    selectReplacementAfterExit(entry);
    hosts.get(entry.threadId)?.hide(entry.id);
    resolvePending(entry, false);
  }, MCP_APP_DOCK_REQUEST_TIMEOUT_MS);
  entry.pending = pending;
  return pending.promise;
}

function schedulePendingRun(entry: InternalEntry, pending: PendingTransition): void {
  if (pending.startFrame !== null || pending.running) return;
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    pending.startFrame = {
      kind: "raf",
      id: window.requestAnimationFrame(() => {
        if (entry.pending !== pending || entry.transitionToken !== pending.token) return;
        pending.startFrame = null;
        void runTransition(entry, pending);
      }),
    };
    return;
  }
  pending.startFrame = {
    kind: "timeout",
    id: setTimeout(() => {
      pending.startFrame = null;
      void runTransition(entry, pending);
    }, 0),
  };
}

async function runTransition(entry: InternalEntry, pending: PendingTransition): Promise<void> {
  if (
    entries.get(entry.id) !== entry ||
    entry.pending !== pending ||
    entry.transitionToken !== pending.token ||
    entry.requestedDisplayMode !== pending.mode
  ) {
    return;
  }

  const target = pending.mode === "fullscreen" ? entry.sidePanelHost : entry.getInlineContainer();
  if (!target) return;

  pending.running = true;
  let applied = false;
  try {
    applied = await entry.layoutFrameTo(target, pending.mode);
  } catch {
    applied = false;
  }
  pending.running = false;
  if (
    entries.get(entry.id) !== entry ||
    entry.pending !== pending ||
    entry.transitionToken !== pending.token ||
    entry.requestedDisplayMode !== pending.mode
  ) {
    return;
  }

  entry.requestedDisplayMode = null;
  entry.displayMode = applied ? pending.mode : "inline";
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  notify();
  resolvePending(entry, applied);
  if (pending.mode === "inline") {
    selectReplacementAfterExit(entry);
    hosts.get(entry.threadId)?.hide(entry.id);
  } else if (!applied) {
    selectReplacementAfterExit(entry);
    hosts.get(entry.threadId)?.hide(entry.id);
  }
}

export function attachMcpAppSidePanelHost(
  entryId: string,
  container: HTMLElement,
  visible = true,
): () => void {
  const entry = entries.get(entryId);
  if (!entry) return () => undefined;
  entry.sidePanelHost = container;
  entry.dockVisible = visible;
  syncFrameVisibility(entry.threadId);
  invalidate(entry.threadId);
  notify();
  if (entry.requestedDisplayMode !== null) {
    const pending = entry.pending;
    if (pending?.mode === entry.requestedDisplayMode) {
      schedulePendingRun(entry, pending);
    } else {
      transitionPromise(entry, entry.requestedDisplayMode);
    }
  }
  return () => {
    if (entry.sidePanelHost !== container) return;
    entry.sidePanelHost = null;
    invalidate(entry.threadId);
    notify();
  };
}

/**
 * App-originated requests deliberately return before any React mount or
 * geometry application. The next animation frame owns the deferred layout so
 * AppBridge can send the JSON-RPC receipt first.
 */
export async function requestMcpAppDisplayMode(
  entryId: string,
  requestedMode: unknown,
): Promise<{ mode: McpAppDisplayMode }> {
  const entry = entries.get(entryId);
  if (!entry) return { mode: "inline" };
  if (requestedMode !== "inline" && requestedMode !== "fullscreen") {
    return { mode: entry.displayMode };
  }

  if (requestedMode === "fullscreen") {
    if (entry.displayMode === "fullscreen" && entry.requestedDisplayMode !== "inline") {
      return { mode: "fullscreen" };
    }
    if (entry.requestedDisplayMode === "fullscreen") return { mode: "fullscreen" };
    cancelPending(entry);
    entry.requestedDisplayMode = "fullscreen";
    syncFrameVisibility(entry.threadId);
    invalidate(entry.threadId);
    notify();
    hosts.get(entry.threadId)?.open(entry.id);
    transitionPromise(entry, "fullscreen");
    return { mode: "fullscreen" };
  }

  if (entry.displayMode === "inline" && entry.requestedDisplayMode === null) {
    return { mode: "inline" };
  }
  if (entry.requestedDisplayMode !== "inline") {
    cancelPending(entry);
    entry.requestedDisplayMode = "inline";
    syncFrameVisibility(entry.threadId);
    invalidate(entry.threadId);
    notify();
  }
  transitionPromise(entry, "inline");
  return { mode: "inline" };
}

/** Close a host tab, waiting for the live frame's inline layout before unregistering it. */
export async function closeMcpAppDockEntry(entryId: string): Promise<void> {
  const entry = entries.get(entryId);
  if (!entry) return;
  await requestMcpAppDisplayMode(entryId, "inline");
  const closeToken = entry.transitionToken;
  const transition = entry.pending?.promise;
  if (transition) await transition;
  if (
    entries.get(entryId) !== entry ||
    entry.transitionToken !== closeToken ||
    entry.requestedDisplayMode !== null ||
    entry.displayMode !== "inline"
  ) {
    return;
  }
  unregisterEntry(entry);
}

/** Exit the selected App before a dock close; the host remains mounted until layout completes. */
export async function exitSelectedMcpAppDockEntry(threadId: string): Promise<void> {
  const entryId = selectedEntryByThread.get(threadId) ?? null;
  if (!entryId) return;
  const entry = entries.get(entryId);
  if (!entry) return;
  await requestMcpAppDisplayMode(entryId, "inline");
  const transition = entry.pending?.promise;
  if (transition) await transition;
}

export function resetMcpAppDockRegistryForTests(): void {
  for (const entry of entries.values()) cancelPending(entry);
  entries.clear();
  hosts.clear();
  selectedEntryByThread.clear();
  snapshotsByThread.clear();
  notify();
}
