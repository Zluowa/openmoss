import { SidebarSectionId } from "@synara/contracts";
import type {
  OrchestrationSidebarOrderItem,
  SidebarOrderDestination,
  SidebarSectionItemKey,
  ThreadId,
} from "@synara/contracts";

export type SidebarThreadOrderItem = OrchestrationSidebarOrderItem;

export interface SidebarThreadOrderState {
  readonly revision: number;
  readonly migrationState: "ready" | "legacy_import_required";
  readonly items: readonly SidebarThreadOrderItem[];
}

export interface SidebarThreadOrderPlacementInput {
  readonly threadId: ThreadId;
  readonly destination: SidebarOrderDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeThreadId: ThreadId | null;
  readonly now: string;
}

export interface SidebarThreadOrderPlacementResult {
  readonly items: SidebarThreadOrderItem[];
  readonly changed: boolean;
  readonly previous: SidebarThreadOrderItem | null;
  readonly previousSuccessorThreadId: ThreadId | null;
}

export interface SidebarItemOrderPlacementInput {
  readonly itemKey: SidebarSectionItemKey;
  readonly itemType: "thread" | "project";
  readonly destination: SidebarOrderDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeItemKey: SidebarSectionItemKey | null;
  readonly now: string;
}

export interface SidebarItemOrderPlacementResult {
  readonly items: SidebarThreadOrderItem[];
  readonly changed: boolean;
  readonly previous: SidebarThreadOrderItem | null;
  readonly previousSuccessorItemKey: SidebarSectionItemKey | null;
}

/** Emitted when a shell order payload cannot be trusted as a complete snapshot. */
export const SIDEBAR_ORDER_REHYDRATE_EVENT = "moss:sidebar-order-rehydrate";

export function requestSidebarOrderRehydrate(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(SIDEBAR_ORDER_REHYDRATE_EVENT));
  }
}

type SidebarOrderContainer = {
  readonly destination: SidebarOrderDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
};

export function orderContainerKey(item: SidebarOrderContainer): string {
  return `${item.destination}:${item.sectionId ?? ""}:${item.sectionCreatedAt ?? ""}`;
}

function sidebarSectionIdOrNull(value: string | null): SidebarThreadOrderItem["sectionId"] {
  return value === null ? null : SidebarSectionId.makeUnsafe(value);
}

