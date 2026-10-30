import { describe, expect, it } from "vitest";

import type { ProviderRuntimeEvent } from "@synara/contracts";

import {
  MEDIA_USAGE_INSTRUMENTATION,
  MediaUsageReceiptAppendError,
  appendMediaUsageReceipt,
  buildMediaUsageReceipt,
  mediaUsageReceiptFromProviderEvent,
  postgresJsonbTextForUsagePayload,
  postgresUsagePayloadDigest,
  type BuildMediaUsageReceiptInput,
  type MediaUsageReceiptAppender,
} from "./mediaUsageReceiptBridge.ts";

const baseInput = {
  subject: {
    provider: "codex",
    providerInstanceId: "codex_moss",
    accountRef: "account-ref-1",
  },
  descriptor: {
    kind: "image",
    modelRef: "gpt-image-2",
    sizeRef: "1024x1024",
    qualityRef: "high",
  },
  skill: {
    invocationId: "skill-invocation-1",
    skillRef: "moss-official-imagegen",
    state: "completed",
  },
  attempt: {
    attemptIndex: 0,
    role: "primary",
    state: "completed",
    toolCallId: "tool-call-1",
    mediaJobId: "media-job-1",
  },
  source: {
    namespace: "moss-media-gateway",
    sourceEventId: "source-event-1",
    authority: "provider-reported",
  },
  occurredAt: "2026-08-13T01:02:03.000Z",
  observedAt: "2026-08-13T01:02:04.000Z",
  threadId: "thread-1",
  turnId: "turn-1",
  requestId: "request-1",
} as const satisfies Omit<BuildMediaUsageReceiptInput, "observation" | "pricing">;

function kinds(input: ReturnType<typeof buildMediaUsageReceipt>) {
  return input.events.map((event) => event.kind);
}

