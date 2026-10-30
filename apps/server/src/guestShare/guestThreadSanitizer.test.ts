import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  modelSelectionOfEvent,
  sanitizeGuestThread,
  sanitizeGuestThreadEvent,
  sanitizeGuestThreadSnapshot,
} from "./guestThreadSanitizer.ts";

const NOW = "2026-10-29T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const turn = (index: number) => TurnId.makeUnsafe(`turn-${index}`);

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  turnId: string | null,
  createdAt = NOW,
): OrchestrationMessage => ({
  id: MessageId.makeUnsafe(id),
  role,
  text: id,
  turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
  streaming: false,
  source: "native",
  createdAt,
  updatedAt: createdAt,
});

const activity = (
  id: string,
  turnId: string | null,
  createdAt = NOW,
): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(id),
  tone: "tool",
  kind: "tool.updated",
  summary: id,
  payload: {},
  turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
  createdAt,
});

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Fix the build",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/secret",
    worktreePath: "/home/owner/.moss/worktrees/x",
    workingDirectory: "/home/owner/project",
    associatedWorktreePath: "/home/owner/wt",
    associatedWorktreeBranch: "wt",
    associatedWorktreeRef: "refs/heads/wt",
    gatewayOperationId: "op-1",
    gatewayOperationIndex: 1,
    lastKnownPr: {
      number: 12,
      title: "PR",
      url: "https://github.com/x/y/pull/12",
      baseBranch: "main",
      headBranch: "wt",
      state: "open",
    },
    createdAt: NOW,
    updatedAt: NOW,
    latestTurn: null,
    handoff: {
      sourceThreadId: ThreadId.makeUnsafe("thread-0"),
      sourceProvider: "codex",
      importedAt: NOW,
      bootstrapStatus: "pending",
    },
    notes: "owner notes",
    pinnedMessages: [],
    threadMarkers: [],
    goal: "ship it",
    goalStartedAt: NOW,
    goalPausedAt: null,
    goalAchievements: [],
    pendingInteractions: [],
    hasPendingApprovals: true,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    archivedAt: null,
    session: null,
    ...overrides,
  } as OrchestrationThread;
}

