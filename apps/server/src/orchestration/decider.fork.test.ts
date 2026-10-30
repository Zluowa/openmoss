import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-30T00:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-fork");
const SOURCE_THREAD_ID = ThreadId.makeUnsafe("thread-source");
const FORK_THREAD_ID = ThreadId.makeUnsafe("thread-fork");
const FIRST_MESSAGE_ID = MessageId.makeUnsafe("message-first");
const SECOND_MESSAGE_ID = MessageId.makeUnsafe("message-second");

async function makeForkReadModel() {
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-project"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-project"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-project"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Fork project",
        workspaceRoot: "/tmp/fork-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  const withThread = await Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("event-thread"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-thread"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-thread"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Canonical source",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        envMode: "local",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        handoff: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  const withFirstMessage = await Effect.runPromise(
    projectEvent(withThread, {
      sequence: 3,
      eventId: EventId.makeUnsafe("event-message-first"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-message-first"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-message-first"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        messageId: FIRST_MESSAGE_ID,
        role: "user",
        text: "first canonical message",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withFirstMessage, {
      sequence: 4,
      eventId: EventId.makeUnsafe("event-message-second"),
      aggregateKind: "thread",
      aggregateId: SOURCE_THREAD_ID,
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("command-message-second"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("command-message-second"),
      metadata: {},
      payload: {
        threadId: SOURCE_THREAD_ID,
        messageId: SECOND_MESSAGE_ID,
        role: "assistant",
        text: "second canonical message",
        attachments: [],
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

describe("decider thread fork", () => {
  it("derives a bounded fork prefix from canonical server history", async () => {
    const readModel = await makeForkReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("command-fork"),
          threadId: FORK_THREAD_ID,
          sourceThreadId: SOURCE_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Fork",
          modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          envMode: "local",
          branch: null,
          worktreePath: null,
          sidechatSourceThreadId: null,
          importedMessages: [],
          throughMessageId: FIRST_MESSAGE_ID,
          createdAt: NOW,
        },
        readModel,
      }),
    );

    const events = result as ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;
    const imported = events.filter(
      (event): event is Extract<OrchestrationEvent, { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent",
    );
    expect(imported).toHaveLength(1);
    const payload = imported[0]?.payload as
      | { readonly text: string; readonly messageId: MessageId }
      | undefined;
    expect(payload?.text).toBe("first canonical message");
    expect(payload?.messageId).not.toBe(FIRST_MESSAGE_ID);
  });
});
