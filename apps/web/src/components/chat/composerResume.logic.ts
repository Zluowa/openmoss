import {
  isRetryableCodexTurnFailure,
  type OrchestrationThread,
  type ProviderKind,
  type TurnId,
} from "@synara/contracts";

type ResumeThread = Pick<
  OrchestrationThread,
  "id" | "latestTurn" | "activities" | "parentThreadId" | "subagentAgentId"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function latestTurnCompletion(
  thread: ResumeThread,
  turnId: TurnId,
): Record<string, unknown> | null {
  const completion = thread.activities
    .filter((activity) => activity.kind === "turn.completed" && activity.turnId === turnId)
    .toSorted(
      (left, right) =>
        (right.sequence ?? -1) - (left.sequence ?? -1) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )
    .at(0);
  return asRecord(completion?.payload);
}

export interface ComposerResumeEligibilityInput {
  readonly thread: ResumeThread | null | undefined;
  readonly provider: ProviderKind | null;
  readonly isServerThread: boolean;
  readonly hasSendableContent: boolean;
  readonly isResponseInProgress: boolean;
  /** A non-empty, unpaused goal owns the next continuation. */
  readonly hasActiveUnpausedGoal: boolean;
  readonly hasQueuedTurn: boolean;
  readonly hasPendingInteraction: boolean;
  readonly hasPlanFollowUp: boolean;
  /** Resume admission is fail-closed: only the ready state may dispatch. */
  readonly providerAdmissionState: "ready" | "preflight" | "blocked";
  readonly isLoading: boolean;
}

/** True only for the current terminal Codex turn that the server can resume. */
export function isComposerResumeEligible(input: ComposerResumeEligibilityInput): boolean {
  const thread = input.thread;
  const latestTurn = thread?.latestTurn;
  if (
    !input.isServerThread ||
    input.provider !== "codex" ||
    thread === null ||
    thread === undefined ||
    thread.parentThreadId != null ||
    thread.subagentAgentId != null ||
    latestTurn === null ||
    latestTurn === undefined ||
    latestTurn.completedAt === null ||
    latestTurn.completedAt === undefined ||
    input.hasSendableContent ||
    input.isResponseInProgress ||
    input.hasActiveUnpausedGoal ||
    input.hasQueuedTurn ||
    input.hasPendingInteraction ||
    input.hasPlanFollowUp ||
    input.providerAdmissionState !== "ready" ||
    input.isLoading
  ) {
    return false;
  }
  if (latestTurn.state === "interrupted") {
    return true;
  }
  if (latestTurn.state !== "error") {
    return false;
  }
  const payload = latestTurnCompletion(thread, latestTurn.turnId);
  return (
    payload?.state === "failed" &&
    isRetryableCodexTurnFailure({
      state: payload.state,
      errorInfo: payload.errorInfo,
      errorMessage: payload.errorMessage,
    })
  );
}

export function hasComposerResumeProjectionAdvancedSince(
  baselineUpdatedAt: string | null | undefined,
  currentUpdatedAt: string | null | undefined,
): boolean {
  if (currentUpdatedAt === null || currentUpdatedAt === undefined) return false;
  if (baselineUpdatedAt === null || baselineUpdatedAt === undefined) return true;
  const baselineMs = Date.parse(baselineUpdatedAt);
  const currentMs = Date.parse(currentUpdatedAt);
  if (!Number.isFinite(baselineMs) || !Number.isFinite(currentMs)) {
    return currentUpdatedAt !== baselineUpdatedAt;
  }
  return currentMs > baselineMs;
}

export function isComposerResumePendingForThread(input: {
  readonly activeThreadId: string | null | undefined;
  readonly inFlightThreadId: string | null | undefined;
  readonly inFlightTurnId: string | null | undefined;
}): boolean {
  return (
    input.inFlightTurnId !== null &&
    input.inFlightTurnId !== undefined &&
    input.inFlightThreadId !== null &&
    input.inFlightThreadId !== undefined &&
    input.activeThreadId === input.inFlightThreadId
  );
}
