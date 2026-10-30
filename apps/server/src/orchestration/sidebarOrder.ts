/**
 * Pure rules for the durable sidebar placement relation.
 *
 * The database and the web client deliberately use this small value model rather
 * than deriving order from timestamps or the legacy custom-section table.  Keep
 * this module free of Effect/SQLite so command admission, migration, and tests
 * exercise exactly the same anchor and compaction rules.
 */
import type {
  OrchestrationSidebarOrderItem,
  SidebarOrderDestination,
  SidebarSectionItemType,
} from "@synara/contracts";

export type SidebarOrderItem = OrchestrationSidebarOrderItem;
export type SidebarOrderContainer = {
  readonly destination: SidebarOrderDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
};

export type SidebarOrderFailureCode =
  | "duplicate-membership"
  | "invalid-item"
  | "invalid-container"
  | "missing-anchor"
  | "self-anchor"
  | "anchor-container-mismatch"
  | "capacity-exceeded"
  | "missing-item"
  | "invalid-anchor"
  | "duplicate-id";

export class SidebarOrderError extends Error {
  readonly code: SidebarOrderFailureCode;

  constructor(code: SidebarOrderFailureCode, message: string) {
    super(message);
    this.name = "SidebarOrderError";
    this.code = code;
  }
}

export function sidebarOrderContainer(input: {
  readonly destination: SidebarOrderDestination;
  readonly sectionId?: string | null;
  readonly sectionCreatedAt?: string | null;
}): SidebarOrderContainer {
  const sectionId = input.sectionId ?? null;
  const sectionCreatedAt = input.sectionCreatedAt ?? null;
  if (input.destination === "custom") {
    if (sectionId === null || sectionCreatedAt === null) {
      throw new SidebarOrderError(
        "invalid-container",
        "Custom sidebar placement requires a section id and exact creation timestamp.",
      );
    }
  } else if (sectionId !== null || sectionCreatedAt !== null) {
    throw new SidebarOrderError(
      "invalid-container",
      "Pinned and default sidebar placement cannot carry custom-section identity.",
    );
  }
  return { destination: input.destination, sectionId, sectionCreatedAt };
}

export function sidebarOrderContainerKey(container: SidebarOrderContainer): string {
  return `${container.destination}:${container.sectionId ?? ""}:${container.sectionCreatedAt ?? ""}`;
}

export function sidebarOrderItemContainer(item: SidebarOrderItem): SidebarOrderContainer {
  return sidebarOrderContainer(item);
}

function itemKeyForThread(threadId: string): string {
  return `thread:${threadId}`;
}

function compareItems(left: SidebarOrderItem, right: SidebarOrderItem): number {
  return left.sortOrder - right.sortOrder || left.key.localeCompare(right.key);
}