describe("buildMediaUsageReceipt", () => {
  it("matches PostgreSQL jsonb text ordering and payload digest bytes", () => {
    const payload = {
      meters: [{ metric: "image_output_count", unit: "count", quantity: "1" }],
    };
    expect(postgresJsonbTextForUsagePayload(payload)).toBe(
      '{"meters": [{"unit": "count", "metric": "image_output_count", "quantity": "1"}]}',
    );
    expect(postgresUsagePayloadDigest(payload)).toBe(
      "655d42e3eded9b35069769e769d436c13006da710f16ff3ccb81dfefad02b577",
    );
  });

  it("keeps skill invocation attribution-only and records an unpriced image observation", () => {
    const receipt = buildMediaUsageReceipt({
      ...baseInput,
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });

    expect(receipt.billingDisposition).toBe("unpriced-observation");
    expect(kinds(receipt)).toEqual(["operation.lifecycle", "operation.lifecycle", "usage.delta"]);
    expect(receipt.events.some((event) => event.kind === "billing.settlement")).toBe(false);
    expect(receipt.events[0]).toMatchObject({
      operation: {
        operationId: receipt.skillOperationId,
        skillInvocationId: "skill-invocation-1",
      },
      payload: {
        operationType: "skill-invocation",
        state: "completed",
        attributionOnly: true,
      },
    });
    expect(receipt.events[1]).toMatchObject({
      operation: {
        operationId: receipt.requestOperationId,
        parentOperationId: receipt.skillOperationId,
        toolCallId: "tool-call-1",
        mediaJobId: "media-job-1",
      },
      payload: {
        operationType: "image-generation",
        attributionOnly: false,
      },
    });
    expect(receipt.events[2]).toMatchObject({
      source: { authority: "provider-reported" },
      payload: {
        meters: [{ metric: "image_output_count", unit: "count", quantity: "1" }],
      },
    });
  });

  it("settles only authoritative money or credits and does not duplicate meters as usage.delta", () => {
    const receipt = buildMediaUsageReceipt({
      ...baseInput,
      descriptor: {
        kind: "video",
        modelRef: "video-model-1",
        resolutionRef: "1920x1080",
        qualityRef: "production",
      },
      observation: {
        videoOutputSeconds: "8.25",
        videoFrames: "198",
        providerExecutionSeconds: "12.5",
        providerCredits: "3",
      },
      pricing: {
        kind: "authoritative",
        money: { currency: "USD", nanoUnits: "250000000", basis: "provider-reported" },
        credits: [{ ledger: "apimart", delta: "-3" }],
      },
    });

    expect(receipt.billingDisposition).toBe("authoritative-settlement");
    expect(kinds(receipt)).toEqual([
      "operation.lifecycle",
      "operation.lifecycle",
      "billing.settlement",
    ]);
    const lifecycle = receipt.events[1];
    const settlement = receipt.events[2];
    expect(lifecycle?.kind).toBe("operation.lifecycle");
    expect(settlement?.kind).toBe("billing.settlement");
    if (lifecycle?.kind === "operation.lifecycle" && settlement?.kind === "billing.settlement") {
      expect(lifecycle.payload.billingOwnerEventId).toBe(settlement.eventId);
      expect(settlement.payload).toMatchObject({
        money: { nanoUnits: "250000000", basis: "provider-reported" },
        credits: [{ ledger: "apimart", delta: "-3" }],
        meters: [
          { metric: "video_output_second", unit: "second", quantity: "8.25" },
          { metric: "video_frame", unit: "frame", quantity: "198" },
          { metric: "provider_execution_second", unit: "second", quantity: "12.5" },
          { metric: "provider_credit", unit: "credit", quantity: "3" },
        ],
      });
    }
  });

  it("keeps estimated observations shadow-only and never creates settlement", () => {
    const receipt = buildMediaUsageReceipt({
      ...baseInput,
      observation: { imageOutputCount: "1" },
      pricing: { kind: "estimated" },
      source: { ...baseInput.source, authority: "estimated" },
    });

    expect(receipt.billingDisposition).toBe("estimated-observation");
    expect(kinds(receipt)).not.toContain("billing.settlement");
    expect(receipt.events.at(-1)).toMatchObject({
      kind: "usage.delta",
      source: { authority: "estimated" },
    });
  });

  it("rejects billable settlement from local/estimated authority and cross-media meters", () => {
    expect(() =>
      buildMediaUsageReceipt({
        ...baseInput,
        source: { ...baseInput.source, authority: "local-derived" },
        observation: { imageOutputCount: "1" },
        pricing: { kind: "authoritative", money: baseInputMoney },
      }),
    ).toThrow("authoritative source authority");
    expect(() =>
      buildMediaUsageReceipt({
        ...baseInput,
        observation: { videoOutputSeconds: "1" },
        pricing: { kind: "unpriced" },
      }),
    ).toThrow("image receipts cannot contain video meters");
    expect(() =>
      buildMediaUsageReceipt({
        ...baseInput,
        source: { ...baseInput.source, authority: "provider-reported" },
        observation: { imageOutputCount: "1" },
        pricing: { kind: "estimated" },
      }),
    ).toThrow("estimated source authority");
  });

  it.each(["started", "failed", "cancelled"] as const)(
    "emits lifecycle only for a %s external request",
    (state) => {
      const receipt = buildMediaUsageReceipt({
        ...baseInput,
        skill: {
          invocationId: baseInput.skill.invocationId,
          skillRef: baseInput.skill.skillRef,
        },
        attempt: { ...baseInput.attempt, state },
        observation: { imageOutputCount: "1" },
        pricing: { kind: "authoritative", money: baseInputMoney },
      });

      expect(kinds(receipt)).toEqual(["operation.lifecycle"]);
      expect(receipt.billingDisposition).toBe("no-usage-observed");
      expect(receipt.events[0]).toMatchObject({ payload: { state } });
    },
  );

  it("derives stable operations for replay and distinct operations for retry and fallback", () => {
    const primary = buildMediaUsageReceipt({
      ...baseInput,
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });
    const replay = buildMediaUsageReceipt({
      ...baseInput,
      observedAt: "2026-08-13T01:03:00.000Z",
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });
    const retry = buildMediaUsageReceipt({
      ...baseInput,
      attempt: { ...baseInput.attempt, attemptIndex: 1, role: "retry" },
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });
    const fallback = buildMediaUsageReceipt({
      ...baseInput,
      descriptor: { ...baseInput.descriptor, modelRef: "fallback-image-model" },
      attempt: { ...baseInput.attempt, attemptIndex: 1, role: "fallback" },
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });

    expect(replay.requestOperationId).toBe(primary.requestOperationId);
    expect(replay.events.map((event) => event.idempotencyKey)).toEqual(
      primary.events.map((event) => event.idempotencyKey),
    );
    expect(retry.requestOperationId).not.toBe(primary.requestOperationId);
    expect(fallback.requestOperationId).not.toBe(retry.requestOperationId);
    expect(retry.skillOperationId).toBe(primary.skillOperationId);
    expect(fallback.skillOperationId).toBe(primary.skillOperationId);
  });

  it("accepts executor-owned stable operation identities across task assignment", () => {
    const operationIdentity = {
      skillOperationId: "official-media-invocation-1",
      requestOperationId: "official-media-attempt-1",
    } as const;
    const started = buildMediaUsageReceipt({
      ...baseInput,
      attempt: { ...baseInput.attempt, state: "started", mediaJobId: "task-1" },
      operationIdentity,
      pricing: { kind: "unpriced" },
    });
    const completed = buildMediaUsageReceipt({
      ...baseInput,
      attempt: { ...baseInput.attempt, state: "completed", mediaJobId: "task-1" },
      operationIdentity,
      observation: { imageOutputCount: "1", providerExecutionSeconds: "2.5" },
      pricing: { kind: "unpriced" },
    });

    expect(started.skillOperationId).toBe(operationIdentity.skillOperationId);
    expect(started.requestOperationId).toBe(operationIdentity.requestOperationId);
    expect(completed.requestOperationId).toBe(started.requestOperationId);
    expect(completed.events.at(-1)).toMatchObject({
      payload: {
        meters: [
          { metric: "image_output_count", unit: "count", quantity: "1" },
          { metric: "provider_execution_second", unit: "second", quantity: "2.5" },
        ],
      },
    });
  });

  it("rejects content-bearing refs and malformed meter quantities", () => {
    expect(() =>
      buildMediaUsageReceipt({
        ...baseInput,
        descriptor: { kind: "image", modelRef: "secret model prompt" },
        observation: { imageOutputCount: "1" },
        pricing: { kind: "unpriced" },
      }),
    ).toThrow("opaque content-free reference");
    expect(() =>
      buildMediaUsageReceipt({
        ...baseInput,
        descriptor: { kind: "video" },
        observation: { videoOutputSeconds: "-1" },
        pricing: { kind: "unpriced" },
      }),
    ).toThrow("non-negative decimal string");
  });
});

