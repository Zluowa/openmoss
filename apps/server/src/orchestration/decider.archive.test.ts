import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  SIDEBAR_SECTION_ITEMS_MAX_COUNT,
  SidebarOrderRevision,
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-25T18:00:00.000Z";
const PARENT_THREAD_ID = ThreadId.makeUnsafe("thread-parent");
const CHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:thread-parent:child");
const GRANDCHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:child:grandchild");
const DELETED_CHILD_THREAD_ID = ThreadId.makeUnsafe("subagent:thread-parent:deleted");
const UNRELATED_THREAD_ID = ThreadId.makeUnsafe("thread-unrelated");

function makeThread(input: {
  id: ThreadId;
  parentThreadId?: ThreadId;
  archivedAt?: string;
  deletedAt?: string;
  isPinned?: boolean;
  archivedByCommandId?: CommandId | null;
  archivedSidebarSectionId?: SidebarSectionId | null;
  archivedSidebarSectionCreatedAt?: string | null;
  archivedSidebarSortOrder?: number | null;
  latestTurn?: OrchestrationReadModel["threads"][number]["latestTurn"];
}): OrchestrationReadModel["threads"][number] {
  return {
    id: input.id,
    projectId: ProjectId.makeUnsafe("project-archive"),
    title: `Thread ${input.id}`,
    modelSelection: {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "auto",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: input.deletedAt ?? null,
    isPinned: input.isPinned ?? false,
    archivedByCommandId: input.archivedByCommandId ?? null,
    archivedSidebarSectionId: input.archivedSidebarSectionId ?? null,
    archivedSidebarSectionCreatedAt: input.archivedSidebarSectionCreatedAt ?? null,
    archivedSidebarSortOrder: input.archivedSidebarSortOrder ?? null,
    ...(input.parentThreadId !== undefined ? { parentThreadId: input.parentThreadId } : {}),
    ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
    ...(input.latestTurn !== undefined ? { latestTurn: input.latestTurn } : {}),
  };
}

function makeReadModel(
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
  sidebarSections: OrchestrationReadModel["sidebarSections"] = [],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads,
    sidebarSections,
  };
}

