import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@moss/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

// WALK-1 S-6: an item panel's warm-up chat is created marked, so it is listed only after its
// first send. Every other create (terminal-first, a draft named before sending) is unmarked.
const PROJECT_ID = ProjectId.makeUnsafe("project-items");
const CREATED_AT = "2026-11-24T10:00:00.000Z";

type ThreadCreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

function createCommand(
  threadId: string,
  overrides: Partial<ThreadCreateCommand> = {},
): ThreadCreateCommand {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: PROJECT_ID,
    title: "周报",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    lastKnownPr: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

async function projectReadModel(): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(CREATED_AT), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: CREATED_AT,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Items",
        workspaceRoot: "/tmp/items",
        defaultModelSelection: null,
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    }),
  );
}

async function createAndProject(command: ThreadCreateCommand) {
  const base = await projectReadModel();
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel: base, command }));
  const [created] = (Array.isArray(result) ? result : [result]) as Array<
    Omit<OrchestrationEvent, "sequence">
  >;
  const readModel = await Effect.runPromise(
    projectEvent(base, { ...created, sequence: 2 } as OrchestrationEvent),
  );
  return {
    event: created!,
    thread: readModel.threads.find((candidate) => candidate.id === command.threadId),
  };
}

describe("listedAfterFirstSend on thread.create", () => {
  it("carries the mark of an item panel's warm-up chat to its event and thread", async () => {
    const { event, thread } = await createAndProject(
      createCommand("thread-item-chat", { listedAfterFirstSend: true }),
    );
    expect(event).toMatchObject({
      type: "thread.created",
      payload: { listedAfterFirstSend: true },
    });
    expect(thread?.listedAfterFirstSend).toBe(true);
  });

  it("leaves every other new thread unmarked (terminal-first, named before sending)", async () => {
    for (const title of ["New terminal", "我起的名字"]) {
      const { event, thread } = await createAndProject(createCommand(`thread-${title}`, { title }));
      expect(event.payload).not.toHaveProperty("listedAfterFirstSend");
      expect(thread).toBeDefined();
      expect(thread).not.toHaveProperty("listedAfterFirstSend");
    }
  });
});
