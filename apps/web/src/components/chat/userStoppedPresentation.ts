import type {
  ClientOrchestrationCommand,
  MessageId,
  OrchestrationLatestTurn,
  ThreadId,
  TurnId,
} from "@synara/contracts";

import type { ChatMessage } from "../../types";

type UserStoppedLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt" | "assistantMessageId"
>;
type UserStoppedMessage = Pick<ChatMessage, "id" | "role"> &
  Partial<Pick<ChatMessage, "createdAt">>;

export interface UserStoppedCandidate {
  threadId: ThreadId;
  turnId: TurnId;
  userMessageId: MessageId;
  startedAt: string;
  requestedAt: string;
}

export interface UserStoppedRecord extends UserStoppedCandidate {
  completedAt: string;
}

export type UserStoppedInterruptCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.turn.interrupt" }
>;

export interface UserStoppedAttributionState {
  pendingByThreadId: ReadonlyMap<string, UserStoppedCandidate>;
  confirmedByThreadId: ReadonlyMap<string, ReadonlyMap<string, UserStoppedRecord>>;
}

export const EMPTY_USER_STOPPED_RECORDS: readonly UserStoppedRecord[] = [];

export function createUserStoppedAttributionState(): UserStoppedAttributionState {
  return {
    pendingByThreadId: new Map(),
    confirmedByThreadId: new Map(),
  };
}

/** Keep the current-response stop command tied to the exact captured turn. */
export function buildUserStoppedInterruptCommand(input: {
  commandId: UserStoppedInterruptCommand["commandId"];
  threadId: ThreadId;
  turnId?: TurnId;
  createdAt: UserStoppedInterruptCommand["createdAt"];
}): UserStoppedInterruptCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: input.commandId,
    threadId: input.threadId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    createdAt: input.createdAt,
  };
}

/** Capture only the exact in-flight turn and its preceding user message. */
export function captureUserStoppedCandidate(input: {
  threadId: ThreadId;
  latestTurn: UserStoppedLatestTurn | null | undefined;
  messages: ReadonlyArray<UserStoppedMessage>;
  requestedAt: string;
}): UserStoppedCandidate | null {
  const latestTurn = input.latestTurn;
  if (!latestTurn || latestTurn.state !== "running") {
    return null;
  }

  const userMessageId = findTurnUserMessageId(
    input.messages,
    latestTurn.assistantMessageId,
    latestTurn.requestedAt,
  );
  if (!userMessageId) {
    return null;
  }

  const startedAt = latestTurn.startedAt ?? input.requestedAt;
  if (!isUsableTimestamp(startedAt) || !isUsableTimestamp(input.requestedAt)) {
    return null;
  }

  return {
    threadId: input.threadId,
    turnId: latestTurn.turnId,
    userMessageId,
    startedAt,
    requestedAt: input.requestedAt,
  };
}

export function registerUserStoppedCandidate(
  state: UserStoppedAttributionState,
  candidate: UserStoppedCandidate,
): UserStoppedAttributionState {
  const threadKey = String(candidate.threadId);
  const current = state.pendingByThreadId.get(threadKey);
  if (sameCandidate(current, candidate)) {
    return state;
  }
  const pendingByThreadId = new Map(state.pendingByThreadId);
  pendingByThreadId.set(threadKey, candidate);
  return { ...state, pendingByThreadId };
}

/**
 * Promote only after the same captured turn is durably interrupted. Pending
 * candidates are deliberately kept in memory and keyed by thread so a thread
 * switch cannot leak a label into another transcript.
 */
export function reconcileUserStoppedAttribution(input: {
  state: UserStoppedAttributionState;
  threadId: ThreadId;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> | null | undefined;
}): UserStoppedAttributionState {
  const threadKey = String(input.threadId);
  const pending = input.state.pendingByThreadId.get(threadKey);
  if (!pending) {
    return input.state;
  }

  const latestTurn = input.latestTurn;
  // A temporarily absent detail snapshot is unknown, not proof that the
  // captured turn disappeared. Keep the candidate until a concrete snapshot
  // can confirm or reject its exact turn id.
  if (!latestTurn) {
    return input.state;
  }
  if (latestTurn.turnId !== pending.turnId) {
    return removePendingCandidate(input.state, threadKey);
  }

  if (latestTurn.state === "completed" || latestTurn.state === "error") {
    return removePendingCandidate(input.state, threadKey);
  }

  if (latestTurn.state !== "interrupted" || !isUsableTimestamp(latestTurn.completedAt)) {
    return input.state;
  }

  const pendingByThreadId = new Map(input.state.pendingByThreadId);
  pendingByThreadId.delete(threadKey);
  const confirmedForThread = new Map(input.state.confirmedByThreadId.get(threadKey) ?? []);
  const record: UserStoppedRecord = {
    ...pending,
    completedAt: latestTurn.completedAt,
  };
  const turnKey = String(record.turnId);
  const previousRecord = confirmedForThread.get(turnKey);
  if (previousRecord && sameRecord(previousRecord, record)) {
    return { ...input.state, pendingByThreadId };
  }
  confirmedForThread.set(turnKey, record);
  const confirmedByThreadId = new Map(input.state.confirmedByThreadId);
  confirmedByThreadId.set(threadKey, confirmedForThread);
  return { pendingByThreadId, confirmedByThreadId };
}

export function selectUserStoppedRecords(
  state: UserStoppedAttributionState,
  threadId: ThreadId | null | undefined,
): readonly UserStoppedRecord[] {
  if (!threadId) {
    return EMPTY_USER_STOPPED_RECORDS;
  }
  const records = state.confirmedByThreadId.get(String(threadId));
  if (!records || records.size === 0) {
    return EMPTY_USER_STOPPED_RECORDS;
  }
  return [...records.values()].sort((left, right) => {
    const byStart = left.startedAt.localeCompare(right.startedAt);
    return byStart !== 0 ? byStart : String(left.turnId).localeCompare(String(right.turnId));
  });
}

function findTurnUserMessageId(
  messages: ReadonlyArray<UserStoppedMessage>,
  assistantMessageId: MessageId | null,
  turnRequestedAt: string | null | undefined,
): MessageId | null {
  const startIndex =
    assistantMessageId === null
      ? messages.length
      : messages.findIndex((message) => message.id === assistantMessageId);
  if (startIndex < 0) {
    return null;
  }
  const requestedAtMs = assistantMessageId === null ? parseTimestamp(turnRequestedAt) : null;
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      (requestedAtMs === null ||
        message.createdAt === undefined ||
        (parseTimestamp(message.createdAt) ?? Number.POSITIVE_INFINITY) <= requestedAtMs)
    ) {
      return message.id;
    }
  }
  return null;
}

function removePendingCandidate(
  state: UserStoppedAttributionState,
  threadKey: string,
): UserStoppedAttributionState {
  const pendingByThreadId = new Map(state.pendingByThreadId);
  pendingByThreadId.delete(threadKey);
  return { ...state, pendingByThreadId };
}

function sameCandidate(
  left: UserStoppedCandidate | undefined,
  right: UserStoppedCandidate,
): boolean {
  return (
    left?.threadId === right.threadId &&
    left?.turnId === right.turnId &&
    left?.userMessageId === right.userMessageId &&
    left?.startedAt === right.startedAt &&
    left?.requestedAt === right.requestedAt
  );
}

function sameRecord(left: UserStoppedRecord, right: UserStoppedRecord): boolean {
  return sameCandidate(left, right) && left.completedAt === right.completedAt;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isUsableTimestamp(value: string | null | undefined): value is string {
  return parseTimestamp(value) !== null;
}