function makeSection(input: {
  id: SidebarSectionId;
  itemThreadIds: readonly ThreadId[];
  createdAt?: string;
}): NonNullable<OrchestrationReadModel["sidebarSections"]>[number] {
  const createdAt = input.createdAt ?? NOW;
  return {
    id: input.id,
    name: "Archive section",
    sortOrder: 0,
    isCollapsed: false,
    items: input.itemThreadIds.map((threadId, sortOrder) => ({
      key: SidebarSectionItemKey.makeUnsafe(`thread:${threadId}`),
      itemType: "thread" as const,
      sortOrder,
      createdAt,
      updatedAt: createdAt,
    })),
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
}

function eventThreadIds(result: unknown): ThreadId[] {
  const events = (Array.isArray(result) ? result : [result]) as Omit<
    OrchestrationEvent,
    "sequence"
  >[];
  return events.map((event) => (event.payload as { threadId: ThreadId }).threadId);
}

function archiveCommand(
  type: "thread.archive" | "thread.unarchive",
  commandId: string,
  threadId: ThreadId,
): Extract<OrchestrationCommand, { type: "thread.archive" | "thread.unarchive" }> {
  return {
    type,
    commandId: CommandId.makeUnsafe(commandId),
    threadId,
    expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(0),
  } as Extract<OrchestrationCommand, { type: "thread.archive" | "thread.unarchive" }>;
}

describe("decider thread archive cascade", () => {
  it("archives the subagent subtree together with the parent", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-parent"),
          threadId: PARENT_THREAD_ID,
          expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(0),
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
          makeThread({ id: GRANDCHILD_THREAD_ID, parentThreadId: CHILD_THREAD_ID }),
          makeThread({
            id: DELETED_CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            deletedAt: NOW,
          }),
          makeThread({ id: UNRELATED_THREAD_ID }),
        ]),
      }),
    );

    const events = result as Omit<OrchestrationEvent, "sequence">[];
    expect(events.every((event) => event.type === "thread.archived")).toBe(true);
    // Descendants first; the commanded thread comes last so the command receipt
    // records it as the aggregate.
    expect(eventThreadIds(result)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_THREAD_ID,
      PARENT_THREAD_ID,
    ]);
  });

  it("skips subagent threads that are already archived", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive-parent-partial"),
          threadId: PARENT_THREAD_ID,
          expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(0),
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
          }),
        ]),
      }),
    );

    expect(eventThreadIds(result)).toEqual([PARENT_THREAD_ID]);
  });

  it("restores only the root when the archive cohort is not provable", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive-parent"),
          threadId: PARENT_THREAD_ID,
          expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(0),
        },
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID, archivedAt: NOW }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
          }),
          // Never archived alongside the parent, so restore leaves it untouched.
          makeThread({ id: GRANDCHILD_THREAD_ID, parentThreadId: CHILD_THREAD_ID }),
        ]),
      }),
    );

    const events = result as Omit<OrchestrationEvent, "sequence">[];
    expect(events.every((event) => event.type === "thread.unarchived")).toBe(true);
    expect(eventThreadIds(result)).toEqual([PARENT_THREAD_ID]);
  });

  it("archives the whole cascade even when the root or a descendant is running", async () => {
    for (const threads of [
      [
        makeThread({
          id: PARENT_THREAD_ID,
          latestTurn: {
            state: "running",
          } as OrchestrationReadModel["threads"][number]["latestTurn"],
        }),
        makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
      ],
      [
        makeThread({ id: PARENT_THREAD_ID }),
        makeThread({
          id: CHILD_THREAD_ID,
          parentThreadId: PARENT_THREAD_ID,
          latestTurn: {
            state: "running",
          } as OrchestrationReadModel["threads"][number]["latestTurn"],
        }),
      ],
    ]) {
      // Archive is the cancel-everything escape hatch: the reactor settles
      // in-flight turns when the archived events land, so the decider emits
      // the cascade instead of rejecting it.
      const events = await Effect.runPromise(
        decideOrchestrationCommand({
          command: archiveCommand("thread.archive", "cmd-running-archive", PARENT_THREAD_ID),
          readModel: makeReadModel(threads),
        }),
      );
      expect(eventThreadIds(events)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);
    }
  });

  it("rejects archive cascades that cross custom, pinned, or default ownership boundaries", async () => {
    const customA = SidebarSectionId.makeUnsafe("section-custom-a");
    const customB = SidebarSectionId.makeUnsafe("section-custom-b");
    const cases = [
      {
        name: "custom-to-other-custom",
        threads: [
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
        ],
        sections: [
          makeSection({ id: customA, itemThreadIds: [PARENT_THREAD_ID] }),
          makeSection({ id: customB, itemThreadIds: [CHILD_THREAD_ID] }),
        ],
      },
      {
        name: "custom-to-pinned",
        threads: [
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID, isPinned: true }),
        ],
        sections: [makeSection({ id: customA, itemThreadIds: [PARENT_THREAD_ID] })],
      },
    ];
    for (const testCase of cases) {
      const outcome = await Effect.runPromiseExit(
        decideOrchestrationCommand({
          command: archiveCommand("thread.archive", `cmd-${testCase.name}`, PARENT_THREAD_ID),
          readModel: makeReadModel(testCase.threads, testCase.sections),
        }),
      );
      expect(outcome._tag, testCase.name).toBe("Failure");
    }

    const inherited = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-custom-inherited", PARENT_THREAD_ID),
        readModel: makeReadModel(
          [
            makeThread({ id: PARENT_THREAD_ID }),
            makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
          ],
          [makeSection({ id: customA, itemThreadIds: [PARENT_THREAD_ID] })],
        ),
      }),
    );
    expect(eventThreadIds(inherited)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);

    const defaultToCustom = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-default-custom", PARENT_THREAD_ID),
        readModel: makeReadModel(
          [
            makeThread({ id: PARENT_THREAD_ID }),
            makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
          ],
          [makeSection({ id: customA, itemThreadIds: [CHILD_THREAD_ID] })],
        ),
      }),
    );
    expect(defaultToCustom._tag).toBe("Failure");

    const defaultToPinned = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-default-pinned", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID, isPinned: true }),
        ]),
      }),
    );
    expect(defaultToPinned._tag).toBe("Failure");
  });

  it("keeps a pinned or default root boundary for inheriting descendants", async () => {
    const pinnedResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-pinned-root", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID, isPinned: true }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
        ]),
      }),
    );
    expect(eventThreadIds(pinnedResult)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);

    const independentlyPinned = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-pinned-boundary", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID, isPinned: true }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID, isPinned: true }),
        ]),
      }),
    );
    expect(independentlyPinned._tag).toBe("Failure");

    const defaultResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-default-root", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
        ]),
      }),
    );
    expect(eventThreadIds(defaultResult)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);
  });

  it("fails closed for cycles and active descendants below archived ancestors", async () => {
    const cycleId = ThreadId.makeUnsafe("thread-cycle-root");
    const cycleChildId = ThreadId.makeUnsafe("thread-cycle-child");
    const cycleOutcome = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-cycle", cycleId),
        readModel: makeReadModel(
          [
            makeThread({ id: cycleId, parentThreadId: cycleChildId }),
            makeThread({ id: cycleChildId, parentThreadId: cycleId }),
          ],
          [
            makeSection({
              id: SidebarSectionId.makeUnsafe("section-cycle"),
              itemThreadIds: [cycleId],
            }),
          ],
        ),
      }),
    );
    expect(cycleOutcome._tag).toBe("Failure");

    const archivedAncestorId = ThreadId.makeUnsafe("thread-archived-ancestor");
    const grandchildId = ThreadId.makeUnsafe("thread-active-grandchild");
    const archivedAncestorOutcome = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-archived-ancestor", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: archivedAncestorId, parentThreadId: PARENT_THREAD_ID, archivedAt: NOW }),
          makeThread({ id: grandchildId, parentThreadId: archivedAncestorId }),
        ]),
      }),
    );
    expect(archivedAncestorOutcome._tag).toBe("Failure");
  });

  it("uses one archive command id as the cohort and restores only exact-cohort descendants", async () => {
    const archiveCommandId = CommandId.makeUnsafe("cmd-cohort-archive");
    const archiveResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", archiveCommandId, PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({ id: PARENT_THREAD_ID }),
          makeThread({ id: CHILD_THREAD_ID, parentThreadId: PARENT_THREAD_ID }),
          makeThread({ id: GRANDCHILD_THREAD_ID, parentThreadId: CHILD_THREAD_ID }),
        ]),
      }),
    );
    const archiveEvents = (Array.isArray(archiveResult) ? archiveResult : [archiveResult]) as Array<
      Omit<OrchestrationEvent, "sequence">
    >;
    expect(new Set(archiveEvents.map((event) => event.commandId))).toEqual(
      new Set([archiveCommandId]),
    );
    expect(eventThreadIds(archiveResult)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_THREAD_ID,
      PARENT_THREAD_ID,
    ]);

    const unarchiveResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-cohort-undo", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({
            id: PARENT_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: archiveCommandId,
          }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: archiveCommandId,
          }),
          makeThread({
            id: GRANDCHILD_THREAD_ID,
            parentThreadId: CHILD_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: CommandId.makeUnsafe("cmd-independent-child"),
          }),
        ]),
      }),
    );
    expect(eventThreadIds(unarchiveResult)).toEqual([CHILD_THREAD_ID, PARENT_THREAD_ID]);
    const unarchiveEvents = (
      Array.isArray(unarchiveResult) ? unarchiveResult : [unarchiveResult]
    ) as Array<Extract<OrchestrationEvent, { type: "thread.unarchived" }>>;
    expect(
      unarchiveEvents.slice(0, -1).every((event) => event.payload.isArchiveCohortFinal === false),
    ).toBe(true);
    expect(unarchiveEvents.at(-1)?.payload.isArchiveCohortFinal).toBe(true);

    const fullCohortResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-full-cohort-undo", PARENT_THREAD_ID),
        readModel: makeReadModel([
          makeThread({
            id: PARENT_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: archiveCommandId,
          }),
          makeThread({
            id: CHILD_THREAD_ID,
            parentThreadId: PARENT_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: archiveCommandId,
          }),
          makeThread({
            id: GRANDCHILD_THREAD_ID,
            parentThreadId: CHILD_THREAD_ID,
            archivedAt: NOW,
            archivedByCommandId: archiveCommandId,
          }),
        ]),
      }),
    );
    const fullCohortEvents = (
      Array.isArray(fullCohortResult) ? fullCohortResult : [fullCohortResult]
    ) as Array<Extract<OrchestrationEvent, { type: "thread.unarchived" }>>;
    expect(eventThreadIds(fullCohortResult)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_THREAD_ID,
      PARENT_THREAD_ID,
    ]);
    expect(fullCohortEvents.map((event) => event.payload.isArchiveCohortFinal)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("restores exact section incarnation and preserves non-contiguous cohort order", async () => {
    const sectionId = SidebarSectionId.makeUnsafe("section-restore-order");
    const section = makeSection({
      id: sectionId,
      itemThreadIds: [
        ThreadId.makeUnsafe("thread-before"),
        PARENT_THREAD_ID,
        ThreadId.makeUnsafe("thread-between"),
        CHILD_THREAD_ID,
      ],
    });
    const archivedByCommandId = CommandId.makeUnsafe("cmd-order-archive");
    const readModel = makeReadModel(
      [
        makeThread({
          id: PARENT_THREAD_ID,
          archivedAt: NOW,
          archivedByCommandId: archivedByCommandId,
          archivedSidebarSectionId: sectionId,
          archivedSidebarSectionCreatedAt: NOW,
          archivedSidebarSortOrder: 1,
        }),
        makeThread({
          id: CHILD_THREAD_ID,
          parentThreadId: PARENT_THREAD_ID,
          archivedAt: NOW,
          archivedByCommandId: archivedByCommandId,
          archivedSidebarSectionId: sectionId,
          archivedSidebarSectionCreatedAt: NOW,
          archivedSidebarSortOrder: 3,
        }),
      ],
      [
        {
          ...section,
          items: section.items.filter(
            (item) =>
              item.key !== `thread:${PARENT_THREAD_ID}` && item.key !== `thread:${CHILD_THREAD_ID}`,
          ),
        },
      ],
    );
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-order-undo", PARENT_THREAD_ID),
        readModel,
      }),
    );
    const events = (Array.isArray(result) ? result : [result]) as Array<
      Extract<OrchestrationEvent, { type: "thread.unarchived" }>
    >;
    expect(events.map((event) => event.payload.threadId)).toEqual([
      CHILD_THREAD_ID,
      PARENT_THREAD_ID,
    ]);
    expect(events.at(-1)?.payload.restoredSidebarPlacements).toEqual([
      {
        threadId: PARENT_THREAD_ID,
        placement: { destination: "custom", sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
      },
      {
        threadId: CHILD_THREAD_ID,
        placement: { destination: "custom", sectionId, sectionCreatedAt: NOW, sortOrder: 3 },
      },
    ]);

    const recreatedSectionResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-order-recreated", PARENT_THREAD_ID),
        readModel: makeReadModel(readModel.threads, [
          {
            ...readModel.sidebarSections![0]!,
            createdAt: "2026-08-31T01:00:00.000Z",
            updatedAt: "2026-08-31T01:00:00.000Z",
          },
        ]),
      }),
    );
    const recreatedEvents = (
      Array.isArray(recreatedSectionResult) ? recreatedSectionResult : [recreatedSectionResult]
    ) as Array<Extract<OrchestrationEvent, { type: "thread.unarchived" }>>;
    expect(recreatedEvents.at(-1)?.payload.restoredSidebarPlacement).toEqual({
      destination: "default",
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder: 0,
    });
    expect(recreatedEvents.at(-1)?.payload.restoredSidebarPlacements).toEqual([
      {
        threadId: PARENT_THREAD_ID,
        placement: {
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 0,
        },
      },
    ]);
  });

  it("carries a child placement when the commanded root inherits its ancestor's custom owner", async () => {
    const ancestorId = ThreadId.makeUnsafe("thread-custom-ancestor");
    const commandedRootId = ThreadId.makeUnsafe("thread-inherited-root");
    const childId = ThreadId.makeUnsafe("thread-explicit-child");
    const sectionId = SidebarSectionId.makeUnsafe("section-inherited-root");
    const archiveResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.archive", "cmd-inherited-root-archive", commandedRootId),
        readModel: makeReadModel(
          [
            makeThread({ id: ancestorId }),
            makeThread({ id: commandedRootId, parentThreadId: ancestorId }),
            makeThread({ id: childId, parentThreadId: commandedRootId }),
          ],
          [makeSection({ id: sectionId, itemThreadIds: [ancestorId, childId] })],
        ),
      }),
    );
    const archiveEvents = (Array.isArray(archiveResult) ? archiveResult : [archiveResult]) as Array<
      Omit<OrchestrationEvent, "sequence">
    >;
    expect(archiveEvents.map((event) => event.payload)).toEqual([
      {
        threadId: childId,
        archivedAt: expect.any(String),
        updatedAt: expect.any(String),
        sidebarOrderRevision: 1,
        placement: { destination: "custom", sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
      },
      {
        threadId: commandedRootId,
        archivedAt: expect.any(String),
        updatedAt: expect.any(String),
        sidebarOrderRevision: 1,
      },
    ]);

    const unarchiveResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-inherited-root-undo", commandedRootId),
        readModel: makeReadModel(
          [
            makeThread({ id: ancestorId }),
            makeThread({
              id: commandedRootId,
              parentThreadId: ancestorId,
              archivedAt: NOW,
              archivedByCommandId: CommandId.makeUnsafe("cmd-inherited-root-archive"),
            }),
            makeThread({
              id: childId,
              parentThreadId: commandedRootId,
              archivedAt: NOW,
              archivedByCommandId: CommandId.makeUnsafe("cmd-inherited-root-archive"),
              archivedSidebarSectionId: sectionId,
              archivedSidebarSectionCreatedAt: NOW,
              archivedSidebarSortOrder: 1,
            }),
          ],
          [makeSection({ id: sectionId, itemThreadIds: [ancestorId] })],
        ),
      }),
    );
    const unarchiveEvents = (
      Array.isArray(unarchiveResult) ? unarchiveResult : [unarchiveResult]
    ) as Array<Extract<OrchestrationEvent, { type: "thread.unarchived" }>>;
    expect(unarchiveEvents.at(-1)?.payload.restoredSidebarPlacement).toEqual({
      destination: "default",
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder: 0,
    });
    expect(unarchiveEvents.at(-1)?.payload.restoredSidebarPlacements).toEqual([
      {
        threadId: childId,
        placement: { destination: "custom", sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
      },
      {
        threadId: commandedRootId,
        placement: {
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 0,
        },
      },
    ]);
  });

  it("rejects an over-capacity custom restore before emitting any event", async () => {
    const sectionId = SidebarSectionId.makeUnsafe("section-restore-capacity");
    const otherIds = Array.from({ length: SIDEBAR_SECTION_ITEMS_MAX_COUNT }, (_, index) =>
      ThreadId.makeUnsafe(`thread-capacity-${index}`),
    );
    const outcome = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: archiveCommand("thread.unarchive", "cmd-capacity-undo", PARENT_THREAD_ID),
        readModel: makeReadModel(
          [
            makeThread({
              id: PARENT_THREAD_ID,
              archivedAt: NOW,
              archivedByCommandId: CommandId.makeUnsafe("cmd-capacity-archive"),
              archivedSidebarSectionId: sectionId,
              archivedSidebarSectionCreatedAt: NOW,
              archivedSidebarSortOrder: 0,
            }),
            ...otherIds.map((id) => makeThread({ id })),
          ],
          [makeSection({ id: sectionId, itemThreadIds: otherIds })],
        ),
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