const baseInputMoney = {
  currency: "USD",
  nanoUnits: "1",
  basis: "provider-reported",
} as const;

describe("appendMediaUsageReceipt", () => {
  it("fails closed on a same-key/different-payload conflict from the atomic append", async () => {
    const receipt = buildMediaUsageReceipt({
      ...baseInput,
      observation: { imageOutputCount: "1" },
      pricing: { kind: "unpriced" },
    });
    let calls = 0;
    const appender: MediaUsageReceiptAppender = {
      instrumentationStatus: "DURABLE",
      appendAtomically: async (events) => {
        calls += 1;
        return events.map((event, index) =>
          index === 1
            ? {
                status: "idempotency_conflict",
                eventId: event.eventId,
                existingDigest: "a".repeat(64),
                incomingDigest: "b".repeat(64),
              }
            : { status: "inserted", eventId: event.eventId },
        );
      },
    };

    await expect(appendMediaUsageReceipt(appender, receipt)).rejects.toBeInstanceOf(
      MediaUsageReceiptAppendError,
    );
    expect(calls).toBe(1);
  });
});

function imageEvent(overrides: Partial<ProviderRuntimeEvent> = {}): ProviderRuntimeEvent {
  return {
    eventId: "provider-event-1",
    provider: "codex",
    providerInstanceId: "codex_moss",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "image-call-1",
    createdAt: "2026-08-13T01:02:03.000Z",
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      data: {
        kind: "codex.generated_image",
        path: "/private/content-must-not-enter-usage/image.png",
        callId: "image-call-1",
      },
    },
    ...overrides,
  } as ProviderRuntimeEvent;
}

describe("mediaUsageReceiptFromProviderEvent", () => {
  it("requires an authoritative account scope before adapting a Codex completion", () => {
    expect(mediaUsageReceiptFromProviderEvent(imageEvent())).toBeNull();
  });

  it("adapts a scoped Codex completion to one unpriced count", () => {
    const receipt = mediaUsageReceiptFromProviderEvent(imageEvent(), {
      accountRef: "account-ref-authoritative",
    });

    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({
      descriptor: { kind: "image" },
      billingDisposition: "unpriced-observation",
    });
    expect(receipt?.descriptor).not.toHaveProperty("modelRef");
    expect(receipt?.events.some((event) => event.kind === "billing.settlement")).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("/private/");
    expect(receipt?.events.at(-1)).toMatchObject({
      kind: "usage.delta",
      payload: {
        meters: [{ metric: "image_output_count", unit: "count", quantity: "1" }],
      },
    });
    expect(receipt?.events.at(-1)?.subject.accountRef).toBe("account-ref-authoritative");
    expect(receipt?.events.at(-1)?.subject.accountRef).not.toBe("provider-instance:codex_moss");
  });

  it("skips incomplete, invalidly scoped, and video-like events", () => {
    const scope = { accountRef: "account-ref-authoritative" } as const;
    expect(
      mediaUsageReceiptFromProviderEvent(
        imageEvent({ providerInstanceId: undefined }) as ProviderRuntimeEvent,
        scope,
      ),
    ).toBeNull();
    expect(
      mediaUsageReceiptFromProviderEvent(
        imageEvent({ payload: { itemType: "image_generation", status: "failed" } }),
        scope,
      ),
    ).toBeNull();
    expect(
      mediaUsageReceiptFromProviderEvent(
        imageEvent({ payload: { itemType: "dynamic_tool_call", status: "completed" } }),
        scope,
      ),
    ).toBeNull();
    expect(
      mediaUsageReceiptFromProviderEvent(imageEvent(), {
        accountRef: "contains private content",
      }),
    ).toBeNull();
  });

  it("reports the production-ready receipt contract separately from unwired callers", () => {
    expect(MEDIA_USAGE_INSTRUMENTATION).toEqual({
      receiptBridge: "PRODUCTION_CONTRACT_READY",
      codexBuiltInImageEventAdapter: "LOCAL_CONTRACT_ACCOUNT_SCOPE_REQUIRED",
      codexBuiltInImageProductionPersistence: "NOT_INSTRUMENTED",
      officialVideoSkillsProductionPersistence: "SERVER_COORDINATOR_READY_GATEWAY_BLOCKED",
    });
  });
});
