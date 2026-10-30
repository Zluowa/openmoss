// FILE: codexMossFirstActivityWatchdog.ts
// Purpose: Pure fail-fast policy for Moss CN / MemFire first-activity deadlines.
// CN DeepSeek with full MCP+skills+high effort often needs ~90s before its
// first progress event; the former 45s deadline was too tight for retest-191h.
// Layer: Provider policy helper
// Exports: evaluateCodexMossFirstActivityTick, CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS, resolveCodexMossFirstActivityTimeoutMs

import type { ProviderRuntimeEvent } from "@synara/contracts";

import { resolveAcpTurnIdleTimeoutMs } from "./acp/AcpTurnIdleWatchdog.ts";

export const CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS = 90_000;

/**
 * Live Moss first-activity deadline used by CodexAdapter. Defaults to
 * {@link CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS} so Adapter cannot
 * silently keep a stale 15s literal when the shared constant moves.
 */
export function resolveCodexMossFirstActivityTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveAcpTurnIdleTimeoutMs({
    envVar: "MOSS_CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS",
    defaultMs: CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS,
    env,
  });
}

export type CodexMossFirstActivityDecision = "continue" | "touch" | "disarm" | "abort";

const MOSS_FIRST_ACTIVITY_CONTENT_STREAM_KINDS = new Set([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
]);

const MOSS_FIRST_ACTIVITY_ITEM_TYPES = new Set([
  "assistant_message",
  "reasoning",
  "plan",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_generation",
  "image_view",
  "error",
]);

/**
 * Return true only for model/tool work or an explicit turn settlement.
 * Bootstrap, connection, warning, user-input, and unmapped events are not
 * evidence that the model has begun producing the requested turn.
 */
export function isCodexMossFirstActivityProgressEvent(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "content.delta":
      return MOSS_FIRST_ACTIVITY_CONTENT_STREAM_KINDS.has(event.payload.streamKind);
    case "item.started":
    case "item.updated":
    case "item.completed":
      return MOSS_FIRST_ACTIVITY_ITEM_TYPES.has(event.payload.itemType);
    case "runtime.error":
    case "turn.completed":
    case "turn.aborted":
      return true;
    default:
      return false;
  }
}

/**
 * Decide whether a Moss-managed turn that has not yet produced progress should
 * keep waiting, pause for human input, disarm after settlement, or abort.
 */
export function evaluateCodexMossFirstActivityTick(input: {
  readonly firstActivityStartedAt: number | null;
  readonly now: number;
  readonly timeoutMs?: number;
  readonly isTurnActive: boolean;
  readonly isAwaitingHuman: boolean;
}): CodexMossFirstActivityDecision {
  if (input.firstActivityStartedAt === null) return "continue";
  if (!input.isTurnActive) return "disarm";
  if (input.isAwaitingHuman) return "touch";
  const timeoutMs = input.timeoutMs ?? CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS;
  if (input.now - input.firstActivityStartedAt < timeoutMs) return "continue";
  return "abort";
}
