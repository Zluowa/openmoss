import { describe, expect, it } from "vitest";

import { collectSubagentDescendants, resolveThreadPresentationOwners } from "./threadHierarchy";

function thread(id: string, parentThreadId?: string | null) {
  return { id, parentThreadId: parentThreadId ?? null };
}

describe("collectSubagentDescendants", () => {
  it("collects nested descendants breadth-first and excludes the root", () => {
    const threads = [
      thread("root"),
      thread("child-a", "root"),
      thread("grandchild", "child-a"),
      thread("child-b", "root"),
      thread("unrelated"),
      thread("unrelated-child", "unrelated"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual([
      "child-a",
      "child-b",
      "grandchild",
    ]);
  });

  it("survives cyclic and self-referential linkage", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      // Corrupted rows: the root claims the child as its parent, and a thread points at itself.
      { id: "root", parentThreadId: "child" },
      thread("self", "self"),
    ];

    expect(collectSubagentDescendants(threads, "root").map((entry) => entry.id)).toEqual(["child"]);
  });
});

describe("resolveThreadPresentationOwners", () => {
  it("reports a parent cycle even when explicit custom ownership would otherwise short-circuit it", () => {
    const resolution = resolveThreadPresentationOwners({
      sections: [{ id: "custom", items: [{ key: "thread:a", itemType: "thread" }] }],
      threads: [thread("a", "b"), thread("b", "a")],
    });

    expect(resolution.cycleThreadIds).toEqual(new Set(["a", "b"]));
    expect(resolution.unresolvedThreadIds).toEqual(new Set(["a", "b"]));
    expect(resolution.owners).toEqual(new Map());
  });

  it("reports a parent cycle even when an explicit pinned boundary exists", () => {
    const resolution = resolveThreadPresentationOwners({
      sections: [],
      threads: [thread("a", "b"), thread("b", "a")],
      pinnedThreadIds: ["a"],
    });

    expect(resolution.cycleThreadIds).toEqual(new Set(["a", "b"]));
    expect(resolution.unresolvedThreadIds).toEqual(new Set(["a", "b"]));
    expect(resolution.owners).toEqual(new Map());
  });

  it("exposes duplicate and malformed membership evidence for fail-closed callers", () => {
    const resolution = resolveThreadPresentationOwners({
      sections: [
        {
          id: "custom-a",
          items: [
            { key: "thread:a", itemType: "thread" },
            { key: "thread:a", itemType: "thread" },
            { key: "thread:missing", itemType: "thread" },
            { key: "not-a-thread-key", itemType: "thread" },
          ],
        },
        { id: "custom-b", items: [{ key: "thread:a", itemType: "thread" }] },
      ],
      threads: [thread("a")],
    });

    expect(resolution.duplicateThreadIds).toEqual(new Set());
    expect(resolution.corruptMembershipThreadIds).toEqual(
      new Set(["a", "missing", "not-a-thread-key"]),
    );
  });
});