/** Sort and compact every container while preserving exact container identity. */
export function compactSidebarOrderItems(
  items: ReadonlyArray<SidebarOrderItem>,
): SidebarOrderItem[] {
  const groups = new Map<string, SidebarOrderItem[]>();
  for (const item of items) {
    const expectedPrefix = item.itemType === "thread" ? "thread:" : "project:";
    if (!item.key.startsWith(expectedPrefix)) {
      throw new SidebarOrderError(
        "invalid-item",
        `Sidebar ${item.itemType} item '${item.key}' has an invalid key.`,
      );
    }
    if (!Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0) {
      throw new SidebarOrderError(
        "invalid-item",
        `Sidebar item '${item.key}' has an invalid order.`,
      );
    }
    const key = sidebarOrderContainerKey(sidebarOrderItemContainer(item));
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const result: SidebarOrderItem[] = [];
  for (const group of groups.values()) {
    group.sort(compareItems);
    group.forEach((item, index) => result.push({ ...item, sortOrder: index }));
  }
  return result;
}

/**
 * Validate the relation before persisting or accepting an import.  A thread
 * key may occur only once; project slots are also unique.  The check is kept
 * independent of active-thread lookup so migration can preserve unknown legacy
 * project slots until the owning project is hydrated.
 */
export function validateSidebarOrderItems(
  items: ReadonlyArray<SidebarOrderItem>,
  maxItemsPerContainer = 256,
): void {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of items) {
    if (seen.has(item.key)) {
      throw new SidebarOrderError(
        "duplicate-membership",
        `Sidebar item '${item.key}' occurs in more than one placement.`,
      );
    }
    seen.add(item.key);
    const container = sidebarOrderItemContainer(item);
    const key = sidebarOrderContainerKey(container);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > maxItemsPerContainer) {
      throw new SidebarOrderError(
        "capacity-exceeded",
        `Sidebar placement '${key}' exceeds its item capacity.`,
      );
    }
    counts.set(key, count);
  }
  const sortOrdersByContainer = new Map<string, number[]>();
  for (const item of items) {
    const key = sidebarOrderContainerKey(sidebarOrderItemContainer(item));
    const orders = sortOrdersByContainer.get(key) ?? [];
    orders.push(item.sortOrder);
    sortOrdersByContainer.set(key, orders);
  }
  for (const [key, orders] of sortOrdersByContainer) {
    orders.sort((left, right) => left - right);
    for (const [index, order] of orders.entries()) {
      if (order !== index) {
        throw new SidebarOrderError(
          "invalid-item",
          `Sidebar placement '${key}' must use contiguous order values.`,
        );
      }
    }
  }
}

export type PlaceSidebarOrderItemInput = {
  readonly itemKey: string;
  readonly itemType?: SidebarSectionItemType;
  readonly destination: SidebarOrderDestination;
  readonly sectionId?: string | null;
  readonly sectionCreatedAt?: string | null;
  readonly beforeThreadId?: string | null;
  /** A mixed-item anchor. When present it supersedes beforeThreadId. */
  readonly beforeItemKey?: string | null;
  readonly now: string;
};

export type PlaceSidebarOrderItemResult = {
  readonly items: SidebarOrderItem[];
  readonly changed: boolean;
  readonly previous: SidebarOrderItem | null;
  readonly next: SidebarOrderItem;
};

/**
 * Place a thread in a custom section without consuming or moving project
 * slots. A thread anchor addresses the thread sequence, while the resulting
 * sequence is written back into the existing thread slots. Thus
 * `[thread:A, project:P, thread:B]` with B before A becomes
 * `[thread:B, project:P, thread:A]`.
 */
