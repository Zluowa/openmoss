// FILE: agentRuntimePreparation.ts
// Purpose: What the composer says while a `download` build is still fetching the agent a chat
//          needs (desktopBridge.agentRuntimes), for people who have never heard of a runtime.
// Layer: Web presentation logic (pure)

import type { DesktopAgentRuntimeState, ProviderKind } from "@moss/contracts";

import type { TranslationKey } from "../localization";

/** The runtime Moss downloads for this agent, or null for agents Moss does not ship. */
export function agentRuntimeNameForProvider(
  provider: ProviderKind | null | undefined,
): string | null {
  if (provider === "codex") return "codex";
  if (provider === "claudeAgent") return "claude";
  return null;
}

/** The download state of the runtime this agent needs, when it is not ready yet. */
export function pendingAgentRuntimeFor(
  provider: ProviderKind | null | undefined,
  states: ReadonlyArray<DesktopAgentRuntimeState>,
): DesktopAgentRuntimeState | null {
  const name = agentRuntimeNameForProvider(provider);
  if (!name) return null;
  const state = states.find((candidate) => candidate.name === name);
  return state && state.phase !== "ready" ? state : null;
}

export interface AgentRuntimePreparationText {
  readonly tone: "progress" | "problem";
  /** 0–100 while bytes are known, else null. */
  readonly percent: number | null;
  readonly key: TranslationKey;
  readonly values: Record<string, string | number>;
  readonly canRetry: boolean;
}

const MB = 1_000_000;

function timeLeft(
  seconds: number,
  format: (key: TranslationKey, values: Record<string, string | number>) => string,
): string {
  if (seconds < 60)
    return format("agentRuntime.time.seconds", { count: Math.max(1, Math.ceil(seconds / 5) * 5) });
  return format("agentRuntime.time.minutes", { count: Math.ceil(seconds / 60) });
}

/**
 * One line for the composer. Progress always shows the percentage and megabytes, and the time
 * left once the speed is known; a problem says what happened and what happens next.
 */
export function describeAgentRuntimePreparation(
  state: DesktopAgentRuntimeState,
  format: (key: TranslationKey, values: Record<string, string | number>) => string,
): AgentRuntimePreparationText {
  const percent =
    state.total > 0 ? Math.min(99, Math.floor((state.bytes / state.total) * 100)) : null;
  const sizes = {
    percent: percent ?? 0,
    done: Math.floor(state.bytes / MB),
    total: Math.ceil(state.total / MB),
  };
  const problem = (key: TranslationKey, canRetry = true): AgentRuntimePreparationText => ({
    tone: "problem",
    percent,
    key,
    values: sizes,
    canRetry,
  });
  if (state.phase === "failed" || state.phase === "waiting") {
    switch (state.failure) {
      case "offline":
        return problem("agentRuntime.failure.offline");
      case "proxy":
        return problem("agentRuntime.failure.proxy");
      case "disk":
        return problem("agentRuntime.failure.disk");
      case "mismatch":
        return problem("agentRuntime.failure.mismatch");
      default:
        return problem("agentRuntime.failure.other");
    }
  }
  if (state.phase === "installing")
    return {
      tone: "progress",
      percent: 99,
      key: "agentRuntime.preparing.installing",
      values: {},
      canRetry: false,
    };
  if (state.phase === "paused")
    return {
      tone: "progress",
      percent,
      key: "agentRuntime.preparing.paused",
      values: {},
      canRetry: false,
    };
  if (state.phase === "downloading" && state.bytes > 0) {
    if (state.secondsLeft !== null && state.secondsLeft > 0)
      return {
        tone: "progress",
        percent,
        key: "agentRuntime.preparing.progress",
        values: { ...sizes, time: timeLeft(state.secondsLeft, format) },
        canRetry: false,
      };
    return {
      tone: "progress",
      percent,
      key: "agentRuntime.preparing.progressNoTime",
      values: sizes,
      canRetry: false,
    };
  }
  return {
    tone: "progress",
    percent: null,
    key: "agentRuntime.preparing.starting",
    values: {},
    canRetry: false,
  };
}
