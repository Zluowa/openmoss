import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

async function readModelWithExistingUserTurn(now: string) {
  const initial = createEmptyReadModel(now);
  const withProject = await Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: asEventId("evt-project-create-model-change"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-model-change"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-create-model-change"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-create-model-change"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-model-change"),
        title: "Model change",
        workspaceRoot: "/tmp/model-change",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const withThread = await Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: asEventId("evt-thread-create-model-change"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-model-change"),
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-create-model-change"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-create-model-change"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-model-change"),
        projectId: asProjectId("project-model-change"),
        title: "Model change",
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        handoff: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withThread, {
      sequence: 3,
      eventId: asEventId("evt-thread-existing-message-model-change"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-model-change"),
      type: "thread.message-sent",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-existing-message-model-change"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-existing-message-model-change"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-model-change"),
        messageId: asMessageId("message-existing-model-change"),
        role: "user",
        text: "Earlier turn",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("decider thread.turn.start model-change transcript", () => {
  it("emits model.changed before the anchored user message and start request", async () => {
    const now = "2026-08-28T00:00:00.000Z";
    const readModel = await readModelWithExistingUserTurn(now);
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-model-change"),
          threadId: ThreadId.makeUnsafe("thread-model-change"),
          message: {
            messageId: asMessageId("message-next-model-change"),
            role: "user",
            text: "hello again",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.3-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const activityEvent = events[0];
    const userEvent = events[1];
    const startEvent = events[2];
    if (activityEvent?.type !== "thread.activity-appended") {
      throw new Error("model change activity event missing");
    }
    expect(activityEvent.payload.activity).toMatchObject({
      kind: "model.changed",
      summary: "Model changed from gpt-5-codex to gpt-5.3-codex.",
      payload: {
        source: "local-turn-model-change",
        anchorMessageId: asMessageId("message-next-model-change"),
        fromModel: "gpt-5-codex",
        toModel: "gpt-5.3-codex",
      },
    });
    expect(activityEvent.payload.activity.id).toBeTruthy();
    expect(userEvent?.causationEventId).toBe(activityEvent.eventId);
    expect(startEvent?.causationEventId).toBe(userEvent?.eventId ?? null);
  });

  it("does not emit a model-change activity when the prepared model is unchanged", async () => {
    const now = "2026-08-28T00:00:00.000Z";
    const readModel = await readModelWithExistingUserTurn(now);
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-model-unchanged"),
          threadId: ThreadId.makeUnsafe("thread-model-change"),
          message: {
            messageId: asMessageId("message-unchanged-model"),
            role: "user",
            text: "same model",
            attachments: [],
          },
          modelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
