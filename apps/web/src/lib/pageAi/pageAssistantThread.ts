// FILE: pageAssistantThread.ts
// Purpose: One page-assistant chat per page. Remembers which chat belongs to which page, and
//          keeps that chat's agent started while the person works on the page: it starts the
//          agent when they open a page AI card or focus the page composer, and stops it after a
//          quiet spell or when the page closes. Stopping never interrupts a running turn.
// Layer: Web lib (page AI)

import type { ThreadId, TurnId } from "@moss/contracts";

const STORAGE_KEY = "moss.pageAssistantThreads.v1";
/** How long a page's agent stays started with nothing happening on the page. */
export const PAGE_ASSISTANT_IDLE_MS = 10 * 60_000;
/** A second warm-up request inside this window is not sent again. */
const WARM_AGAIN_AFTER_MS = 30_000;

let memory: Record<string, string> | null = null;

const read = (): Record<string, string> => {
  if (memory) return memory;
  memory = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value) memory[key] = value;
      }
    }
  } catch {
    // Storage can be unavailable; the registry then lasts until the app closes.
  }
  return memory;
};

const write = (next: Record<string, string>) => {
  memory = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // See read().
  }
};

/** Which chat is each page's assistant, keyed by pageAiKey. */
export const pageAssistantThreads = {
  get: (pageKey: string): ThreadId | null => (read()[pageKey] as ThreadId | undefined) ?? null,
  set: (pageKey: string, threadId: ThreadId) => {
    if (read()[pageKey] === threadId) return;
    write({ ...read(), [pageKey]: threadId });
  },
  forget: (pageKey: string, threadId?: ThreadId) => {
    const current = read();
    if (!(pageKey in current) || (threadId && current[pageKey] !== threadId)) return;
    const { [pageKey]: _removed, ...rest } = current;
    write(rest);
  },
  /** Test seam: drops the in-memory copy so the next read comes from storage. */
  resetForTests: () => {
    memory = null;
  },
};

export interface PageAssistantKeeperDeps {
  /** Asks Moss to start the chat's agent. Failures are ignored: the next send starts it. */
  readonly warm: (threadId: ThreadId) => Promise<void>;
  /** Asks Moss to stop the chat's agent. */
  readonly release: (threadId: ThreadId) => Promise<void>;
  /** True while the chat has a turn starting or running; such a chat is never stopped. */
  readonly isBusy: (threadId: ThreadId) => boolean;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface PageAssistantKeeper {
  /** The person is about to use the page's assistant: start its agent if needed. */
  readonly warm: (threadId: ThreadId) => void;
  /** Something happened on the page: push the idle stop back. */
  readonly touch: (threadId: ThreadId) => void;
  /** The page closed: stop the agent unless a turn is running. */
  readonly dispose: () => void;
}

export function createPageAssistantKeeper(deps: PageAssistantKeeperDeps): PageAssistantKeeper {
  const idleMs = deps.idleMs ?? PAGE_ASSISTANT_IDLE_MS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let threadId: ThreadId | null = null;
  let lastWarmAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let disposed = false;

  const stop = (id: ThreadId) => {
    if (deps.isBusy(id)) return false;
    lastWarmAt = Number.NEGATIVE_INFINITY;
    void deps.release(id).catch(() => undefined);
    return true;
  };

  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      if (disposed || !threadId) return;
      // A running turn keeps the agent; check again after another quiet spell.
      if (!stop(threadId)) schedule();
    }, idleMs);
  };

  const follow = (id: ThreadId) => {
    // A different chat for the same page (the old one was archived): stop the old agent.
    if (threadId && threadId !== id) stop(threadId);
    threadId = id;
  };

  return {
    warm: (id) => {
      if (disposed) return;
      follow(id);
      schedule();
      if (now() - lastWarmAt < WARM_AGAIN_AFTER_MS) return;
      lastWarmAt = now();
      void deps.warm(id).catch(() => {
        lastWarmAt = Number.NEGATIVE_INFINITY;
      });
    },
    touch: (id) => {
      if (disposed) return;
      follow(id);
      schedule();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (threadId) stop(threadId);
    },
  };
}

export type PageAssistantSendResult =
  | { readonly kind: "dispatched" }
  | { readonly kind: "error"; readonly message: string; readonly outcomeUnknown?: boolean }
  | { readonly kind: "unavailable" | "open-thread" };

/**
 * Sends a page turn to the page's assistant chat when it can take one, else to a new chat
 * that becomes the page's assistant. A send that may already have reached the agent is never
 * repeated in a new chat.
 */
export async function sendPageAssistantTurn<
  Summary extends {
    readonly id: ThreadId;
    readonly latestTurn: { readonly turnId: TurnId } | null;
  },
>(input: {
  readonly pageKey: string;
  readonly reusable: () => Summary | null;
  readonly sendToExisting: (summary: Summary) => Promise<PageAssistantSendResult>;
  readonly discardUnsent: (threadId: ThreadId) => void;
  readonly startNewChat: () => Promise<ThreadId>;
}): Promise<{ threadId: ThreadId; baselineTurnId: TurnId | null; reused: boolean }> {
  const summary = input.reusable();
  if (summary) {
    const baselineTurnId = summary.latestTurn?.turnId ?? null;
    const result = await input.sendToExisting(summary);
    if (result.kind === "dispatched") return { threadId: summary.id, baselineTurnId, reused: true };
    if (result.kind === "error" && result.outcomeUnknown) throw new Error(result.message);
    input.discardUnsent(summary.id);
  }
  const threadId = await input.startNewChat();
  pageAssistantThreads.set(input.pageKey, threadId);
  return { threadId, baselineTurnId: null, reused: false };
}

