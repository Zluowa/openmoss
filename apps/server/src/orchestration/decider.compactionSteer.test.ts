import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  type ProviderKind,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-10-29T12:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-compaction-steer");
const LIVE_TURN_ID = TurnId.makeUnsafe("turn-live");

function compactionActivity(
  id: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind: "context-compaction",
    summary: payload.status === "inProgress" ? "Compacting context" : "Context compacted",
    payload: { itemType: "context_compaction", ...payload },
    turnId: LIVE_TURN_ID,
    createdAt: NOW,
  };
}

function makeReadModel(input: {
  provider: ProviderKind;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 10,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-compaction-steer"),
        title: "Compaction steer",
        modelSelection: {
          provider: input.provider,
          model: input.provider === "codex" ? "gpt-5.5" : "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session: {
          threadId: THREAD_ID,
          providerName: input.provider,
          status: "running",
          runtimeMode: "full-access",
          activeTurnId: LIVE_TURN_ID,
          lastError: null,
          updatedAt: NOW,
        },
        activities: [...input.activities],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  } as OrchestrationReadModel;
}

function steer(): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-steer"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.makeUnsafe("message-steer"),
      role: "user",
      text: "Hey I want to keep going",
      attachments: [],
    },
    dispatchMode: "steer",
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  };
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  return Array.isArray(result) ? result : [result];
}

describe("decider steering into a manual compaction", () => {
  it.each(["codex", "claudeAgent"] as const)(
    "queues the %s steer first and stops the compaction",
    async (provider) => {
      const events = await decide(
        steer(),
        makeReadModel({
          provider,
          activities: [
            compactionActivity("compacting", { status: "inProgress", source: "manual" }),
          ],
        }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-queued",
        "thread.turn-interrupt-requested",
      ]);
      expect(events[0]).toMatchObject({ payload: { startsNewTurn: true } });
      expect(events[1]).toMatchObject({ payload: { dispatchMode: "steer" } });
      expect(events[2]).toMatchObject({ payload: { turnId: LIVE_TURN_ID } });
    },
  );

  it("still steers natively through an automatic compaction inside ordinary work", async () => {
    const events = await decide(
      steer(),
      makeReadModel({
        provider: "codex",
        activities: [compactionActivity("auto-compacting", { status: "inProgress" })],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });

  it("steers natively once the manual compaction has settled", async () => {
    const events = await decide(
      steer(),
      makeReadModel({
        provider: "claudeAgent",
        activities: [
          compactionActivity("compacting", { status: "inProgress", source: "manual" }),
          compactionActivity("compacted", { status: "completed", source: "manual" }),
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
  });
});
