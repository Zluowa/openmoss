import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@moss/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

// WALK-7 N7-1: a new chat nothing was sent in, whose 画布 the person drew on.
const THREAD_ID = ThreadId.makeUnsafe("thread-new-chat");
const CREATED_AT = "2026-11-24T10:00:00.000Z";
const FIRST_DRAWN_AT = "2026-11-24T10:01:00.000Z";
const LATER_DRAWN_AT = "2026-11-24T10:05:00.000Z";

function readModel(canvasEditedAt: string | null): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: CREATED_AT,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-a"),
        title: "New thread",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        canvasEditedAt,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        latestTurn: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  } as OrchestrationReadModel;
}

const record = (model: OrchestrationReadModel, editedAt: string) =>
  Effect.runPromise(
    decideOrchestrationCommand({
      readModel: model,
      command: {
        type: "thread.canvas-edited.record",
        commandId: CommandId.makeUnsafe(`canvas-edited:${THREAD_ID}`),
        threadId: THREAD_ID,
        editedAt,
      },
    }),
  );

describe("a conversation's 画布 first holding content", () => {
  it("is recorded as an optional field on thread.meta-updated, without moving the chat", async () => {
    const event = await record(readModel(null), FIRST_DRAWN_AT);
    expect(event).toMatchObject({
      type: "thread.meta-updated",
      payload: { threadId: THREAD_ID, canvasEditedAt: FIRST_DRAWN_AT, updatedAt: CREATED_AT },
    });
  });

  it("is set once: a later record emits nothing", async () => {
    expect(await record(readModel(FIRST_DRAWN_AT), LATER_DRAWN_AT)).toEqual([]);
  });

  it("is rebuilt from the events, and a second event never moves it", async () => {
    const first = (await record(readModel(null), FIRST_DRAWN_AT)) as Omit<
      OrchestrationEvent,
      "sequence"
    >;
    const projected = await Effect.runPromise(
      projectEvent(readModel(null), { ...first, sequence: 2 } as OrchestrationEvent),
    );
    expect(projected.threads[0]?.canvasEditedAt).toBe(FIRST_DRAWN_AT);
    // A replayed or stray second event with another value keeps the first.
    const again = await Effect.runPromise(
      projectEvent(projected, {
        ...first,
        sequence: 3,
        payload: { threadId: THREAD_ID, canvasEditedAt: LATER_DRAWN_AT, updatedAt: CREATED_AT },
      } as OrchestrationEvent),
    );
    expect(again.threads[0]?.canvasEditedAt).toBe(FIRST_DRAWN_AT);
  });
});
