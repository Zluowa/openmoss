// FILE: threadHierarchy.ts
// Purpose: Parent/child traversal over subagent thread linkage shared by server and web.
// Exports: collectSubagentDescendants

interface HierarchyThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
}

export type ThreadPresentationOwner = `custom:${string}` | `pinned:${string}` | `default:${string}`;

export interface ThreadPresentationSection {
  readonly id: string;
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly itemType: string;
  }>;
}

export interface ThreadPresentationOwnerResolution<T extends HierarchyThread> {
  /** Deterministic effective presentation owner for every resolvable thread. */
  readonly owners: ReadonlyMap<T["id"], ThreadPresentationOwner>;
  /** Threads whose parent chain could not be resolved safely. */
  readonly unresolvedThreadIds: ReadonlySet<T["id"]>;
  /** Threads participating in, or depending on, a parent cycle. */
  readonly cycleThreadIds: ReadonlySet<T["id"]>;
  /** Duplicate thread identities in the input. */
  readonly duplicateThreadIds: ReadonlySet<T["id"]>;
  /** Explicit custom memberships keyed by thread identity. */
  readonly explicitCustomSectionByThreadId: ReadonlyMap<T["id"], string>;
  /** Duplicate or malformed explicit membership identities. */
  readonly corruptMembershipThreadIds: ReadonlySet<T["id"]>;
}

/**
 * Resolve one effective presentation boundary per thread.
 *
 * This is intentionally independent of the web/server schemas. Both sides need
 * the exact same inheritance rules when deciding whether a subagent subtree is
 * allowed to cross a sidebar boundary. Explicit custom membership wins; a
 * pinned thread and a missing-parent/root thread each begin a new boundary,
 * while ordinary descendants inherit their parent's boundary. Cycles and
 * duplicate identities are reported separately so callers can fail closed
 * instead of silently filing corrupt data in the default view.
 */
