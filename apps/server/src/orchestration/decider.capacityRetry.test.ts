import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@moss/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

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
  // No provider handler runs a capacity retry any more, so accepting one would leave
  // the chat "starting" forever. Even the exact case it was built for is refused.
  it("refuses even a current typed Codex overload, pointing at resume", async () => {
    await expect(
      Effect.runPromise(
        Effect.flip(
          decideOrchestrationCommand({ command: capacityCommand(), readModel: makeReadModel() }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.capacity-retry",
      detail:
        "'thread.turn.capacity-retry' is no longer supported: no provider handler runs it. Use 'thread.turn.resume' or send a message.",
    });
  });
});
