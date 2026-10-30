import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import type { OrchestrationThread } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
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
