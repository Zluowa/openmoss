import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@moss/contracts";
import type { OrchestrationThread } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { translateMoss } from "~/localization";

import {
  classifyComposerResumeRefusal,
  composerResumeRefusalMessageKey,
  hasComposerResumeProjectionAdvancedSince,
  isComposerResumePendingForThread,
  isComposerResumeEligible,
} from "./composerResume.logic";

const THREAD_ID = ThreadId.makeUnsafe("thread-resume-logic");
const TURN_ID = TurnId.makeUnsafe("turn-resume-logic");
const NOW = "2026-08-30T00:00:00.000Z";
const DONE = "2026-08-30T00:00:01.000Z";

function makeThread(
  latestTurn: OrchestrationThread["latestTurn"] = {
    turnId: TURN_ID,
    state: "interrupted",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: DONE,
    assistantMessageId: null,
  },
  activities: OrchestrationThread["activities"] = [],
): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-resume-logic"),
    title: "Resume",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: DONE,
    parentThreadId: null,
    subagentAgentId: null,
    latestTurn,
    messages: [
      {
        id: MessageId.makeUnsafe("message-resume-logic"),
        role: "user",
        text: "hello",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activities,
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    archivedAt: null,
    handoff: null,
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: DONE,
    },
  };
}

function baseEligibility(thread = makeThread()) {
  return {
    thread,
    session: thread.session
      ? { status: thread.session.status, activeTurnId: thread.session.activeTurnId }
      : null,
    provider: "codex" as const,
    isServerThread: true,
    hasSendableContent: false,
    isResponseInProgress: false,
    hasActiveUnpausedGoal: false,
    hasQueuedTurn: false,
    hasPendingInteraction: false,
    hasPlanFollowUp: false,
    providerAdmissionState: "ready" as const,
    isLoading: false,
  };
}

function completion(payload: Record<string, unknown>) {
  return [
    {
      id: EventId.makeUnsafe("activity-resume-logic"),
      tone: "error" as const,
      kind: "turn.completed" as const,
      summary: "Turn failed",
      payload: payload as never,
      turnId: TURN_ID,
      sequence: 1,
      createdAt: DONE,
    },
  ];
}

describe("isComposerResumeEligible", () => {
  it.each([
    ["interrupted", makeThread()],
    [
      "server overloaded",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({ state: "failed", errorInfo: "serverOverloaded" }),
      ),
    ],
    [
      "rate limited",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({ state: "failed", errorInfo: "rateLimitExceeded" }),
      ),
    ],
    [
      "internal server error",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({ state: "failed", errorInfo: "internalServerError" }),
      ),
    ],
    [
      "http connection failed",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({ state: "failed", errorInfo: { httpConnectionFailed: {} } }),
      ),
    ],
    [
      "response stream connection failed",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({
          state: "failed",
          errorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        }),
      ),
    ],
    [
      "response stream disconnected",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({
          state: "failed",
          errorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        }),
      ),
    ],
    [
      "too many failed attempts",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({ state: "failed", errorInfo: { responseTooManyFailedAttempts: {} } }),
      ),
    ],
    [
      "legacy model unavailable",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({
          state: "failed",
          errorInfo: "other",
          errorMessage: "model is temporarily unavailable",
        }),
      ),
    ],
    [
      "legacy stream disconnect",
      makeThread(
        { ...makeThread().latestTurn!, state: "error" },
        completion({
          state: "failed",
          errorInfo: "other",
          errorMessage:
            "stream disconnected before completion: we're currently processing too many requests",
        }),
      ),
    ],
  ])("accepts %s", (_name, thread) => {
    expect(isComposerResumeEligible(baseEligibility(thread))).toBe(true);
  });

  it.each([
    ["completed", { ...makeThread().latestTurn!, state: "completed" as const }],
    ["running", { ...makeThread().latestTurn!, state: "running" as const, completedAt: null }],
    ["no terminal time", { ...makeThread().latestTurn!, completedAt: null }],
  ])("rejects %s latest turns", (_name, latestTurn) => {
    expect(isComposerResumeEligible(baseEligibility(makeThread(latestTurn)))).toBe(false);
  });

  it.each([
    ["usage", { state: "failed", errorInfo: "usageLimitExceeded" }],
    ["generic", { state: "failed", errorInfo: "other" }],
    [
      "legacy leading whitespace",
      {
        state: "failed",
        errorInfo: "other",
        errorMessage:
          " stream disconnected before completion: we're currently processing too many requests",
      },
    ],
    [
      "malformed object details",
      { state: "failed", errorInfo: { httpConnectionFailed: { token: "raw-provider-error" } } },
    ],
  ])("rejects %s failures", (_name, payload) => {
    const thread = makeThread({ ...makeThread().latestTurn!, state: "error" }, completion(payload));
    expect(isComposerResumeEligible(baseEligibility(thread))).toBe(false);
  });

  it.each([
    ["text", { hasSendableContent: true }],
    ["busy", { isResponseInProgress: true }],
    ["active unpaused goal", { hasActiveUnpausedGoal: true }],
    ["queue", { hasQueuedTurn: true }],
    ["interaction", { hasPendingInteraction: true }],
    ["plan follow-up", { hasPlanFollowUp: true }],
    ["provider preflight", { providerAdmissionState: "preflight" as const }],
    ["provider block", { providerAdmissionState: "blocked" as const }],
    ["loading", { isLoading: true }],
    ["non-Codex", { provider: "claudeAgent" as const }],
    ["local draft", { isServerThread: false }],
  ])("rejects composer precedence gate: %s", (_name, overrides) => {
    expect(isComposerResumeEligible({ ...baseEligibility(), ...overrides })).toBe(false);
  });

  it("allows a paused goal when every other admission is eligible", () => {
    expect(
      isComposerResumeEligible({
        ...baseEligibility(),
        hasActiveUnpausedGoal: false,
      }),
    ).toBe(true);
  });

  it("offers Continue after Stop although the stopped turn's message never got a turn id", () => {
    // The shape the mobile run left: the person message that started the turn has no
    // turn id, the turn settled as interrupted, and the session is ready again.
    const stopped = makeThread();
    const thread = {
      ...stopped,
      messages: stopped.messages.map((message) => ({ ...message, turnId: null })),
    };
    expect(isComposerResumeEligible(baseEligibility(thread))).toBe(true);
  });

  it.each([
    [
      "the session is reconnecting after the stop",
      { status: "starting" as const, activeTurnId: null },
    ],
    ["a queued follow-up is starting", { status: "running" as const, activeTurnId: null }],
    [
      "another turn is active",
      { status: "ready" as const, activeTurnId: TurnId.makeUnsafe("next") },
    ],
  ])("hides Continue while %s, as the server would refuse it", (_name, session) => {
    expect(isComposerResumeEligible({ ...baseEligibility(), session })).toBe(false);
  });

  it("hides Continue while the latest turn is still marked as queued", () => {
    const thread = makeThread(undefined, [
      {
        id: EventId.makeUnsafe("activity-resume-logic-queued"),
        tone: "info" as const,
        kind: "turn.queued" as const,
        summary: "Turn queued",
        payload: {} as never,
        turnId: TURN_ID,
        sequence: 2,
        createdAt: DONE,
      },
    ]);
    expect(isComposerResumeEligible(baseEligibility(thread))).toBe(false);
  });

  it("rejects routed parent and subagent threads", () => {
    expect(
      isComposerResumeEligible(
        baseEligibility({ ...makeThread(), parentThreadId: ThreadId.makeUnsafe("parent") }),
      ),
    ).toBe(false);
    expect(
      isComposerResumeEligible(
        baseEligibility({ ...makeThread(), subagentAgentId: "agent-child" }),
      ),
    ).toBe(false);
  });
});