export function placeSidebarThreadOrder(
  items: ReadonlyArray<SidebarOrderItem>,
  input: PlaceSidebarOrderItemInput,
): PlaceSidebarOrderItemResult {
  if (input.destination !== "custom" || input.beforeItemKey !== undefined) {
    return placeSidebarOrderItem(items, input);
  }
  const container = sidebarOrderContainer(input);
  const containerKey = sidebarOrderContainerKey(container);
  const existing = items.find((item) => item.key === input.itemKey) ?? null;
  if (existing !== null && input.itemType !== undefined && existing.itemType !== input.itemType) {
    throw new SidebarOrderError(
      "invalid-item",
      `Sidebar item '${input.itemKey}' has a different item type than the placement request.`,
    );
  }
  const beforeKey =
    input.beforeThreadId === null || input.beforeThreadId === undefined
      ? null
      : itemKeyForThread(input.beforeThreadId);
  if (beforeKey !== null && beforeKey === input.itemKey) {
    throw new SidebarOrderError("self-anchor", "A sidebar thread cannot anchor itself.");
  }
  const anchor = beforeKey === null ? null : items.find((item) => item.key === beforeKey);
  if (beforeKey !== null && anchor === undefined) {
    throw new SidebarOrderError(
      "missing-anchor",
      "The sidebar thread drop target no longer exists.",
    );
  }
  if (anchor !== null && anchor !== undefined && anchor.itemType !== "thread") {
    throw new SidebarOrderError("invalid-anchor", "A thread placement requires a thread anchor.");
  }
  if (
    anchor !== null &&
    anchor !== undefined &&
    sidebarOrderContainerKey(sidebarOrderItemContainer(anchor)) !== containerKey
  ) {
    throw new SidebarOrderError(
      "anchor-container-mismatch",
      "The sidebar thread drop target belongs to another placement.",
    );
  }

  const targetItems = items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === containerKey)
    .sort(compareItems);
  const existingInTarget =
    existing !== null &&
    sidebarOrderContainerKey(sidebarOrderItemContainer(existing)) === containerKey;
  const targetThreads = targetItems
    .filter((item) => item.key !== input.itemKey)
    .filter((item) => item.itemType === "thread");
  const targetThreadIds = targetThreads.map((item) => item.key.slice("thread:".length));
  const withoutMovedThread = targetThreadIds.filter(
    (threadId) => threadId !== input.itemKey.slice("thread:".length),
  );
  const insertionIndex =
    beforeKey === null
      ? withoutMovedThread.length
      : withoutMovedThread.findIndex((threadId) => `thread:${threadId}` === beforeKey);
  if (insertionIndex < 0) {
    throw new SidebarOrderError("missing-anchor", "The sidebar thread drop target is not active.");
  }
  const orderedThreadIds = [
    ...withoutMovedThread.slice(0, insertionIndex),
    input.itemKey.slice("thread:".length),
    ...withoutMovedThread.slice(insertionIndex),
  ];
  const sourceByThreadId = new Map(
    items
      .filter((item) => item.itemType === "thread")
      .map((item) => [item.key.slice("thread:".length), item]),
  );
  const movedThread: SidebarOrderItem = {
    key: input.itemKey as SidebarOrderItem["key"],
    itemType: "thread",
    destination: "custom",
    sectionId: container.sectionId as SidebarOrderItem["sectionId"],
    sectionCreatedAt: container.sectionCreatedAt as SidebarOrderItem["sectionCreatedAt"],
    sortOrder: 0,
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  sourceByThreadId.set(input.itemKey.slice("thread:".length), movedThread);
  const orderedThreads = orderedThreadIds.map((threadId) => {
    const source = sourceByThreadId.get(threadId);
    if (source === undefined) {
      throw new SidebarOrderError("missing-item", `Sidebar thread '${threadId}' is missing.`);
    }
    return {
      ...source,
      destination: "custom" as const,
      sectionId: container.sectionId as SidebarOrderItem["sectionId"],
      sectionCreatedAt: container.sectionCreatedAt as SidebarOrderItem["sectionCreatedAt"],
      updatedAt: input.now,
    };
  });
  let threadIndex = 0;
  const nextSectionItems = targetItems.map((item) => {
    if (item.itemType !== "thread") return item;
    const next = orderedThreads[threadIndex++];
    if (next === undefined) {
      throw new SidebarOrderError(
        "missing-item",
        "The custom section thread slots are inconsistent.",
      );
    }
    return { ...next, sortOrder: item.sortOrder };
  });
  if (!existingInTarget) {
    const appended = orderedThreads[threadIndex++];
    if (appended === undefined) {
      throw new SidebarOrderError(
        "missing-item",
        "The custom section thread slots are inconsistent.",
      );
    }
    nextSectionItems.push({ ...appended, sortOrder: targetItems.length });
  }
  const otherItems = items.filter(
    (item) =>
      item.key !== input.itemKey &&
      sidebarOrderContainerKey(sidebarOrderItemContainer(item)) !== containerKey,
  );
  const nextItems = compactSidebarOrderItems([...otherItems, ...nextSectionItems]);
  const beforeItems = compactSidebarOrderItems(items);
  const signature = (item: SidebarOrderItem) =>
    `${sidebarOrderContainerKey(sidebarOrderItemContainer(item))}:${item.key}:${item.sortOrder}`;
  const beforeSignatures = beforeItems.map(signature).sort();
  const nextSignatures = nextItems.map(signature).sort();
  const changed =
    beforeSignatures.length !== nextSignatures.length ||
    beforeSignatures.some((value, index) => value !== nextSignatures[index]);
  return {
    items: nextItems,
    changed,
    previous: existing,
    next: nextItems.find((item) => item.key === input.itemKey) ?? movedThread,
  };
}