let sequence = 100;
const event = <T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): OrchestrationEvent =>
  ({
    sequence: sequence++,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe("command-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  }) as OrchestrationEvent;

describe("sanitizeGuestThread", () => {
  it("clears owner-private fields and local paths, keeping the transcript and summary flags", () => {
    const sanitized = sanitizeGuestThread(makeThread());
    expect(sanitized).toMatchObject({
      id: THREAD_ID,
      title: "Fix the build",
      modelSelection: { provider: "codex", model: "gpt-5.5" },
      branch: null,
      worktreePath: null,
      workingDirectory: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      gatewayOperationId: null,
      gatewayOperationIndex: null,
      lastKnownPr: null,
      handoff: null,
      claudeCacheReview: null,
      hasPendingApprovals: true,
    });
    for (const key of [
      "notes",
      "pinnedMessages",
      "threadMarkers",
      "goal",
      "goalStartedAt",
      "goalPausedAt",
      "goalAchievements",
      "pendingInteractions",
    ]) {
      expect(sanitized).not.toHaveProperty(key);
    }
  });
});

describe("sanitizeGuestThreadSnapshot", () => {
  it("keeps the newest user turns with their activities, plans, and checkpoints", () => {
    const thread = makeThread({
      messages: [
        message("u1", "user", "turn-1", "2026-10-29T09:00:00.000Z"),
        message("a1", "assistant", "turn-1", "2026-10-29T09:01:00.000Z"),
        message("u2", "user", "turn-2", "2026-10-29T09:02:00.000Z"),
        message("a2", "assistant", "turn-2", "2026-10-29T09:03:00.000Z"),
        message("u3", "user", "turn-3", "2026-10-29T09:04:00.000Z"),
        message("a3", "assistant", null, "2026-10-29T09:05:00.000Z"),
      ],
      activities: [
        activity("act-1", "turn-1"),
        activity("act-2", "turn-2"),
        activity("act-old", null, "2026-10-29T08:00:00.000Z"),
        activity("act-3", "turn-3"),
        activity("act-new", null, "2026-10-29T09:06:00.000Z"),
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: turn(1),
          planMarkdown: "old",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "plan-3",
          turnId: turn(3),
          planMarkdown: "new",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      checkpoints: [
        {
          turnId: turn(1),
          checkpointTurnCount: 1,
          checkpointRef: "ref-1" as never,
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: NOW,
        },
        {
          turnId: turn(2),
          checkpointTurnCount: 2,
          checkpointRef: "ref-2" as never,
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: NOW,
        },
      ],
    });
    const snapshot = sanitizeGuestThreadSnapshot(
      { snapshotSequence: 42, thread, history: { totalMessageCount: 60, olderCursor: null } },
      { userTurnLimit: 2, messageLimit: 600 },
    );
    expect(snapshot.snapshotSequence).toBe(42);
    expect(snapshot.thread.messages.map((entry) => entry.id)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(snapshot.thread.activities.map((entry) => entry.id)).toEqual([
      "act-2",
      "act-3",
      "act-new",
    ]);
    expect(snapshot.thread.proposedPlans.map((plan) => plan.id)).toEqual(["plan-3"]);
    expect(snapshot.thread.checkpoints.map((checkpoint) => checkpoint.turnId)).toEqual([turn(2)]);
    expect(snapshot.history).toEqual({
      totalMessageCount: 4,
      olderCursor: null,
      olderActivityCursor: null,
      totalActivityCount: 3,
    });
  });

  it("leaves a short thread whole and applies the message limit", () => {
    const thread = makeThread({
      messages: [message("u1", "user", "turn-1"), message("a1", "assistant", "turn-1")],
      activities: [activity("act-old", null, "2026-10-29T08:00:00.000Z")],
    });
    const whole = sanitizeGuestThreadSnapshot(
      { snapshotSequence: 1, thread },
      { userTurnLimit: 20, messageLimit: 600 },
    );
    expect(whole.thread.messages).toHaveLength(2);
    expect(whole.thread.activities).toHaveLength(1);
    const limited = sanitizeGuestThreadSnapshot(
      { snapshotSequence: 1, thread },
      { userTurnLimit: 20, messageLimit: 1 },
    );
    expect(limited.thread.messages.map((entry) => entry.id)).toEqual(["a1"]);
  });
});

describe("sanitizeGuestThreadEvent", () => {
  it("forwards transcript events and drops owner-private ones", () => {
    const sent = event("thread.message-sent", {
      threadId: THREAD_ID,
      messageId: MessageId.makeUnsafe("m-1"),
      role: "assistant",
      text: "hi",
      turnId: null,
      streaming: false,
      source: "native",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(sanitizeGuestThreadEvent(sent)).toEqual(sent);
    expect(
      sanitizeGuestThreadEvent(
        event("thread.pinned-message-added", {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("m-1"),
          updatedAt: NOW,
        } as never),
      ),
    ).toBeNull();
    expect(
      sanitizeGuestThreadEvent(
        event("thread.archived", { threadId: THREAD_ID, archivedAt: NOW, updatedAt: NOW }),
      ),
    ).toBeNull();
    expect(
      sanitizeGuestThreadEvent(
        event("thread.claude-cache-set", { threadId: THREAD_ID, review: null, updatedAt: NOW }),
      ),
    ).toBeNull();
  });

  it("keeps only the title, model, and environment mode of a metadata update", () => {
    const update = event("thread.meta-updated", {
      threadId: THREAD_ID,
      title: "Renamed",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-sonnet-5",
      },
      notes: "private",
      worktreePath: "/home/owner/wt",
      isPinned: true,
      updatedAt: NOW,
    });
    expect(sanitizeGuestThreadEvent(update)).toEqual({
      ...update,
      payload: {
        threadId: THREAD_ID,
        title: "Renamed",
        modelSelection: {
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          model: "claude-sonnet-5",
        },
        updatedAt: NOW,
      },
    });
    expect(modelSelectionOfEvent(update)).toEqual({
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
    });
    expect(
      sanitizeGuestThreadEvent(
        event("thread.meta-updated", { threadId: THREAD_ID, notes: "private", updatedAt: NOW }),
      ),
    ).toBeNull();
  });

  it("strips provider options from a turn start like the owner stream does", () => {
    const start = event("thread.turn-start-requested", {
      threadId: THREAD_ID,
      messageId: MessageId.makeUnsafe("m-1"),
      providerOptions: { codex: { environment: { OPENAI_API_KEY: "sk-secret" } } } as never,
      dispatchMode: "queue",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    });
    const sanitized = sanitizeGuestThreadEvent(start);
    expect(sanitized?.type).toBe("thread.turn-start-requested");
    expect(JSON.stringify(sanitized)).not.toContain("sk-secret");
    expect(sanitized?.payload).toMatchObject({ providerOptions: { codex: { environment: {} } } });
  });
});
