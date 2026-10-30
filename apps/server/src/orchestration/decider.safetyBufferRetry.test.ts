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
import { projectProviderRuntimeActivities } from "./providerRuntimeActivityProjection.ts";

const CREATED_AT = "2026-09-05T00:00:00.000Z";
const REQUESTED_AT = "2026-09-05T00:00:01.000Z";
const BUFFERED_AT = "2026-09-05T00:00:02.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-safety");
const PROVIDER_THREAD_ID = "provider-thread-safety-buffering";
const TURN_ID = TurnId.makeUnsafe("turn-safety");
const SOURCE_ACTIVITY_ID = EventId.makeUnsafe("activity-safety");

function projectedSafetyActivity(
  overrides: {
    readonly showBufferingUi?: boolean;
    readonly fasterModel?: string | null;
    readonly sequence?: number;
  } = {},
) {
  const [activity] = projectProviderRuntimeActivities(
    {
      type: "model.safety-buffering.updated",
      eventId: SOURCE_ACTIVITY_ID,
      provider: "codex",
      createdAt: BUFFERED_AT,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      payload: {
        threadId: PROVIDER_THREAD_ID,
        turnId: TURN_ID,
        model: "gpt-5.6-codex",
        reasons: ["latency"],
        showBufferingUi: overrides.showBufferingUi ?? true,
        useCases: ["long_running"],
        fasterModel: overrides.fasterModel === undefined ? "gpt-5.5-codex" : overrides.fasterModel,
      },
    },
    overrides.sequence ?? 7,
  );
  return activity!;
}

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-safety"),
    title: "Safety",
    modelSelection: {
      provider: "codex",
      instanceId: "codex",
      model: "gpt-5.6-codex",
      options: { reasoningEffort: "high" },
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    parentThreadId: null,
    subagentAgentId: null,
    branch: null,
    worktreePath: null,
    createdAt: CREATED_AT,
    updatedAt: BUFFERED_AT,
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: REQUESTED_AT,
      startedAt: REQUESTED_AT,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: CREATED_AT,
    handoff: null,
    messages: [
      {
        id: MessageId.makeUnsafe("message-safety-source"),
        role: "user",
        text: "original input",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      {
        id: MessageId.makeUnsafe("message-safety-assistant"),
        role: "assistant",
        text: "partial",
        turnId: TURN_ID,
        streaming: true,
        source: "native",
        createdAt: REQUESTED_AT,
        updatedAt: BUFFERED_AT,
      },
    ],
    activities: [projectedSafetyActivity()],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    archivedAt: null,
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: REQUESTED_AT,
    },
    ...overrides,
  };
}

function readModel(thread = makeThread()): OrchestrationReadModel {
  return {
    snapshotSequence: 7,
    spaces: [],
    projects: [],
    threads: [thread],
    updatedAt: BUFFERED_AT,
  };
}

function command(commandId = "command-safety") {
  return {
    type: "thread.turn.safety-buffer-retry" as const,
    commandId: CommandId.makeUnsafe(commandId),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: BUFFERED_AT,
  };
}

describe("safety buffering retry decider", () => {
  it("derives the faster model from the latest typed activity and fences duplicates", async () => {
    expect(projectedSafetyActivity().payload).toMatchObject({
      threadId: THREAD_ID,
    });
    expect(PROVIDER_THREAD_ID).not.toBe(THREAD_ID);
    const events = await Effect.runPromise(
      decideOrchestrationCommand({ command: command(), readModel: readModel() }),
    );
    expect(events).toMatchObject([
      {
        type: "thread.activity-appended",
        payload: { activity: { kind: "model.safety-buffering.retry-requested" } },
      },
      {
        type: "thread.turn-safety-buffer-retry-requested",
        payload: {
          turnId: TURN_ID,
          messageId: "message-safety-source",
          sourceActivityId: SOURCE_ACTIVITY_ID,
          targetModel: "gpt-5.5-codex",
          modelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.5-codex",
            options: { reasoningEffort: "high" },
          },
        },
      },
    ]);

    let projected = readModel();
    for (const [index, event] of (events as Omit<OrchestrationEvent, "sequence">[]).entries()) {
      projected = await Effect.runPromise(
        projectEvent(projected, { ...event, sequence: 8 + index } as OrchestrationEvent),
      );
    }
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: command("command-safety-duplicate"),
          readModel: projected,
        }),
      ),
    ).rejects.toThrow(/already requested/);
  });

  it("rejects hidden, stale, non-Codex, and targetless notifications", async () => {
    for (const thread of [
      makeThread({
        activities: [projectedSafetyActivity({ showBufferingUi: false, sequence: 8 })],
      }),
      makeThread({
        latestTurn: { ...makeThread().latestTurn!, turnId: TurnId.makeUnsafe("newer") },
      }),
      makeThread({ session: { ...makeThread().session!, providerName: "claudeAgent" } }),
      makeThread({
        activities: [projectedSafetyActivity({ fasterModel: null })],
      }),
      makeThread({
        activities: [
          projectProviderRuntimeActivities(
            {
              type: "model.safety-buffering.updated",
              eventId: SOURCE_ACTIVITY_ID,
              provider: "codex",
              createdAt: BUFFERED_AT,
              threadId: ThreadId.makeUnsafe("other-moss-thread"),
              turnId: TURN_ID,
              payload: {
                threadId: PROVIDER_THREAD_ID,
                turnId: TURN_ID,
                model: "gpt-5.6-codex",
                reasons: ["latency"],
                showBufferingUi: true,
                useCases: ["long_running"],
                fasterModel: "gpt-5.5-codex",
              },
            },
            7,
          )[0]!,
        ],
      }),
    ]) {
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({ command: command(), readModel: readModel(thread) }),
        ),
      ).rejects.toThrow();
    }
  });

  it("removes only the superseded turn while preserving source and queued messages", async () => {
    const queuedAt = "2026-09-05T00:00:03.000Z";
    const thread = makeThread({
      messages: [
        ...makeThread().messages,
        {
          id: MessageId.makeUnsafe("message-queued"),
          role: "user",
          text: "queued follow-up",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: queuedAt,
          updatedAt: queuedAt,
        },
      ],
      latestUserMessageAt: queuedAt,
    });
    const projected = await Effect.runPromise(
      projectEvent(readModel(thread), {
        sequence: 8,
        eventId: EventId.makeUnsafe("event-safety-rollback"),
        type: "thread.conversation-rolled-back",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: queuedAt,
        commandId: CommandId.makeUnsafe("command-safety-rollback"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          messageId: MessageId.makeUnsafe("message-safety-source"),
          numTurns: 1,
          removedTurnIds: [TURN_ID],
          skipAttachmentPrune: true,
          preserveUnboundMessages: true,
        },
      }),
    );
    expect(projected.threads[0]?.messages.map((message) => message.id)).toEqual([
      "message-safety-source",
      "message-queued",
    ]);
    expect(projected.threads[0]?.activities).toEqual([]);
  });
});
