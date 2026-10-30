import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { UnifiedUsageEvent as ExportedUnifiedUsageEvent } from "./index";
import { UnifiedUsageEvent, UsageLedgerAppendResult, UsageWindow } from "./usageLedger";

const digest = (character: string) => character.repeat(64);

const eventBase = {
  schemaVersion: 1 as const,
  eventId: "event-001",
  idempotencyKey: "request-001",
  payloadDigest: digest("a"),
  occurredAt: "2026-08-13T01:02:03.000Z",
  observedAt: "2026-08-13T01:02:04.000Z",
  subject: {
    provider: "codex",
    providerInstanceId: "codex_moss",
    accountRef: "account-ref-001",
    entitlementRef: "entitlement-001",
  },
  operation: {
    operationId: "operation-child-001",
    parentOperationId: "operation-root-001",
    threadId: "thread-001",
    turnId: "turn-001",
    requestId: "request-001",
    responseId: "response-001",
    toolCallId: "tool-call-001",
    skillInvocationId: "skill-invocation-001",
    mediaJobId: "media-job-001",
  },
  source: {
    namespace: "codex-app-server",
    adapterVersion: "0.147.0",
    sourceEventId: "source-event-001",
    sequence: "42",
    authority: "provider-reported" as const,
  },
  redaction: "content-free-v1" as const,
};

const decodeEvent = Schema.decodeUnknownSync(UnifiedUsageEvent);

