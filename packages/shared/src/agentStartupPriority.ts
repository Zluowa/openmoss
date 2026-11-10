// FILE: agentStartupPriority.ts
// Purpose: Keeps a newly started agent at normal CPU priority on Windows until its session is
//          ready, then applies the configured below-normal priority before it runs any tools.
//          The setting (upstream #1577) keeps agents' work and their tools from taking CPU away
//          from the person's own programs; only the short handshake is exempt.
// Layer: Shared platform runtime
// Exports: AGENT_STARTUP_PRIORITY_GRACE_MS, deferAgentPriorityUntilReady,
//          settleAgentStartupPriority, cancelAgentStartupPriority

import { lowerProcessPriority } from "./platformProcess";

/**
 * Upper bound on how long a deferred agent keeps normal priority when its owner never reports
 * ready (a stalled handshake, an owner that forgot). Startup on a fully busy PC was measured at
 * up to ~20 s, so this sits above that and below any agent's first real tool work.
 */
export const AGENT_STARTUP_PRIORITY_GRACE_MS = 30_000;

/**
 * Windows priority classes are strict: a below-normal process only runs when no normal-priority
 * thread wants the CPU. With the PC busy (a browser, a game, a compile), a below-normal agent's
 * own startup measured 0.6–6.7 s for a handshake that takes 0.4–0.6 s at normal priority. POSIX
 * `nice 5` only reduces a share, so there the agent keeps its before-exec priority.
 */
export function shouldDeferAgentPriority(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

interface PendingLowering {
  readonly settle: () => void;
  readonly cancel: () => void;
}

const pendingLowerings = new WeakMap<object, PendingLowering>();

/**
 * Registers the priority lowering for `owner` (the child handle). It runs on
 * {@link settleAgentStartupPriority} or after the grace, whichever comes first, and never after
 * {@link cancelAgentStartupPriority} (the process exited, so its PID may belong to someone else).
 * Children the agent starts after the lowering inherit the below-normal class.
 */
export function deferAgentPriorityUntilReady(
  owner: object,
  input: {
    readonly pid: number | undefined;
    readonly platform?: NodeJS.Platform;
    readonly graceMs?: number;
  },
): void {
  pendingLowerings.get(owner)?.cancel();
  let finished = false;
  const finish = () => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    if (pendingLowerings.get(owner) === entry) pendingLowerings.delete(owner);
    return true;
  };
  const entry: PendingLowering = {
    settle: () => {
      if (finish()) {
        lowerProcessPriority(input.pid, input.platform ? { platform: input.platform } : {});
      }
    },
    cancel: () => {
      finish();
    },
  };
  const timer = setTimeout(entry.settle, input.graceMs ?? AGENT_STARTUP_PRIORITY_GRACE_MS);
  timer.unref?.();
  pendingLowerings.set(owner, entry);
}

/** The agent is ready: apply its configured lower priority now. Safe to call more than once. */
export function settleAgentStartupPriority(owner: object): void {
  pendingLowerings.get(owner)?.settle();
}

/** The agent exited or was torn down: drop the pending lowering without touching its PID. */
export function cancelAgentStartupPriority(owner: object): void {
  pendingLowerings.get(owner)?.cancel();
}

/** Test seam: whether `owner` still waits for its lowering. */
export function hasPendingAgentStartupPriority(owner: object): boolean {
  return pendingLowerings.has(owner);
}
