import {
  CommandId,
  EventId,
  ProjectId,
  SidebarOrderRevision,
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
  type OrchestrationSidebarOrderItem,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { rehomeSidebarSectionItems } from "./sidebarOrder.ts";

const NOW = "2026-08-31T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-projector-section");
const SECTION_ID = SidebarSectionId.makeUnsafe("section-projector");

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  payload: unknown;
  commandId?: CommandId;
  occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-projector-section-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "sidebar-section"
        ? SECTION_ID
        : input.aggregateKind === "project"
          ? ProjectId.makeUnsafe(input.aggregateId)
          : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt ?? NOW,
    commandId:
      input.commandId ?? CommandId.makeUnsafe(`command-projector-section-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

async function apply(model: ReturnType<typeof createEmptyReadModel>, event: OrchestrationEvent) {
  return Effect.runPromise(projectEvent(model, event));
}

describe("sidebar section in-memory projector", () => {
  it("replays one durable revision across section and archive order events", async () => {
    let model = createEmptyReadModel(NOW);

    model = await apply(
      model,
      makeEvent({
        sequence: 1,
        type: "sidebar-section.created",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          name: "Revision section",
          sortOrder: 0,
          isCollapsed: false,
          sidebarOrderRevision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    expect(model.sidebarOrderRevision).toBe(1);

    model = await apply(
      model,
      makeEvent({
        sequence: 2,
        type: "thread.archived",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          threadId: THREAD_ID,
          archivedAt: NOW,
          sidebarOrderRevision: 2,
        },
      }),
    );
    expect(model.sidebarOrderRevision).toBe(2);

    model = await apply(
      model,
      makeEvent({
        sequence: 3,
        type: "thread.unarchived",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          threadId: THREAD_ID,
          updatedAt: NOW,
          sidebarOrderRevision: 3,
        },
      }),
    );
    expect(model.sidebarOrderRevision).toBe(3);

    model = await apply(
      model,
      makeEvent({
        sequence: 4,
        type: "sidebar-section.deleted",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          sidebarOrderRevision: 4,
          deletedAt: NOW,
        },
      }),
    );
    expect(model.sidebarOrderRevision).toBe(4);
  });

  it("keeps custom placement exclusive with pinning and archive cleanup", async () => {
    let model = createEmptyReadModel(NOW);
    model = await apply(
      model,
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          threadId: THREAD_ID,
          projectId: ProjectId.makeUnsafe("project-projector-section"),
          title: "Projector section thread",
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    model = await apply(
      model,
      makeEvent({
        sequence: 2,
        type: "sidebar-section.created",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          name: "Projector section",
          sortOrder: 0,
          isCollapsed: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    model = await apply(
      model,
      makeEvent({
        sequence: 3,
        type: "sidebar-section.thread-placed",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          threadId: THREAD_ID,
          destination: "custom",
          updatedAt: NOW,
        },
      }),
    );
    expect(model.sidebarSections).toHaveLength(1);
    expect(model.sidebarSections?.[0]?.items.map((item) => item.key)).toEqual([
      `thread:${THREAD_ID}`,
    ]);
    expect(model.threads[0]?.isPinned).toBe(false);

    model = await apply(
      model,
      makeEvent({
        sequence: 4,
        type: "sidebar-section.thread-placed",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          sectionId: null,
          threadId: THREAD_ID,
          destination: "pinned",
          updatedAt: NOW,
        },
      }),
    );
    expect(model.sidebarSections?.[0]?.items).toEqual([]);
    expect(model.threads[0]?.isPinned).toBe(true);

    model = await apply(
      model,
      makeEvent({
        sequence: 5,
        type: "sidebar-section.thread-placed",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          threadId: THREAD_ID,
          destination: "custom",
          updatedAt: NOW,
        },
      }),
    );
    model = await apply(
      model,
      makeEvent({
        sequence: 6,
        type: "thread.archived",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: { threadId: THREAD_ID, archivedAt: NOW },
      }),
    );
    expect(model.sidebarSections?.[0]?.items).toEqual([]);
  });

  it("replays a full delete payload into the default mixed suffix", async () => {
    const firstId = ThreadId.makeUnsafe("thread-delete-full-first");
    const secondId = ThreadId.makeUnsafe("thread-delete-full-second");
    let model = createEmptyReadModel(NOW);
    for (const [sequence, threadId] of [
      [1, firstId],
      [2, secondId],
    ] as const) {
      model = await apply(
        model,
        makeEvent({
          sequence,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId: ProjectId.makeUnsafe("project-delete-full"),
            title: String(threadId),
            modelSelection: { instanceId: "codex", model: "gpt-5.5" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      );
    }
    model = {
      ...model,
      threads: model.threads.map((thread) => ({ ...thread, isPinned: true })),
    };
    model = await apply(
      model,
      makeEvent({
        sequence: 3,
        type: "sidebar-section.created",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          name: "Delete full",
          sortOrder: 0,
          isCollapsed: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    for (const [sequence, threadId] of [
      [4, firstId],
      [5, secondId],
    ] as const) {
      model = await apply(
        model,
        makeEvent({
          sequence,
          type: "sidebar-section.thread-placed",
          aggregateKind: "sidebar-section",
          aggregateId: SECTION_ID,
          payload: {
            sectionId: SECTION_ID,
            threadId,
            destination: "custom",
            sectionCreatedAt: NOW,
            updatedAt: NOW,
          },
        }),
      );
    }
    const rehomed = rehomeSidebarSectionItems(model.sidebarOrderItems ?? [], {
      sectionId: SECTION_ID,
      sectionCreatedAt: NOW,
      now: NOW,
    });
    model = await apply(
      model,
      makeEvent({
        sequence: 6,
        type: "sidebar-section.deleted",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          sectionCreatedAt: NOW,
          sidebarOrderRevision: 6,
          sidebarOrderItems: rehomed.items,
          deletedAt: NOW,
        },
      }),
    );
    expect(model.sidebarSections).toEqual([]);
    expect(model.threads.every((thread) => thread.isPinned === false)).toBe(true);
    expect(model.sidebarOrderItems?.filter((item) => item.destination === "custom")).toEqual([]);
    expect(
      model.sidebarOrderItems
        ?.filter((item) => item.destination === "default")
        .map((item) => item.key),
    ).toEqual([`thread:${firstId}`, `thread:${secondId}`]);
  });

  it("replays a historical delete by rehoming mixed rows instead of dropping them", async () => {
    const projectId = ProjectId.makeUnsafe("project-delete-history");
    const firstId = ThreadId.makeUnsafe("thread-delete-history-first");
    const secondId = ThreadId.makeUnsafe("thread-delete-history-second");
    let model = createEmptyReadModel(NOW);
    model = await apply(
      model,
      makeEvent({
        sequence: 1,
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        payload: {
          projectId,
          title: "Historical delete project",
          workspaceRoot: "/tmp/historical-delete-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    for (const [sequence, threadId] of [
      [2, firstId],
      [3, secondId],
    ] as const) {
      model = await apply(
        model,
        makeEvent({
          sequence,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId,
            title: `Historical delete ${threadId}`,
            modelSelection: { instanceId: "codex", model: "gpt-5.5" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      );
    }
    model = await apply(
      model,
      makeEvent({
        sequence: 4,
        type: "sidebar-section.created",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          name: "Historical delete",
          sortOrder: 0,
          isCollapsed: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    const mixedItems: OrchestrationSidebarOrderItem[] = [
      {
        key: `thread:${firstId}` as OrchestrationSidebarOrderItem["key"],
        itemType: "thread",
        destination: "custom",
        sectionId: SECTION_ID,
        sectionCreatedAt: NOW,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        key: `project:${projectId}` as OrchestrationSidebarOrderItem["key"],
        itemType: "project",
        destination: "custom",
        sectionId: SECTION_ID,
        sectionCreatedAt: NOW,
        sortOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        key: `thread:${secondId}` as OrchestrationSidebarOrderItem["key"],
        itemType: "thread",
        destination: "custom",
        sectionId: SECTION_ID,
        sectionCreatedAt: NOW,
        sortOrder: 2,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const section = model.sidebarSections?.[0];
    if (section === undefined) throw new Error("Expected historical delete section.");
    model = {
      ...model,
      projects: model.projects.map((project) => ({ ...project, isPinned: true })),
      threads: model.threads.map((thread) => ({ ...thread, isPinned: true })),
      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(3),
      sidebarOrderItems: mixedItems,
      sidebarSections: [
        {
          ...section,
          items: mixedItems.map((item) => ({
            sectionId: SECTION_ID,
            key: SidebarSectionItemKey.makeUnsafe(item.key),
            itemType: item.itemType,
            sortOrder: item.sortOrder,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        },
      ],
    };

    model = await apply(
      model,
      makeEvent({
        sequence: 5,
        type: "sidebar-section.deleted",
        aggregateKind: "sidebar-section",
        aggregateId: SECTION_ID,
        payload: {
          sectionId: SECTION_ID,
          sidebarOrderRevision: 4,
          deletedAt: NOW,
        },
      }),
    );
    expect(model.sidebarSections).toEqual([]);
    expect(model.sidebarOrderItems?.filter((item) => item.destination === "custom")).toEqual([]);
    expect(
      model.sidebarOrderItems
        ?.filter((item) => item.destination === "default")
        .map((item) => item.key),
    ).toEqual([`thread:${firstId}`, `project:${projectId}`, `thread:${secondId}`]);
    expect(model.projects.find((project) => project.id === projectId)?.isPinned).toBe(false);
    expect(model.threads.every((thread) => thread.isPinned === false)).toBe(true);
  });

  it("restores a descendants-first archive cohort in saved order and clears provenance only at root-last", async () => {
    const projectId = ProjectId.makeUnsafe("project-projector-archive-cohort");
    const beforeId = ThreadId.makeUnsafe("thread-projector-before");
    const rootId = ThreadId.makeUnsafe("thread-projector-root");
    const betweenId = ThreadId.makeUnsafe("thread-projector-between");
    const childId = ThreadId.makeUnsafe("thread-projector-child");
    const appendedId = ThreadId.makeUnsafe("thread-projector-appended");
    const sectionId = SidebarSectionId.makeUnsafe("section-projector-archive-cohort");
    const archiveCommandId = CommandId.makeUnsafe("command-projector-archive-cohort");
    const undoAt = "2026-08-31T00:00:02.000Z";

    const createThread = async (sequence: number, threadId: ThreadId, parentThreadId?: ThreadId) =>
      apply(
        model,
        makeEvent({
          sequence,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            projectId,
            title: `Projector ${threadId}`,
            modelSelection: { instanceId: "codex", model: "gpt-5.5" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            updatedAt: NOW,
            ...(parentThreadId === undefined ? {} : { parentThreadId }),
          },
        }),
      );

    let model = createEmptyReadModel(NOW);
    model = await createThread(1, beforeId);
    model = await createThread(2, rootId);
    model = await createThread(3, betweenId);
    model = await createThread(4, childId, rootId);
    model = await createThread(5, appendedId);
    model = await apply(
      model,
      makeEvent({
        sequence: 6,
        type: "sidebar-section.created",
        aggregateKind: "sidebar-section",
        aggregateId: sectionId,
        payload: {
          sectionId,
          name: "Archive cohort",
          sortOrder: 0,
          isCollapsed: false,
          updatedAt: NOW,
          createdAt: NOW,
        },
      }),
    );
    for (const [sequence, threadId] of [
      [7, beforeId],
      [8, rootId],
      [9, betweenId],
      [10, childId],
    ] as const) {
      model = await apply(
        model,
        makeEvent({
          sequence,
          type: "sidebar-section.thread-placed",
          aggregateKind: "sidebar-section",
          aggregateId: sectionId,
          payload: {
            sectionId,
            threadId,
            destination: "custom",
            updatedAt: NOW,
          },
        }),
      );
    }
    model = await apply(
      model,
      makeEvent({
        sequence: 11,
        type: "thread.archived",
        aggregateKind: "thread",
        aggregateId: childId,
        commandId: archiveCommandId,
        payload: {
          threadId: childId,
          archivedAt: NOW,
          updatedAt: NOW,
          placement: { sectionId, sectionCreatedAt: NOW, sortOrder: 3 },
        },
      }),
    );
    model = await apply(
      model,
      makeEvent({
        sequence: 12,
        type: "thread.archived",
        aggregateKind: "thread",
        aggregateId: rootId,
        commandId: archiveCommandId,
        payload: {
          threadId: rootId,
          archivedAt: NOW,
          updatedAt: NOW,
          placement: { sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
        },
      }),
    );
    expect(model.sidebarSections?.[0]?.items.map((item) => [item.key, item.sortOrder])).toEqual([
      [`thread:${beforeId}`, 0],
      [`thread:${betweenId}`, 2],
    ]);

    model = await apply(
      model,
      makeEvent({
        sequence: 13,
        type: "sidebar-section.thread-placed",
        aggregateKind: "sidebar-section",
        aggregateId: sectionId,
        payload: {
          sectionId: null,
          threadId: betweenId,
          destination: "pinned",
          updatedAt: NOW,
        },
      }),
    );
    model = await apply(
      model,
      makeEvent({
        sequence: 14,
        type: "sidebar-section.thread-placed",
        aggregateKind: "sidebar-section",
        aggregateId: sectionId,
        payload: {
          sectionId,
          threadId: appendedId,
          destination: "custom",
          updatedAt: NOW,
        },
      }),
    );

    model = await apply(
      model,
      makeEvent({
        sequence: 15,
        type: "thread.unarchived",
        aggregateKind: "thread",
        aggregateId: childId,
        commandId: CommandId.makeUnsafe("command-projector-undo-cohort"),
        payload: {
          threadId: childId,
          updatedAt: undoAt,
          restoredSidebarPlacement: { sectionId, sectionCreatedAt: NOW, sortOrder: 3 },
          isArchiveCohortFinal: false,
          restoredSidebarPlacements: [],
        },
      }),
    );
    expect(model.sidebarSections?.[0]?.items.map((item) => item.key)).toEqual([
      `thread:${beforeId}`,
      `thread:${appendedId}`,
    ]);
    expect(model.threads.find((thread) => thread.id === childId)?.archivedAt).toBeNull();
    expect(model.threads.find((thread) => thread.id === childId)?.archivedByCommandId).toBe(
      archiveCommandId,
    );
    expect(model.threads.find((thread) => thread.id === rootId)?.archivedAt).toBe(NOW);

    model = await apply(
      model,
      makeEvent({
        sequence: 16,
        type: "thread.unarchived",
        aggregateKind: "thread",
        aggregateId: rootId,
        commandId: CommandId.makeUnsafe("command-projector-undo-cohort"),
        payload: {
          threadId: rootId,
          updatedAt: undoAt,
          restoredSidebarPlacement: { sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
          isArchiveCohortFinal: true,
          restoredSidebarPlacements: [
            {
              threadId: rootId,
              placement: { sectionId, sectionCreatedAt: NOW, sortOrder: 1 },
            },
            {
              threadId: childId,
              placement: { sectionId, sectionCreatedAt: NOW, sortOrder: 3 },
            },
          ],
        },
      }),
    );
    expect(model.sidebarSections?.[0]?.items.map((item) => [item.key, item.sortOrder])).toEqual([
      [`thread:${beforeId}`, 0],
      [`thread:${rootId}`, 1],
      [`thread:${appendedId}`, 2],
      [`thread:${childId}`, 3],
    ]);
    for (const threadId of [rootId, childId]) {
      const thread = model.threads.find((entry) => entry.id === threadId);
      expect(thread?.archivedAt).toBeNull();
      expect(thread?.archivedByCommandId).toBeNull();
      expect(thread?.archivedSidebarSectionId).toBeNull();
      expect(thread?.archivedSidebarSortOrder).toBeNull();
    }
  });
});
