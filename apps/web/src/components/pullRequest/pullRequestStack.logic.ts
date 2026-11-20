import type { PullRequestDetail, PullRequestStack, PullRequestStackEntry } from "@moss/contracts";

import { formatMossTranslation, type TranslationKey } from "~/localization";

/** Words in the reader's language; English when absent (tests and logs). */
type StackTextFormat = (key: TranslationKey, values?: Record<string, string | number>) => string;

const englishStackText: StackTextFormat = (key, values) =>
  formatMossTranslation("en", key, values ?? {});

/** The translation key of each assessment label, for surfaces that show it. */
export const PULL_REQUEST_STACK_LABEL_KEYS: Record<
  PullRequestStackAssessment["label"],
  TranslationKey
> = {
  "Ready to merge": "codeReview.stack.label.ready",
  "Stack needs attention": "codeReview.stack.label.attention",
  "Merge status pending": "codeReview.stack.label.pending",
  "Mergeable with failing checks": "codeReview.stack.label.failingChecks",
  "Stack merged": "codeReview.stack.label.merged",
};

export type PullRequestStackAssessment = {
  readonly label:
    | "Ready to merge"
    | "Stack needs attention"
    | "Merge status pending"
    | "Mergeable with failing checks"
    | "Stack merged";
  readonly tone: "ready" | "blocked" | "pending" | "warning" | "complete";
  readonly mergeTargetCount: number;
  readonly canAttemptMerge: boolean;
  readonly blocker: string | null;
};

/** Entries affected by merging the selected PR, ordered from the base branch upwards. */
export function pullRequestStackTargetEntries(
  stack: PullRequestStack,
): ReadonlyArray<PullRequestStackEntry> {
  return stack.entries.filter(
    (entry) => entry.position <= stack.position && entry.state !== "merged",
  );
}

export function assessPullRequestStack(
  stack: PullRequestStack,
  format: StackTextFormat = englishStackText,
): PullRequestStackAssessment {
  const targets = pullRequestStackTargetEntries(stack);
  if (targets.length === 0) {
    return {
      label: "Stack merged",
      tone: "complete",
      mergeTargetCount: 0,
      canAttemptMerge: false,
      blocker: null,
    };
  }

  const closed = targets.find((entry) => entry.state === "closed");
  if (closed) {
    return {
      label: "Stack needs attention",
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: format("codeReview.stack.closedBlocker", { number: closed.number }),
    };
  }

  const draft = targets.find((entry) => entry.isDraft);
  if (draft) {
    return {
      label: "Stack needs attention",
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: format("codeReview.stack.draftBlocker", { number: draft.number }),
    };
  }

  const conflicting = targets.find(
    (entry) =>
      entry.mergeability === "conflicting" ||
      ["BLOCKED", "DIRTY", "DRAFT"].includes(entry.mergeStateStatus ?? ""),
  );
  if (conflicting) {
    return {
      label: "Stack needs attention",
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: format("codeReview.stack.notReadyBlocker", { number: conflicting.number }),
    };
  }

  if (targets.some((entry) => entry.mergeStateStatus === "UNSTABLE")) {
    return {
      label: "Mergeable with failing checks",
      tone: "warning",
      mergeTargetCount: targets.length,
      canAttemptMerge: true,
      blocker: null,
    };
  }

  const pending = targets.some(
    (entry) =>
      entry.mergeability === "unknown" ||
      entry.mergeStateStatus === null ||
      ["BEHIND", "UNKNOWN"].includes(entry.mergeStateStatus),
  );
  if (pending) {
    return {
      label: "Merge status pending",
      tone: "pending",
      mergeTargetCount: targets.length,
      canAttemptMerge: true,
      blocker: null,
    };
  }

  return {
    label: "Ready to merge",
    tone: "ready",
    mergeTargetCount: targets.length,
    canAttemptMerge: true,
    blocker: null,
  };
}

export function pullRequestMergeBlocker(
  detail: Pick<PullRequestDetail, "mergeability" | "stackMetadataIncomplete">,
  stackAssessment: PullRequestStackAssessment | null,
  format: StackTextFormat = englishStackText,
): string | null {
  if (detail.stackMetadataIncomplete === true) {
    return format("codeReview.stack.unavailable");
  }
  if (stackAssessment?.canAttemptMerge === false) {
    return stackAssessment.blocker ?? format("codeReview.stack.notReady");
  }
  return detail.mergeability === "conflicting" ? format("codeReview.merge.resolveConflicts") : null;
}
