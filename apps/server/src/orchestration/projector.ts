import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSidebarOrderItem,
  OrchestrationSidebarSection,
  ThreadArchivedSidebarPlacement,
  ThreadId,
  ThreadRestoredSidebarPlacement,
} from "@synara/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
  SidebarOrderRevision,
  SidebarSectionItemKey,
  ThreadAsyncUserInputAnsweredPayload,
  ThreadClaudeCacheSetPayload,
  type OrchestrationMessageTextSegment,
} from "@synara/contracts";
import { clearRemovedAsyncUserInputResponses } from "@synara/shared/asyncUserInput";
import { isGroupContainerKind } from "@synara/shared/projectContainers";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import {
  addPinnedMessage,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
} from "@synara/shared/pinnedMessages";
import {
  addThreadMarker,
  removeThreadMarker,
  setThreadMarkerDone,
  setThreadMarkerLabel,
} from "@synara/shared/threadMarkers";
import { Effect, Schema } from "effect";
import {
  inferLegacyProviderKindFromModelSelection,
  resolveModelSelectionInstanceId,
} from "@synara/shared/providerInstances";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  SpaceCreatedPayload,
  SpaceDeletedPayload,
  SpaceMetaUpdatedPayload,
  SpaceOrderUpdatedPayload,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  SidebarProjectsOrderUpdatedPayload,
  SidebarSectionCollapsedPayload,
  SidebarSectionCreatedPayload,
  SidebarSectionDeletedPayload,
  SidebarSectionOrderUpdatedPayload,
  SidebarSectionProjectPlacedPayload,
  SidebarSectionRenamedPayload,
  SidebarSectionThreadOrderUpdatedPayload,
  SidebarSectionThreadPlacedPayload,
  OrchestrationSidebarOrder as OrchestrationSidebarOrderSchema,
  OrchestrationSidebarSection as OrchestrationSidebarSectionSchema,
  ThreadArchivedPayload,
  ThreadActivityAppendedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinnedMessageAddedPayload,
  ThreadPinnedMessageDoneSetPayload,
  ThreadPinnedMessageLabelSetPayload,
  ThreadPinnedMessageRemovedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadConversationRolledBackPayload,
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadSidechatActivityRecordedPayload,
  ThreadSidechatExpiredPayload,
  ThreadMarkerAddedPayload,
  ThreadMarkerDoneSetPayload,
  ThreadMarkerLabelSetPayload,
  ThreadMarkerRemovedPayload,
  ThreadTurnCapacityRetryRequestedPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnResumeRequestedPayload,
  ThreadTurnStartRequestedPayload,
} from "./Schemas.ts";
import {
  compactSidebarOrderItems,
  placeSidebarOrderItem,
  placeSidebarThreadOrder,
  rehomeSidebarSectionItems,
} from "./sidebarOrder.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import { deriveTurnStopActivity } from "@synara/shared/turnStopActivity";
import { maxIso, settleTurnStateFromSession } from "./turnLifecycle.ts";
import {
  canAdoptFirstTurnProvider,
  deriveTurnStartModelSelection,
  deriveTurnStartSession,
} from "./turnStartSession.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_ACTIVITIES = 500;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function isTerminalLatestTurn(
  latestTurn: OrchestrationThread["latestTurn"] | null | undefined,
): boolean {
  if (!latestTurn?.completedAt) {
    return false;
  }
  return latestTurn.state === "completed" || latestTurn.state === "error";
}

// Turn lifecycle must settle with the session: once a session leaves "running",
// no provider event will ever mark the turn complete on its own, so a running
// latestTurn is settled here. Checkpoint diff events (thread.turn-diff-completed)
// only enrich the terminal state afterwards — they are not the lifecycle authority.
// A retained activeTurnId blocks settlement (except on error): stop-requested flows
// deliberately emit "interrupted" while keeping the turn active until the provider's
// terminal event decides the real outcome, and a premature settle here could never
// be corrected because settlement only applies to running turns.
function settleLatestTurnForSessionStatus(
  latestTurn: OrchestrationThread["latestTurn"],
  session: Pick<OrchestrationSession, "status" | "activeTurnId" | "updatedAt">,
): OrchestrationThread["latestTurn"] {
  if (latestTurn?.state !== "running") {
    return latestTurn;
  }
  const settledState = settleTurnStateFromSession(session, latestTurn.state);
  if (settledState === null) {
    return latestTurn;
  }
  return {
    ...latestTurn,
    state: settledState,
    completedAt: latestTurn.completedAt ?? session.updatedAt,
  };
}

// Every projected event patches exactly one thread, and streaming assistant
// deltas run this on the dispatch hot path, so patch the single affected slot
// instead of mapping a closure over every thread.
function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  const nextThreads = threads.slice();
  const index = nextThreads.findIndex((thread) => thread.id === threadId);
  if (index === -1) {
    return nextThreads;
  }
  nextThreads[index] = { ...nextThreads[index]!, ...patch };
  return nextThreads;
}

function removeThreadFromSidebarSections(
  sections: ReadonlyArray<OrchestrationSidebarSection>,
  threadId: ThreadId,
): OrchestrationSidebarSection[] {
  const itemKey = "thread:" + threadId;
  return sections.map((section) => {
    const items = section.items
      .filter((item) => item.key !== itemKey)
      .map((item, index) => (item.sortOrder === index ? item : { ...item, sortOrder: index }));
    return items.length === section.items.length ? section : { ...section, items };
  });
}

function removeSidebarItemFromSections(
  sections: ReadonlyArray<OrchestrationSidebarSection>,
  itemKey: string,
): OrchestrationSidebarSection[] {
  return sections.map((section) => {
    const items = section.items
      .filter((item) => item.key !== itemKey)
      .map((item, index) => (item.sortOrder === index ? item : { ...item, sortOrder: index }));
    return items.length === section.items.length ? section : { ...section, items };
  });
}