export function resolveThreadPresentationOwners<T extends HierarchyThread>(input: {
  readonly sections: ReadonlyArray<ThreadPresentationSection>;
  readonly threads: readonly T[];
  readonly pinnedThreadIds?: ReadonlySet<T["id"]> | readonly T["id"][];
}): ThreadPresentationOwnerResolution<T> {
  const threadById = new Map<T["id"], T>();
  const duplicateThreadIds = new Set<T["id"]>();
  for (const thread of input.threads) {
    if (threadById.has(thread.id)) {
      duplicateThreadIds.add(thread.id);
      continue;
    }
    threadById.set(thread.id, thread);
  }

  const explicitCustomSectionByThreadId = new Map<T["id"], string>();
  const corruptMembershipThreadIds = new Set<T["id"]>();
  const sectionIds = new Set<string>();
  for (const section of input.sections) {
    if (sectionIds.has(section.id)) {
      // A duplicate section identity makes any item owner ambiguous. Mark all
      // items in both incarnations as corrupt while retaining deterministic
      // first-wins behavior for non-archive consumers.
      for (const duplicateSection of input.sections.filter((entry) => entry.id === section.id)) {
        for (const item of duplicateSection.items) {
          if (item.itemType === "thread" && item.key.startsWith("thread:")) {
            corruptMembershipThreadIds.add(item.key.slice("thread:".length) as T["id"]);
          }
        }
      }
    }
    sectionIds.add(section.id);
    for (const item of section.items) {
      if (item.itemType !== "thread") continue;
      if (!item.key.startsWith("thread:") || item.key.length <= "thread:".length) {
        corruptMembershipThreadIds.add(item.key as T["id"]);
        continue;
      }
      const threadId = item.key.slice("thread:".length) as T["id"];
      const existingSectionId = explicitCustomSectionByThreadId.get(threadId);
      if (existingSectionId !== undefined) {
        corruptMembershipThreadIds.add(threadId);
      }
      if (!explicitCustomSectionByThreadId.has(threadId)) {
        explicitCustomSectionByThreadId.set(threadId, section.id);
      }
      if (!threadById.has(threadId)) {
        corruptMembershipThreadIds.add(threadId);
      }
    }
  }

  const pinnedThreadIdSet =
    input.pinnedThreadIds instanceof Set
      ? input.pinnedThreadIds
      : new Set(input.pinnedThreadIds ?? []);
  const owners = new Map<T["id"], ThreadPresentationOwner>();
  const unresolvedThreadIds = new Set<T["id"]>();
  const cycleThreadIds = new Set<T["id"]>();
  // Detect cycles before owner resolution. Explicit custom/pinned boundaries
  // must never hide a malformed parent graph from archive admission.
  const graphState = new Map<T["id"], "visiting" | "visited">();
  const graphPath: T["id"][] = [];
  const detectParentCycles = (threadId: T["id"]): void => {
    if (duplicateThreadIds.has(threadId) || graphState.get(threadId) === "visited") return;
    const state = graphState.get(threadId);
    if (state === "visiting") {
      const cycleStart = graphPath.indexOf(threadId);
      for (const cycleThreadId of graphPath.slice(cycleStart < 0 ? 0 : cycleStart)) {
        cycleThreadIds.add(cycleThreadId);
        unresolvedThreadIds.add(cycleThreadId);
      }
      return;
    }
    const thread = threadById.get(threadId);
    if (thread === undefined) return;
    graphState.set(threadId, "visiting");
    graphPath.push(threadId);
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId !== null && threadById.has(parentThreadId)) {
      detectParentCycles(parentThreadId as T["id"]);
    }
    graphPath.pop();
    graphState.set(threadId, "visited");
  };
  for (const thread of input.threads) detectParentCycles(thread.id);
  const resolving = new Map<T["id"], number>();
  const resolutionPath: T["id"][] = [];

  const resolveOwner = (threadId: T["id"]): ThreadPresentationOwner | undefined => {
    const knownOwner = owners.get(threadId);
    if (knownOwner !== undefined) return knownOwner;
    if (unresolvedThreadIds.has(threadId)) return undefined;

    const cycleStartIndex = resolving.get(threadId);
    if (cycleStartIndex !== undefined) {
      for (const cycleThreadId of resolutionPath.slice(cycleStartIndex)) {
        cycleThreadIds.add(cycleThreadId);
        unresolvedThreadIds.add(cycleThreadId);
      }
      return undefined;
    }
    if (
      cycleThreadIds.has(threadId) ||
      duplicateThreadIds.has(threadId) ||
      corruptMembershipThreadIds.has(threadId)
    ) {
      unresolvedThreadIds.add(threadId);
      return undefined;
    }

    const explicitSectionId = explicitCustomSectionByThreadId.get(threadId);
    if (explicitSectionId !== undefined) {
      const owner: ThreadPresentationOwner = `custom:${explicitSectionId}`;
      owners.set(threadId, owner);
      return owner;
    }
    if (pinnedThreadIdSet.has(threadId)) {
      const owner: ThreadPresentationOwner = `pinned:${threadId}`;
      owners.set(threadId, owner);
      return owner;
    }

    const thread = threadById.get(threadId);
    if (thread === undefined) {
      unresolvedThreadIds.add(threadId);
      return undefined;
    }
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null || !threadById.has(parentThreadId)) {
      const owner: ThreadPresentationOwner = `default:${threadId}`;
      owners.set(threadId, owner);
      return owner;
    }

    resolving.set(threadId, resolutionPath.length);
    resolutionPath.push(threadId);
    const parentOwner = resolveOwner(parentThreadId as T["id"]);
    resolutionPath.pop();
    resolving.delete(threadId);
    if (parentOwner === undefined) {
      unresolvedThreadIds.add(threadId);
      if (cycleThreadIds.has(parentThreadId as T["id"])) cycleThreadIds.add(threadId);
      return undefined;
    }
    owners.set(threadId, parentOwner);
    return parentOwner;
  };

  for (const thread of input.threads) {
    resolveOwner(thread.id);
  }

  return {
    owners,
    unresolvedThreadIds,
    cycleThreadIds,
    duplicateThreadIds,
    explicitCustomSectionByThreadId,
    corruptMembershipThreadIds,
  };
}

// Collects every thread reachable from `rootThreadId` through `parentThreadId`
// links, breadth-first, excluding the root itself. Subagent threads are only
// reachable through their parent thread, so lifecycle changes on a parent
// (archive, restore, delete) apply to this whole subtree. Visited tracking keeps
// corrupted self- or cyclic linkage from hanging the caller.
export function collectSubagentDescendants<T extends HierarchyThread>(
  threads: readonly T[],
  rootThreadId: T["id"],
): T[] {
  const childrenByParentId = new Map<string, T[]>();
  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId);
    if (siblings === undefined) {
      childrenByParentId.set(parentThreadId, [thread]);
    } else {
      siblings.push(thread);
    }
  }

  const descendants: T[] = [];
  const visitedThreadIds = new Set<string>([rootThreadId]);
  const queue: string[] = [rootThreadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentThreadId = queue[index];
    if (parentThreadId === undefined) {
      break;
    }
    for (const child of childrenByParentId.get(parentThreadId) ?? []) {
      if (visitedThreadIds.has(child.id)) {
        continue;
      }
      visitedThreadIds.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
}
