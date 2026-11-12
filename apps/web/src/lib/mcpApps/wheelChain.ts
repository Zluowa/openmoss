// FILE: wheelChain.ts
// Purpose: Wheel a widget did not use scrolls the transcript, as Claude's in-page frame does.
//          The widget is a separate webview, so its proxy reports the leftover wheel as a
//          `moss:wheel` message on the bridge port; this decodes it and scrolls the chat.
// Layer: MCP App host (web)
// Exports: decodeMcpAppWheelMessage, chainMcpAppWheel

import { MCP_APP_SANDBOX_WHEEL_MAX_DELTA, MCP_APP_SANDBOX_WHEEL_TYPE } from "@moss/contracts";

export interface McpAppWheelDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

const clamp = (value: number) =>
  Math.max(-MCP_APP_SANDBOX_WHEEL_MAX_DELTA, Math.min(MCP_APP_SANDBOX_WHEEL_MAX_DELTA, value));

/** `{type: "moss:wheel", deltaX, deltaY}` with finite numbers only, clamped; else null. */
export function decodeMcpAppWheelMessage(message: unknown): McpAppWheelDelta | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== MCP_APP_SANDBOX_WHEEL_TYPE) return null;
  if (Object.keys(candidate).toSorted().join(",") !== "deltaX,deltaY,type") return null;
  const { deltaX, deltaY } = candidate;
  if (typeof deltaX !== "number" || typeof deltaY !== "number") return null;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return null;
  return { deltaX: clamp(deltaX), deltaY: clamp(deltaY) };
}

/** Scrolls the transcript that holds `anchor` (the widget's inline slot) by the delta. */
export function chainMcpAppWheel(anchor: Element | null, delta: McpAppWheelDelta): boolean {
  const scroller = anchor?.closest<HTMLElement>('[data-chat-scroll-container="true"]');
  if (!scroller) return false;
  // Instant, like the wheel itself: no smooth-scroll animation per frame.
  if (delta.deltaY !== 0) scroller.scrollTop += delta.deltaY;
  if (delta.deltaX !== 0) scroller.scrollLeft += delta.deltaX;
  return true;
}
