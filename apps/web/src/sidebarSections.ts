import type {
  OrchestrationSidebarSectionShell,
  SidebarSectionItemKey,
  ThreadId,
} from "@synara/contracts";
import {
  SIDEBAR_SECTION_ID_MAX_LENGTH,
  SIDEBAR_SECTION_ITEM_KEY_MAX_LENGTH,
  SIDEBAR_SECTION_ITEMS_MAX_COUNT,
  SIDEBAR_SECTION_NAME_MAX_LENGTH,
  SIDEBAR_SECTIONS_MAX_COUNT,
} from "@synara/contracts";

const THREAD_ITEM_PREFIX = "thread:";
const THREAD_ITEM_KEY_PATTERN = /^thread:.+$/u;

export function threadSidebarItemKey(threadId: string): SidebarSectionItemKey {
  return ("thread:" + threadId) as SidebarSectionItemKey;
}

export function threadIdFromSidebarItemKey(itemKey: string): ThreadId | null {
  if (!THREAD_ITEM_KEY_PATTERN.test(itemKey)) {
    return null;
  }
  return itemKey.slice(THREAD_ITEM_PREFIX.length) as ThreadId;
}

/**
 * Fail closed at the browser boundary. The server decodes the contract before
 * publishing it, but shell events are still untrusted input to a long-lived
 * tab and must not duplicate a thread into multiple custom sections.
 */
export function normalizeSidebarSections(
  input: unknown,
  visibleThreadIds?: ReadonlySet<string>,
): OrchestrationSidebarSectionShell[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const sections: OrchestrationSidebarSectionShell[] = [];
  const seenSectionIds = new Set<string>();
  const seenItemKeys = new Set<string>();
  for (const candidate of input) {
    if (sections.length >= SIDEBAR_SECTIONS_MAX_COUNT) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const section = candidate as Record<string, unknown>;
    const id = typeof section.id === "string" ? section.id.trim() : "";
    const name = typeof section.name === "string" ? section.name.trim() : "";
    const createdAt = typeof section.createdAt === "string" ? section.createdAt.trim() : "";
    const updatedAt = typeof section.updatedAt === "string" ? section.updatedAt.trim() : "";
    const rawItems = Array.isArray(section.items) ? section.items : [];
    if (
      id.length === 0 ||
      id.length > SIDEBAR_SECTION_ID_MAX_LENGTH ||
      name.length === 0 ||
      name.length > SIDEBAR_SECTION_NAME_MAX_LENGTH ||
      createdAt.length === 0 ||
      updatedAt.length === 0 ||
      rawItems.length > SIDEBAR_SECTION_ITEMS_MAX_COUNT ||
      seenSectionIds.has(id)
    ) {
      continue;
    }
    const sortOrder =
      typeof section.sortOrder === "number" && Number.isSafeInteger(section.sortOrder)
        ? Math.max(0, section.sortOrder)
        : sections.length;
    const isCollapsed = section.isCollapsed === true;
    const items: OrchestrationSidebarSectionShell["items"][number][] = [];
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (
        (item.itemType !== "thread" && item.itemType !== "project") ||
        key.length > SIDEBAR_SECTION_ITEM_KEY_MAX_LENGTH ||
        !/^(?:thread|project):.+$/u.test(key) ||
        seenItemKeys.has(key)
      ) {
        continue;
      }
      const threadId = key.startsWith(THREAD_ITEM_PREFIX)
        ? key.slice(THREAD_ITEM_PREFIX.length)
        : null;
      if (threadId !== null && visibleThreadIds !== undefined && !visibleThreadIds.has(threadId)) {
        continue;
      }
      const itemCreatedAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const itemUpdatedAt = typeof item.updatedAt === "string" ? item.updatedAt.trim() : "";
      if (itemCreatedAt.length === 0 || itemUpdatedAt.length === 0) continue;
      seenItemKeys.add(key);
      items.push({
        key: key as SidebarSectionItemKey,
        itemType: item.itemType,
        sortOrder:
          typeof item.sortOrder === "number" && Number.isSafeInteger(item.sortOrder)
            ? Math.max(0, item.sortOrder)
            : items.length,
        createdAt: itemCreatedAt,
        updatedAt: itemUpdatedAt,
      });
    }
    items.sort(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    );
    seenSectionIds.add(id);
    sections.push({
      id: id as OrchestrationSidebarSectionShell["id"],
      name: name as OrchestrationSidebarSectionShell["name"],
      sortOrder,
      isCollapsed,
      items,
      createdAt,
      updatedAt,
    });
  }
  sections.sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
  return sections;
}

export function sidebarSectionThreadIds(
  sections: ReadonlyArray<OrchestrationSidebarSectionShell>,
): Set<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const section of sections) {
    for (const item of section.items) {
      const threadId = threadIdFromSidebarItemKey(item.key);
      if (threadId !== null) ids.add(threadId);
    }
  }
  return ids;
}

export function sidebarSectionsEqual(
  left: ReadonlyArray<OrchestrationSidebarSectionShell>,
  right: ReadonlyArray<OrchestrationSidebarSectionShell> | undefined,
): boolean {
  if (right === undefined || left.length !== right.length) return false;
  return left.every((section, index) => {
    const other = right[index];
    if (
      other === undefined ||
      section.id !== other.id ||
      section.name !== other.name ||
      section.sortOrder !== other.sortOrder ||
      section.isCollapsed !== other.isCollapsed ||
      section.createdAt !== other.createdAt ||
      section.updatedAt !== other.updatedAt ||
      section.items.length !== other.items.length
    ) {
      return false;
    }
    return section.items.every((item, itemIndex) => {
      const otherItem = other.items[itemIndex];
      return (
        otherItem !== undefined &&
        item.key === otherItem.key &&
        item.itemType === otherItem.itemType &&
        item.sortOrder === otherItem.sortOrder &&
        item.createdAt === otherItem.createdAt &&
        item.updatedAt === otherItem.updatedAt
      );
    });
  });
}

export function removeThreadFromSidebarSections(
  sections: ReadonlyArray<OrchestrationSidebarSectionShell>,
  threadId: string,
): OrchestrationSidebarSectionShell[] {
  const itemKey = threadSidebarItemKey(threadId);
  let changed = false;
  const nextSections = sections.map((section) => {
    const items = section.items
      .filter((item) => item.key !== itemKey)
      .map((item, index) => (item.sortOrder === index ? item : { ...item, sortOrder: index }));
    if (items.length === section.items.length) return section;
    changed = true;
    return { ...section, items };
  });
  return changed ? nextSections : [...sections];
}
