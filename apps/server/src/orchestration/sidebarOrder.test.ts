import { describe, expect, it } from "vitest";

import type { OrchestrationSidebarOrderItem } from "@synara/contracts";

import {
  compactSidebarOrderItems,
  listSidebarOrderKeys,
  placeSidebarOrderItem,
  placeSidebarThreadOrder,
  rehomeSidebarSectionItems,
  reorderSidebarProjects,
  reorderSidebarSectionThreads,
  sidebarOrderContainerKey,
  validateSidebarOrderItems,
  SidebarOrderError,
} from "./sidebarOrder";

const NOW = "2026-08-31T00:00:00.000Z";

function thread(
  id: string,
  destination: "pinned" | "default" | "custom",
  sortOrder: number,
  sectionId: string | null = null,
  sectionCreatedAt: string | null = null,
): OrchestrationSidebarOrderItem {
  return {
    key: `thread:${id}` as OrchestrationSidebarOrderItem["key"],
    itemType: "thread",
    destination,
    sectionId: sectionId as OrchestrationSidebarOrderItem["sectionId"],
    sectionCreatedAt: sectionCreatedAt as OrchestrationSidebarOrderItem["sectionCreatedAt"],
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function project(
  id: string,
  destination: "pinned" | "default" | "custom",
  sortOrder: number,
  sectionId: string | null = null,
  sectionCreatedAt: string | null = null,
): OrchestrationSidebarOrderItem {
  return {
    key: `project:${id}` as OrchestrationSidebarOrderItem["key"],
    itemType: "project",
    destination,
    sectionId: sectionId as OrchestrationSidebarOrderItem["sectionId"],
    sectionCreatedAt: sectionCreatedAt as OrchestrationSidebarOrderItem["sectionCreatedAt"],
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("durable sidebar order rules", () => {
  it("moves an item before an exact anchor and compacts both containers", () => {
    const result = placeSidebarOrderItem(
      [thread("a", "default", 0), thread("b", "default", 1), thread("c", "default", 2)],
      {
        itemKey: "thread:c",
        destination: "default",
        beforeThreadId: "a",
        now: NOW,
      },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
      }),
    ).toEqual(["thread:c", "thread:a", "thread:b"]);
    expect(result.changed).toBe(true);
    expect(result.next.sortOrder).toBe(0);
  });

  it("supports cross-container insertion without changing custom identity", () => {
    const result = placeSidebarOrderItem(
      [
        thread("a", "default", 0),
        thread("b", "custom", 0, "section-a", NOW),
        thread("c", "custom", 1, "section-a", NOW),
      ],
      {
        itemKey: "thread:a",
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: NOW,
        beforeThreadId: "thread-c".replace("thread-", ""),
        now: NOW,
      },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: NOW,
      }),
    ).toEqual(["thread:b", "thread:a", "thread:c"]);
    expect(result.items.find((item) => item.key === "thread:a")?.sectionCreatedAt).toBe(NOW);
  });

  it("accepts an exact no-op and rejects foreign or self anchors", () => {
    const items = [thread("a", "default", 0), thread("b", "default", 1)];
    expect(
      placeSidebarOrderItem(items, {
        itemKey: "thread:a",
        destination: "default",
        beforeThreadId: "b",
        now: NOW,
      }).changed,
    ).toBe(false);
    expect(() =>
      placeSidebarOrderItem(items, {
        itemKey: "thread:a",
        destination: "pinned",
        beforeThreadId: "b",
        now: NOW,
      }),
    ).toThrowError(SidebarOrderError);
    expect(() =>
      placeSidebarOrderItem(items, {
        itemKey: "thread:a",
        destination: "default",
        beforeThreadId: "a",
        now: NOW,
      }),
    ).toThrowError(SidebarOrderError);
  });

  it("validates unique keys and compacts sparse legacy rows", () => {
    expect(() =>
      validateSidebarOrderItems([thread("a", "default", 0), thread("a", "default", 1)]),
    ).toThrowError(/more than one placement/);
    const compacted = compactSidebarOrderItems([
      thread("b", "default", 3),
      thread("a", "default", 8),
    ]);
    expect(
      listSidebarOrderKeys(compacted, {
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
      }),
    ).toEqual(["thread:b", "thread:a"]);
    expect(compacted.map((item) => item.sortOrder)).toEqual([0, 1]);
    expect(sidebarOrderContainerKey(compacted[0]!)).toBe("default::");
  });

  it("accepts exact container capacity and rejects one additional row", () => {
    const atCapacity = Array.from({ length: 256 }, (_, index) =>
      thread(`capacity-${index}`, "default", index),
    );
    expect(() => validateSidebarOrderItems(atCapacity, 256)).not.toThrow();
    expect(() =>
      validateSidebarOrderItems(
        [...atCapacity, thread("capacity-overflow", "default", atCapacity.length)],
        256,
      ),
    ).toThrowError(/exceeds its item capacity/);
  });

  it("rejects duplicate project ids in a requested order", () => {
    expect(() =>
      reorderSidebarProjects(
        [project("duplicate-a", "default", 0), project("duplicate-b", "default", 1)],
        { orderedProjectIds: ["duplicate-a", "duplicate-a"], now: NOW },
      ),
    ).toThrowError(/cannot contain duplicates/);
  });

  it("applies partial default-project ordering without consuming thread slots", () => {
    const result = reorderSidebarProjects(
      [
        project("partial-a", "default", 0),
        thread("partial-thread", "default", 1),
        project("partial-b", "default", 2),
        project("partial-c", "default", 3),
      ],
      { orderedProjectIds: ["partial-c"], now: NOW },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
      }),
    ).toEqual([
      "project:partial-c",
      "thread:partial-thread",
      "project:partial-a",
      "project:partial-b",
    ]);
    expect(result.items.find((item) => item.key === "thread:partial-thread")?.sortOrder).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("rewrites only thread slots in a mixed section", () => {
    const result = reorderSidebarSectionThreads(
      [
        thread("a", "custom", 0, "section-a", NOW),
        project("p", "custom", 1, "section-a", NOW),
        thread("b", "custom", 2, "section-a", NOW),
      ],
      {
        sectionId: "section-a",
        sectionCreatedAt: NOW,
        orderedThreadIds: ["b", "a"],
        now: NOW,
      },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: NOW,
      }),
    ).toEqual(["thread:b", "project:p", "thread:a"]);
  });

  it("places a thread before a mixed-section thread anchor without moving project slots", () => {
    const result = placeSidebarThreadOrder(
      [
        thread("a", "custom", 0, "section-a", NOW),
        project("p", "custom", 1, "section-a", NOW),
        thread("b", "custom", 2, "section-a", NOW),
      ],
      {
        itemKey: "thread:b",
        itemType: "thread",
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: NOW,
        beforeThreadId: "a",
        now: NOW,
      },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: NOW,
      }),
    ).toEqual(["thread:b", "project:p", "thread:a"]);
    expect(result.changed).toBe(true);
  });

  it("rehomes an exact deleted section incarnation as one mixed default suffix", () => {
    const result = rehomeSidebarSectionItems(
      [
        thread("default", "default", 0),
        thread("a", "custom", 0, "section-a", NOW),
        project("p", "custom", 1, "section-a", NOW),
        thread("b", "custom", 2, "section-a", NOW),
        thread("old", "custom", 0, "section-a", "2026-08-30T00:00:00.000Z"),
      ],
      { sectionId: "section-a", sectionCreatedAt: NOW, now: NOW },
    );

    expect(
      listSidebarOrderKeys(result.items, {
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
      }),
    ).toEqual(["thread:default", "thread:a", "project:p", "thread:b"]);
    expect(
      listSidebarOrderKeys(result.items, {
        destination: "custom",
        sectionId: "section-a",
        sectionCreatedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toEqual(["thread:old"]);
    expect(result.rehomed.map((item) => item.key)).toEqual(["thread:a", "project:p", "thread:b"]);
  });
});