describe("UnifiedUsageEvent", () => {
  it("is exported from the contracts package barrel", () => {
    expect(ExportedUnifiedUsageEvent).toBe(UnifiedUsageEvent);
  });

  it("decodes text and voice token deltas without conflating them with cost", () => {
    const event = decodeEvent({
      ...eventBase,
      kind: "usage.delta",
      payload: {
        meters: [
          { metric: "input_text_token", unit: "token", quantity: "120" },
          { metric: "input_cached_text_token", unit: "token", quantity: "40" },
          { metric: "output_text_token", unit: "token", quantity: "31" },
          { metric: "input_audio_token", unit: "token", quantity: "18" },
          { metric: "output_audio_token", unit: "token", quantity: "25" },
          { metric: "request_count", unit: "count", quantity: "1" },
        ],
      },
    });

    expect(event.kind).toBe("usage.delta");
    if (event.kind === "usage.delta") {
      expect(event.payload.meters.map((meter) => meter.metric)).toEqual([
        "input_text_token",
        "input_cached_text_token",
        "output_text_token",
        "input_audio_token",
        "output_audio_token",
        "request_count",
      ]);
      expect(event.payload).not.toHaveProperty("money");
    }
  });

  it("decodes image counts and video seconds or frames as typed meters", () => {
    const image = decodeEvent({
      ...eventBase,
      eventId: "event-image-001",
      idempotencyKey: "request-image-001",
      kind: "usage.delta",
      payload: {
        meters: [
          { metric: "input_image_token", unit: "token", quantity: "2048" },
          { metric: "image_output_count", unit: "count", quantity: "2" },
        ],
      },
    });
    const video = decodeEvent({
      ...eventBase,
      eventId: "event-video-001",
      idempotencyKey: "request-video-001",
      kind: "usage.delta",
      payload: {
        meters: [
          { metric: "video_input_second", unit: "second", quantity: "12.5" },
          { metric: "video_output_second", unit: "second", quantity: "8" },
          { metric: "provider_execution_second", unit: "second", quantity: "23.75" },
          { metric: "video_frame", unit: "frame", quantity: "240" },
        ],
      },
    });

    expect(image.kind === "usage.delta" && image.payload.meters[1]?.unit).toBe("count");
    expect(video.kind === "usage.delta" && video.payload.meters).toContainEqual({
      metric: "video_output_second",
      unit: "second",
      quantity: "8",
    });
    expect(video.kind === "usage.delta" && video.payload.meters).toContainEqual({
      metric: "provider_execution_second",
      unit: "second",
      quantity: "23.75",
    });
  });

  it("represents unknown USD cost as null while credits remain a separate ledger unit", () => {
    const event = decodeEvent({
      ...eventBase,
      eventId: "event-settlement-001",
      idempotencyKey: "settlement-001",
      kind: "billing.settlement",
      payload: {
        meters: [{ metric: "output_text_token", unit: "token", quantity: "31" }],
        money: null,
        credits: [{ ledger: "moss-point", delta: "-2" }],
        measurementBasis: "provider-reported",
      },
    });

    expect(event.kind).toBe("billing.settlement");
    if (event.kind === "billing.settlement") {
      expect(event.payload.money).toBeNull();
      expect(event.payload.credits).toEqual([{ ledger: "moss-point", delta: "-2" }]);
    }
  });

  it("keeps estimated money non-billable and skill invocations attribution-only", () => {
    expect(() =>
      decodeEvent({
        ...eventBase,
        eventId: "event-estimated-settlement-001",
        idempotencyKey: "estimated-settlement-001",
        kind: "billing.settlement",
        payload: {
          meters: [],
          money: {
            currency: "USD",
            nanoUnits: "9000000",
            basis: "estimated",
          },
          credits: [],
          measurementBasis: "unknown",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeEvent({
        ...eventBase,
        eventId: "event-estimated-adjustment-001",
        idempotencyKey: "estimated-adjustment-001",
        kind: "billing.adjustment",
        payload: {
          relatesToEventId: "event-settlement-001",
          direction: "charge",
          meters: [],
          money: {
            currency: "USD",
            nanoUnits: "9000000",
            basis: "estimated",
          },
          credits: [],
          reasonCode: "shadow-estimate",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeEvent({
        ...eventBase,
        eventId: "event-skill-001",
        idempotencyKey: "skill-lifecycle-001",
        kind: "operation.lifecycle",
        payload: {
          operationType: "skill-invocation",
          state: "completed",
          attributionOnly: false,
          billingOwnerEventId: "event-settlement-001",
        },
      }),
    ).toThrow();

    const reservation = decodeEvent({
      ...eventBase,
      eventId: "event-estimated-reservation-001",
      idempotencyKey: "estimated-reservation-001",
      kind: "billing.reservation",
      payload: {
        reservedMeters: [],
        money: { currency: "USD", nanoUnits: "9000000", basis: "estimated" },
        credits: [],
        expiresAt: null,
      },
    });
    const imageChild = decodeEvent({
      ...eventBase,
      eventId: "event-image-lifecycle-001",
      idempotencyKey: "image-lifecycle-001",
      kind: "operation.lifecycle",
      payload: {
        operationType: "image-generation",
        state: "completed",
        attributionOnly: false,
        billingOwnerEventId: "event-image-settlement-001",
      },
    });

    expect(reservation.kind).toBe("billing.reservation");
    expect(imageChild.kind === "operation.lifecycle" && imageChild.payload.attributionOnly).toBe(
      false,
    );
  });

  it("keeps provider-defined window identity separate from presentation labels", () => {
    const window = Schema.decodeUnknownSync(UsageWindow)({
      windowKey: "codex-secondary-001",
      sourceWindowId: "secondary-001",
      sourceRole: "secondary",
      cycleKind: "provider-defined",
      durationSeconds: 604_800,
      resetsAt: "2026-08-20T00:00:00.000Z",
      startBasis: "provider",
      revision: "revision-17",
      fieldMask: ["durationSeconds", "resetsAt"],
    });

    expect(window).toMatchObject({
      sourceRole: "secondary",
      cycleKind: "provider-defined",
      durationSeconds: 604_800,
      startBasis: "provider",
    });
    expect(JSON.stringify(window).toLowerCase()).not.toContain("weekly");
  });

  it("rejects content-bearing fields and unsafe opaque references", () => {
    expect(() =>
      decodeEvent({
        ...eventBase,
        kind: "usage.delta",
        payload: {
          meters: [{ metric: "request_count", unit: "count", quantity: "1" }],
          response: "raw provider response",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeEvent({
        ...eventBase,
        subject: { ...eventBase.subject, accountRef: "/Users/example/.config/credential" },
        kind: "usage.delta",
        payload: {
          meters: [{ metric: "request_count", unit: "count", quantity: "1" }],
        },
      }),
    ).toThrow();
  });

  it("supports out-of-order counters, explicit counter epochs, and linked adjustments", () => {
    const laterObservedFirst = decodeEvent({
      ...eventBase,
      eventId: "event-counter-020",
      idempotencyKey: "counter-020",
      kind: "usage.counter-snapshot",
      source: { ...eventBase.source, sequence: "20" },
      payload: {
        seriesId: "session-counter-001",
        epochId: "epoch-before-reset",
        revision: "20",
        counterMode: "cumulative",
        meters: [{ metric: "output_text_token", unit: "token", quantity: "1000" }],
      },
    });
    const lateEarlierEventAfterReset = decodeEvent({
      ...eventBase,
      eventId: "event-counter-019",
      idempotencyKey: "counter-019",
      observedAt: "2026-08-13T01:05:00.000Z",
      kind: "usage.counter-snapshot",
      source: { ...eventBase.source, sequence: "19" },
      payload: {
        seriesId: "session-counter-001",
        epochId: "epoch-after-reset",
        revision: "1",
        counterMode: "cumulative",
        meters: [{ metric: "output_text_token", unit: "token", quantity: "5" }],
      },
    });
    const adjustment = decodeEvent({
      ...eventBase,
      eventId: "event-adjustment-001",
      idempotencyKey: "adjustment-001",
      kind: "billing.adjustment",
      payload: {
        relatesToEventId: "event-settlement-001",
        direction: "refund",
        meters: [],
        money: {
          currency: "USD",
          nanoUnits: "5000000",
          basis: "rate-card-calculated",
          priceCardId: "voice-card-v1",
        },
        credits: [{ ledger: "moss-point", delta: "2" }],
        reasonCode: "provider-correction",
      },
    });

    expect(laterObservedFirst.source.sequence).toBe("20");
    expect(lateEarlierEventAfterReset.source.sequence).toBe("19");
    expect(
      laterObservedFirst.kind === "usage.counter-snapshot" &&
        lateEarlierEventAfterReset.kind === "usage.counter-snapshot" &&
        laterObservedFirst.payload.epochId !== lateEarlierEventAfterReset.payload.epochId,
    ).toBe(true);
    expect(adjustment.kind === "billing.adjustment" && adjustment.payload.direction).toBe("refund");
  });

  it("types inserted, exact replay, and digest-conflict append outcomes", () => {
    const decode = Schema.decodeUnknownSync(UsageLedgerAppendResult);
    expect(decode({ status: "inserted", eventId: "event-001" })).toEqual({
      status: "inserted",
      eventId: "event-001",
    });
    expect(decode({ status: "idempotent", eventId: "event-001" })).toEqual({
      status: "idempotent",
      eventId: "event-001",
    });
    expect(
      decode({
        status: "idempotency_conflict",
        eventId: "event-001",
        existingDigest: digest("a"),
        incomingDigest: digest("b"),
      }),
    ).toMatchObject({ status: "idempotency_conflict" });
    expect(() =>
      decode({
        status: "idempotency_conflict",
        eventId: "event-001",
        existingDigest: digest("a"),
        incomingDigest: digest("a"),
      }),
    ).toThrow();
  });
});
