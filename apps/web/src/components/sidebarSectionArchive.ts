// FILE: sidebarSectionArchive.ts
// Purpose: Plans safe custom-section archive batches from authoritative sidebar ownership.
// Layer: Sidebar UI logic

import type { OrchestrationSidebarSectionShell, ThreadId, TurnId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";

import { isSessionRunningTurn } from "../session-logic";
import type { MossLocaleCode } from "../uiLocale";
import { buildSidebarSectionThreadTrees, resolveSidebarSectionThreadOwners } from "./Sidebar.logic";

export type SidebarSectionArchiveThread = {
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null;
  readonly archivedAt?: string | null;
  readonly session?: {
    readonly status: string;
    readonly activeTurnId?: TurnId | null | undefined;
  } | null;
};

export type SidebarSectionArchiveRootGroup = Readonly<{
  rootThreadId: ThreadId;
  affectedThreadIds: readonly ThreadId[];
  runningThreadIds: readonly ThreadId[];
  externalDescendantThreadIds: readonly ThreadId[];
}>;

export type SidebarSectionArchivePlan = Readonly<{
  sectionId: OrchestrationSidebarSectionShell["id"];
  sectionName: string;
  rootGroups: readonly SidebarSectionArchiveRootGroup[];
  eligibleRootGroups: readonly SidebarSectionArchiveRootGroup[];
  blockedRunningRootGroups: readonly SidebarSectionArchiveRootGroup[];
  blockedExternalDescendantRootGroups: readonly SidebarSectionArchiveRootGroup[];
}>;

export type SidebarSectionArchivePlanInput = Readonly<{
  sections: ReadonlyArray<OrchestrationSidebarSectionShell>;
  threads: ReadonlyArray<SidebarSectionArchiveThread>;
  pinnedThreadIds?: ReadonlySet<ThreadId> | readonly ThreadId[];
}>;

export type SidebarSectionArchiveBatchSummary = Readonly<{
  archivedRootCount: number;
  failedRootCount: number;
  skippedRunningRootCount: number;
  skippedExternalDescendantRootCount: number;
}>;

export type SidebarSectionArchiveExecutionInput = Readonly<{
  initialPlan: SidebarSectionArchivePlan;
  readCurrentPlan: () => SidebarSectionArchivePlan | null;
  archiveRoot: (
    group: SidebarSectionArchiveRootGroup,
    eligibleBatchThreadIds: ReadonlySet<ThreadId>,
  ) => Promise<boolean>;
  cancelled?: boolean;
}>;

export type SidebarSectionArchiveExecutionResult = Readonly<{
  summary: SidebarSectionArchiveBatchSummary;
  successfullyArchivedThreadIds: readonly ThreadId[];
  cancelled: boolean;
}>;

export type SidebarSectionArchiveToast = Readonly<{
  type: "error" | "info" | "success" | "warning";
  title: string;
  description: string;
}>;

function buildArchivePlanBySectionId(
  input: SidebarSectionArchivePlanInput,
): ReadonlyMap<OrchestrationSidebarSectionShell["id"], SidebarSectionArchivePlan> {
  const activeThreads = input.threads.filter((thread) => thread.archivedAt == null);
  const threadById = new Map(activeThreads.map((thread) => [thread.id, thread] as const));
  const owners = resolveSidebarSectionThreadOwners({
    sections: input.sections,
    threads: activeThreads,
    ...(input.pinnedThreadIds !== undefined ? { pinnedThreadIds: input.pinnedThreadIds } : {}),
  });
  const rootRowsBySectionId = buildSidebarSectionThreadTrees({
    sections: input.sections,
    threads: activeThreads,
    ...(input.pinnedThreadIds !== undefined ? { pinnedThreadIds: input.pinnedThreadIds } : {}),
  });
  const plans = new Map<OrchestrationSidebarSectionShell["id"], SidebarSectionArchivePlan>();

  for (const section of input.sections) {
    const rootThreadIds: ThreadId[] = [];
    const seenRootThreadIds = new Set<ThreadId>();
    for (const row of rootRowsBySectionId.get(section.id) ?? []) {
      if (row.depth !== 0 || seenRootThreadIds.has(row.thread.id)) continue;
      seenRootThreadIds.add(row.thread.id);
      rootThreadIds.push(row.thread.id);
    }

    const rootGroups: SidebarSectionArchiveRootGroup[] = rootThreadIds.map((rootThreadId) => {
      const affectedThreadIds = [
        rootThreadId,
        ...collectSubagentDescendants(activeThreads, rootThreadId)
          .map((thread) => thread.id)
          .filter((threadId) => threadId !== rootThreadId),
      ];
      const runningThreadIds = affectedThreadIds.filter((threadId) => {
        const thread = threadById.get(threadId);
        return thread !== undefined && isSessionRunningTurn(thread.session);
      });
      const externalDescendantThreadIds = affectedThreadIds
        .slice(1)
        .filter((threadId) => owners.get(threadId) !== section.id);
      return {
        rootThreadId,
        affectedThreadIds,
        runningThreadIds,
        externalDescendantThreadIds,
      };
    });
    const eligibleRootGroups = rootGroups.filter(
      (group) =>
        group.runningThreadIds.length === 0 && group.externalDescendantThreadIds.length === 0,
    );
    const blockedExternalDescendantRootGroups = rootGroups.filter(
      (group) => group.externalDescendantThreadIds.length > 0,
    );
    const blockedRunningRootGroups = rootGroups.filter(
      (group) =>
        group.externalDescendantThreadIds.length === 0 && group.runningThreadIds.length > 0,
    );
    plans.set(section.id, {
      sectionId: section.id,
      sectionName: section.name,
      rootGroups,
      eligibleRootGroups,
      blockedRunningRootGroups,
      blockedExternalDescendantRootGroups,
    });
  }

  return plans;
}

export function buildSidebarSectionArchivePlans(
  input: SidebarSectionArchivePlanInput,
): ReadonlyMap<OrchestrationSidebarSectionShell["id"], SidebarSectionArchivePlan> {
  return buildArchivePlanBySectionId(input);
}

export function buildSidebarSectionArchivePlan(
  input: SidebarSectionArchivePlanInput & {
    sectionId: OrchestrationSidebarSectionShell["id"];
  },
): SidebarSectionArchivePlan | null {
  return buildArchivePlanBySectionId(input).get(input.sectionId) ?? null;
}

const EMPTY_ARCHIVE_BATCH_SUMMARY: SidebarSectionArchiveBatchSummary = {
  archivedRootCount: 0,
  failedRootCount: 0,
  skippedRunningRootCount: 0,
  skippedExternalDescendantRootCount: 0,
};

function getPrimaryBlockedRootCounts(plan: SidebarSectionArchivePlan): {
  readonly running: number;
  readonly external: number;
} {
  const rootIds = new Set(plan.rootGroups.map((group) => group.rootThreadId));
  const externalRootIds = new Set(
    plan.blockedExternalDescendantRootGroups
      .map((group) => group.rootThreadId)
      .filter((rootThreadId) => rootIds.has(rootThreadId)),
  );
  const runningRootIds = new Set(
    plan.blockedRunningRootGroups
      .map((group) => group.rootThreadId)
      .filter((rootThreadId) => rootIds.has(rootThreadId) && !externalRootIds.has(rootThreadId)),
  );
  return {
    running: runningRootIds.size,
    external: externalRootIds.size,
  };
}

function getPrimaryBlockedRootReason(
  plan: SidebarSectionArchivePlan,
  rootThreadId: ThreadId,
): "running" | "external" | null {
  if (
    plan.blockedExternalDescendantRootGroups.some((group) => group.rootThreadId === rootThreadId)
  ) {
    return "external";
  }
  if (plan.blockedRunningRootGroups.some((group) => group.rootThreadId === rootThreadId)) {
    return "running";
  }
  return null;
}

export function getSidebarSectionArchiveBlockedRootCounts(plan: SidebarSectionArchivePlan): {
  readonly running: number;
  readonly external: number;
} {
  return getPrimaryBlockedRootCounts(plan);
}

/**
 * Executes a confirmed section plan through injected store/command adapters. The current plan
 * is re-read before every root so a pin, move, running turn, or disappearance after confirmation
 * fails closed without duplicating the server's root cascade.
 */
export async function executeSidebarSectionArchivePlan(
  input: SidebarSectionArchiveExecutionInput,
): Promise<SidebarSectionArchiveExecutionResult> {
  if (input.cancelled === true) {
    return {
      summary: EMPTY_ARCHIVE_BATCH_SUMMARY,
      successfullyArchivedThreadIds: [],
      cancelled: true,
    };
  }

  const eligibleBatchThreadIds = new Set<ThreadId>();
  for (const group of input.initialPlan.eligibleRootGroups) {
    for (const threadId of group.affectedThreadIds) {
      eligibleBatchThreadIds.add(threadId);
    }
  }

  let archivedRootCount = 0;
  let failedRootCount = 0;
  const initialBlockedRootCounts = getPrimaryBlockedRootCounts(input.initialPlan);
  let skippedRunningRootCount = initialBlockedRootCounts.running;
  let skippedExternalDescendantRootCount = initialBlockedRootCounts.external;
  const successfullyArchivedThreadIds = new Set<ThreadId>();

  for (const plannedGroup of input.initialPlan.eligibleRootGroups) {
    const currentPlan = input.readCurrentPlan();
    const currentGroup = currentPlan?.eligibleRootGroups.find(
      (group) => group.rootThreadId === plannedGroup.rootThreadId,
    );
    if (!currentGroup) {
      const blockReason = currentPlan
        ? getPrimaryBlockedRootReason(currentPlan, plannedGroup.rootThreadId)
        : null;
      if (blockReason === "external") {
        skippedExternalDescendantRootCount += 1;
      } else if (blockReason === "running") {
        skippedRunningRootCount += 1;
      } else {
        failedRootCount += 1;
      }
      continue;
    }

    for (const threadId of currentGroup.affectedThreadIds) {
      eligibleBatchThreadIds.add(threadId);
    }

    let archived = false;
    try {
      archived = await input.archiveRoot(currentGroup, eligibleBatchThreadIds);
    } catch {
      archived = false;
    }

    if (archived) {
      archivedRootCount += 1;
      for (const threadId of currentGroup.affectedThreadIds) {
        successfullyArchivedThreadIds.add(threadId);
      }
      continue;
    }

    const failurePlan = input.readCurrentPlan();
    const blockReason = failurePlan
      ? getPrimaryBlockedRootReason(failurePlan, plannedGroup.rootThreadId)
      : null;
    if (blockReason === "external") {
      skippedExternalDescendantRootCount += 1;
    } else if (blockReason === "running") {
      skippedRunningRootCount += 1;
    } else {
      failedRootCount += 1;
    }
  }

  return {
    summary: {
      archivedRootCount,
      failedRootCount,
      skippedRunningRootCount,
      skippedExternalDescendantRootCount,
    },
    successfullyArchivedThreadIds: [...successfullyArchivedThreadIds],
    cancelled: false,
  };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

export function sidebarSectionArchiveResultToast(
  locale: MossLocaleCode,
  sectionName: string,
  summary: SidebarSectionArchiveBatchSummary,
): SidebarSectionArchiveToast {
  const hasSkippedRoots =
    summary.skippedRunningRootCount > 0 || summary.skippedExternalDescendantRootCount > 0;
  const hasFailures = summary.failedRootCount > 0;

  if (locale === "zh-CN") {
    const title =
      summary.archivedRootCount > 0
        ? `已归档 ${summary.archivedRootCount} 个对话`
        : hasFailures
          ? "归档对话失败"
          : "未归档任何对话";
    const lines: string[] = [];
    if (summary.archivedRootCount > 0) {
      lines.push(`已归档“${sectionName}”中的 ${summary.archivedRootCount} 个对话。`);
    }
    if (summary.failedRootCount > 0) {
      lines.push(`归档失败：${summary.failedRootCount} 个对话。`);
    }
    if (summary.skippedRunningRootCount > 0) {
      lines.push(`跳过：${summary.skippedRunningRootCount} 个正在运行的对话。`);
    }
    if (summary.skippedExternalDescendantRootCount > 0) {
      lines.push(`跳过：${summary.skippedExternalDescendantRootCount} 个位于本分区外的关联对话。`);
    }
    const type =
      hasFailures || hasSkippedRoots
        ? summary.archivedRootCount > 0
          ? "warning"
          : "error"
        : "success";
    return { type, title, description: lines.join(" ") };
  }

  const title =
    summary.archivedRootCount > 0
      ? `Archived ${countLabel(summary.archivedRootCount, "chat")}`
      : hasFailures
        ? "Failed to archive chats"
        : "No chats archived";
  const lines: string[] = [];
  if (summary.archivedRootCount > 0) {
    lines.push(`Archived ${countLabel(summary.archivedRootCount, "chat")} in "${sectionName}".`);
  }
  if (summary.failedRootCount > 0) {
    lines.push(`Failed to archive ${countLabel(summary.failedRootCount, "chat")}.`);
  }
  if (summary.skippedRunningRootCount > 0) {
    lines.push(`Skipped ${countLabel(summary.skippedRunningRootCount, "running chat")}.`);
  }
  if (summary.skippedExternalDescendantRootCount > 0) {
    lines.push(
      `Skipped ${countLabel(summary.skippedExternalDescendantRootCount, "linked chat", "linked chats")} outside this section.`,
    );
  }
  const type =
    hasFailures || hasSkippedRoots
      ? summary.archivedRootCount > 0
        ? "warning"
        : "error"
      : "success";
  return { type, title, description: lines.join(" ") };
}

export function sidebarSectionArchiveNothingToast(
  locale: MossLocaleCode,
  sectionName: string,
): SidebarSectionArchiveToast {
  return locale === "zh-CN"
    ? {
        type: "info",
        title: "无需归档",
        description: `“${sectionName}”中没有可归档的对话。`,
      }
    : {
        type: "info",
        title: "Nothing to archive",
        description: `"${sectionName}" has no chats to archive.`,
      };
}
