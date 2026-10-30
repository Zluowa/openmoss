import { Schema } from "effect";

import {
  EventId,
  MossNormalizedSessionEvent as MossNormalizedSessionEventSchema,
  isToolLifecycleItemType,
  type MossNormalizedSessionEvent,
  type MossNormalizedSessionEventType,
  type ProviderRuntimeEvent,
  type RuntimeSessionId,
} from "@synara/contracts";

function isUntrackedDynamicToolCallRequest(
  requestType: string | undefined,
  requestId: string | undefined,
): boolean {
  // Codex auto-served `item/tool/call` requests share the request envelope but
  // have no request id. They are not permission prompts and should not become
  // misleading pending permission events. Requests with an id remain intact.
  return (
    requestType === "dynamic_tool_call" && (requestId === undefined || requestId.trim() === "")
  );
}

export interface NormalizeProviderRuntimeEventOptions {
  readonly sessionId?: RuntimeSessionId;
}

const decodeNormalizedSessionEvent = Schema.decodeUnknownSync(MossNormalizedSessionEventSchema);

function tracePayload(
  event: ProviderRuntimeEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const traced: Record<string, unknown> = {
    ...payload,
    sourceEventType: event.type,
  };
  if (event.itemId) {
    traced.itemId = event.itemId;
  }
  if (event.requestId) {
    traced.requestId = event.requestId;
  }
  if (event.launchPlanHash) {
    traced.launchPlanHash = event.launchPlanHash;
  }
  if (event.raw) {
    traced.rawSource = event.raw.source;
  }
  return traced;
}

function makeNormalizedEvent(
  event: ProviderRuntimeEvent,
  type: MossNormalizedSessionEventType,
  suffix: string,
  payload: Record<string, unknown>,
  options: NormalizeProviderRuntimeEventOptions,
): MossNormalizedSessionEvent | null {
  const sessionId = event.sessionId ?? options.sessionId;
  if (!sessionId) {
    return null;
  }

  return decodeNormalizedSessionEvent({
    eventId: EventId.makeUnsafe(`moss-normalized-${event.eventId}-${suffix}`),
    type,
    provider: event.provider,
    sessionId,
    threadId: event.threadId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    createdAt: event.createdAt,
    rawEventId: event.eventId,
    payload: tracePayload(event, payload),
  });
}

function keepEvent(
  event: MossNormalizedSessionEvent | null,
): ReadonlyArray<MossNormalizedSessionEvent> {
  return event ? [event] : [];
}

function normalizeTextEvent(
  event: ProviderRuntimeEvent,
  text: string,
  payload: Record<string, unknown>,
  options: NormalizeProviderRuntimeEventOptions,
): ReadonlyArray<MossNormalizedSessionEvent> {
  if (text.length === 0) {
    return [];
  }
  return keepEvent(
    makeNormalizedEvent(
      event,
      "text",
      "text",
      {
        text,
        ...payload,
      },
      options,
    ),
  );
}

function normalizeToolLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
  options: NormalizeProviderRuntimeEventOptions,
): ReadonlyArray<MossNormalizedSessionEvent> {
  if (!isToolLifecycleItemType(event.payload.itemType)) {
    return [];
  }
  const normalizedType = event.type === "item.completed" ? "tool-result" : "tool-call";
  return keepEvent(
    makeNormalizedEvent(
      event,
      normalizedType,
      normalizedType,
      {
        toolKind: event.payload.itemType,
        status: event.payload.status ?? null,
        title: event.payload.title ?? null,
        detail: event.payload.detail ?? null,
        data: event.payload.data ?? null,
      },
      options,
    ),
  );
}

function normalizeTurnCompletedEvent(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  options: NormalizeProviderRuntimeEventOptions,
): ReadonlyArray<MossNormalizedSessionEvent> {
  const normalized: MossNormalizedSessionEvent[] = [];
  if (
    event.payload.usage !== undefined ||
    event.payload.modelUsage !== undefined ||
    event.payload.totalCostUsd !== undefined ||
    event.payload.cumulativeCostUsd !== undefined
  ) {
    const usage = makeNormalizedEvent(
      event,
      "usage",
      "usage",
      {
        usage: event.payload.usage ?? null,
        modelUsage: event.payload.modelUsage ?? null,
        totalCostUsd: event.payload.totalCostUsd ?? null,
        cumulativeCostUsd: event.payload.cumulativeCostUsd ?? null,
      },
      options,
    );
    if (usage) {
      normalized.push(usage);
    }
  }

  if (event.payload.state === "failed" && event.payload.errorMessage) {
    const error = makeNormalizedEvent(
      event,
      "error",
      "error",
      {
        message: event.payload.errorMessage,
        class: "provider_error",
        state: event.payload.state,
      },
      options,
    );
    if (error) {
      normalized.push(error);
    }
  }

  const finish = makeNormalizedEvent(
    event,
    "finish",
    "finish",
    {
      state: event.payload.state,
      stopReason: event.payload.stopReason ?? null,
    },
    options,
  );
  if (finish) {
    normalized.push(finish);
  }
  return normalized;
}

