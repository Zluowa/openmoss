// FILE: pendingSidebarPlacement.ts
// Purpose: Persist a draft's exact custom-section placement until promotion.

import type { SidebarSectionId, ThreadId } from "@synara/contracts";

export interface PendingSidebarPlacement {
  readonly threadId: ThreadId;
  readonly sectionId: SidebarSectionId;
  readonly sectionCreatedAt: string;
}

export const PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY = "moss:pending-sidebar-placements:v1";

function readAll(): Record<string, PendingSidebarPlacement> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result: Record<string, PendingSidebarPlacement> = {};
    for (const [threadId, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (
        threadId.length === 0 ||
        typeof row.threadId !== "string" ||
        row.threadId !== threadId ||
        typeof row.sectionId !== "string" ||
        row.sectionId.length === 0 ||
        typeof row.sectionCreatedAt !== "string" ||
        Number.isNaN(Date.parse(row.sectionCreatedAt))
      )
        continue;
      result[threadId] = {
        threadId: threadId as ThreadId,
        sectionId: row.sectionId as SidebarSectionId,
        sectionCreatedAt: row.sectionCreatedAt,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, PendingSidebarPlacement>): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(value).length === 0) {
      localStorage.removeItem(PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY);
    } else {
      localStorage.setItem(PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY, JSON.stringify(value));
    }
  } catch {
    // A storage quota/private-mode failure leaves the draft usable; promotion
    // simply has no placement request to apply.
  }
}

export function setPendingSidebarPlacement(
  input: Omit<PendingSidebarPlacement, "threadId"> & { threadId: ThreadId },
): void {
  if (
    String(input.threadId).length === 0 ||
    String(input.sectionId).length === 0 ||
    Number.isNaN(Date.parse(input.sectionCreatedAt))
  ) {
    return;
  }
  const current = readAll();
  current[input.threadId] = input;
  writeAll(current);
}

export function getPendingSidebarPlacement(threadId: ThreadId): PendingSidebarPlacement | null {
  return readAll()[threadId] ?? null;
}

export function clearPendingSidebarPlacement(threadId: ThreadId): void {
  const current = readAll();
  if (!(threadId in current)) return;
  delete current[threadId];
  writeAll(current);
}

export function clearPendingSidebarPlacements(threadIds: ReadonlyArray<ThreadId>): void {
  const current = readAll();
  let changed = false;
  for (const threadId of threadIds) {
    if (!(threadId in current)) continue;
    delete current[threadId];
    changed = true;
  }
  if (changed) writeAll(current);
}
