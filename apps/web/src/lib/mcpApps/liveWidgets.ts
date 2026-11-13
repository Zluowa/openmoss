// FILE: liveWidgets.ts
// Purpose: One live widget (host controller + side-panel entry) per tool call, shared by every
//          row that shows it. Rows come and go — React StrictMode, a turn folding into its
//          「已工作」 group, the transcript list virtualising — but the widget keeps running and its
//          frame moves to whichever slot is mounted. A widget with no row for a short grace
//          period is torn down.
// Layer: Web MCP App host state
// Exports: acquireMcpAppWidget, releaseMcpAppWidget, peekMcpAppWidget, mcpAppRowStartState,
//          McpAppLiveWidget, resetMcpAppLiveWidgetsForTests

import type { McpAppHostController, McpAppHostSnapshot } from "../mcpAppHost";

/** How long a widget outlives its last row (a remount arrives well within this). */
export const MCP_APP_WIDGET_RELEASE_GRACE_MS = 1_500;

export interface McpAppLiveWidget<Context> {
  readonly id: string;
  readonly controller: McpAppHostController;
  /** Per-render things the controller's callbacks read (translations, navigation, open state). */
  context: Context;
  refs: number;
  /** What the side-panel registry last allowed. */
  registryVisible: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  dispose: (() => void) | null;
}

const widgets = new Map<string, McpAppLiveWidget<unknown>>();

export function acquireMcpAppWidget<Context>(
  id: string,
  context: Context,
  create: (widget: McpAppLiveWidget<Context>) => {
    readonly controller: McpAppHostController;
    readonly dispose: () => void;
  },
): McpAppLiveWidget<Context> {
  const existing = widgets.get(id) as McpAppLiveWidget<Context> | undefined;
  if (existing) {
    if (existing.releaseTimer !== null) clearTimeout(existing.releaseTimer);
    existing.releaseTimer = null;
    existing.refs += 1;
    existing.context = context;
    return existing;
  }
  const widget = {
    id,
    context,
    refs: 1,
    registryVisible: true,
    releaseTimer: null,
    dispose: null,
  } as unknown as McpAppLiveWidget<Context> & { controller: McpAppHostController };
  const created = create(widget);
  (widget as { controller: McpAppHostController }).controller = created.controller;
  widget.dispose = created.dispose;
  widgets.set(id, widget as McpAppLiveWidget<unknown>);
  return widget;
}

export function releaseMcpAppWidget(
  id: string,
  graceMs: number = MCP_APP_WIDGET_RELEASE_GRACE_MS,
): void {
  const widget = widgets.get(id);
  if (!widget) return;
  widget.refs = Math.max(0, widget.refs - 1);
  if (widget.refs > 0 || widget.releaseTimer !== null) return;
  widget.releaseTimer = setTimeout(() => {
    widget.releaseTimer = null;
    if (widget.refs > 0 || widgets.get(id) !== widget) return;
    widgets.delete(id);
    widget.dispose?.();
  }, graceMs);
}

export function peekMcpAppWidget(id: string): McpAppLiveWidget<unknown> | undefined {
  return widgets.get(id);
}

/**
 * What a row should show on its very first render. A row that remounts (its turn folded into
 * 「已工作」, or finished) gets the call's running widget only in a layout effect; drawn from an
 * empty state until then, its card would commit at 0 px and animate back to its height on every
 * remount, and its frame would be parked for a frame. With a running widget the row starts from
 * that widget's state and attaches at once; otherwise it reserves the remembered height.
 */
export function mcpAppRowStartState(
  id: string,
  rememberedHeight: number | null,
): {
  readonly snapshot: McpAppHostSnapshot | null;
  readonly started: boolean;
  readonly height: number;
} {
  const snapshot = widgets.get(id)?.controller.getSnapshot() ?? null;
  return {
    snapshot,
    started: snapshot !== null && snapshot.phase !== "idle",
    height: snapshot?.height ?? rememberedHeight ?? 0,
  };
}

export function resetMcpAppLiveWidgetsForTests(): void {
  for (const widget of widgets.values()) {
    if (widget.releaseTimer !== null) clearTimeout(widget.releaseTimer);
    widget.dispose?.();
  }
  widgets.clear();
}
