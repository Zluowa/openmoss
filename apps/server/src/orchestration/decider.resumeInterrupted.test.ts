import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@moss/contracts";
import { INTERRUPTED_TASK_CONTINUATION_PROMPT } from "@moss/shared/turnResume";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-30T00:00:00.000Z";
const DONE = "2026-08-30T00:00:01.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-resume-decider");
const TURN_ID = TurnId.makeUnsafe("turn-resume-decider");

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-resume-decider"),
    title: "Resume",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "debug",
    parentThreadId: null,
    subagentAgentId: null,
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: DONE,
    latestTurn: {
      turnId: TURN_ID,
      state: "interrupted",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: DONE,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    handoff: null,
    messages: [
      {
        id: MessageId.makeUnsafe("message-resume-decider"),
        role: "user",
        text: "hello",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities: [],
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
      lastError: "interrupted",
      updatedAt: DONE,
    },
    ...overrides,
  };
}

function makeReadModel(thread = makeThread()): OrchestrationReadModel {
  return {
    snapshotSequence: 2,
    spaces: [],
    projects: [],
    threads: [thread],
    updatedAt: DONE,
  };
}

function resumeCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: "thread.turn.resume" as const,
    commandId: CommandId.makeUnsafe("command-resume-decider"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: DONE,
    ...overrides,
  };
}

function failureActivity(
  errorInfo: unknown,
  errorMessage?: string,
): OrchestrationReadModel["threads"][number]["activities"][number] {
  return {
    id: EventId.makeUnsafe(`activity-resume-${String(errorInfo)}`),
    tone: "error" as const,
    kind: "turn.completed",
    summary: "Turn failed",
    payload: {
      state: "failed",
      errorInfo: errorInfo as never,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
    turnId: TURN_ID,
    sequence: 2,
    createdAt: DONE,
  };
}

async function decideResume(
  thread = makeThread(),
  commandOverrides: Record<string, unknown> = {},
): Promise<ReadonlyArray<OrchestrationEvent["type"]>> {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({
      command: resumeCommand(commandOverrides),
      readModel: makeReadModel(thread),
    }),
  );
  return (Array.isArray(decided) ? decided : [decided]).map(
    (event: { readonly type: OrchestrationEvent["type"] }) => event.type,
  );
}

