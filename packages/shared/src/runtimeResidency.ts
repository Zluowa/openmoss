// FILE: runtimeResidency.ts
// Purpose: One policy for what Moss keeps loaded while nobody is looking at it: browser pages,
//          the side panel's editors and previews, the apps a conversation opened, and the
//          backend's per-conversation stores.
// Layer: Shared runtime policy (pure: no timers, no I/O)
// Exports: RuntimeResidencyClass, RuntimeResidencyPolicy, RUNTIME_RESIDENCY_POLICIES,
//          ResidentRuntimeState, selectExpiredRuntimes, selectRuntimesOverBudget,
//          planRuntimeResidency
// Why: Every heavy surface used to decide this on its own (the browser in the desktop process,
//      the Canvas in its panel, apps not at all). One planner and one table keep them consistent:
//      a shown runtime is never touched, a hidden one stays warm for a while so switching back is
//      instant, and past a budget the least recently used hidden one goes first.
//
// The rules, in order:
//   1. A shown or pinned runtime (in use, an agent acting on it, a sign-in popup open) stays.
//   2. A runtime hidden for longer than the class's delay is suspended. Under memory pressure the
//      shorter delay applies.
//   3. Each owner (a conversation) keeps at most `maxHiddenPerOwner` hidden runtimes loaded.
//   4. At most `maxLoaded` runtimes of the class stay loaded app-wide, shown ones included.
// 3 and 4 suspend the least recently used hidden runtime first. A suspended runtime comes back
// from its saved state (a page from its URL, an editor from its saved document, an app from its
// tool result) the next time it is shown.

export type RuntimeResidencyClass = "browserTab" | "dockFrame" | "appWidget" | "conversationStore";

export interface RuntimeResidencyPolicy {
  /** A hidden runtime is suspended after this long. */
  readonly hiddenSuspendMs: number;
  /** The delay instead, while the system reports memory pressure. */
  readonly pressuredHiddenSuspendMs: number;
  /** Hidden runtimes one owner keeps loaded. */
  readonly maxHiddenPerOwner: number;
  /** Runtimes of this class loaded app-wide, shown ones included. */
  readonly maxLoaded: number;
}

export const RUNTIME_RESIDENCY_POLICIES: Readonly<
  Record<RuntimeResidencyClass, RuntimeResidencyPolicy>
> = {
  // A browser page keeps its DOM, scroll, form input and history: switching tabs must never cost
  // the page, so it stays warm for minutes. Each page is its own renderer process.
  browserTab: {
    hiddenSuspendMs: 10 * 60_000,
    pressuredHiddenSuspendMs: 60_000,
    maxHiddenPerOwner: 5,
    maxLoaded: 12,
  },
  // Side-panel editors and previews (Canvas, slides, HTML renders). Reloading one from the
  // browser cache takes about a second; loaded, one holds 20-50 MB of the window's heap, far
  // more with images. Three minutes covers reading and answering in the chat.
  dockFrame: {
    hiddenSuspendMs: 3 * 60_000,
    pressuredHiddenSuspendMs: 60_000,
    maxHiddenPerOwner: 2,
    maxLoaded: 4,
  },
  // Apps opened by a conversation (MCP Apps). Each runs in its own guest process and may hold
  // state the person built up, so it is kept as long as a browser page.
  appWidget: {
    hiddenSuspendMs: 10 * 60_000,
    pressuredHiddenSuspendMs: 60_000,
    maxHiddenPerOwner: 4,
    maxLoaded: 8,
  },
  // A conversation's backend store (its Canvas: the folder's writer lease and project state).
  // "Hidden" here means idle: no request for five minutes means nobody has its editor open, as an
  // open editor saves through the store while it is used. Reopening one takes about 5 ms.
  conversationStore: {
    hiddenSuspendMs: 5 * 60_000,
    pressuredHiddenSuspendMs: 60_000,
    maxHiddenPerOwner: 1,
    maxLoaded: 8,
  },
};

export interface ResidentRuntimeState {
  readonly key: string;
  /** The conversation (or other scope) the runtime belongs to. */
  readonly owner: string;
  readonly visible: boolean;
  /** Never suspended: in use, an agent is acting on it, or a sign-in popup depends on it. */
  readonly pinned: boolean;
  /** When it was last shown or used (any monotonic clock shared by the caller's runtimes). */
  readonly lastActiveAt: number;
  /** When it was last hidden; null while shown. */
  readonly hiddenSince: number | null;
}