/**
 * Move one item to a destination. `beforeThreadId` is intentionally a thread
 * anchor, never an array index: project slots in a custom section remain in
 * place and an anchor from another container fails closed.
 */
export function placeSidebarOrderItem(
  items: ReadonlyArray<SidebarOrderItem>,
  input: PlaceSidebarOrderItemInput,
): PlaceSidebarOrderItemResult {
  if (
    input.itemType === "thread" &&
    input.destination === "custom" &&
    input.beforeItemKey === undefined
  ) {
    return placeSidebarThreadOrder(items, input);
  }
  const container = sidebarOrderContainer(input);
  const existing = items.find((item) => item.key === input.itemKey) ?? null;
  if (existing !== null && input.itemType !== undefined && existing.itemType !== input.itemType) {
    throw new SidebarOrderError(
      "invalid-item",
      `Sidebar item '${input.itemKey}' has a different item type than the placement request.`,
    );
  }
  const destinationItems = items
    .filter((item) => item.key !== input.itemKey)
    .filter(
      (item) =>
        sidebarOrderContainerKey(sidebarOrderItemContainer(item)) ===
        sidebarOrderContainerKey(container),
    )
    .sort(compareItems);

  const beforeKey =
    input.beforeItemKey !== undefined
      ? input.beforeItemKey
      : input.beforeThreadId === null || input.beforeThreadId === undefined
        ? null
        : itemKeyForThread(input.beforeThreadId);
  if (beforeKey !== null && beforeKey === input.itemKey) {
    throw new SidebarOrderError("self-anchor", "A sidebar item cannot anchor itself.");
  }
  const anchor = beforeKey === null ? null : items.find((item) => item.key === beforeKey);
  if (beforeKey !== null && anchor === undefined) {
    throw new SidebarOrderError("missing-anchor", "The sidebar drop target no longer exists.");
  }
  if (
    anchor !== null &&
    anchor !== undefined &&
    sidebarOrderContainerKey(sidebarOrderItemContainer(anchor)) !==
      sidebarOrderContainerKey(container)
  ) {
    throw new SidebarOrderError(
      "anchor-container-mismatch",
      "The sidebar drop target belongs to another placement.",
    );
  }

  const insertionIndex =
    anchor === null || anchor === undefined
      ? destinationItems.length
      : destinationItems.findIndex((item) => item.key === anchor.key);
  if (insertionIndex < 0) {
    throw new SidebarOrderError("missing-anchor", "The sidebar drop target is not active.");
  }

  const next: SidebarOrderItem = {
    key: input.itemKey as SidebarOrderItem["key"],
    itemType: input.itemType ?? existing?.itemType ?? "thread",
    destination: container.destination,
    sectionId: container.sectionId as SidebarOrderItem["sectionId"],
    sectionCreatedAt: container.sectionCreatedAt as SidebarOrderItem["sectionCreatedAt"],
    sortOrder: insertionIndex,
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  const nextContainerItems = [
    ...destinationItems.slice(0, insertionIndex),
    next,
    ...destinationItems.slice(insertionIndex),
  ].map((item, index) => ({ ...item, sortOrder: index }));
  const otherItems = items.filter(
    (item) =>
      item.key !== input.itemKey &&
      sidebarOrderContainerKey(sidebarOrderItemContainer(item)) !==
        sidebarOrderContainerKey(container),
  );
  const nextItems = compactSidebarOrderItems([...otherItems, ...nextContainerItems]);
  const oldContainerKey =
    existing === null ? null : sidebarOrderContainerKey(sidebarOrderItemContainer(existing));
  const samePlacement =
    existing !== null &&
    oldContainerKey === sidebarOrderContainerKey(container) &&
    existing.sortOrder === insertionIndex;
  return {
    items: nextItems,
    changed: !samePlacement,
    previous: existing,
    next: nextItems.find((item) => item.key === input.itemKey) ?? next,
  };
}

export type ReorderSidebarSectionThreadsInput = {
  readonly sectionId: string;
  readonly sectionCreatedAt: string;
  readonly orderedThreadIds: ReadonlyArray<string>;
  readonly now: string;
};

export type ReorderSidebarSectionThreadsResult = {
  readonly items: SidebarOrderItem[];
  readonly changed: boolean;
};

/**
 * Rewrite only thread slots in one custom section. Project slots are left at
 * their exact indexes, which makes mixed sections stable under thread-only
 * keyboard/pointer reordering.
 */
export function reorderSidebarSectionThreads(
  items: ReadonlyArray<SidebarOrderItem>,
  input: ReorderSidebarSectionThreadsInput,
): ReorderSidebarSectionThreadsResult {
  const section = sidebarOrderContainer({
    destination: "custom",
    sectionId: input.sectionId,
    sectionCreatedAt: input.sectionCreatedAt,
  });
  const sectionKey = sidebarOrderContainerKey(section);
  const sectionItems = items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === sectionKey)
    .sort(compareItems);
  const currentThreads = sectionItems.filter((item) => item.itemType === "thread");
  const currentThreadIds = currentThreads.map((item) => item.key.slice("thread:".length));
  const orderedIds = [...input.orderedThreadIds];
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new SidebarOrderError(
      "duplicate-id",
      "A section thread order cannot contain duplicates.",
    );
  }
  if (
    orderedIds.length !== currentThreadIds.length ||
    currentThreadIds.some((threadId) => !orderedIds.includes(threadId))
  ) {
    throw new SidebarOrderError(
      "missing-item",
      "A section thread order must contain every current thread exactly once.",
    );
  }
  const threadById = new Map(
    currentThreads.map((item) => [item.key.slice("thread:".length), item]),
  );
  let threadIndex = 0;
  const nextSectionItems = sectionItems.map((item) => {
    if (item.itemType !== "thread") return item;
    const threadId = orderedIds[threadIndex++];
    const source = threadId === undefined ? undefined : threadById.get(threadId);
    if (source === undefined) {
      throw new SidebarOrderError("missing-item", `Section thread '${threadId ?? ""}' is missing.`);
    }
    return { ...source, sortOrder: item.sortOrder, updatedAt: input.now };
  });
  const changed = nextSectionItems.some((item, index) => item.key !== sectionItems[index]?.key);
  return {
    items: compactSidebarOrderItems([
      ...items.filter(
        (item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) !== sectionKey,
      ),
      ...nextSectionItems,
    ]),
    changed,
  };
}