describe("resume interrupted turn decider", () => {
  it("continues an interrupted turn as an ordinary turn the provider reactor starts", async () => {
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: resumeCommand(),
        readModel: makeReadModel(),
      }),
    );
    const events = (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<
      Omit<OrchestrationEvent, "sequence">
    >;
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]).toMatchObject({
      commandId: "command-resume-decider",
      payload: {
        threadId: THREAD_ID,
        messageId: "resume:command-resume-decider",
        role: "user",
        text: INTERRUPTED_TASK_CONTINUATION_PROMPT,
        dispatchOrigin: "user",
        turnId: null,
        source: "native",
      },
    });
    expect(events[1]).toMatchObject({
      payload: {
        threadId: THREAD_ID,
        messageId: "resume:command-resume-decider",
        dispatchMode: "queue",
        runtimeMode: "full-access",
        interactionMode: "debug",
      },
    });
  });

  it("does not count the settled turn's own person message as queued work", async () => {
    // Every plain send leaves its message without a turn id (the shape the mobile
    // run's database held). Once that turn settles the message is history.
    const settledMessage = {
      ...makeThread().messages[0]!,
      turnId: null,
    };
    await expect(decideResume(makeThread({ messages: [settledMessage] }))).resolves.toContain(
      "thread.turn-start-requested",
    );
    // A native steer that rode the live turn never gets a turn id either.
    await expect(
      decideResume(
        makeThread({
          messages: [
            settledMessage,
            {
              ...settledMessage,
              id: MessageId.makeUnsafe("message-resume-decider-steer"),
              dispatchMode: "steer",
              startsNewTurn: false,
              createdAt: DONE,
              updatedAt: DONE,
            },
          ],
          latestUserMessageAt: "2026-08-30T00:00:09.000Z",
        }),
      ),
    ).resolves.toContain("thread.turn-start-requested");
  });

  it("reports a refusal from the continuation under the resume command", async () => {
    // A checkpoint revert is checked by the turn start, not by resume itself.
    const revertStarted = {
      id: EventId.makeUnsafe("activity-resume-decider-revert"),
      tone: "info" as const,
      kind: "checkpoint.revert.started",
      summary: "Reverting",
      payload: {},
      turnId: null,
      sequence: 3,
      createdAt: DONE,
    };
    await expect(
      Effect.runPromise(
        Effect.flip(
          decideOrchestrationCommand({
            command: resumeCommand(),
            readModel: makeReadModel(makeThread({ activities: [revertStarted] })),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.resume",
    });
  });

  it.each([
    "serverOverloaded",
    "rateLimitExceeded",
    "internalServerError",
    { httpConnectionFailed: {} },
    { responseStreamConnectionFailed: { httpStatusCode: 503 } },
    { responseStreamDisconnected: { httpStatusCode: 429 } },
    { responseTooManyFailedAttempts: {} },
  ])("accepts typed retryable failure %j", async (errorInfo) => {
    const thread = makeThread({
      latestTurn: { ...makeThread().latestTurn!, state: "error" },
      activities: [failureActivity(errorInfo)],
    });
    await expect(decideResume(thread)).resolves.toContain("thread.turn-start-requested");
  });

  it("accepts only the two frozen legacy messages for other failures", async () => {
    for (const errorMessage of [
      "model is temporarily unavailable",
      "stream disconnected before completion: we're currently processing too many requests",
    ]) {
      const thread = makeThread({
        latestTurn: { ...makeThread().latestTurn!, state: "error" },
        activities: [failureActivity("other", errorMessage)],
      });
      await expect(decideResume(thread)).resolves.toContain("thread.turn-start-requested");
    }
  });

  it.each([
    [
      "completed terminal latest turn",
      { ...makeThread().latestTurn!, state: "completed" as const },
    ],
    [
      "running non-terminal latest turn",
      { ...makeThread().latestTurn!, state: "running" as const, completedAt: null },
    ],
  ])("rejects %s latest turns", async (_label, latestTurn) => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: resumeCommand(),
          readModel: makeReadModel(makeThread({ latestTurn })),
        }),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["usage", "usageLimitExceeded", undefined],
    ["unknown", "other", undefined],
    ["legacy excluded term", "other", "model is temporarily unavailable because of quota"],
    ["superseding terminal evidence", "other", undefined],
    [
      "malformed object details",
      { httpConnectionFailed: { token: "raw-provider-error" } },
      undefined,
    ],
  ])("rejects %s", async (_label, errorInfo, errorMessage) => {
    const activities = [failureActivity(errorInfo, errorMessage)];
    if (_label === "superseding terminal evidence") {
      activities.push({
        ...failureActivity("serverOverloaded"),
        id: EventId.makeUnsafe("activity-resume-superseding"),
        sequence: 3,
        payload: { state: "completed" },
      });
    }
    const thread = makeThread({
      latestTurn: { ...makeThread().latestTurn!, state: "error" },
      activities,
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: resumeCommand(), readModel: makeReadModel(thread) }),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["stale turn", { turnId: TurnId.makeUnsafe("turn-old") }],
    ["live session", { thread: { session: { ...makeThread().session!, status: "running" } } }],
    [
      "queued follow-up already promoted and starting",
      {
        thread: {
          session: { ...makeThread().session!, status: "starting", activeTurnId: null },
        },
      },
    ],
    [
      "queued lifecycle marker",
      {
        thread: {
          activities: [
            {
              id: EventId.makeUnsafe("activity-resume-decider-queued"),
              tone: "info" as const,
              kind: "turn.queued",
              summary: "Turn queued",
              payload: {},
              turnId: TURN_ID,
              sequence: 3,
              createdAt: DONE,
            } as never,
          ],
        },
      },
    ],
    ["pending user input flag", { thread: { hasPendingUserInput: true } }],
    [
      "pending interaction shape",
      {
        thread: {
          pendingInteractions: [
            {
              interactionKind: "userInput",
              requestId: "input-resume-decider",
              threadId: THREAD_ID,
              turnId: TURN_ID,
              lifecycleGeneration: null,
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt: NOW,
              resolvedAt: null,
            },
          ],
        },
      },
    ],
    ["subagent", { thread: { subagentAgentId: "agent-child" } }],
    [
      "routed session",
      { thread: { session: { ...makeThread().session!, threadId: ThreadId.makeUnsafe("other") } } },
    ],
    ["goal", { thread: { goal: "keep going", goalPausedAt: null } }],
    ["pending approval", { thread: { hasPendingApprovals: true } }],
    [
      "non-Codex",
      { thread: { session: { ...makeThread().session!, providerName: "claudeAgent" } } },
    ],
    ["child", { thread: { parentThreadId: ThreadId.makeUnsafe("parent") } }],
  ])("rejects %s admission", async (_label, input) => {
    const commandOverrides = "turnId" in input ? { turnId: input.turnId } : {};
    const threadOverrides = "thread" in input ? input.thread : {};
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: resumeCommand(commandOverrides),
          readModel: makeReadModel(makeThread(threadOverrides)),
        }),
      ),
    ).rejects.toThrow();
  });
});
