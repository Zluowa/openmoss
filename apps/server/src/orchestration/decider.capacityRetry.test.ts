import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-08-29T00:00:00.000Z";
const FAILED_AT = "2026-08-29T00:00:10.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-capacity");
const TURN_ID = TurnId.makeUnsafe("turn-capacity");

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-capacity"),
    title: "Capacity",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    parentThreadId: null,
    subagentAgentId: null,
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: FAILED_AT,
    latestTurn: {
      turnId: TURN_ID,
      state: "error",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: FAILED_AT,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    handoff: null,
    messages: [
      {
        id: MessageId.makeUnsafe("user-capacity"),
        role: "user",
        text: "hello",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [
      {
        id: EventId.makeUnsafe("activity-capacity"),
        tone: "error",
        kind: "turn.completed",
        summary: "Turn failed",
        payload: { state: "failed", errorInfo: "serverOverloaded" },
        turnId: TURN_ID,
        sequence: 2,
        createdAt: FAILED_AT,
      },
    ],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    archivedAt: null,
    session: {
      threadId: THREAD_ID,
      status: "error",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: "server overloaded",
      updatedAt: FAILED_AT,
    },
    ...overrides,
  };
}

function makeReadModel(
  thread: OrchestrationReadModel["threads"][number] = makeThread(),
): OrchestrationReadModel {
  return {
    snapshotSequence: 2,
    spaces: [],
    projects: [],
    threads: [thread],
    updatedAt: FAILED_AT,
  };
}

function capacityCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "thread.turn.capacity-retry" as const,
    commandId: CommandId.makeUnsafe("command-capacity"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    trigger: "capacity_retry_manual" as const,
    createdAt: FAILED_AT,
    ...overrides,
  };
}

describe("capacity retry decider", () => {
  it("accepts only the current typed Codex overload and emits a minimal event", async () => {
    const event = await Effect.runPromise(
      decideOrchestrationCommand({ command: capacityCommand(), readModel: makeReadModel() }),
    );
    expect(event).toMatchObject({
      type: "thread.turn-capacity-retry-requested",
      payload: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        trigger: "capacity_retry_manual",
        createdAt: FAILED_AT,
      },
    });
    expect(Object.keys((event as Omit<OrchestrationEvent, "sequence">).payload)).toEqual([
      "threadId",
      "turnId",
      "trigger",
      "createdAt",
    ]);
  });

  const rejectionCases: ReadonlyArray<
    readonly [string, Partial<OrchestrationReadModel["threads"][number]>]
  > = [
    [
      "stale turn",
      { latestTurn: { ...makeThread().latestTurn!, turnId: TurnId.makeUnsafe("turn-old") } },
    ],
    [
      "usage limit",
      {
        activities: [
          {
            ...makeThread().activities[0]!,
            payload: { state: "failed", errorInfo: "usageLimitExceeded" },
          },
        ],
      },
    ],
    [
      "generic error",
      {
        activities: [
          { ...makeThread().activities[0]!, payload: { state: "failed", errorInfo: "other" } },
        ],
      },
    ],
    ["non-Codex provider", { session: { ...makeThread().session!, providerName: "claudeAgent" } }],
    ["starting session", { session: { ...makeThread().session!, status: "starting" } }],
    ["running session", { session: { ...makeThread().session!, status: "running" } }],
    ["archived thread", { archivedAt: FAILED_AT }],
    ["deleted thread", { deletedAt: FAILED_AT }],
    ["child thread", { parentThreadId: ThreadId.makeUnsafe("thread-parent") }],
    [
      "routed provider thread",
      { session: { ...makeThread().session!, threadId: ThreadId.makeUnsafe("provider-child") } },
    ],
    ["unbound queued user message", { messages: [{ ...makeThread().messages[0]!, turnId: null }] }],
  ];

  it.each(rejectionCases)("rejects %s", async (_label, overrides) => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: capacityCommand(),
          readModel: makeReadModel(makeThread(overrides)),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a newer terminal error even when an older overload row exists", async () => {
    const thread = makeThread({
      activities: [
        makeThread().activities[0]!,
        {
          ...makeThread().activities[0]!,
          id: EventId.makeUnsafe("activity-capacity-newer"),
          sequence: 3,
          payload: { state: "failed", errorInfo: "other" },
        },
      ],
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: capacityCommand(),
          readModel: makeReadModel(thread),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects the duplicate after the accepted intent projects starting", async () => {
    const first = await Effect.runPromise(
      decideOrchestrationCommand({ command: capacityCommand(), readModel: makeReadModel() }),
    );
    const projected = await Effect.runPromise(
      projectEvent(makeReadModel(), {
        ...(first as Omit<OrchestrationEvent, "sequence">),
        sequence: 3,
      } as OrchestrationEvent),
    );
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: capacityCommand({ commandId: CommandId.makeUnsafe("command-capacity-2") }),
          readModel: projected,
        }),
      ),
    ).rejects.toThrow();
  });
});
