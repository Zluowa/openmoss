import { describe, expect, it } from "vitest";

import {
  SidebarSectionId,
  SidebarSectionItemKey,
  TurnId,
  ThreadId,
  type OrchestrationSidebarSectionShell,
} from "@synara/contracts";

import {
  buildSidebarSectionArchivePlan,
  buildSidebarSectionArchivePlans,
  executeSidebarSectionArchivePlan,
  getSidebarSectionArchiveBlockedRootCounts,
  sidebarSectionArchiveNothingToast,
  sidebarSectionArchiveResultToast,
  type SidebarSectionArchiveThread,
} from "./sidebarSectionArchive";

const NOW = "2026-08-31T00:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<SidebarSectionArchiveThread> = {},
): SidebarSectionArchiveThread {
  return {
    id: ThreadId.makeUnsafe(id),
    parentThreadId: null,
    archivedAt: null,
    session: null,
    ...overrides,
  };
}

function makeSection(
  id: string,
  threadIds: readonly ThreadId[],
  overrides: Partial<OrchestrationSidebarSectionShell> = {},
): OrchestrationSidebarSectionShell {
  return {
    id: SidebarSectionId.makeUnsafe(id),
    name: id,
    sortOrder: 0,
    isCollapsed: false,
    items: threadIds.map((threadId, sortOrder) => ({
      key: SidebarSectionItemKey.makeUnsafe(`thread:${threadId}`),
      itemType: "thread",
      sortOrder,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function runningSession() {
  return {
    status: "running" as const,
    activeTurnId: TurnId.makeUnsafe("turn-running"),
  };
}

describe("buildSidebarSectionArchivePlan", () => {
  it("archives one root once while including its complete internal cascade", () => {
    const root = ThreadId.makeUnsafe("root");
    const child = ThreadId.makeUnsafe("child");
    const grandchild = ThreadId.makeUnsafe("grandchild");
    const section = makeSection("research", [root]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(root)),
        makeThread(String(child), { parentThreadId: root }),
        makeThread(String(grandchild), { parentThreadId: child }),
      ],
    });

    expect(plan?.eligibleRootGroups.map((group) => group.rootThreadId)).toEqual([root]);
    expect(plan?.eligibleRootGroups[0]?.affectedThreadIds).toEqual([root, child, grandchild]);
    expect(plan?.blockedRunningRootGroups).toEqual([]);
    expect(plan?.blockedExternalDescendantRootGroups).toEqual([]);
  });

  it("cancels before dispatching any root and returns no success state", async () => {
    const root = ThreadId.makeUnsafe("cancel-root");
    const section = makeSection("cancel", [root]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [makeThread(String(root))],
    });
    if (!plan) throw new Error("expected archive plan");
    const archiveRoot = async () => true;

    const result = await executeSidebarSectionArchivePlan({
      initialPlan: plan,
      readCurrentPlan: () => plan,
      archiveRoot,
      cancelled: true,
    });
    expect(result.cancelled).toBe(true);
    expect(result.summary).toEqual({
      archivedRootCount: 0,
      failedRootCount: 0,
      skippedRunningRootCount: 0,
      skippedExternalDescendantRootCount: 0,
    });
    expect(result.successfullyArchivedThreadIds).toEqual([]);
  });

  it("rechecks external and running ownership drift before dispatch", async () => {
    const externalRoot = ThreadId.makeUnsafe("drift-external-root");
    const externalChild = ThreadId.makeUnsafe("drift-external-child");
    const runningRoot = ThreadId.makeUnsafe("drift-running-root");
    const section = makeSection("drift", [externalRoot, runningRoot]);
    const initialPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(externalRoot)),
        makeThread(String(externalChild), { parentThreadId: externalRoot }),
        makeThread(String(runningRoot)),
      ],
    });
    if (!initialPlan) throw new Error("expected archive plan");
    const externalGroup = initialPlan.eligibleRootGroups.find(
      (group) => group.rootThreadId === externalRoot,
    );
    const runningGroup = initialPlan.eligibleRootGroups.find(
      (group) => group.rootThreadId === runningRoot,
    );
    if (!externalGroup || !runningGroup) throw new Error("expected eligible groups");
    const externalPlan: typeof initialPlan = {
      ...initialPlan,
      eligibleRootGroups: [runningGroup],
      blockedRunningRootGroups: [],
      blockedExternalDescendantRootGroups: [
        { ...externalGroup, externalDescendantThreadIds: [externalChild] },
      ],
    };
    const runningPlan: typeof initialPlan = {
      ...initialPlan,
      eligibleRootGroups: [],
      blockedRunningRootGroups: [{ ...runningGroup, runningThreadIds: [runningRoot] }],
      blockedExternalDescendantRootGroups: [],
    };
    let readCount = 0;
    const dispatchedRoots: ThreadId[] = [];
    const result = await executeSidebarSectionArchivePlan({
      initialPlan,
      readCurrentPlan: () => {
        readCount += 1;
        return readCount === 1 ? externalPlan : runningPlan;
      },
      archiveRoot: async (group) => {
        dispatchedRoots.push(group.rootThreadId);
        return true;
      },
    });

    expect(dispatchedRoots).toEqual([]);
    expect(result.summary).toEqual({
      archivedRootCount: 0,
      failedRootCount: 0,
      skippedRunningRootCount: 1,
      skippedExternalDescendantRootCount: 1,
    });
  });

  it("serializes partial failures and clears only successful group ids", async () => {
    const first = ThreadId.makeUnsafe("partial-first");
    const second = ThreadId.makeUnsafe("partial-second");
    const firstChild = ThreadId.makeUnsafe("partial-first-child");
    const section = makeSection("partial", [first, second]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(first)),
        makeThread(String(firstChild), { parentThreadId: first }),
        makeThread(String(second)),
      ],
    });
    if (!plan) throw new Error("expected archive plan");
    const calls: ThreadId[] = [];
    const result = await executeSidebarSectionArchivePlan({
      initialPlan: plan,
      readCurrentPlan: () => plan,
      archiveRoot: async (group) => {
        calls.push(group.rootThreadId);
        return group.rootThreadId === first;
      },
    });

    expect(calls).toEqual([first, second]);
    expect(result.summary).toEqual({
      archivedRootCount: 1,
      failedRootCount: 1,
      skippedRunningRootCount: 0,
      skippedExternalDescendantRootCount: 0,
    });
    expect(result.successfullyArchivedThreadIds).toEqual([first, firstChild]);
  });

  it("includes collapsed descendants because planning is independent of rendered rows", () => {
    const root = ThreadId.makeUnsafe("collapsed-root");
    const child = ThreadId.makeUnsafe("collapsed-child");
    const section = makeSection("collapsed", [root], { isCollapsed: true });
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [makeThread(String(root)), makeThread(String(child), { parentThreadId: root })],
    });

    expect(plan?.rootGroups).toHaveLength(1);
    expect(plan?.rootGroups[0]?.affectedThreadIds).toEqual([root, child]);
  });

  it("blocks the whole root group when either the root or a descendant is running", () => {
    const root = ThreadId.makeUnsafe("running-root");
    const child = ThreadId.makeUnsafe("running-child");
    const section = makeSection("running", [root]);
    const rootPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(root), { session: runningSession() }),
        makeThread(String(child), { parentThreadId: root }),
      ],
    });
    expect(rootPlan?.eligibleRootGroups).toEqual([]);
    expect(rootPlan?.blockedRunningRootGroups[0]?.runningThreadIds).toEqual([root]);

    const descendantPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(root)),
        makeThread(String(child), { parentThreadId: root, session: runningSession() }),
      ],
    });
    expect(descendantPlan?.eligibleRootGroups).toEqual([]);
    expect(descendantPlan?.blockedRunningRootGroups[0]?.runningThreadIds).toEqual([child]);
  });

  it("keeps an all-blocked plan dispatch-free", async () => {
    const root = ThreadId.makeUnsafe("all-blocked-root");
    const section = makeSection("all-blocked", [root]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [makeThread(String(root), { session: runningSession() })],
    });
    if (!plan) throw new Error("expected archive plan");
    const dispatchedRoots: ThreadId[] = [];
    const result = await executeSidebarSectionArchivePlan({
      initialPlan: plan,
      readCurrentPlan: () => plan,
      archiveRoot: async (group) => {
        dispatchedRoots.push(group.rootThreadId);
        return true;
      },
    });

    expect(dispatchedRoots).toEqual([]);
    expect(result.summary).toEqual({
      archivedRootCount: 0,
      failedRootCount: 0,
      skippedRunningRootCount: 1,
      skippedExternalDescendantRootCount: 0,
    });
  });

  it("blocks pinned and explicitly re-owned descendants without issuing a child command", () => {
    const root = ThreadId.makeUnsafe("ownership-root");
    const pinnedChild = ThreadId.makeUnsafe("pinned-child");
    const reownedChild = ThreadId.makeUnsafe("reowned-child");
    const section = makeSection("owner", [root]);
    const otherSection = makeSection("other", [reownedChild]);
    const pinnedPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      pinnedThreadIds: new Set([pinnedChild]),
      threads: [
        makeThread(String(root)),
        makeThread(String(pinnedChild), { parentThreadId: root }),
      ],
    });
    expect(pinnedPlan?.eligibleRootGroups).toEqual([]);
    expect(pinnedPlan?.blockedExternalDescendantRootGroups[0]?.externalDescendantThreadIds).toEqual(
      [pinnedChild],
    );
    expect(pinnedPlan?.blockedExternalDescendantRootGroups[0]?.affectedThreadIds).toEqual([
      root,
      pinnedChild,
    ]);

    const reownedPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section, otherSection],
      threads: [
        makeThread(String(root)),
        makeThread(String(reownedChild), { parentThreadId: root }),
      ],
    });
    expect(reownedPlan?.eligibleRootGroups).toEqual([]);
    expect(
      reownedPlan?.blockedExternalDescendantRootGroups[0]?.externalDescendantThreadIds,
    ).toEqual([reownedChild]);
  });

  it("uses the external-ownership reason as the sole primary block for mixed groups", () => {
    const root = ThreadId.makeUnsafe("mixed-root");
    const child = ThreadId.makeUnsafe("mixed-child");
    const section = makeSection("mixed-owner", [root]);
    const otherSection = makeSection("mixed-other", [child]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section, otherSection],
      threads: [
        makeThread(String(root)),
        makeThread(String(child), { parentThreadId: root, session: runningSession() }),
      ],
    });

    expect(plan?.blockedExternalDescendantRootGroups.map((group) => group.rootThreadId)).toEqual([
      root,
    ]);
    expect(plan?.blockedRunningRootGroups).toEqual([]);
    expect(plan && getSidebarSectionArchiveBlockedRootCounts(plan)).toEqual({
      running: 0,
      external: 1,
    });
  });

  it("counts a mixed current-plan drift once with external priority", async () => {
    const root = ThreadId.makeUnsafe("mixed-drift-root");
    const child = ThreadId.makeUnsafe("mixed-drift-child");
    const section = makeSection("mixed-drift", [root]);
    const initialPlan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [makeThread(String(root)), makeThread(String(child), { parentThreadId: root })],
    });
    if (!initialPlan) throw new Error("expected archive plan");
    const group = initialPlan.eligibleRootGroups[0];
    if (!group) throw new Error("expected eligible group");
    const mixedPlan: typeof initialPlan = {
      ...initialPlan,
      eligibleRootGroups: [],
      blockedRunningRootGroups: [{ ...group, runningThreadIds: [child] }],
      blockedExternalDescendantRootGroups: [{ ...group, externalDescendantThreadIds: [child] }],
    };

    const result = await executeSidebarSectionArchivePlan({
      initialPlan,
      readCurrentPlan: () => mixedPlan,
      archiveRoot: async () => true,
    });

    expect(result.summary).toEqual({
      archivedRootCount: 0,
      failedRootCount: 0,
      skippedRunningRootCount: 0,
      skippedExternalDescendantRootCount: 1,
    });
    expect(
      result.summary.archivedRootCount +
        result.summary.failedRootCount +
        result.summary.skippedRunningRootCount +
        result.summary.skippedExternalDescendantRootCount,
    ).toBeLessThanOrEqual(initialPlan.rootGroups.length);
  });

  it("preserves independent root order and ignores archived rows", () => {
    const first = ThreadId.makeUnsafe("first-root");
    const second = ThreadId.makeUnsafe("second-root");
    const archived = ThreadId.makeUnsafe("archived-root");
    const section = makeSection("ordered", [second, first, archived]);
    const plan = buildSidebarSectionArchivePlan({
      sectionId: section.id,
      sections: [section],
      threads: [
        makeThread(String(first)),
        makeThread(String(second)),
        makeThread(String(archived), { archivedAt: NOW }),
      ],
    });

    expect(plan?.eligibleRootGroups.map((group) => group.rootThreadId)).toEqual([second, first]);
  });

  it("terminates self-cycles and multi-node cycles without duplicate affected ids", () => {
    const self = ThreadId.makeUnsafe("self-cycle");
    const first = ThreadId.makeUnsafe("cycle-first");
    const second = ThreadId.makeUnsafe("cycle-second");
    const selfSection = makeSection("self", [self]);
    const selfPlan = buildSidebarSectionArchivePlan({
      sectionId: selfSection.id,
      sections: [selfSection],
      threads: [makeThread(String(self), { parentThreadId: self })],
    });
    expect(selfPlan?.eligibleRootGroups[0]?.affectedThreadIds).toEqual([self]);

    const cycleSection = makeSection("cycle", [first]);
    const cyclePlan = buildSidebarSectionArchivePlan({
      sectionId: cycleSection.id,
      sections: [cycleSection],
      threads: [
        makeThread(String(first), { parentThreadId: second }),
        makeThread(String(second), { parentThreadId: first }),
      ],
    });
    const affected = cyclePlan?.eligibleRootGroups[0]?.affectedThreadIds ?? [];
    expect(affected).toEqual([first, second]);
    expect(new Set(affected).size).toBe(affected.length);
  });

  it("returns one plan per section and a single result presentation", () => {
    const first = makeSection("first", [ThreadId.makeUnsafe("first-root")]);
    const second = makeSection("second", []);
    const plans = buildSidebarSectionArchivePlans({
      sections: [first, second],
      threads: [makeThread("first-root")],
    });
    expect([...plans.keys()]).toEqual([first.id, second.id]);
    expect(plans.get(second.id)?.rootGroups).toEqual([]);

    expect(
      sidebarSectionArchiveResultToast("zh-CN", "first", {
        archivedRootCount: 1,
        failedRootCount: 1,
        skippedRunningRootCount: 1,
        skippedExternalDescendantRootCount: 1,
      }),
    ).toEqual({
      type: "warning",
      title: "已归档 1 个对话",
      description:
        "已归档“first”中的 1 个对话。 归档失败：1 个对话。 跳过：1 个正在运行的对话。 跳过：1 个位于本分区外的关联对话。",
    });
    expect(sidebarSectionArchiveNothingToast("zh-CN", "empty")).toEqual({
      type: "info",
      title: "无需归档",
      description: "“empty”中没有可归档的对话。",
    });
  });
});
