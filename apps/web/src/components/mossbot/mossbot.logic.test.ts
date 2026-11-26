import { describe, expect, it } from "vitest";
import {
  MessageId,
  ProjectId,
  ThreadId,
  SUPPORTED_PROVIDER_KINDS,
  TurnId,
  type MossbotRoomView,
  type ProjectAgentSummary,
} from "@moss/contracts";
import {
  buildMossbotConfigureInput,
  isMossbot,
  mossbotCompanionState,
  mossbotRoomReplyFileWindows,
  mossbotStatus,
  resolveMossbotForThread,
} from "./mossbot.logic";

describe("Mossbot provider selection", () => {
  it.each(SUPPORTED_PROVIDER_KINDS)("preserves the %s CLI, account and model", (provider) => {
    const selection = { provider, instanceId: `${provider}-personal`, model: "my-model" };
    const input = buildMossbotConfigureInput({
      projectId: ProjectId.makeUnsafe("bot-1"),
      requestId: "req-1",
      name: "  My assistant  ",
      instructions: "Help with research.",
      modelSelection: selection,
    });
    expect(input.coordinatorModelSelection).toEqual(selection);
    expect(input.workerRouting?.modelSelection).toEqual(selection);
    expect(input.agentKind).toBe("mossbot");
    expect(input.coordinatorName).toBe("My assistant");
    expect(input.coordinatorIcon).toBe("mossbot-kid-block");
    expect(input.autoMemoryEnabled).toBe(true);
    expect(input.workerRouting?.environment).toBe("local");
    expect(input.workerRouting?.runtimeMode).not.toBe("full-access");
  });

  it("requires a name and persona before creating anything", () => {
    expect(() =>
      buildMossbotConfigureInput({
        projectId: ProjectId.makeUnsafe("bot"),
        requestId: "r",
        name: " ",
        instructions: "help",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
      }),
    ).toThrow("name");
  });

  it("preserves the selected model's native options for the assistant and its workers", () => {
    const selection = {
      provider: "codex" as const,
      model: "gpt-5.1-codex-mini",
      instanceId: "codex-personal",
      options: { reasoningEffort: "low" as const },
    };
    const input = buildMossbotConfigureInput({
      projectId: ProjectId.makeUnsafe("bot-options"),
      requestId: "options",
      name: "Atlas",
      instructions: "Help me plan.",
      modelSelection: selection,
      avatar: "mossbot-kid-robot",
    });
    expect(input.coordinatorModelSelection).toEqual(selection);
    expect(input.coordinatorIcon).toBe("mossbot-kid-robot");
    expect(input.workerRouting?.modelSelection).toEqual(selection);
  });

  it("keeps a linked-project worker in its personal assistant, without claiming ordinary threads", () => {
    const id = ProjectId.makeUnsafe("bot");
    const coordinator = ThreadId.makeUnsafe("coordinator");
    const worker = ThreadId.makeUnsafe("worker");
    const summary: ProjectAgentSummary = {
      projectId: id,
      agentKind: "mossbot",
      configured: true,
      coordinatorName: "Nova",
      coordinatorThreadId: coordinator,
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "idle",
      revision: 1,
      memberThreadIds: [worker],
    };
    const summaries = new Map([[id, summary]]);
    expect(resolveMossbotForThread({ projectId: id, threadId: coordinator, summaries })).toBe(
      summary,
    );
    expect(
      resolveMossbotForThread({
        projectId: ProjectId.makeUnsafe("linked-repo"),
        threadId: worker,
        summaries,
      }),
    ).toBe(summary);
    expect(
      resolveMossbotForThread({
        projectId: ProjectId.makeUnsafe("linked-repo"),
        threadId: ThreadId.makeUnsafe("ordinary"),
        summaries,
      }),
    ).toBeNull();
  });

  it("classifies only explicitly persisted personal assistants", () => {
    expect(isMossbot(undefined)).toBe(false);
    expect(isMossbot({})).toBe(false);
    expect(isMossbot({ agentKind: "hub" })).toBe(false);
    expect(isMossbot({ agentKind: "mossbot" })).toBe(true);
  });

  it("prioritizes pause and pending human input over a working label", () => {
    const summary: ProjectAgentSummary = {
      projectId: ProjectId.makeUnsafe("bot"),
      configured: true,
      coordinatorName: "Mossbot",
      coordinatorThreadId: null,
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "running",
      revision: 1,
    };
    expect(mossbotStatus(summary)).toBe("Working");
    expect(mossbotStatus({ ...summary, pausedAt: "2026-11-05T00:00:00Z" })).toBe("Paused");
    expect(mossbotStatus({ ...summary, needsYouThreadIds: ["waiting" as never] })).toBe(
      "Needs you",
    );
  });

  it("gives the companion a state that matches the status line", () => {
    const summary: ProjectAgentSummary = {
      projectId: ProjectId.makeUnsafe("bot"),
      configured: true,
      coordinatorName: "Mossbot",
      coordinatorThreadId: null,
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "running",
      revision: 1,
    };
    expect(mossbotCompanionState(summary)).toBe("working");
    expect(mossbotCompanionState({ ...summary, needsYouThreadIds: ["waiting" as never] })).toBe(
      "waiting",
    );
    expect(mossbotCompanionState({ ...summary, pausedAt: "2026-11-05T00:00:00Z" })).toBe(
      "sleeping",
    );
    expect(mossbotCompanionState({ ...summary, coordinatorStatus: "stopped" })).toBe("sleeping");
    expect(mossbotCompanionState({ ...summary, coordinatorStatus: "idle" })).toBe("idle");
  });
});