function syncSidebarSectionItemsFromOrder(
  sections: ReadonlyArray<OrchestrationSidebarSection>,
  items: ReadonlyArray<OrchestrationSidebarOrderItem>,
): OrchestrationSidebarSection[] {
  return sections.map((section) => {
    const nextItems = items
      .filter(
        (item) =>
          item.destination === "custom" &&
          item.sectionId === section.id &&
          item.sectionCreatedAt === section.createdAt,
      )
      .sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key))
      .map((item) => ({
        key: item.key,
        itemType: item.itemType,
        sortOrder: item.sortOrder,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    return nextItems.length === section.items.length &&
      nextItems.every((item, index) => {
        const current = section.items[index];
        return (
          current?.key === item.key &&
          current.itemType === item.itemType &&
          current.sortOrder === item.sortOrder
        );
      })
      ? section
      : { ...section, items: nextItems };
  });
}

function deriveSidebarOrderItems(model: OrchestrationReadModel): OrchestrationSidebarOrderItem[] {
  const items: OrchestrationSidebarOrderItem[] = [];
  for (const section of model.sidebarSections ?? []) {
    for (const item of section.items) {
      items.push({
        key: item.key,
        itemType: item.itemType,
        destination: "custom",
        sectionId: section.id,
        sectionCreatedAt: section.createdAt,
        sortOrder: item.sortOrder,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    }
  }
  for (const project of model.projects) {
    if (project.deletedAt !== null || (project.kind ?? "project") !== "project") continue;
    const key = `project:${project.id}` as OrchestrationSidebarOrderItem["key"];
    if (items.some((item) => item.key === key)) continue;
    const destination = project.isPinned ? "pinned" : "default";
    items.push({
      key,
      itemType: "project",
      destination,
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder: items.filter((item) => item.destination === destination).length,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }
  for (const thread of model.threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (items.some((item) => item.key === `thread:${thread.id}`)) continue;
    if (thread.parentThreadId !== null && thread.parentThreadId !== undefined && !thread.isPinned) {
      continue;
    }
    const destination = thread.isPinned ? "pinned" : "default";
    const sortOrder = items.filter((item) => item.destination === destination).length;
    items.push({
      key: `thread:${thread.id}` as OrchestrationSidebarOrderItem["key"],
      itemType: "thread",
      destination,
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }
  return compactSidebarOrderItems(items);
}

function applySidebarOrderProjection(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  let items = model.sidebarOrderItems ?? deriveSidebarOrderItems(model);
  let revision: SidebarOrderRevision =
    model.sidebarOrderRevision ?? SidebarOrderRevision.makeUnsafe(0);
  if (event.type === "sidebar-order.legacy-imported") {
    return {
      ...model,
      sidebarOrderRevision: event.payload.sidebarOrderRevision,
      sidebarOrderMigrationState: "ready",
      sidebarOrderItems: compactSidebarOrderItems(event.payload.items),
    };
  }
  if (event.type === "sidebar-section.deleted" && event.payload.sidebarOrderItems !== undefined) {
    const deletedSection = (model.sidebarSections ?? []).find(
      (section) =>
        section.id === event.payload.sectionId &&
        (event.payload.sectionCreatedAt === undefined ||
          section.createdAt === event.payload.sectionCreatedAt),
    );
    const removedKeys = new Set([
      ...(deletedSection?.items.map((item) => item.key) ?? []),
      ...items
        .filter(
          (item) =>
            item.destination === "custom" &&
            item.sectionId === event.payload.sectionId &&
            (event.payload.sectionCreatedAt === undefined ||
              item.sectionCreatedAt === event.payload.sectionCreatedAt),
        )
        .map((item) => item.key),
    ]);
    items = compactSidebarOrderItems(event.payload.sidebarOrderItems);
    revision = event.payload.sidebarOrderRevision ?? revision;
    return {
      ...model,
      sidebarOrderRevision: revision,
      sidebarOrderItems: items,
      sidebarSections: syncSidebarSectionItemsFromOrder(model.sidebarSections ?? [], items),
      projects: model.projects.map((project) =>
        removedKeys.has(`project:${project.id}` as OrchestrationSidebarOrderItem["key"])
          ? { ...project, isPinned: false, updatedAt: event.payload.deletedAt }
          : project,
      ),
      threads: model.threads.map((thread) =>
        removedKeys.has(`thread:${thread.id}` as OrchestrationSidebarOrderItem["key"])
          ? { ...thread, isPinned: false, updatedAt: event.payload.deletedAt }
          : thread,
      ),
    };
  }
  if (event.type === "sidebar-section.deleted") {
    const sectionCreatedAt =
      event.payload.sectionCreatedAt ??
      (model.sidebarSections ?? []).find((section) => section.id === event.payload.sectionId)
        ?.createdAt ??
      items.find(
        (item) => item.destination === "custom" && item.sectionId === event.payload.sectionId,
      )?.sectionCreatedAt ??
      null;
    const removedItems = items.filter(
      (item) =>
        item.destination === "custom" &&
        item.sectionId === event.payload.sectionId &&
        (sectionCreatedAt === null || item.sectionCreatedAt === sectionCreatedAt),
    );
    const removedKeys = new Set(removedItems.map((item) => item.key));
    if (sectionCreatedAt !== null) {
      items = rehomeSidebarSectionItems(items, {
        sectionId: event.payload.sectionId,
        sectionCreatedAt,
        now: event.payload.deletedAt,
      }).items;
    } else {
      items = items.filter((item) => !removedKeys.has(item.key));
    }
    revision = event.payload.sidebarOrderRevision ?? revision;
    return {
      ...model,
      sidebarOrderRevision: revision,
      sidebarOrderItems: items,
      sidebarSections: syncSidebarSectionItemsFromOrder(model.sidebarSections ?? [], items),
      projects: model.projects.map((project) =>
        removedKeys.has(`project:${project.id}` as OrchestrationSidebarOrderItem["key"])
          ? { ...project, isPinned: false, updatedAt: event.payload.deletedAt }
          : project,
      ),
      threads: model.threads.map((thread) =>
        removedKeys.has(`thread:${thread.id}` as OrchestrationSidebarOrderItem["key"])
          ? { ...thread, isPinned: false, updatedAt: event.payload.deletedAt }
          : thread,
      ),
    };
  }
  if (
    event.type === "sidebar-section.thread-placed" &&
    event.payload.sidebarOrderItems !== undefined
  ) {
    items = compactSidebarOrderItems(event.payload.sidebarOrderItems);
    revision = event.payload.sidebarOrderRevision ?? revision;
  } else if (
    (event.type === "sidebar-section.project-placed" ||
      event.type === "sidebar-section.thread-order-updated" ||
      event.type === "sidebar-projects.order-updated") &&
    event.payload.sidebarOrderItems !== undefined
  ) {
    items = compactSidebarOrderItems(event.payload.sidebarOrderItems);
    revision = event.payload.sidebarOrderRevision;
    if (event.type === "sidebar-section.project-placed") {
      return {
        ...model,
        sidebarOrderRevision: revision,
        sidebarOrderItems: items,
        sidebarSections: syncSidebarSectionItemsFromOrder(model.sidebarSections ?? [], items),
        projects: model.projects.map((project) =>
          project.id === event.payload.projectId
            ? {
                ...project,
                isPinned: event.payload.destination === "pinned",
                updatedAt: event.payload.updatedAt,
              }
            : project,
        ),
      };
    }
    return {
      ...model,
      sidebarOrderRevision: revision,
      sidebarOrderItems: items,
      sidebarSections: syncSidebarSectionItemsFromOrder(model.sidebarSections ?? [], items),
    };
  } else {
    const key =
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted"
        ? `project:${event.payload.projectId}`
        : `thread:${event.type === "thread.created" ? event.payload.threadId : event.type === "thread.deleted" || event.type === "thread.archived" || event.type === "thread.unarchived" || event.type === "thread.meta-updated" ? event.payload.threadId : event.type === "sidebar-section.thread-placed" ? event.payload.threadId : ""}`;
    switch (event.type) {
      case "sidebar-section.created":
        revision = event.payload.sidebarOrderRevision ?? revision;
        if (event.payload.initialThreadId !== undefined) {
          const sectionItem: OrchestrationSidebarOrderItem = {
            key: `thread:${event.payload.initialThreadId}` as OrchestrationSidebarOrderItem["key"],
            itemType: "thread",
            destination: "custom",
            sectionId: event.payload.sectionId,
            sectionCreatedAt: event.payload.createdAt,
            sortOrder: 0,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          };
          items = compactSidebarOrderItems([
            ...items.filter((item) => item.key !== sectionItem.key),
            sectionItem,
          ]);
        }
        break;
      case "sidebar-section.thread-placed": {
        const existingSection = (model.sidebarSections ?? []).find(
          (section) => section.id === event.payload.sectionId,
        );
        try {
          const result = placeSidebarThreadOrder(items, {
            itemKey: `thread:${event.payload.threadId}`,
            itemType: "thread",
            destination: event.payload.destination,
            sectionId: event.payload.destination === "custom" ? event.payload.sectionId : null,
            sectionCreatedAt:
              event.payload.destination === "custom"
                ? (event.payload.sectionCreatedAt ?? existingSection?.createdAt ?? null)
                : null,
            beforeThreadId: event.payload.beforeThreadId ?? null,
            now: event.payload.updatedAt,
          });
          items = result.items;
          revision = event.payload.sidebarOrderRevision ?? revision;
        } catch {
          // A historical event may predate anchor/incarnation fields. Keep its
          // legacy section projection readable rather than making replay fail.
          revision = event.payload.sidebarOrderRevision ?? revision;
        }
        break;
      }
      case "project.created": {
        if ((event.payload.kind ?? "project") !== "project") break;
        if (items.some((item) => item.key === key)) break;
        const destination = event.payload.isPinned === true ? "pinned" : "default";
        items = compactSidebarOrderItems([
          ...items,
          {
            key: key as OrchestrationSidebarOrderItem["key"],
            itemType: "project",
            destination,
            sectionId: null,
            sectionCreatedAt: null,
            sortOrder: items.filter((item) => item.destination === destination).length,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          },
        ]);
        break;
      }
      case "project.deleted":
        items = items.filter((item) => item.key !== key);
        break;
      case "project.meta-updated": {
        const project = model.projects.find(
          (candidate) => candidate.id === event.payload.projectId,
        );
        const existing = items.find((item) => item.key === key);
        const shouldExist =
          project !== undefined &&
          project.deletedAt === null &&
          (project.kind ?? "project") === "project";
        if (!shouldExist) {
          items = items.filter((item) => item.key !== key);
          break;
        }
        if (existing === undefined) {
          const destination = project.isPinned ? "pinned" : "default";
          items = compactSidebarOrderItems([
            ...items,
            {
              key: key as OrchestrationSidebarOrderItem["key"],
              itemType: "project",
              destination,
              sectionId: null,
              sectionCreatedAt: null,
              sortOrder: items.filter((item) => item.destination === destination).length,
              createdAt: project.createdAt,
              updatedAt: event.payload.updatedAt,
            },
          ]);
          break;
        }
        if (existing.itemType !== "project" || event.payload.isPinned === undefined) break;
        try {
          items = placeSidebarOrderItem(items, {
            itemKey: key,
            itemType: "project",
            destination: event.payload.isPinned ? "pinned" : "default",
            sectionId: null,
            sectionCreatedAt: null,
            beforeItemKey: null,
            now: event.payload.updatedAt,
          }).items;
        } catch {
          // Historical metadata events remain readable if the durable relation
          // was not seeded on the installation that produced them.
        }
        break;
      }
      case "thread.created": {
        const threadKey = key;
        if (threadKey.length > 0 && !items.some((item) => item.key === threadKey)) {
          const destination = event.payload.isPinned ? "pinned" : "default";
          items = compactSidebarOrderItems([
            ...items,
            {
              key: threadKey as OrchestrationSidebarOrderItem["key"],
              itemType: "thread",
              destination,
              sectionId: null,
              sectionCreatedAt: null,
              sortOrder: items.filter((item) => item.destination === destination).length,
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
            },
          ]);
        }
        break;
      }
      case "thread.deleted":
        revision = event.payload.sidebarOrderRevision ?? revision;
        items = items.filter((item) => item.key !== key);
        break;
      case "thread.archived":
        revision = event.payload.sidebarOrderRevision ?? revision;
        items = items.filter((item) => item.key !== key);
        break;
      case "thread.unarchived": {
        revision = event.payload.sidebarOrderRevision ?? revision;
        const placements =
          event.payload.isArchiveCohortFinal &&
          (event.payload.restoredSidebarPlacements ?? []).length > 0
            ? (event.payload.restoredSidebarPlacements ?? [])
            : event.payload.restoredSidebarPlacement === undefined ||
                event.payload.restoredSidebarPlacement === null
              ? []
              : [
                  {
                    threadId: event.payload.threadId,
                    placement: event.payload.restoredSidebarPlacement,
                  },
                ];
        if (placements.length > 0) {
          const restoredItems: OrchestrationSidebarOrderItem[] = placements.map((entry) => ({
            key: `thread:${entry.threadId}` as OrchestrationSidebarOrderItem["key"],
            itemType: "thread",
            destination: entry.placement.destination ?? "custom",
            sectionId: entry.placement.sectionId,
            sectionCreatedAt: entry.placement.sectionCreatedAt,
            sortOrder: entry.placement.sortOrder,
            createdAt: event.payload.updatedAt ?? event.occurredAt,
            updatedAt: event.payload.updatedAt ?? event.occurredAt,
          }));
          const restoredKeys = new Set(restoredItems.map((item) => item.key));
          items = compactSidebarOrderItems([
            ...items.filter((item) => !restoredKeys.has(item.key)),
            ...restoredItems,
          ]);
        }
        break;
      }
      case "thread.meta-updated":
        if (event.payload.isPinned !== undefined) {
          try {
            items = placeSidebarOrderItem(items, {
              itemKey: key,
              itemType: "thread",
              destination: event.payload.isPinned ? "pinned" : "default",
              sectionId: null,
              sectionCreatedAt: null,
              beforeThreadId: null,
              now: event.payload.updatedAt,
            }).items;
          } catch {
            // Legacy pin events remain readable even when the relation was not
            // seeded yet; the compatibility isPinned projection is retained.
          }
        }
        break;
      default:
        break;
    }
  }
  return {
    ...model,
    sidebarOrderRevision: revision,
    sidebarOrderMigrationState: model.sidebarOrderMigrationState ?? "ready",
    sidebarOrderItems: items,
  };
}

// Archive projection deliberately leaves the remaining sort-order gaps intact.
// The archive payload stores the original index, so preserving those values lets
// descendants-first Undo events restore multiple items in their original order;
// the final cohort event compacts the section once the whole batch is present.
function removeArchivedThreadFromSidebarSections(
  sections: ReadonlyArray<OrchestrationSidebarSection>,
  threadId: ThreadId,
): OrchestrationSidebarSection[] {
  const itemKey = "thread:" + threadId;
  return sections.map((section) => {
    const items = section.items.filter((item) => item.key !== itemKey);
    return items.length === section.items.length ? section : { ...section, items };
  });
}

function updateSidebarSection(
  sections: ReadonlyArray<OrchestrationSidebarSection>,
  sectionId: OrchestrationSidebarSection["id"],
  patch: Partial<Omit<OrchestrationSidebarSection, "id">>,
): OrchestrationSidebarSection[] {
  return sections.map((section) => (section.id === sectionId ? { ...section, ...patch } : section));
}

function addThreadToSidebarSection(input: {
  readonly sections: ReadonlyArray<OrchestrationSidebarSection>;
  readonly sectionId: OrchestrationSidebarSection["id"];
  readonly threadId: ThreadId;
  readonly sortOrder?: number;
  readonly occurredAt: string;
}): OrchestrationSidebarSection[] {
  const itemKey = SidebarSectionItemKey.makeUnsafe("thread:" + input.threadId);
  return input.sections.map((section) => {
    if (section.id !== input.sectionId) return section;
    const withoutThread = section.items.filter((item) => item.key !== itemKey);
    const nextSortOrder =
      input.sortOrder ??
      withoutThread.reduce((maximum, item) => Math.max(maximum, item.sortOrder + 1), 0);
    return {
      ...section,
      items: [
        ...withoutThread,
        {
          key: itemKey,
          itemType: "thread" as const,
          sortOrder: nextSortOrder,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        },
      ],
      updatedAt: input.occurredAt,
    };
  });
}

function isFinalArchiveCohortRestore(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
): boolean {
  const thread = threads.find((entry) => entry.id === threadId);
  const cohortId = thread?.archivedByCommandId ?? null;
  if (cohortId === null) return true;
  const parentThreadId = thread?.parentThreadId ?? null;
  if (parentThreadId === null) return true;
  const parent = threads.find((entry) => entry.id === parentThreadId);
  // Cohort provenance remains attached to earlier descendant restores until
  // the root-last event finalizes the whole batch. ArchivedAt alone cannot
  // identify the terminal event because descendants are restored first.
  return parent?.archivedByCommandId !== cohortId;
}

function restoreArchiveCohortSidebarItems(input: {
  readonly sections: ReadonlyArray<OrchestrationSidebarSection>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly rootThreadId: ThreadId;
  readonly rootPlacement: ThreadArchivedSidebarPlacement | null;
  readonly restoredSidebarPlacements?: ReadonlyArray<ThreadRestoredSidebarPlacement>;
  readonly occurredAt: string;
}): OrchestrationSidebarSection[] {
  const root = input.threads.find((thread) => thread.id === input.rootThreadId);
  const cohortId = root?.archivedByCommandId ?? null;
  const placementByThreadId = new Map<ThreadId, ThreadArchivedSidebarPlacement>();
  if ((input.restoredSidebarPlacements?.length ?? 0) > 0) {
    for (const entry of input.restoredSidebarPlacements ?? []) {
      placementByThreadId.set(entry.threadId, entry.placement);
    }
  } else {
    for (const thread of input.threads) {
      if (thread.id === input.rootThreadId) {
        if (input.rootPlacement !== null) placementByThreadId.set(thread.id, input.rootPlacement);
        continue;
      }
      if (
        cohortId === null ||
        thread.archivedByCommandId !== cohortId ||
        thread.archivedAt !== null
      ) {
        continue;
      }
      if (
        thread.archivedSidebarSectionId == null ||
        thread.archivedSidebarSectionCreatedAt == null ||
        thread.archivedSidebarSortOrder == null
      ) {
        continue;
      }
      placementByThreadId.set(thread.id, {
        sectionId: thread.archivedSidebarSectionId,
        sectionCreatedAt: thread.archivedSidebarSectionCreatedAt,
        sortOrder: thread.archivedSidebarSortOrder,
      });
    }
  }

  const placementsBySectionId = new Map<
    string,
    Array<{ readonly threadId: ThreadId; readonly placement: ThreadArchivedSidebarPlacement }>
  >();
  for (const [threadId, placement] of placementByThreadId) {
    const section = input.sections.find(
      (candidate) =>
        candidate.id === placement.sectionId && candidate.createdAt === placement.sectionCreatedAt,
    );
    if (section === undefined) continue;
    const entries = placementsBySectionId.get(section.id);
    const entry = { threadId, placement };
    if (entries === undefined) placementsBySectionId.set(section.id, [entry]);
    else entries.push(entry);
  }

  return input.sections.map((section) => {
    const entries = placementsBySectionId.get(section.id);
    if (entries === undefined || entries.length === 0) return section;
    const restoredKeys = new Set(entries.map(({ threadId }) => `thread:${threadId}`));
    const existingItems = section.items
      .filter((item) => !restoredKeys.has(item.key))
      .toSorted(
        (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
      );
    const sortedEntries = entries.toSorted(
      (left, right) =>
        left.placement.sortOrder - right.placement.sortOrder ||
        left.threadId.localeCompare(right.threadId),
    );
    let combined = existingItems;
    for (const { threadId, placement } of sortedEntries) {
      const insertionIndex = Math.min(placement.sortOrder, combined.length);
      const restoredItem = {
        key: SidebarSectionItemKey.makeUnsafe(`thread:${threadId}`),
        itemType: "thread" as const,
        sortOrder: placement.sortOrder,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
      };
      combined = [
        ...combined.slice(0, insertionIndex),
        restoredItem,
        ...combined.slice(insertionIndex),
      ];
    }
    return {
      ...section,
      items: combined.map((item, index) =>
        item.sortOrder === index && item.updatedAt === input.occurredAt
          ? item
          : { ...item, sortOrder: index, updatedAt: input.occurredAt },
      ),
      updatedAt: input.occurredAt,
    };
  });
}

interface ProjectedProviderSessionBinding {
  readonly status: OrchestrationSession["status"];
  readonly providerName: string | null;
  readonly providerInstanceId?: string | null | undefined;
}

export function canProjectTurnModelSelectionForSession(
  session: ProjectedProviderSessionBinding | null | undefined,
  requestedInstanceId: string,
): boolean {
  if (!session || session.status === "stopped" || session.status === "error") {
    return true;
  }
  const boundInstanceId = session.providerInstanceId ?? session.providerName;
  return !boundInstanceId || requestedInstanceId === boundInstanceId;
}

function canProjectTurnModelSelection(
  thread: OrchestrationThread,
  modelSelection: OrchestrationThread["modelSelection"] | undefined,
): boolean {
  if (modelSelection === undefined) {
    return false;
  }
  return canProjectTurnModelSelectionForSession(
    thread.session,
    resolveModelSelectionInstanceId(modelSelection),
  );
}

// Message ids are unique within a thread and streamed deltas land on the newest
// message, so searching backwards finds the target in one step instead of
// scanning the whole (capped at MAX_THREAD_MESSAGES) transcript.
function findMessageIndexFromEnd(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.id === messageId) {
      return index;
    }
  }
  return -1;
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages, removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  return {
    messages: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    ),
  };
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertThreadActivity(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  activity: OrchestrationThread["activities"][number],
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  if (existingIndex >= 0 && compareThreadActivities(activities[existingIndex]!, activity) === 0) {
    const next = [...activities];
    next[existingIndex] = activity;
    return next.slice(-MAX_THREAD_ACTIVITIES);
  }

  const withoutExisting =
    existingIndex < 0
      ? activities
      : [...activities.slice(0, existingIndex), ...activities.slice(existingIndex + 1)];
  const last = withoutExisting.at(-1);
  if (!last || compareThreadActivities(last, activity) <= 0) {
    return [...withoutExisting, activity].slice(-MAX_THREAD_ACTIVITIES);
  }

  let low = 0;
  let high = withoutExisting.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareThreadActivities(withoutExisting[middle]!, activity) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return [...withoutExisting.slice(0, low), activity, ...withoutExisting.slice(low)].slice(
    -MAX_THREAD_ACTIVITIES,
  );
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    threads: [],
    sidebarSections: [],
    updatedAt: nowIso,
  };
}

/**
 * Mirrors the SQLite message_text_segments projection in the in-memory read
 * model: streamed assistant deltas accumulate into the current segment, a
 * row-making provider event between deltas starts a new segment at its own
 * time (segmentStartedAt), and completion keeps the boundaries when the
 * collated segment text matches the final text. Single-segment messages and
 * edits/rewrites/imports need no side table metadata and drop the segments.
 */
function deriveNextMessageTextSegments(
  previous: ReadonlyArray<OrchestrationMessageTextSegment> | undefined,
  input: {
    readonly text: string;
    readonly streaming: boolean;
    readonly segmentStartedAt: string | undefined;
    readonly sequence: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): ReadonlyArray<OrchestrationMessageTextSegment> | undefined {
  if (input.streaming) {
    if (input.segmentStartedAt) {
      return [
        ...(previous ?? []),
        {
          sequence: input.sequence,
          startedAt: input.segmentStartedAt,
          endedAt: input.updatedAt,
          text: input.text,
        },
      ];
    }
    if (previous && previous.length > 0) {
      const tail = previous[previous.length - 1]!;
      return [
        ...previous.slice(0, -1),
        { ...tail, text: `${tail.text}${input.text}`, endedAt: input.updatedAt },
      ];
    }
    return [
      {
        sequence: input.sequence,
        startedAt: input.createdAt,
        endedAt: input.updatedAt,
        text: input.text,
      },
    ];
  }

  // Completion / edit / rewrite / import.
  if (previous && previous.length > 1) {
    const collatedSegmentText = previous.map((segment) => segment.text).join("");
    if (collatedSegmentText === input.text || input.text.length === 0) {
      const tail = previous[previous.length - 1]!;
      return [...previous.slice(0, -1), { ...tail, endedAt: input.updatedAt }];
    }
  }
  return undefined;
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "space.created":
      return decodeForEvent(SpaceCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.spaces.find((entry) => entry.id === payload.spaceId);
          const nextSpace = {
            id: payload.spaceId,
            name: payload.name,
            icon: payload.icon,
            sortOrder: payload.sortOrder,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };
          return {
            ...nextBase,
            spaces: existing
              ? nextBase.spaces.map((entry) => (entry.id === payload.spaceId ? nextSpace : entry))
              : [...nextBase.spaces, nextSpace],
          };
        }),
      );

    case "space.meta-updated":
      return decodeForEvent(SpaceMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? {
                  ...space,
                  ...(payload.name !== undefined ? { name: payload.name } : {}),
                  ...(payload.icon !== undefined ? { icon: payload.icon } : {}),
                  updatedAt: payload.updatedAt,
                }
              : space,
          ),
        })),
      );

    case "space.order-updated":
      return decodeForEvent(SpaceOrderUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const orderBySpaceId = new Map(
            payload.orderedSpaceIds.map((spaceId, index) => [spaceId, index] as const),
          );
          return {
            ...nextBase,
            spaces: nextBase.spaces.map((space) => {
              const sortOrder = orderBySpaceId.get(space.id);
              // A listed space whose position did not move is not a change; skipping it keeps
              // this read model, the SQL projection, and the client store byte-identical.
              return sortOrder === undefined || sortOrder === space.sortOrder
                ? space
                : { ...space, sortOrder, updatedAt: payload.updatedAt };
            }),
          };
        }),
      );

    case "space.deleted":
      return decodeForEvent(SpaceDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? { ...space, deletedAt: payload.deletedAt, updatedAt: payload.deletedAt }
              : space,
          ),
          projects: nextBase.projects.map((project) =>
            project.spaceId === payload.spaceId
              ? {
                  ...project,
                  spaceId: null,
                  updatedAt:
                    project.updatedAt > payload.deletedAt ? project.updatedAt : payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            kind: payload.kind,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            isPinned: payload.isPinned ?? false,
            spaceId: payload.spaceId ?? null,
            additionalFolders: payload.additionalFolders ?? [],
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
        Effect.map((next) => applySidebarOrderProjection(next, event)),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
                  ...(payload.spaceId !== undefined ? { spaceId: payload.spaceId } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
        Effect.map((next) => applySidebarOrderProjection(next, event)),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
        Effect.map((next) => applySidebarOrderProjection(next, event)),
      );

    case "sidebar-section.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          SidebarSectionCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const initialItems =
          payload.initialThreadId === undefined
            ? []
            : [
                {
                  key: SidebarSectionItemKey.makeUnsafe("thread:" + payload.initialThreadId),
                  itemType: "thread" as const,
                  sortOrder: 0,
                  createdAt: payload.createdAt,
                  updatedAt: payload.updatedAt,
                },
              ];
        const section = yield* decodeForEvent(
          OrchestrationSidebarSectionSchema,
          {
            id: payload.sectionId,
            name: payload.name,
            sortOrder: payload.sortOrder,
            isCollapsed: payload.isCollapsed,
            items: initialItems,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          },
          event.type,
          "section",
        );
        const existing = (nextBase.sidebarSections ?? []).find((entry) => entry.id === section.id);
        return {
          ...nextBase,
          sidebarSections: existing
            ? (nextBase.sidebarSections ?? []).map((entry) =>
                entry.id === section.id ? section : entry,
              )
            : [...(nextBase.sidebarSections ?? []), section],
        };
      }).pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "sidebar-section.renamed":
      return decodeForEvent(
        SidebarSectionRenamedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          sidebarSections: updateSidebarSection(nextBase.sidebarSections ?? [], payload.sectionId, {
            name: payload.name,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "sidebar-section.collapsed":
      return decodeForEvent(
        SidebarSectionCollapsedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          sidebarSections: updateSidebarSection(nextBase.sidebarSections ?? [], payload.sectionId, {
            isCollapsed: payload.isCollapsed,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "sidebar-section.deleted":
      return decodeForEvent(SidebarSectionDeletedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => {
            const deletedSection = (nextBase.sidebarSections ?? []).find(
              (section) =>
                section.id === payload.sectionId &&
                (payload.sectionCreatedAt === undefined ||
                  section.createdAt === payload.sectionCreatedAt),
            );
            const removedKeys = new Set(deletedSection?.items.map((item) => item.key) ?? []);
            return {
              ...nextBase,
              sidebarSections: (nextBase.sidebarSections ?? []).filter(
                (section) => section.id !== payload.sectionId,
              ),
              projects: nextBase.projects.map((project) =>
                removedKeys.has(`project:${project.id}` as OrchestrationSidebarOrderItem["key"])
                  ? { ...project, isPinned: false, updatedAt: payload.deletedAt }
                  : project,
              ),
              threads: nextBase.threads.map((thread) =>
                removedKeys.has(`thread:${thread.id}` as OrchestrationSidebarOrderItem["key"])
                  ? { ...thread, isPinned: false, updatedAt: payload.deletedAt }
                  : thread,
              ),
            };
          }),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "sidebar-section.order-updated":
      return decodeForEvent(SidebarSectionOrderUpdatedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => {
            const orderBySectionId = new Map(
              payload.orderedSectionIds.map((sectionId, index) => [sectionId, index] as const),
            );
            return {
              ...nextBase,
              sidebarSections: (nextBase.sidebarSections ?? []).map((section) => {
                const sortOrder = orderBySectionId.get(section.id);
                return sortOrder === undefined || sortOrder === section.sortOrder
                  ? section
                  : { ...section, sortOrder, updatedAt: payload.updatedAt };
              }),
            };
          }),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "sidebar-section.thread-placed":
      return decodeForEvent(SidebarSectionThreadPlacedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => {
            const withoutThread = removeThreadFromSidebarSections(
              nextBase.sidebarSections ?? [],
              payload.threadId,
            );
            const sidebarSections =
              payload.destination === "custom" && payload.sectionId !== null
                ? addThreadToSidebarSection({
                    sections: withoutThread,
                    sectionId: payload.sectionId,
                    threadId: payload.threadId,
                    ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
                    occurredAt: payload.updatedAt,
                  })
                : withoutThread;
            return {
              ...nextBase,
              sidebarSections,
              threads: updateThread(nextBase.threads, payload.threadId, {
                isPinned: payload.destination === "pinned",
                updatedAt: payload.updatedAt,
                archivedByCommandId: null,
                archivedSidebarDestination: null,
                archivedSidebarSectionId: null,
                archivedSidebarSectionCreatedAt: null,
                archivedSidebarSortOrder: null,
              }),
            };
          }),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "sidebar-section.project-placed":
      return decodeForEvent(
        SidebarSectionProjectPlacedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) =>
          applySidebarOrderProjection(
            {
              ...nextBase,
              projects: nextBase.projects.map((project) =>
                project.id === payload.projectId
                  ? {
                      ...project,
                      isPinned: payload.destination === "pinned",
                      updatedAt: payload.updatedAt,
                    }
                  : project,
              ),
            },
            event,
          ),
        ),
      );

    case "sidebar-section.thread-order-updated":
      return decodeForEvent(
        SidebarSectionThreadOrderUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(Effect.map(() => applySidebarOrderProjection(nextBase, event)));

    case "sidebar-projects.order-updated":
      return decodeForEvent(
        SidebarProjectsOrderUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(Effect.map(() => applySidebarOrderProjection(nextBase, event)));

    case "sidebar-order.legacy-imported":
      return decodeForEvent(
        OrchestrationSidebarOrderSchema,
        {
          revision: event.payload.sidebarOrderRevision,
          migrationState: "ready",
          items: event.payload.items,
        },
        event.type,
        "payload",
      ).pipe(
        Effect.map((order) =>
          applySidebarOrderProjection(
            {
              ...nextBase,
              sidebarOrderRevision: order.revision,
              sidebarOrderMigrationState: order.migrationState,
              sidebarOrderItems: order.items,
            },
            event,
          ),
        ),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const isStudio = isGroupContainerKind(
          nextBase.projects.find((project) => project.id === payload.projectId)?.kind,
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            envMode: isStudio ? "local" : payload.envMode,
            branch: isStudio ? null : payload.branch,
            worktreePath: isStudio ? null : payload.worktreePath,
            workingDirectory: isStudio
              ? (payload.workingDirectory ?? payload.worktreePath)
              : payload.workingDirectory,
            associatedWorktreePath: isStudio ? null : payload.associatedWorktreePath,
            associatedWorktreeBranch: isStudio ? null : payload.associatedWorktreeBranch,
            associatedWorktreeRef: isStudio ? null : payload.associatedWorktreeRef,
            createBranchFlowCompleted: isStudio ? false : payload.createBranchFlowCompleted,
            isPinned: payload.isPinned,
            parentThreadId: payload.parentThreadId,
            creationSource: payload.creationSource ?? null,
            sourceThreadId: payload.sourceThreadId ?? null,
            sourceTurnId: payload.sourceTurnId ?? null,
            gatewayOperationId: payload.gatewayOperationId ?? null,
            gatewayOperationIndex: payload.gatewayOperationIndex ?? null,
            subagentAgentId: payload.subagentAgentId,
            subagentNickname: payload.subagentNickname,
            subagentRole: payload.subagentRole,
            forkSourceThreadId: payload.forkSourceThreadId,
            ...(payload.forkSourceMessageId
              ? { forkSourceMessageId: payload.forkSourceMessageId }
              : {}),
            sidechatSourceThreadId: payload.sidechatSourceThreadId,
            sidechatContext: payload.sidechatContext,
            sidechatLastActivityAt: payload.sidechatLastActivityAt,
            sidechatExpiredAt: payload.sidechatExpiredAt,
            lastKnownPr: payload.lastKnownPr ?? null,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledAt: null,
            snoozedUntil: null,
            snoozeReminderAt: null,
            deletedAt: null,
            handoff: payload.handoff,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      }).pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "thread.sidechat-activity-recorded":
      return decodeForEvent(
        ThreadSidechatActivityRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            sidechatLastActivityAt: payload.lastActivityAt,
            updatedAt: payload.lastActivityAt,
          }),
        })),
      );

    case "thread.sidechat-expired":
      return decodeForEvent(
        ThreadSidechatExpiredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            sidechatExpiredAt: payload.expiredAt,
            updatedAt: payload.expiredAt,
          }),
        })),
      );

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => ({
            ...nextBase,
            sidebarSections: removeThreadFromSidebarSections(
              nextBase.sidebarSections ?? [],
              payload.threadId,
            ),
            threads: updateThread(nextBase.threads, payload.threadId, {
              deletedAt: payload.deletedAt,
              snoozedUntil: null,
              snoozeReminderAt: null,
              updatedAt: payload.deletedAt,
              archivedByCommandId: null,
              archivedSidebarDestination: null,
              archivedSidebarSectionId: null,
              archivedSidebarSectionCreatedAt: null,
              archivedSidebarSortOrder: null,
            }),
          })),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => {
            const archivedAt = payload.archivedAt ?? payload.updatedAt ?? event.occurredAt;
            return {
              ...nextBase,
              sidebarSections: removeArchivedThreadFromSidebarSections(
                nextBase.sidebarSections ?? [],
                payload.threadId,
              ),
              threads: updateThread(nextBase.threads, payload.threadId, {
                archivedAt,
                snoozedUntil: null,
                snoozeReminderAt: null,
                updatedAt: payload.updatedAt ?? archivedAt,
                archivedByCommandId: event.commandId ?? null,
                archivedSidebarDestination:
                  payload.placement?.destination ??
                  (payload.placement?.sectionId !== null &&
                  payload.placement?.sectionId !== undefined
                    ? "custom"
                    : null),
                archivedSidebarSectionId: payload.placement?.sectionId ?? null,
                archivedSidebarSectionCreatedAt: payload.placement?.sectionCreatedAt ?? null,
                archivedSidebarSortOrder: payload.placement?.sortOrder ?? null,
              }),
            };
          }),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload")
        .pipe(
          Effect.map((payload) => {
            const updatedAt = payload.updatedAt ?? payload.unarchivedAt ?? event.occurredAt;
            const currentThread =
              nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
            const isFinalCohortRestore =
              payload.isArchiveCohortFinal ||
              isFinalArchiveCohortRestore(nextBase.threads, payload.threadId);
            const sidebarSections = isFinalCohortRestore
              ? restoreArchiveCohortSidebarItems({
                  sections: nextBase.sidebarSections ?? [],
                  threads: nextBase.threads,
                  rootThreadId: payload.threadId,
                  rootPlacement: payload.restoredSidebarPlacement ?? null,
                  restoredSidebarPlacements: payload.restoredSidebarPlacements ?? [],
                  occurredAt: updatedAt,
                })
              : nextBase.sidebarSections;
            const cohortId = currentThread?.archivedByCommandId ?? null;
            return {
              ...nextBase,
              sidebarSections,
              threads: nextBase.threads.map((thread) => {
                const isRestoredCohortMember =
                  cohortId !== null && thread.archivedByCommandId === cohortId;
                const shouldRestore =
                  thread.id === payload.threadId ||
                  (isFinalCohortRestore && isRestoredCohortMember);
                if (!shouldRestore) return thread;
                return {
                  ...thread,
                  archivedAt: null,
                  updatedAt: thread.id === payload.threadId ? updatedAt : thread.updatedAt,
                  ...(isFinalCohortRestore
                    ? {
                        archivedByCommandId: null,
                        archivedSidebarDestination: null,
                        archivedSidebarSectionId: null,
                        archivedSidebarSectionCreatedAt: null,
                        archivedSidebarSortOrder: null,
                      }
                    : {}),
                };
              }),
            };
          }),
        )
        .pipe(Effect.map((next) => applySidebarOrderProjection(next, event)));

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          const isStudio = isGroupContainerKind(
            nextBase.projects.find((project) => project.id === existingThread?.projectId)?.kind,
          );
          const nextCreateBranchFlowCompleted =
            payload.createBranchFlowCompleted !== undefined
              ? payload.createBranchFlowCompleted
              : payload.branch !== undefined &&
                  existingThread !== null &&
                  payload.branch !== existingThread.branch
                ? false
                : undefined;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(isStudio
                ? {
                    envMode: "local" as const,
                    branch: null,
                    worktreePath: null,
                    workingDirectory:
                      payload.workingDirectory !== undefined
                        ? payload.workingDirectory
                        : payload.worktreePath !== undefined
                          ? payload.worktreePath
                          : (existingThread?.workingDirectory ??
                            existingThread?.worktreePath ??
                            null),
                  }
                : {
                    ...(payload.envMode !== undefined ? { envMode: payload.envMode } : {}),
                    ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
                    ...(payload.worktreePath !== undefined
                      ? { worktreePath: payload.worktreePath }
                      : {}),
                    ...(payload.workingDirectory !== undefined
                      ? { workingDirectory: payload.workingDirectory }
                      : {}),
                  }),
              ...(payload.associatedWorktreePath !== undefined
                ? { associatedWorktreePath: payload.associatedWorktreePath }
                : {}),
              ...(payload.associatedWorktreeBranch !== undefined
                ? { associatedWorktreeBranch: payload.associatedWorktreeBranch }
                : {}),
              ...(payload.associatedWorktreeRef !== undefined
                ? { associatedWorktreeRef: payload.associatedWorktreeRef }
                : {}),
              ...(nextCreateBranchFlowCompleted !== undefined
                ? { createBranchFlowCompleted: nextCreateBranchFlowCompleted }
                : {}),
              ...(isStudio
                ? {
                    associatedWorktreePath: null,
                    associatedWorktreeBranch: null,
                    associatedWorktreeRef: null,
                    createBranchFlowCompleted: false,
                  }
                : {}),
              ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
              ...(payload.settledAt !== undefined ? { settledAt: payload.settledAt } : {}),
              ...(payload.snoozedUntil !== undefined ? { snoozedUntil: payload.snoozedUntil } : {}),
              ...(payload.snoozeReminderAt !== undefined
                ? { snoozeReminderAt: payload.snoozeReminderAt }
                : {}),
              ...(payload.parentThreadId !== undefined
                ? { parentThreadId: payload.parentThreadId }
                : {}),
              ...(payload.subagentAgentId !== undefined
                ? { subagentAgentId: payload.subagentAgentId }
                : {}),
              ...(payload.subagentNickname !== undefined
                ? { subagentNickname: payload.subagentNickname }
                : {}),
              ...(payload.subagentRole !== undefined ? { subagentRole: payload.subagentRole } : {}),
              ...(payload.lastKnownPr !== undefined ? { lastKnownPr: payload.lastKnownPr } : {}),
              ...(payload.handoff !== undefined ? { handoff: payload.handoff } : {}),
              ...(payload.pinnedMessages !== undefined
                ? { pinnedMessages: payload.pinnedMessages }
                : {}),

              ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
              ...(payload.goal !== undefined ? { goal: payload.goal } : {}),
              ...(payload.goalStartedAt !== undefined
                ? { goalStartedAt: payload.goalStartedAt }
                : {}),
              ...(payload.goalPausedAt !== undefined ? { goalPausedAt: payload.goalPausedAt } : {}),
              ...(payload.goalAchievements !== undefined
                ? { goalAchievements: payload.goalAchievements }
                : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
        Effect.map((next) => applySidebarOrderProjection(next, event)),
      );

    case "thread.pinned-message-added":
      return decodeForEvent(
        ThreadPinnedMessageAddedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: addPinnedMessage(existingThread?.pinnedMessages, payload.pin),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-removed":
      return decodeForEvent(
        ThreadPinnedMessageRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: removePinnedMessage(
                existingThread?.pinnedMessages,
                payload.messageId,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-done-set":
      return decodeForEvent(
        ThreadPinnedMessageDoneSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageDone(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.done,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-label-set":
      return decodeForEvent(
        ThreadPinnedMessageLabelSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageLabel(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.label,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-added":
      return decodeForEvent(ThreadMarkerAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: addThreadMarker(existingThread?.threadMarkers, payload.marker),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-removed":
      return decodeForEvent(ThreadMarkerRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: removeThreadMarker(existingThread?.threadMarkers, payload.markerId),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-done-set":
      return decodeForEvent(ThreadMarkerDoneSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerDone(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.done,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-label-set":
      return decodeForEvent(ThreadMarkerLabelSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerLabel(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.label,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.claude-cache-set":
      return decodeForEvent(ThreadClaudeCacheSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            claudeCacheReview: payload.review,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const projectedModelSelection = deriveTurnStartModelSelection({
            currentModelSelection: thread.modelSelection,
            requestedModelSelection: canProjectTurnModelSelection(thread, payload.modelSelection)
              ? payload.modelSelection
              : undefined,
            canAdoptRequestedProvider: canAdoptFirstTurnProvider({
              hasLatestTurn: thread.latestTurn !== null,
              hasSession: thread.session !== null,
              messages: thread.messages,
            }),
          });
          const modelSelectionPatch =
            projectedModelSelection !== thread.modelSelection
              ? { modelSelection: projectedModelSelection }
              : {};
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName: projectedModelSelection.provider,
            providerInstanceId:
              projectedModelSelection.instanceId ??
              thread.session?.providerInstanceId ??
              projectedModelSelection.provider,
            requestedRuntimeMode: payload.runtimeMode,
            requestedAt: payload.createdAt,
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...modelSelectionPatch,
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              runtimeMode: payload.runtimeMode,
              interactionMode: payload.interactionMode,
              ...(isSidechatThread(thread) ? { sidechatLastActivityAt: payload.createdAt } : {}),
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "thread.async-user-input-answered":
      return decodeForEvent(
        ThreadAsyncUserInputAnsweredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages: thread.messages.map((message) =>
                message.id === payload.messageId && message.asyncUserInput
                  ? {
                      ...message,
                      asyncUserInput: {
                        ...message.asyncUserInput,
                        response: payload.response,
                        responseSequence: event.sequence,
                      },
                    }
                  : message,
              ),
            }),
          };
        }),
      );

    case "thread.turn-capacity-retry-requested":
      return decodeForEvent(
        ThreadTurnCapacityRetryRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread || thread.latestTurn?.turnId !== payload.turnId) {
            return nextBase;
          }
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName:
              thread.session?.providerName ??
              inferLegacyProviderKindFromModelSelection(thread.modelSelection),
            providerInstanceId:
              thread.session?.providerInstanceId ??
              thread.modelSelection.instanceId ??
              thread.modelSelection.provider,
            requestedRuntimeMode: thread.runtimeMode,
            requestedAt: payload.createdAt,
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "thread.turn-resume-requested":
      return decodeForEvent(
        ThreadTurnResumeRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread || thread.latestTurn?.turnId !== payload.turnId) {
            return nextBase;
          }
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName:
              thread.session?.providerName ??
              inferLegacyProviderKindFromModelSelection(thread.modelSelection),
            providerInstanceId:
              thread.session?.providerInstanceId ??
              thread.modelSelection.instanceId ??
              thread.modelSelection.provider,
            requestedRuntimeMode: thread.runtimeMode,
            requestedAt: payload.createdAt,
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.asyncUserInput ? { asyncUserInput: payload.asyncUserInput } : {}),
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
            ...(payload.mentions !== undefined ? { mentions: payload.mentions } : {}),
            ...(payload.dispatchMode !== undefined ? { dispatchMode: payload.dispatchMode } : {}),
            ...(payload.dispatchOrigin !== undefined
              ? { dispatchOrigin: payload.dispatchOrigin }
              : {}),
            ...(payload.startsNewTurn !== undefined
              ? { startsNewTurn: payload.startsNewTurn }
              : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            source: payload.source,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        // Hot path: one streamed delta must not cost a full copy-and-rebuild of
        // the transcript. Update the one affected slot in a single shallow copy
        // and only re-cap when the transcript actually grew past the limit.
        const existingIndex = findMessageIndexFromEnd(thread.messages, message.id);
        let cappedMessages: ReadonlyArray<OrchestrationMessage>;
        if (existingIndex >= 0) {
          const entry = thread.messages[existingIndex]!;
          const resolvedText = message.streaming
            ? `${entry.text}${message.text}`
            : message.text.length > 0
              ? message.text
              : entry.text;
          const nextSegments =
            message.role === "assistant"
              ? deriveNextMessageTextSegments(entry.textSegments, {
                  // For streaming deltas the segment owns only this delta's
                  // text (resolvedText is the whole accumulated message).
                  text: message.streaming ? message.text : resolvedText,
                  streaming: message.streaming,
                  segmentStartedAt: payload.segmentStartedAt,
                  sequence: payload.segmentSequence ?? event.sequence,
                  createdAt: payload.createdAt,
                  updatedAt: payload.updatedAt,
                })
              : undefined;
          const nextMessages = thread.messages.slice();
          const entryWithoutTextSegments = { ...entry };
          delete entryWithoutTextSegments.textSegments;
          nextMessages[existingIndex] = {
            ...entryWithoutTextSegments,
            ...(message.asyncUserInput ? { asyncUserInput: message.asyncUserInput } : {}),
            text: resolvedText,
            ...(nextSegments !== undefined ? { textSegments: nextSegments } : {}),
            streaming: message.streaming,
            source: message.source,
            updatedAt: message.updatedAt,
            turnId: resolveStableMessageTurnId({
              existingTurnId: entry.turnId,
              incomingTurnId: message.turnId,
            }),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(message.skills !== undefined ? { skills: message.skills } : {}),
            ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
            ...(message.dispatchMode !== undefined
              ? { dispatchMode: message.dispatchMode }
              : entry.dispatchMode !== undefined
                ? { dispatchMode: entry.dispatchMode }
                : {}),
            ...(message.dispatchOrigin !== undefined
              ? { dispatchOrigin: message.dispatchOrigin }
              : entry.dispatchOrigin !== undefined
                ? { dispatchOrigin: entry.dispatchOrigin }
                : {}),
            ...(message.startsNewTurn !== undefined
              ? { startsNewTurn: message.startsNewTurn }
              : entry.startsNewTurn !== undefined
                ? { startsNewTurn: entry.startsNewTurn }
                : {}),
          };
          cappedMessages = nextMessages;
        } else {
          const nextSegments =
            message.role === "assistant"
              ? deriveNextMessageTextSegments(undefined, {
                  text: message.text,
                  streaming: message.streaming,
                  segmentStartedAt: payload.segmentStartedAt,
                  sequence: payload.segmentSequence ?? event.sequence,
                  createdAt: payload.createdAt,
                  updatedAt: payload.updatedAt,
                })
              : undefined;
          cappedMessages =
            thread.messages.length >= MAX_THREAD_MESSAGES
              ? [
                  ...thread.messages.slice(thread.messages.length - MAX_THREAD_MESSAGES + 1),
                  {
                    ...message,
                    ...(nextSegments !== undefined ? { textSegments: nextSegments } : {}),
                  },
                ]
              : [
                  ...thread.messages,
                  {
                    ...message,
                    ...(nextSegments !== undefined ? { textSegments: nextSegments } : {}),
                  },
                ];
        }

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            ...(isSidechatThread(thread) && !thread.sidechatExpiredAt
              ? { sidechatLastActivityAt: session.updatedAt }
              : {}),
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? thread.latestTurn?.turnId === session.activeTurnId &&
                  isTerminalLatestTurn(thread.latestTurn)
                  ? thread.latestTurn
                  : {
                      turnId: session.activeTurnId,
                      state: "running",
                      requestedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.requestedAt
                          : session.updatedAt,
                      startedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? (thread.latestTurn.startedAt ?? session.updatedAt)
                          : session.updatedAt,
                      completedAt: null,
                      assistantMessageId:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.assistantMessageId
                          : null,
                    }
                : settleLatestTurnForSessionStatus(thread.latestTurn, session),
            updatedAt: maxIso(thread.updatedAt, event.occurredAt),
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Preserve the previous latestTurn assistantMessageId when the
        // incoming payload has none. Turn-diff placeholders can fire before
        // the assistant message is finalized — they must not erase a real id
        // that thread.message-sent has already recorded.
        const preservedAssistantMessageId =
          payload.assistantMessageId ??
          (thread.latestTurn?.turnId === payload.turnId
            ? thread.latestTurn.assistantMessageId
            : null);
        const previousLatestCheckpointTurnCount = thread.checkpoints.find(
          (entry) => entry.turnId === thread.latestTurn?.turnId,
        )?.checkpointTurnCount;
        const preservesNewerLatestTurn =
          payload.preserveLatestTurn === true ||
          (previousLatestCheckpointTurnCount !== undefined &&
            previousLatestCheckpointTurnCount > payload.checkpointTurnCount);
        const matchingLatestTurn =
          thread.latestTurn?.turnId === payload.turnId ? thread.latestTurn : null;
        const latestTurn = preservesNewerLatestTurn
          ? thread.latestTurn
          : matchingLatestTurn !== null
            ? {
                // Checkpoints describe filesystem state; the provider session is
                // the lifecycle authority. In particular, a successful empty git
                // capture must not turn an interrupted, answer-less turn into a
                // completed one merely because both checkpoint commands and
                // runtime ingestion subscribe to the same terminal event.
                ...matchingLatestTurn,
                assistantMessageId: preservedAssistantMessageId,
              }
            : {
                // Historical/sessionless checkpoint projections have no matching
                // lifecycle row to enrich, so retain the legacy reconstruction
                // behavior for those imports and rollback paths.
                turnId: payload.turnId,
                state: checkpointStatusToLatestTurnState(payload.status),
                requestedAt: payload.completedAt,
                startedAt: payload.completedAt,
                completedAt: payload.completedAt,
                assistantMessageId: preservedAssistantMessageId,
              };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn,
            updatedAt: maxIso(thread.updatedAt, event.occurredAt),
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const retainedMessages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          );
          const messages = clearRemovedAsyncUserInputResponses(
            retainedMessages,
            new Set(retainedMessages.map((message) => message.id)),
            event.sequence,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.conversation-rolled-back":
      return decodeForEvent(
        ThreadConversationRolledBackPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          if (payload.numTurns === 0) {
            return nextBase;
          }
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          // Safety-buffer retries roll back one superseded turn in the middle of
          // the transcript: unbound (null-turn) messages before AND after the
          // removed turn stay, including the anchor and any queued follow-ups.
          const payloadRemovedTurnIds = new Set(payload.removedTurnIds ?? []);
          const preserveUnbound =
            payload.preserveUnboundMessages === true && payloadRemovedTurnIds.size > 0;
          const rollback = preserveUnbound
            ? {
                messages: thread.messages.filter(
                  (message) =>
                    message.turnId === null || !payloadRemovedTurnIds.has(message.turnId),
                ),
                removedTurnIds: payloadRemovedTurnIds,
              }
            : rollbackThreadMessagesFromMessage(thread.messages, payload.messageId);
          if (
            rollback.messages === thread.messages ||
            (preserveUnbound && rollback.messages.length === thread.messages.length)
          ) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((checkpoint) => !rollback.removedTurnIds.has(checkpoint.turnId))
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const proposedPlans = thread.proposedPlans
            .filter((plan) => plan.turnId === null || !rollback.removedTurnIds.has(plan.turnId))
            .slice(-200);
          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !rollback.removedTurnIds.has(activity.turnId),
          );
          const latestCheckpoint = checkpoints.at(-1) ?? null;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages: clearRemovedAsyncUserInputResponses(
                rollback.messages,
                new Set(rollback.messages.map((message) => message.id)),
                event.sequence,
              ).slice(-MAX_THREAD_MESSAGES),
              proposedPlans,
              activities,
              latestTurn:
                latestCheckpoint === null
                  ? null
                  : {
                      turnId: latestCheckpoint.turnId,
                      state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                      requestedAt: latestCheckpoint.completedAt,
                      startedAt: latestCheckpoint.completedAt,
                      completedAt: latestCheckpoint.completedAt,
                      assistantMessageId: latestCheckpoint.assistantMessageId,
                    },
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.turn-interrupt-requested": {
      const thread = nextBase.threads.find((entry) => entry.id === event.payload.threadId);
      if (!thread) return Effect.succeed(nextBase);
      const activity = deriveTurnStopActivity(event, thread.session?.activeTurnId ?? null);
      return Effect.succeed(
        activity
          ? {
              ...nextBase,
              threads: updateThread(nextBase.threads, thread.id, {
                activities: upsertThreadActivity(thread.activities, activity),
                updatedAt: event.occurredAt,
              }),
            }
          : nextBase,
      );
    }

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = upsertThreadActivity(
            thread.activities,
            payload.activity.sequence !== undefined
              ? payload.activity
              : { ...payload.activity, sequence: event.sequence, sequenceSource: "orchestration" },
          );

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