export function normalizeProviderRuntimeEvent(
  event: ProviderRuntimeEvent,
  options: NormalizeProviderRuntimeEventOptions = {},
): ReadonlyArray<MossNormalizedSessionEvent> {
  switch (event.type) {
    case "content.delta":
      return normalizeTextEvent(
        event,
        event.payload.delta,
        {
          streamKind: event.payload.streamKind,
          contentIndex: event.payload.contentIndex ?? null,
          summaryIndex: event.payload.summaryIndex ?? null,
        },
        options,
      );
    case "turn.proposed.delta":
      return normalizeTextEvent(
        event,
        event.payload.delta,
        {
          streamKind: "plan_text",
        },
        options,
      );
    case "item.started":
    case "item.updated":
    case "item.completed":
      return normalizeToolLifecycleEvent(event, options);
    case "request.opened":
      if (isUntrackedDynamicToolCallRequest(event.payload.requestType, event.requestId)) {
        return [];
      }
      return keepEvent(
        makeNormalizedEvent(
          event,
          "permission-request",
          "permission-request-opened",
          {
            status: "pending",
            requestType: event.payload.requestType,
            detail: event.payload.detail ?? null,
            args: event.payload.args ?? null,
          },
          options,
        ),
      );
    case "request.resolved":
      if (isUntrackedDynamicToolCallRequest(event.payload.requestType, event.requestId)) {
        return [];
      }
      return keepEvent(
        makeNormalizedEvent(
          event,
          "permission-request",
          "permission-request-resolved",
          {
            status: "resolved",
            requestType: event.payload.requestType,
            decision: event.payload.decision ?? null,
            resolution: event.payload.resolution ?? null,
          },
          options,
        ),
      );
    case "user-input.requested":
      return keepEvent(
        makeNormalizedEvent(
          event,
          "permission-request",
          "user-input-requested",
          {
            status: "pending",
            requestType: "tool_user_input",
            questions: event.payload.questions,
          },
          options,
        ),
      );
    case "user-input.resolved":
      return keepEvent(
        makeNormalizedEvent(
          event,
          "permission-request",
          "user-input-resolved",
          {
            status: "resolved",
            requestType: "tool_user_input",
            answers: event.payload.answers,
          },
          options,
        ),
      );
    case "thread.token-usage.updated":
      return keepEvent(
        makeNormalizedEvent(
          event,
          "usage",
          "usage",
          {
            usage: event.payload.usage,
          },
          options,
        ),
      );
    case "turn.completed":
      return normalizeTurnCompletedEvent(event, options);
    case "turn.aborted": {
      const error = makeNormalizedEvent(
        event,
        "error",
        "error",
        {
          message: event.payload.reason,
          class: "provider_error",
          aborted: true,
        },
        options,
      );
      const finish = makeNormalizedEvent(
        event,
        "finish",
        "finish",
        {
          state: "interrupted",
          stopReason: event.payload.reason,
        },
        options,
      );
      return [error, finish].filter((entry): entry is MossNormalizedSessionEvent => entry !== null);
    }
    case "session.exited":
      return keepEvent(
        makeNormalizedEvent(
          event,
          event.payload.exitKind === "error" ? "error" : "finish",
          event.payload.exitKind === "error" ? "error" : "finish",
          {
            scope: "session",
            reason: event.payload.reason ?? null,
            recoverable: event.payload.recoverable ?? null,
            exitKind: event.payload.exitKind ?? null,
          },
          options,
        ),
      );
    case "thread.realtime.error":
      return keepEvent(
        makeNormalizedEvent(
          event,
          "error",
          "error",
          {
            message: event.payload.message,
            class: "transport_error",
          },
          options,
        ),
      );
    case "runtime.error":
      return keepEvent(
        makeNormalizedEvent(
          event,
          "error",
          "error",
          {
            message: event.payload.message,
            class: event.payload.class ?? "unknown",
            detail: event.payload.detail ?? null,
          },
          options,
        ),
      );
    default:
      return [];
  }
}

export function normalizeProviderRuntimeEvents(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  options: NormalizeProviderRuntimeEventOptions = {},
): ReadonlyArray<MossNormalizedSessionEvent> {
  return events.flatMap((event) => normalizeProviderRuntimeEvent(event, options));
}