const at = (second: number) => `2026-11-24T11:00:${String(second).padStart(2, "0")}.000Z`;

describe("mossbotRoomReplyFileWindows (WALK-6 N6-1 in a group)", () => {
  const ROOM_CREATED_AT = "2026-11-24T10:00:00.000Z";
  const analyst = ProjectId.makeUnsafe("analyst");
  const writer = ProjectId.makeUnsafe("writer");
  function reply(
    memberId: ProjectId,
    id: string,
    turnId: string | null,
    createdAt: string,
    updatedAt: string,
    streaming = false,
  ): MossbotRoomView["replies"][number] {
    return {
      memberId,
      threadId: ThreadId.makeUnsafe(`${memberId}-thread`),
      message: {
        id: MessageId.makeUnsafe(id),
        role: "assistant",
        text: id,
        turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
        streaming,
        source: "native",
        createdAt,
        updatedAt,
      },
    };
  }
  const windows = (replies: MossbotRoomView["replies"], running: ReadonlyArray<ProjectId> = []) =>
    mossbotRoomReplyFileWindows({
      room: {
        createdAt: ROOM_CREATED_AT,
        deliveries: running.map((memberId) => ({
          requestId: `post-${memberId}`,
          memberId,
          state: "running" as const,
          error: null,
        })),
      },
      replies,
    });

  it("runs a member's first turn from the group's creation to the turn's last message", () => {
    const result = windows([
      reply(analyst, "a1", "turn-1", at(12), at(13)),
      reply(analyst, "a2", "turn-1", at(20), at(25)),
    ]);
    const window = { startedAt: ROOM_CREATED_AT, completedAt: at(25) };
    expect(result.get("a1")).toEqual(window);
    expect(result.get("a2")).toEqual(window);
  });

  it("starts a later turn at the member's previous turn, not at a post that waited in its queue", () => {
    // turn-1 ran until about 0:30; the post that started turn-2 came at 0:15 and waited, and
    // turn-2 worked before its first message at 0:50.
    const result = windows([
      reply(analyst, "a1", "turn-1", at(10), at(30)),
      reply(analyst, "a2", "turn-2", at(50), at(55)),
    ]);
    expect(result.get("a2")).toEqual({ startedAt: at(10), completedAt: at(55) });
  });

  it("keeps each member's turns apart", () => {
    const result = windows([
      reply(analyst, "a1", "turn-a", at(10), at(20)),
      reply(writer, "w1", "turn-w", at(30), at(40)),
    ]);
    expect(result.get("w1")).toEqual({ startedAt: ROOM_CREATED_AT, completedAt: at(40) });
  });

  it("leaves the turn open while its reply streams or its member still works", () => {
    expect(windows([reply(analyst, "a1", "turn-1", at(10), at(12), true)]).get("a1")).toEqual({
      startedAt: ROOM_CREATED_AT,
      completedAt: null,
    });
    const working = windows(
      [
        reply(analyst, "a1", "turn-1", at(10), at(20)),
        reply(analyst, "a2", "turn-2", at(30), at(35)),
      ],
      [analyst],
    );
    expect(working.get("a1")).toEqual({ startedAt: ROOM_CREATED_AT, completedAt: at(20) });
    expect(working.get("a2")).toEqual({ startedAt: at(10), completedAt: null });
  });

  it("gives no window to a reply without a turn, so its chips keep their download", () => {
    expect(windows([reply(analyst, "a1", null, at(10), at(12))]).has("a1")).toBe(false);
  });
});