export type ReorderSidebarProjectsInput = {
  readonly orderedProjectIds: ReadonlyArray<string>;
  readonly now: string;
};

/**
 * Substitute the requested project sequence into the default project's
 * existing slots. Unlisted projects retain their relative order and every
 * thread slot remains untouched.
 */
export function reorderSidebarProjects(
  items: ReadonlyArray<SidebarOrderItem>,
  input: ReorderSidebarProjectsInput,
): ReorderSidebarOrderItemResult {
  const defaultContainer = sidebarOrderContainer({ destination: "default" });
  const defaultKey = sidebarOrderContainerKey(defaultContainer);
  const defaultItems = items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === defaultKey)
    .sort(compareItems);
  const projects = defaultItems.filter((item) => item.itemType === "project");
  const requested = [...input.orderedProjectIds];
  if (new Set(requested).size !== requested.length) {
    throw new SidebarOrderError("duplicate-id", "A project order cannot contain duplicates.");
  }
  const projectById = new Map(projects.map((item) => [item.key.slice("project:".length), item]));
  for (const projectId of requested) {
    if (!projectById.has(projectId)) {
      throw new SidebarOrderError(
        "missing-item",
        `Project '${projectId}' is not in the default unpinned placement.`,
      );
    }
  }
  const requestedSet = new Set(requested);
  const unlisted = projects
    .map((item) => item.key.slice("project:".length))
    .filter((projectId) => !requestedSet.has(projectId));
  const nextProjectIds = [...requested, ...unlisted];
  let projectIndex = 0;
  const nextDefaultItems = defaultItems.map((item) => {
    if (item.itemType !== "project") return item;
    const projectId = nextProjectIds[projectIndex++];
    const source = projectId === undefined ? undefined : projectById.get(projectId);
    if (source === undefined) {
      throw new SidebarOrderError("missing-item", "Default project slots are inconsistent.");
    }
    return { ...source, sortOrder: item.sortOrder, updatedAt: input.now };
  });
  const changed = nextDefaultItems.some((item, index) => item.key !== defaultItems[index]?.key);
  return {
    items: compactSidebarOrderItems([
      ...items.filter(
        (item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) !== defaultKey,
      ),
      ...nextDefaultItems,
    ]),
    changed,
  };
}