/** What a page run's watcher needs from its chat: this run's turn state and reply. */
export function pageRunProgress(
  thread: {
    readonly latestTurn: { readonly turnId: TurnId; readonly state: string } | null;
    readonly session: {
      readonly status: string;
      readonly activeTurnId?: TurnId | undefined;
      readonly updatedAt: string;
    } | null;
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly text: string;
      readonly createdAt: string;
      readonly streaming: boolean;
    }>;
  },
  baselineTurnId: TurnId | null,
  startedAt: number,
): { readonly state: string; readonly reply: string } {
  // The page's assistant chat is reused: earlier turns and replies belong to earlier runs.
  const latestTurn =
    thread.latestTurn && thread.latestTurn.turnId !== baselineTurnId ? thread.latestTurn : null;
  // The run's own message is stamped when it is sent, after the run started. Allow for a
  // little clock skew between the page and the server.
  const firstOwnMessage =
    baselineTurnId === null
      ? 0
      : thread.messages.findIndex(
          (message) =>
            message.role === "user" && Date.parse(message.createdAt) >= startedAt - 5_000,
        );
  const ownMessages = firstOwnMessage === -1 ? [] : thread.messages.slice(firstOwnMessage);
  const reply = ownMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n\n");
  // An agent that never started leaves no turn behind, only a failed session.
  const turn =
    latestTurn?.state ??
    (thread.session?.status === "error" &&
    !thread.session.activeTurnId &&
    Date.parse(thread.session.updatedAt) >= startedAt - 5_000
      ? "error"
      : "pending");
  const streaming = ownMessages.some((message) => message.streaming);
  return { state: streaming ? "running" : turn, reply };
}

/**
 * How long a page run may show no sign of life at all (no reply text, no tool call, no thinking,
 * no turn or agent state change) before Moss stops it. A healthy turn shows something within
 * seconds and keeps doing so; Claude Code's own stream watchdog waits at least 5 minutes for a
 * silent model stream. Acceptance round 11 saw a 可视化 turn sit at 「思考中…」 for 26 minutes.
 */
export const PAGE_RUN_STALL_MS = 180_000;
/**
 * While a tool call is open, Moss sees nothing until it finishes, and a model can take minutes to
 * write a large tool input (a whole HTML page for 可视化). The run gets longer before it counts
 * as stuck; the tools themselves keep their own time limits.
 */
export const PAGE_RUN_OPEN_TOOL_STALL_MS = 600_000;

const CLOSED_TOOL_ACTIVITY_KINDS = new Set(["tool.completed", "tool.summary"]);

/**
 * Everything of a page run that shows the agent is alive, as one comparable mark, and whether
 * a tool call is still open.
 */
export function pageRunActivity(
  thread: {
    readonly latestTurn: { readonly turnId: TurnId; readonly state: string } | null;
    readonly session: { readonly status: string } | null;
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly text: string;
      readonly createdAt: string;
      readonly streaming: boolean;
    }>;
    readonly activities: ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly createdAt: string;
    }>;
  },
  startedAt: number,
): { readonly mark: string; readonly toolOpen: boolean } {
  // Same clock-skew allowance as pageRunProgress.
  const ownSince = startedAt - 5_000;
  const messages = thread.messages.filter((message) => Date.parse(message.createdAt) >= ownSince);
  const activities = thread.activities.filter(
    (activity) => Date.parse(activity.createdAt) >= ownSince,
  );
  const lastTool = activities.findLast((activity) => activity.kind.startsWith("tool."));
  const mark = [
    thread.latestTurn ? `${thread.latestTurn.turnId}:${thread.latestTurn.state}` : "",
    thread.session?.status ?? "",
    messages.length,
    messages.reduce((length, message) => length + message.text.length, 0),
    messages.filter((message) => message.streaming).length,
    activities.length,
    activities.at(-1)?.id ?? "",
  ].join("|");
  return { mark, toolOpen: !!lastTool && !CLOSED_TOOL_ACTIVITY_KINDS.has(lastTool.kind) };
}

export interface PageRunStallGuardDeps {
  /** Called once, when the run has shown nothing for `waitedMs`. */
  readonly onStall: (waitedMs: number) => void;
  readonly stallMs?: number;
  readonly openToolStallMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface PageRunStallGuard {
  /** The run's current activity; a mark different from the last one restarts the wait. */
  readonly observe: (activity: { readonly mark: string; readonly toolOpen: boolean }) => void;
  readonly dispose: () => void;
}

export function createPageRunStallGuard(deps: PageRunStallGuardDeps): PageRunStallGuard {
  const stallMs = deps.stallMs ?? PAGE_RUN_STALL_MS;
  const openToolStallMs = deps.openToolStallMs ?? PAGE_RUN_OPEN_TOOL_STALL_MS;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let last: string | null = null;
  let done = false;
  return {
    observe: ({ mark, toolOpen }) => {
      if (done || mark === last) return;
      last = mark;
      if (timer !== null) clearTimer(timer);
      const waitMs = toolOpen ? openToolStallMs : stallMs;
      timer = setTimer(() => {
        timer = null;
        if (done) return;
        done = true;
        deps.onStall(waitMs);
      }, waitMs);
    },
    dispose: () => {
      done = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