const refused = (detail: string) =>
  new Error(`Orchestration command invariant failed (thread.turn.resume): ${detail}`);

describe("classifyComposerResumeRefusal", () => {
  it.each([
    [
      refused("Thread 'thread-a' already has an active or queued turn."),
      "busy",
      "这个对话还在运行，或还有消息在排队。等它结束后再继续。",
    ],
    [
      refused("Resume requires a terminal latest turn on thread 'thread-a'."),
      "busy",
      "这个对话还在运行，或还有消息在排队。等它结束后再继续。",
    ],
    [
      refused("Thread 'thread-a' has a pending approval or user input interaction."),
      "pending-interaction",
      "先处理正在等待的批准或问题，再继续。",
    ],
    [
      refused("Resume turn 'turn-a' is not the latest turn on thread 'thread-a'."),
      "unavailable",
      "这个任务没法从这里继续了。发一条消息就能接着做。",
    ],
    [new Error("socket closed"), "unavailable", "这个任务没法从这里继续了。发一条消息就能接着做。"],
  ] as const)("explains %s plainly", (error, refusal, zhText) => {
    expect(classifyComposerResumeRefusal(error)).toBe(refusal);
    const key = composerResumeRefusalMessageKey(refusal);
    expect(translateMoss("zh-CN", key)).toBe(zhText);
    // The person never sees thread or turn ids from the server's own words.
    expect(translateMoss("en", key)).not.toMatch(/thread-a|turn-a|Thread '/u);
  });
});

describe("hasComposerResumeProjectionAdvancedSince", () => {
  it("requires a later revision when a baseline exists", () => {
    expect(hasComposerResumeProjectionAdvancedSince(DONE, DONE)).toBe(false);
    expect(hasComposerResumeProjectionAdvancedSince(DONE, "2026-08-30T00:00:02.000Z")).toBe(true);
    expect(hasComposerResumeProjectionAdvancedSince(null, DONE)).toBe(true);
  });
});

describe("isComposerResumePendingForThread", () => {
  it("only keeps a pending Resume bound to its originating thread", () => {
    expect(
      isComposerResumePendingForThread({
        activeThreadId: "thread-a",
        inFlightThreadId: "thread-a",
        inFlightTurnId: "turn-a",
      }),
    ).toBe(true);
    expect(
      isComposerResumePendingForThread({
        activeThreadId: "thread-b",
        inFlightThreadId: "thread-a",
        inFlightTurnId: "turn-a",
      }),
    ).toBe(false);
    expect(
      isComposerResumePendingForThread({
        activeThreadId: "thread-a",
        inFlightThreadId: null,
        inFlightTurnId: "turn-a",
      }),
    ).toBe(false);
  });
});