export type RehomeSidebarSectionItemsInput = {
  readonly sectionId: string;
  readonly sectionCreatedAt: string;
  readonly now: string;
};

export type RehomeSidebarSectionItemsResult = {
  readonly items: SidebarOrderItem[];
  readonly rehomed: SidebarOrderItem[];
  readonly changed: boolean;
};

/**
 * Remove one exact custom-section incarnation and append its live mixed rows to
 * the default container.  The rows are appended as a mixed sequence, so a
 * section delete never silently drops a project or a thread and never changes
 * the relative order of the rows being rehomed.
 */
export function rehomeSidebarSectionItems(
  items: ReadonlyArray<SidebarOrderItem>,
  input: RehomeSidebarSectionItemsInput,
): RehomeSidebarSectionItemsResult {
  const section = sidebarOrderContainer({
    destination: "custom",
    sectionId: input.sectionId,
    sectionCreatedAt: input.sectionCreatedAt,
  });
  const defaultContainer = sidebarOrderContainer({ destination: "default" });
  const sectionKey = sidebarOrderContainerKey(section);
  const defaultKey = sidebarOrderContainerKey(defaultContainer);
  const sectionRows = items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === sectionKey)
    .sort(compareItems);
  if (sectionRows.length === 0) {
    return { items: compactSidebarOrderItems(items), rehomed: [], changed: false };
  }
  const defaultRows = items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === defaultKey)
    .sort(compareItems);
  const rehomed = sectionRows.map((item, index) => ({
    ...item,
    destination: "default" as const,
    sectionId: null,
    sectionCreatedAt: null,
    sortOrder: defaultRows.length + index,
    updatedAt: input.now,
  }));
  const retained = items.filter((item) => {
    const containerKey = sidebarOrderContainerKey(sidebarOrderItemContainer(item));
    return containerKey !== sectionKey && containerKey !== defaultKey;
  });
  return {
    items: compactSidebarOrderItems([...retained, ...defaultRows, ...rehomed]),
    rehomed: sectionRows,
    changed: true,
  };
}

export type ReorderSidebarOrderItemResult = {
  readonly items: SidebarOrderItem[];
  readonly changed: boolean;
};

/** Return active item keys in a deterministic container order. */
export function listSidebarOrderKeys(
  items: ReadonlyArray<SidebarOrderItem>,
  container: SidebarOrderContainer,
): string[] {
  const key = sidebarOrderContainerKey(container);
  return items
    .filter((item) => sidebarOrderContainerKey(sidebarOrderItemContainer(item)) === key)
    .sort(compareItems)
    .map((item) => item.key);
}
