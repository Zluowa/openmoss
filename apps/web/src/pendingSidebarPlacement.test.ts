import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarSectionId, ThreadId } from "@synara/contracts";

import {
  clearPendingSidebarPlacement,
  getPendingSidebarPlacement,
  PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY,
  setPendingSidebarPlacement,
} from "./pendingSidebarPlacement";

const THREAD_ID = ThreadId.makeUnsafe("thread-pending");
const SECTION_ID = "section-pending";
const SECTION_CREATED_AT = "2026-08-31T00:00:00.000Z";

describe("pending sidebar placement storage", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips an exact thread and section incarnation", () => {
    setPendingSidebarPlacement({
      threadId: THREAD_ID,
      sectionId: SidebarSectionId.makeUnsafe(SECTION_ID),
      sectionCreatedAt: SECTION_CREATED_AT,
    });
    expect(getPendingSidebarPlacement(THREAD_ID)).toEqual({
      threadId: THREAD_ID,
      sectionId: SECTION_ID,
      sectionCreatedAt: SECTION_CREATED_AT,
    });
    clearPendingSidebarPlacement(THREAD_ID);
    expect(getPendingSidebarPlacement(THREAD_ID)).toBeNull();
  });

  it("fails closed for malformed rows and mismatched map identities", () => {
    localStorage.setItem(
      PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY,
      JSON.stringify({
        [THREAD_ID]: {
          threadId: "thread-other",
          sectionId: SECTION_ID,
          sectionCreatedAt: SECTION_CREATED_AT,
        },
        "thread-valid": {
          threadId: "thread-valid",
          sectionId: SECTION_ID,
          sectionCreatedAt: SECTION_CREATED_AT,
        },
        "thread-bad-date": {
          threadId: "thread-bad-date",
          sectionId: SECTION_ID,
          sectionCreatedAt: "not-a-date",
        },
      }),
    );
    expect(getPendingSidebarPlacement(THREAD_ID)).toBeNull();
    expect(getPendingSidebarPlacement(ThreadId.makeUnsafe("thread-valid"))).toMatchObject({
      threadId: "thread-valid",
      sectionId: SECTION_ID,
    });
  });

  it("does not persist an invalid section incarnation", () => {
    setPendingSidebarPlacement({
      threadId: ThreadId.makeUnsafe("thread-invalid"),
      sectionId: "" as SidebarSectionId,
      sectionCreatedAt: "invalid",
    });
    expect(localStorage.getItem(PENDING_SIDEBAR_PLACEMENTS_STORAGE_KEY)).toBeNull();
  });
});