export function normalizeSidebarThreadOrder(input: unknown): SidebarThreadOrderItem[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const result: SidebarThreadOrderItem[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      item.key.length <= 7 ||
      typeof item.itemType !== "string" ||
      (item.itemType !== "thread" && item.itemType !== "project") ||
      !item.key.startsWith(`${item.itemType}:`) ||
      (item.destination !== "pinned" &&
        item.destination !== "default" &&
        item.destination !== "custom") ||
      typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string" ||
      Number.isNaN(Date.parse(item.createdAt)) ||
      Number.isNaN(Date.parse(item.updatedAt)) ||
      typeof item.sortOrder !== "number" ||
      !Number.isSafeInteger(item.sortOrder) ||
      item.sortOrder < 0 ||
      seen.has(item.key)
    )
      return null;
    const sectionId =
      item.sectionId === null || typeof item.sectionId === "string" ? item.sectionId : undefined;
    const sectionCreatedAt =
      item.sectionCreatedAt === null || typeof item.sectionCreatedAt === "string"
        ? item.sectionCreatedAt
        : undefined;
    if (sectionId === undefined || sectionCreatedAt === undefined) return null;
    if (item.destination === "custom" && (sectionId === null || sectionCreatedAt === null))
      return null;
    if (item.destination !== "custom" && (sectionId !== null || sectionCreatedAt !== null))
      return null;
    if (
      sectionId === "" ||
      (sectionCreatedAt !== null && Number.isNaN(Date.parse(sectionCreatedAt)))
    )
      return null;
    seen.add(item.key);
    result.push({
      key: item.key as SidebarSectionItemKey,
      itemType: item.itemType,
      destination: item.destination as SidebarOrderDestination,
      sectionId: sectionId as SidebarThreadOrderItem["sectionId"],
      sectionCreatedAt: sectionCreatedAt as SidebarThreadOrderItem["sectionCreatedAt"],
      sortOrder: item.sortOrder,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  const sorted = result.toSorted(
    (left, right) =>
      orderContainerKey(left).localeCompare(orderContainerKey(right)) ||
      left.sortOrder - right.sortOrder ||
      left.key.localeCompare(right.key),
  );
  let previousContainer: string | null = null;
  let expectedSort = 0;
  for (const item of sorted) {
    const container = orderContainerKey(item);
    if (container !== previousContainer) {
      previousContainer = container;
      expectedSort = 0;
    }
    if (item.sortOrder !== expectedSort) return null;
    expectedSort += 1;
  }
  return sorted;
}

export function itemsInContainer(
  items: readonly SidebarThreadOrderItem[],
  container: SidebarOrderContainer,
): SidebarThreadOrderItem[] {
  const key = orderContainerKey(container);
  return items
    .filter((item) => orderContainerKey(item) === key)
    .toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    );
}

function compactOrderItems(items: readonly SidebarThreadOrderItem[]): SidebarThreadOrderItem[] {
  const groups = new Map<string, SidebarThreadOrderItem[]>();
  for (const item of items) {
    const key = orderContainerKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const result: SidebarThreadOrderItem[] = [];
  for (const group of groups.values()) {
    group
      .toSorted(
        (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
      )
      .forEach((item, index) => result.push({ ...item, sortOrder: index }));
  }
  return result;
}

/** Apply the same before-anchor move used by the production placement hook. */
export function placeSidebarThreadOrder(
  items: readonly SidebarThreadOrderItem[],
  input: SidebarThreadOrderPlacementInput,
): SidebarThreadOrderPlacementResult | null {
  if (
    (input.destination === "custom" &&
      (input.sectionId === null || input.sectionCreatedAt === null)) ||
    (input.destination !== "custom" &&
      (input.sectionId !== null || input.sectionCreatedAt !== null))
  ) {
    return null;
  }
  const sourceKey = `thread:${input.threadId}`;
  const previous = items.find((item) => item.key === sourceKey) ?? null;
  if (previous === null) return null;
  const target: SidebarOrderContainer = {
    destination: input.destination,
    sectionId: input.sectionId,
    sectionCreatedAt: input.sectionCreatedAt,
  };
  const targetKey = orderContainerKey(target);
  const sourceItems = itemsInContainer(items, previous);
  const sourceIndex = sourceItems.findIndex((item) => item.key === sourceKey);
  const previousSuccessorThreadId = sourceItems
    .slice(sourceIndex + 1)
    .find((item) => item.itemType === "thread" && item.key.startsWith("thread:"))
    ?.key.slice("thread:".length) as ThreadId | undefined;
  const anchorKey = input.beforeThreadId === null ? null : `thread:${input.beforeThreadId}`;
  if (anchorKey === sourceKey) return null;
  const anchor = anchorKey === null ? null : (items.find((item) => item.key === anchorKey) ?? null);
  if (anchorKey !== null && (anchor === null || orderContainerKey(anchor) !== targetKey)) {
    return null;
  }

  // Custom sections are mixed containers. A thread move, including a
  // cross-container move, rewrites only thread slots; project slots retain
  // their exact indexes. A cross-container move gets one new thread slot at
  // the target tail, which lets a before-thread request still preserve the
  // mixed project layout (for example [A, P] + B before A -> [B, P, A]).
  if (input.destination === "custom") {
    const targetItems = itemsInContainer(items, target);
    const existingInTarget = orderContainerKey(previous) === targetKey;
    const targetThreadItems = targetItems.filter(
      (item) => item.itemType === "thread" && item.key !== sourceKey,
    );
    const targetThreadIds = targetThreadItems.map((item) => item.key.slice("thread:".length));
    const anchorIndex =
      input.beforeThreadId === null
        ? targetThreadIds.length
        : targetThreadIds.findIndex((threadId) => `thread:${threadId}` === anchorKey);
    if (anchorIndex < 0) return null;
    const orderedThreadIds = [
      ...targetThreadIds.slice(0, anchorIndex),
      input.threadId,
      ...targetThreadIds.slice(anchorIndex),
    ];
    const sourceByThreadId = new Map(
      items
        .filter((item) => item.itemType === "thread")
        .map((item) => [item.key.slice("thread:".length), item]),
    );
    sourceByThreadId.set(input.threadId, {
      ...previous,
      destination: "custom",
      sectionId: sidebarSectionIdOrNull(target.sectionId),
      sectionCreatedAt: target.sectionCreatedAt,
      updatedAt: input.now,
    });
    const orderedThreads: SidebarThreadOrderItem[] = [];
    for (const threadId of orderedThreadIds) {
      const source = sourceByThreadId.get(threadId);
      if (source === undefined) return null;
      orderedThreads.push({
        ...source,
        destination: "custom",
        sectionId: sidebarSectionIdOrNull(target.sectionId),
        sectionCreatedAt: target.sectionCreatedAt,
        updatedAt: source.key === sourceKey ? input.now : source.updatedAt,
      });
    }
    let threadIndex = 0;
    const requiredThreadSlots = targetItems.filter((item) => item.itemType === "thread").length;
    if (orderedThreads.length < requiredThreadSlots + (existingInTarget ? 0 : 1)) return null;
    const nextTargetItems: SidebarThreadOrderItem[] = targetItems.map((item) => {
      if (item.itemType !== "thread") return item;
      const next = orderedThreads[threadIndex++]!;
      return { ...next, sortOrder: item.sortOrder };
    });
    if (!existingInTarget) {
      const appended = orderedThreads[threadIndex++];
      if (appended === undefined) return null;
      nextTargetItems.push({ ...appended, sortOrder: targetItems.length });
    }
    const nextItems = compactOrderItems([
      ...items.filter((item) => item.key !== sourceKey && orderContainerKey(item) !== targetKey),
      ...nextTargetItems,
    ]);
    const beforeSignatures = items
      .map((item) => `${orderContainerKey(item)}:${item.key}:${item.sortOrder}`)
      .sort();
    const nextSignatures = nextItems
      .map((item) => `${orderContainerKey(item)}:${item.key}:${item.sortOrder}`)
      .sort();
    const changed =
      beforeSignatures.length !== nextSignatures.length ||
      beforeSignatures.some((value, index) => value !== nextSignatures[index]);
    return {
      items: nextItems,
      changed,
      previous,
      previousSuccessorThreadId: previousSuccessorThreadId ?? null,
    };
  }
  const targetItems = items
    .filter((item) => item.key !== sourceKey && orderContainerKey(item) === targetKey)
    .toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    );
  const insertionIndex =
    anchor === null ? targetItems.length : targetItems.findIndex((item) => item.key === anchor.key);
  if (insertionIndex < 0) return null;
  const changed =
    orderContainerKey(previous) !== targetKey ||
    (orderContainerKey(previous) === targetKey && previous.sortOrder !== insertionIndex);
  const moved: SidebarThreadOrderItem = {
    ...previous,
    destination: target.destination,
    sectionId: sidebarSectionIdOrNull(target.sectionId),
    sectionCreatedAt: target.sectionCreatedAt,
    sortOrder: insertionIndex,
    updatedAt: input.now,
  };
  const nextTargetItems = [
    ...targetItems.slice(0, insertionIndex),
    moved,
    ...targetItems.slice(insertionIndex),
  ].map((item, index) => ({ ...item, sortOrder: index }));
  return {
    items: compactOrderItems([
      ...items.filter((item) => item.key !== sourceKey && orderContainerKey(item) !== targetKey),
      ...nextTargetItems,
    ]),
    changed,
    previous,
    previousSuccessorThreadId: previousSuccessorThreadId ?? null,
  };
}

/** Mixed-item equivalent used by project placement; keeps the exact successor for Undo. */
export function placeSidebarItemOrder(
  items: readonly SidebarThreadOrderItem[],
  input: SidebarItemOrderPlacementInput,
): SidebarItemOrderPlacementResult | null {
  if (
    (input.destination === "custom" &&
      (input.sectionId === null || input.sectionCreatedAt === null)) ||
    (input.destination !== "custom" &&
      (input.sectionId !== null || input.sectionCreatedAt !== null))
  ) {
    return null;
  }
  const previous = items.find((item) => item.key === input.itemKey) ?? null;
  if (previous !== null && previous.itemType !== input.itemType) return null;
  if (previous === null) return null;
  const target: SidebarOrderContainer = {
    destination: input.destination,
    sectionId: input.sectionId,
    sectionCreatedAt: input.sectionCreatedAt,
  };
  const targetKey = orderContainerKey(target);
  const sourceItems = itemsInContainer(items, previous);
  const sourceIndex = sourceItems.findIndex((item) => item.key === input.itemKey);
  const successor = sourceItems[sourceIndex + 1]?.key ?? null;
  if (input.beforeItemKey === input.itemKey) return null;
  const anchor =
    input.beforeItemKey === null
      ? null
      : (items.find((item) => item.key === input.beforeItemKey) ?? null);
  if (
    input.beforeItemKey !== null &&
    (anchor === null || orderContainerKey(anchor) !== targetKey)
  ) {
    return null;
  }
  const targetItems = items
    .filter((item) => item.key !== input.itemKey && orderContainerKey(item) === targetKey)
    .toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    );
  const insertionIndex =
    input.beforeItemKey === null
      ? targetItems.length
      : targetItems.findIndex((item) => item.key === input.beforeItemKey);
  if (insertionIndex < 0) return null;
  const changed =
    orderContainerKey(previous) !== targetKey ||
    (orderContainerKey(previous) === targetKey && previous.sortOrder !== insertionIndex);
  const moved: SidebarThreadOrderItem = {
    ...previous,
    itemType: input.itemType,
    destination: target.destination,
    sectionId: sidebarSectionIdOrNull(target.sectionId),
    sectionCreatedAt: target.sectionCreatedAt,
    sortOrder: insertionIndex,
    updatedAt: input.now,
  };
  const nextTargetItems = [
    ...targetItems.slice(0, insertionIndex),
    moved,
    ...targetItems.slice(insertionIndex),
  ].map((item, index) => ({ ...item, sortOrder: index }));
  return {
    items: compactOrderItems([
      ...items.filter(
        (item) => item.key !== input.itemKey && orderContainerKey(item) !== targetKey,
      ),
      ...nextTargetItems,
    ]),
    changed,
    previous,
    previousSuccessorItemKey: successor,
  };
}

export function threadIdsInContainer(
  items: readonly SidebarThreadOrderItem[],
  container: Pick<SidebarThreadOrderItem, "destination" | "sectionId" | "sectionCreatedAt">,
): ThreadId[] {
  return itemsInContainer(items, container)
    .filter((item) => item.itemType === "thread" && item.key.startsWith("thread:"))
    .map((item) => item.key.slice("thread:".length) as ThreadId);
}

export function sidebarThreadOrderAnchor(
  items: readonly SidebarThreadOrderItem[],
  itemKey: string,
  beforeThreadId: string | null,
): boolean {
  if (beforeThreadId === null) return true;
  const source = items.find((item) => item.key === itemKey);
  const anchor = items.find((item) => item.key === `thread:${beforeThreadId}`);
  return (
    source !== undefined &&
    anchor !== undefined &&
    orderContainerKey(source) === orderContainerKey(anchor)
  );
}
