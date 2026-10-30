import {
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
  type OrchestrationSidebarOrderItem,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  itemsInContainer,
  normalizeSidebarThreadOrder,
  orderContainerKey,
  placeSidebarItemOrder,
  placeSidebarThreadOrder,
  threadIdsInContainer,
} from "./sidebarThreadOrder";

const NOW = "2026-08-31T00:00:00.000Z";
const thread = (
  id: string,
  destination: "pinned" | "default" | "custom",
  sortOrder: number,
  sectionId: string | null = null,
  sectionCreatedAt: string | null = null,
): OrchestrationSidebarOrderItem => ({
  key: `thread:${id}` as OrchestrationSidebarOrderItem["key"],
  itemType: "thread",
  destination,
  sectionId: sectionId === null ? null : SidebarSectionId.makeUnsafe(sectionId),
  sectionCreatedAt: sectionCreatedAt as OrchestrationSidebarOrderItem["sectionCreatedAt"],
  sortOrder,
  createdAt: NOW,
  updatedAt: NOW,
});

const project = (
  id: string,
  destination: "pinned" | "default" | "custom",
  sortOrder: number,
  sectionId: string | null = null,
  sectionCreatedAt: string | null = null,
): OrchestrationSidebarOrderItem => ({
  key: `project:${id}` as OrchestrationSidebarOrderItem["key"],
  itemType: "project",
  destination,
  sectionId: sectionId === null ? null : SidebarSectionId.makeUnsafe(sectionId),
  sectionCreatedAt: sectionCreatedAt as OrchestrationSidebarOrderItem["sectionCreatedAt"],
  sortOrder,
  createdAt: NOW,
  updatedAt: NOW,
});

describe("authoritative sidebar thread order", () => {
  it("rejects the complete snapshot when any row is malformed or out of sequence", () => {
    const valid = thread("a", "default", 0);
    expect(normalizeSidebarThreadOrder([valid])).toEqual([valid]);
    expect(
      normalizeSidebarThreadOrder([
        valid,
        { ...thread("b", "default", 2), updatedAt: "not-a-date" },
      ]),
    ).toBeNull();
    expect(normalizeSidebarThreadOrder([valid, thread("b", "default", 2)])).toBeNull();
    expect(normalizeSidebarThreadOrder([valid, valid])).toBeNull();
    expect(
      normalizeSidebarThreadOrder([
        { ...valid, key: "project:a" as OrchestrationSidebarOrderItem["key"] },
      ]),
    ).toBeNull();
  });

  it("moves before an exact anchor and captures the previous successor", () => {
    const result = placeSidebarThreadOrder(
      [thread("a", "default", 0), thread("b", "default", 1), thread("c", "default", 2)],
      {
        threadId: ThreadId.makeUnsafe("c"),
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
        beforeThreadId: ThreadId.makeUnsafe("a"),
        now: NOW,
      },
    );

    expect(result?.changed).toBe(true);
    expect(result?.previousSuccessorThreadId).toBeNull();
    expect(
      threadIdsInContainer(result?.items ?? [], {
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
      }),
    ).toEqual(["c", "a", "b"]);
  });

  it("captures the exact mixed successor for a project inverse", () => {
    const result = placeSidebarItemOrder(
      [
        project("source", "default", 0),
        thread("successor", "default", 1),
        project("tail", "default", 2),
      ],
      {
        itemKey: SidebarSectionItemKey.makeUnsafe("project:source"),
        itemType: "project",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        beforeItemKey: null,
        now: NOW,
      },
    );

    expect(result?.changed).toBe(true);
    expect(result?.previousSuccessorItemKey).toBe("thread:successor");
  });

  it("keeps mixed project slots and exact custom incarnation during a cross-container move", () => {
    const result = placeSidebarThreadOrder(
      [
        {
          ...thread("project-holder", "custom", 0, "section", NOW),
          key: "project:holder" as OrchestrationSidebarOrderItem["key"],
          itemType: "project",
        },
        thread("source", "default", 0),
        thread("anchor", "custom", 1, "section", NOW),
      ],
      {
        threadId: ThreadId.makeUnsafe("source"),
        destination: "custom",
        sectionId: "section",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("anchor"),
        now: NOW,
      },
    );

    expect(result?.changed).toBe(true);
    expect(result?.items.find((item) => item.key === "project:holder")?.sortOrder).toBe(0);
    expect(
      itemsInContainer(result?.items ?? [], {
        destination: "custom",
        sectionId: "section",
        sectionCreatedAt: NOW,
      }).map((item) => item.key),
    ).toEqual(["project:holder", "thread:source", "thread:anchor"]);
  });

  it("keeps mixed project slots when a cross-container thread moves before the first thread", () => {
    const result = placeSidebarThreadOrder(
      [
        thread("first", "custom", 0, "section", NOW),
        {
          ...thread("project-holder", "custom", 1, "section", NOW),
          key: "project:holder" as OrchestrationSidebarOrderItem["key"],
          itemType: "project",
        },
        thread("last", "custom", 2, "section", NOW),
        thread("source-first", "default", 0),
      ],
      {
        threadId: ThreadId.makeUnsafe("source-first"),
        destination: "custom",
        sectionId: "section",
        sectionCreatedAt: NOW,
        beforeThreadId: ThreadId.makeUnsafe("first"),
        now: NOW,
      },
    );

    expect(
      itemsInContainer(result?.items ?? [], {
        destination: "custom",
        sectionId: "section",
        sectionCreatedAt: NOW,
      }).map((item) => item.key),
    ).toEqual(["thread:source-first", "project:holder", "thread:first", "thread:last"]);
    expect(result?.items.find((item) => item.key === "project:holder")?.sortOrder).toBe(1);
  });

  it("appends a cross-container thread after the last thread without shifting projects", () => {
    const result = placeSidebarThreadOrder(
      [
        thread("first-append", "custom", 0, "section-append", NOW),
        {
          ...thread("project-holder-append", "custom", 1, "section-append", NOW),
          key: "project:holder-append" as OrchestrationSidebarOrderItem["key"],
          itemType: "project",
        },
        thread("last-append", "custom", 2, "section-append", NOW),
        thread("source-append", "default", 0),
      ],
      {
        threadId: ThreadId.makeUnsafe("source-append"),
        destination: "custom",
        sectionId: "section-append",
        sectionCreatedAt: NOW,
        beforeThreadId: null,
        now: NOW,
      },
    );

    expect(
      itemsInContainer(result?.items ?? [], {
        destination: "custom",
        sectionId: "section-append",
        sectionCreatedAt: NOW,
      }).map((item) => item.key),
    ).toEqual([
      "thread:first-append",
      "project:holder-append",
      "thread:last-append",
      "thread:source-append",
    ]);
    expect(result?.items.find((item) => item.key === "project:holder-append")?.sortOrder).toBe(1);
  });

  it("fails closed for absent/foreign anchors and reports exact no-ops", () => {
    const items = [thread("a", "default", 0), thread("b", "default", 1)];
    expect(
      placeSidebarThreadOrder(items, {
        threadId: ThreadId.makeUnsafe("a"),
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
        beforeThreadId: ThreadId.makeUnsafe("b"),
        now: NOW,
      })?.changed,
    ).toBe(false);
    expect(
      placeSidebarThreadOrder(items, {
        threadId: ThreadId.makeUnsafe("a"),
        destination: "default",
        sectionId: null,
        sectionCreatedAt: null,
        beforeThreadId: ThreadId.makeUnsafe("missing"),
        now: NOW,
      }),
    ).toBeNull();
    expect(orderContainerKey(items[0]!)).toBe("default::");
  });
});
