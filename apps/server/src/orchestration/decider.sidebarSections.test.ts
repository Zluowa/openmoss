import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  SidebarOrderRevision,
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSidebarOrderItem,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-08-31T00:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-sidebar-sections");
const REVISION = SidebarOrderRevision.makeUnsafe(0);

function makeThread(input: {
  id: string;
  isPinned?: boolean;
  archivedAt?: string | null;
  deletedAt?: string | null;
}): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: PROJECT_ID,
    title: input.id,
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
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
    archivedAt: input.archivedAt ?? null,
    isPinned: input.isPinned ?? false,
  };
}

function makeSection(
  id: string,
  items: ReadonlyArray<{ threadId: string; sortOrder: number }> = [],
): NonNullable<OrchestrationReadModel["sidebarSections"]>[number] {
  return {
    id: SidebarSectionId.makeUnsafe(id),
    name: id,
    sortOrder: 0,
    isCollapsed: false,
    items: items.map((item) => ({
      key: SidebarSectionItemKey.makeUnsafe(`thread:${item.threadId}`),
      itemType: "thread" as const,
      sortOrder: item.sortOrder,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function makeReadModel(
  threads: OrchestrationReadModel["threads"],
  sidebarSections: NonNullable<OrchestrationReadModel["sidebarSections"]> = [],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [],
    threads,
    sidebarSections,
    updatedAt: NOW,
  };
}

describe("sidebar section decider", () => {
  it("creates and places the initial thread as one atomic event batch", async () => {
    const threadId = ThreadId.makeUnsafe("thread-section-create");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "sidebar-section.create",
          commandId: CommandId.makeUnsafe("cmd-section-create"),
          sectionId: SidebarSectionId.makeUnsafe("section-created"),
          name: "Created section",
          initialThreadId: threadId,
          expectedSidebarOrderRevision: REVISION,
          createdAt: NOW,
        },
        readModel: makeReadModel([makeThread({ id: threadId })]),
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(
      (result as unknown as Array<{ type: string; aggregateKind: string }>).map((event) => [
        event.type,
        event.aggregateKind,
      ]),
    ).toEqual([
      ["sidebar-section.created", "sidebar-section"],
      ["sidebar-section.thread-placed", "sidebar-section"],
    ]);
    expect(
      (result as unknown as Array<{ payload: { initialThreadId?: ThreadId } }>)[0]?.payload
        .initialThreadId,
    ).toBeUndefined();
  });

  it("creates an empty section without any thread anchor", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "sidebar-section.create",
          commandId: CommandId.makeUnsafe("cmd-section-empty-create"),
          sectionId: SidebarSectionId.makeUnsafe("section-empty-created"),
          name: "Empty section",
          expectedSidebarOrderRevision: REVISION,
          createdAt: NOW,
        },
        readModel: makeReadModel([]),
      }),
    );

    expect(result).toMatchObject({
      type: "sidebar-section.created",
      aggregateKind: "sidebar-section",
      aggregateId: "section-empty-created",
    });
  });

  it("moves an already-sectioned thread into the new section exactly once", async () => {
    const threadId = ThreadId.makeUnsafe("thread-section-move");
    const sourceSectionId = SidebarSectionId.makeUnsafe("section-source");
    const targetSectionId = SidebarSectionId.makeUnsafe("section-target");
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "sidebar-section.create",
          commandId: CommandId.makeUnsafe("cmd-section-move-create"),
          sectionId: targetSectionId,
          name: "Target section",
          initialThreadId: threadId,
          expectedSidebarOrderRevision: REVISION,
          createdAt: NOW,
        },
        readModel: makeReadModel(
          [makeThread({ id: threadId })],
          [makeSection(sourceSectionId, [{ threadId, sortOrder: 0 }])],
        ),
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = result as Array<Omit<OrchestrationEvent, "sequence">>;
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("sidebar-section.created");
    expect(events[1]?.type).toBe("sidebar-section.thread-placed");
    expect((events[0]?.payload as { initialThreadId?: ThreadId }).initialThreadId).toBeUndefined();

    let projected = makeReadModel(
      [makeThread({ id: threadId })],
      [makeSection(sourceSectionId, [{ threadId, sortOrder: 0 }])],
    );
    for (const [index, event] of events.entries()) {
      projected = await Effect.runPromise(
        projectEvent(projected, {
          ...event,
          sequence: index + 1,
          eventId: event.eventId ?? EventId.makeUnsafe(`event-section-move-${index + 1}`),
        } as OrchestrationEvent),
      );
    }
    expect(
      projected.sidebarSections?.filter((section) =>
        section.items.some((item) => item.key === `thread:${threadId}`),
      ),
    ).toHaveLength(1);
    expect(
      projected.sidebarSections?.find((section) => section.id === sourceSectionId)?.items,
    ).toEqual([]);
    expect(
      projected.sidebarSections
        ?.find((section) => section.id === targetSectionId)
        ?.items.map((item) => item.key),
    ).toEqual([`thread:${threadId}`]);
  });

  it("keeps section-only commands manageable with no threads", async () => {
    const sectionId = SidebarSectionId.makeUnsafe("section-empty-manage");
    const readModel = makeReadModel([], [makeSection("section-empty-manage")]);
    const commands = [
      {
        type: "sidebar-section.rename" as const,
        commandId: CommandId.makeUnsafe("cmd-empty-rename"),
        sectionId,
        expectedSidebarOrderRevision: REVISION,
        name: "Renamed empty section",
      },
      {
        type: "sidebar-section.collapse" as const,
        commandId: CommandId.makeUnsafe("cmd-empty-collapse"),
        sectionId,
        expectedSidebarOrderRevision: REVISION,
        isCollapsed: true,
      },
      {
        type: "sidebar-section.delete" as const,
        commandId: CommandId.makeUnsafe("cmd-empty-delete"),
        sectionId,
        expectedSidebarOrderRevision: REVISION,
      },
      {
        type: "sidebar-section.reorder" as const,
        commandId: CommandId.makeUnsafe("cmd-empty-reorder"),
        sectionId,
        orderedSectionIds: [sectionId],
        expectedSidebarOrderRevision: REVISION,
      },
    ];

    for (const command of commands) {
      await expect(
        Effect.runPromise(decideOrchestrationCommand({ command, readModel })),
      ).resolves.toBeDefined();
    }
  });

  it("deletes a section by rehoming its mixed rows and clearing pin compatibility", async () => {
    const sectionId = SidebarSectionId.makeUnsafe("section-delete-rehome");
    const first = ThreadId.makeUnsafe("thread-delete-first");
    const second = ThreadId.makeUnsafe("thread-delete-second");
    const defaultThread = ThreadId.makeUnsafe("thread-delete-default");
    const readModel = makeReadModel(
      [
        makeThread({ id: first, isPinned: true }),
        makeThread({ id: second, isPinned: true }),
        makeThread({ id: defaultThread }),
      ],
      [
        makeSection(sectionId, [
          { threadId: first, sortOrder: 0 },
          { threadId: second, sortOrder: 1 },
        ]),
      ],
    );
    const decision = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "sidebar-section.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-rehome"),
          sectionId,
          expectedSidebarOrderRevision: REVISION,
        },
        readModel,
      }),
    );
    expect(decision).toMatchObject({
      type: "sidebar-section.deleted",
      payload: {
        sectionId,
        sectionCreatedAt: NOW,
        sidebarOrderItems: expect.any(Array),
      },
    });
    const event = decision as Omit<OrchestrationEvent, "sequence">;
    const projected = await Effect.runPromise(
      projectEvent(readModel, {
        ...event,
        sequence: 2,
        eventId: EventId.makeUnsafe("event-delete-rehome"),
      } as OrchestrationEvent),
    );
    expect(projected.sidebarSections).toEqual([]);
    expect(
      projected.sidebarOrderItems
        ?.filter((item) => item.destination === "default")
        .toSorted((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => item.key),
    ).toEqual([`thread:${defaultThread}`, `thread:${first}`, `thread:${second}`]);
    expect(projected.threads.filter((thread) => thread.isPinned)).toEqual([]);
  });

  it("acknowledges an already-current custom placement without appending a no-op", async () => {
    const threadId = ThreadId.makeUnsafe("thread-section-noop");
    const sectionId = SidebarSectionId.makeUnsafe("section-noop");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "sidebar-section.thread.place",
            commandId: CommandId.makeUnsafe("cmd-section-noop"),
            threadId,
            sectionId,
            destination: "custom",
            beforeThreadId: null,
            sectionCreatedAt: NOW,
            expectedSidebarOrderRevision: REVISION,
          },
          readModel: makeReadModel(
            [makeThread({ id: threadId })],
            [makeSection("section-noop", [{ threadId: threadId, sortOrder: 0 }])],
          ),
        }),
      ),
    ).resolves.toMatchObject({ _tag: "SidebarOrderNoopDecision", sidebarOrderRevision: 0 });
  });

  it("keeps project slots fixed for a thread.place in a mixed custom section", async () => {
    const sectionId = SidebarSectionId.makeUnsafe("section-thread-place-mixed");
    const first = ThreadId.makeUnsafe("thread-place-first");
    const second = ThreadId.makeUnsafe("thread-place-second");
    const projectKey = "project:project-place-mixed" as OrchestrationSidebarOrderItem["key"];
    const readModel = {
      ...makeReadModel(
        [makeThread({ id: first }), makeThread({ id: second })],
        [
          makeSection("section-thread-place-mixed", [
            { threadId: first, sortOrder: 0 },
            { threadId: second, sortOrder: 2 },
          ]),
        ],
      ),
      sidebarOrderRevision: REVISION,
      sidebarOrderItems: [
        {
          key: `thread:${first}` as OrchestrationSidebarOrderItem["key"],
          itemType: "thread" as const,
          destination: "custom" as const,
          sectionId,
          sectionCreatedAt: NOW,
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          key: projectKey,
          itemType: "project" as const,
          destination: "custom" as const,
          sectionId,
          sectionCreatedAt: NOW,
          sortOrder: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          key: `thread:${second}` as OrchestrationSidebarOrderItem["key"],
          itemType: "thread" as const,
          destination: "custom" as const,
          sectionId,
          sectionCreatedAt: NOW,
          sortOrder: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    } satisfies OrchestrationReadModel;
    const decision = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "sidebar-section.thread.place",
          commandId: CommandId.makeUnsafe("cmd-thread-place-mixed"),
          threadId: second,
          sectionId,
          destination: "custom",
          beforeThreadId: first,
          sectionCreatedAt: NOW,
          expectedSidebarOrderRevision: REVISION,
        },
        readModel,
      }),
    );
    expect(decision).toMatchObject({
      type: "sidebar-section.thread-placed",
      payload: {
        sidebarOrderItems: expect.arrayContaining([
          expect.objectContaining({ key: `thread:${second}`, sortOrder: 0 }),
          expect.objectContaining({ key: projectKey, sortOrder: 1 }),
          expect.objectContaining({ key: `thread:${first}`, sortOrder: 2 }),
        ]),
      },
    });
    const event = decision as Omit<OrchestrationEvent, "sequence">;
    const projected = await Effect.runPromise(
      projectEvent(readModel, {
        ...event,
        sequence: 2,
        eventId: EventId.makeUnsafe("event-thread-place-mixed"),
      } as OrchestrationEvent),
    );
    expect(
      projected.sidebarOrderItems
        ?.filter(
          (item) =>
            item.destination === "custom" &&
            item.sectionId === sectionId &&
            item.sectionCreatedAt === NOW,
        )
        .toSorted((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => item.key),
    ).toEqual([`thread:${second}`, projectKey, `thread:${first}`]);
  });

  it("requires reorder commands to name every active section exactly once", async () => {
    const first = SidebarSectionId.makeUnsafe("section-order-a");
    const second = SidebarSectionId.makeUnsafe("section-order-b");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "sidebar-section.reorder",
            commandId: CommandId.makeUnsafe("cmd-section-order-invalid"),
            sectionId: first,
            orderedSectionIds: [first, first],
            expectedSidebarOrderRevision: REVISION,
          },
          readModel: makeReadModel(
            [makeThread({ id: "thread-section-order" })],
            [makeSection(first), makeSection(second)],
          ),
        }),
      ),
    ).rejects.toBeInstanceOf(OrchestrationCommandInvariantError);
  });
});
