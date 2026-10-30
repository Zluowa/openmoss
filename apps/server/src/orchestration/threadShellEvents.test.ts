import { EventId, MessageId, ThreadId, TurnId } from "@synara/contracts";
import type { OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldApplyDeferredThreadShellSummary,
  shouldApplyThreadsProjection,
  shouldPublishThreadShellForEvent,
} from "./threadShellEvents.ts";

const threadId = ThreadId.makeUnsafe("thread-shell-events");
const createdAt = "2026-07-09T00:00:00.000Z";

function event<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
): Extract<OrchestrationEvent, { type: TType }> {
  return {
    type,
    payload,
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as Extract<OrchestrationEvent, { type: TType }>;
}

function activityEvent(
  kind: string,
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  return event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.makeUnsafe(`activity-${kind}`),
      tone: "info",
      kind,
      summary: kind,
      payload: {},
      turnId: null,
      createdAt,
    },
  });
}

function messageEvent(input: {
  role: "user" | "assistant";
  streaming: boolean;
}): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return event("thread.message-sent", {
    threadId,
    messageId: MessageId.makeUnsafe(`message-${input.role}-${input.streaming}`),
    role: input.role,
    text: "text",
    turnId: null,
    streaming: input.streaming,
    source: "native",
    createdAt,
    updatedAt: createdAt,
  });
}

function capacityRetryEvent(): Extract<
  OrchestrationEvent,
  { type: "thread.turn-capacity-retry-requested" }
> {
  return event("thread.turn-capacity-retry-requested", {
    threadId,
    turnId: TurnId.makeUnsafe("turn-shell-capacity"),
    trigger: "capacity_retry_automatic",
    createdAt,
  });
}

describe("thread shell event relevance", () => {
  it("drops telemetry and tool progress that cannot change the shell", () => {
    expect(shouldPublishThreadShellForEvent(activityEvent("context-window.updated"))).toBe(false);
    expect(shouldPublishThreadShellForEvent(activityEvent("account.rate-limits.updated"))).toBe(
      false,
    );
    expect(shouldPublishThreadShellForEvent(activityEvent("tool.updated"))).toBe(false);
    expect(
      shouldPublishThreadShellForEvent(messageEvent({ role: "assistant", streaming: true })),
    ).toBe(false);
  });

  it("keeps events that update shell fields or summary state", () => {
    expect(shouldPublishThreadShellForEvent(activityEvent("approval.requested"))).toBe(true);
    expect(shouldApplyDeferredThreadShellSummary(activityEvent("approval.requested"))).toBe(false);
    expect(shouldPublishThreadShellForEvent(messageEvent({ role: "user", streaming: false }))).toBe(
      true,
    );
    expect(
      shouldApplyDeferredThreadShellSummary(messageEvent({ role: "user", streaming: false })),
    ).toBe(true);
    expect(
      shouldPublishThreadShellForEvent(messageEvent({ role: "assistant", streaming: false })),
    ).toBe(true);
  });

  it("publishes capacity retry shell revisions without deferred summary or turn projection", () => {
    const retryEvent = capacityRetryEvent();
    expect(shouldApplyThreadsProjection(retryEvent)).toBe(true);
    expect(shouldApplyDeferredThreadShellSummary(retryEvent)).toBe(false);
    expect(shouldApplyDeferredThreadShellSummary(retryEvent)).toBe(false);
    expect(shouldPublishThreadShellForEvent(retryEvent)).toBe(true);
  });

  it("publishes Resume shell revisions without deferred summary or transcript rows", () => {
    const resumeEvent = event("thread.turn-resume-requested", {
      threadId,
      turnId: TurnId.makeUnsafe("turn-shell-resume"),
      createdAt,
    });
    expect(shouldApplyThreadsProjection(resumeEvent)).toBe(true);
    expect(shouldApplyDeferredThreadShellSummary(resumeEvent)).toBe(false);
    expect(shouldApplyDeferredThreadShellSummary(resumeEvent)).toBe(false);
    expect(shouldPublishThreadShellForEvent(resumeEvent)).toBe(true);
  });
});