const isCandidate = (runtime: ResidentRuntimeState) => !runtime.visible && !runtime.pinned;
const leastRecentlyUsedFirst = (a: ResidentRuntimeState, b: ResidentRuntimeState) =>
  a.lastActiveAt - b.lastActiveAt;

function hiddenDelay(policy: RuntimeResidencyPolicy, pressured: boolean): number {
  return pressured ? policy.pressuredHiddenSuspendMs : policy.hiddenSuspendMs;
}

/** Rule 2: hidden for longer than the delay. */
export function selectExpiredRuntimes(input: {
  readonly runtimes: readonly ResidentRuntimeState[];
  readonly now: number;
  readonly delayMs: number;
}): string[] {
  return input.runtimes
    .filter(
      (runtime) =>
        isCandidate(runtime) &&
        runtime.hiddenSince !== null &&
        input.now - runtime.hiddenSince >= input.delayMs,
    )
    .map((runtime) => runtime.key);
}

/**
 * Rules 3 and 4: the hidden, unpinned runtimes to suspend so that each owner keeps at most
 * `maxHiddenPerOwner` hidden runtimes and at most `maxLoaded` stay loaded overall. Least recently
 * used first. Either limit may be omitted.
 */
export function selectRuntimesOverBudget(input: {
  readonly runtimes: readonly ResidentRuntimeState[];
  readonly maxHiddenPerOwner?: number;
  readonly maxLoaded?: number;
}): string[] {
  const suspended = new Set<string>();
  if (input.maxHiddenPerOwner !== undefined) {
    const hiddenByOwner = new Map<string, ResidentRuntimeState[]>();
    for (const runtime of input.runtimes) {
      if (!isCandidate(runtime)) continue;
      const list = hiddenByOwner.get(runtime.owner) ?? [];
      list.push(runtime);
      hiddenByOwner.set(runtime.owner, list);
    }
    for (const list of hiddenByOwner.values()) {
      const excess = list.length - input.maxHiddenPerOwner;
      if (excess <= 0) continue;
      for (const runtime of list.toSorted(leastRecentlyUsedFirst).slice(0, excess))
        suspended.add(runtime.key);
    }
  }
  if (input.maxLoaded !== undefined) {
    const loaded = input.runtimes.filter((runtime) => !suspended.has(runtime.key));
    let excess = loaded.length - input.maxLoaded;
    for (const runtime of loaded.filter(isCandidate).toSorted(leastRecentlyUsedFirst)) {
      if (excess <= 0) break;
      suspended.add(runtime.key);
      excess -= 1;
    }
  }
  return [...suspended];
}

/**
 * Everything to suspend now under `policy`, and when to ask again (the next hidden runtime's
 * expiry), or null when nothing is waiting to expire.
 */
export function planRuntimeResidency(input: {
  readonly runtimes: readonly ResidentRuntimeState[];
  readonly now: number;
  readonly policy: RuntimeResidencyPolicy;
  readonly pressured?: boolean;
}): { readonly suspend: readonly string[]; readonly nextCheckAt: number | null } {
  const delayMs = hiddenDelay(input.policy, input.pressured ?? false);
  const expired = new Set(
    selectExpiredRuntimes({ runtimes: input.runtimes, now: input.now, delayMs }),
  );
  const remaining = input.runtimes.filter((runtime) => !expired.has(runtime.key));
  const overBudget = selectRuntimesOverBudget({
    runtimes: remaining,
    maxHiddenPerOwner: input.policy.maxHiddenPerOwner,
    maxLoaded: input.policy.maxLoaded,
  });
  const suspend = [...expired, ...overBudget];
  const suspending = new Set(suspend);
  let nextCheckAt: number | null = null;
  for (const runtime of input.runtimes) {
    if (!isCandidate(runtime) || runtime.hiddenSince === null || suspending.has(runtime.key))
      continue;
    const expiresAt = runtime.hiddenSince + delayMs;
    if (nextCheckAt === null || expiresAt < nextCheckAt) nextCheckAt = expiresAt;
  }
  return { suspend, nextCheckAt };
}
