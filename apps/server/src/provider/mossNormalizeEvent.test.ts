import { describe, expect, it } from "vitest";

import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@synara/contracts";

import {
  normalizeProviderRuntimeEvent,
  normalizeProviderRuntimeEvents,
} from "./mossNormalizeEvent.ts";

const threadId = ThreadId.makeUnsafe("thread-normalized");
const sessionId = RuntimeSessionId.makeUnsafe("runtime-session-normalized");
const turnId = TurnId.makeUnsafe("turn-normalized");

function baseEvent(
  input: Omit<
    ProviderRuntimeEvent,
    "eventId" | "threadId" | "createdAt" | "sessionId" | "turnId"
  > & {
    readonly eventId: string;
  },
): ProviderRuntimeEvent {
  return {
    ...input,
    eventId: EventId.makeUnsafe(input.eventId),
    threadId,
    sessionId,
    turnId,
    createdAt: "2026-07-01T00:00:00.000Z",
    launchPlanHash: "sha256:launch-plan",
  } as ProviderRuntimeEvent;
}

describe("mossNormalizeEvent", () => {
  it("maps Codex content deltas to text events with raw trace", () => {
    const normalized = normalizeProviderRuntimeEvent(
      baseEvent({
        eventId: "raw-codex-text",
        provider: "codex",
        type: "content.delta",
        raw: {
          source: "codex.eventmsg",
          payload: { type: "message_delta" },
        },
        payload: {
          streamKind: "assistant_text",
          delta: "hello",
        },
      }),
    );

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      type: "text",
      rawEventId: "raw-codex-text",
      payload: {
        text: "hello",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:launch-plan",
        rawSource: "codex.eventmsg",
      },
    });
  });

  it("maps Claude tool lifecycle events to tool-call and tool-result", () => {
    const normalized = normalizeProviderRuntimeEvents([
      baseEvent({
        eventId: "raw-claude-tool-start",
        provider: "claudeAgent",
        type: "item.started",
        itemId: RuntimeItemId.makeUnsafe("tool-1"),
        payload: {
          itemType: "mcp_tool_call",
          status: "inProgress",
          title: "Read file",
          data: {
            name: "filesystem.readFile",
          },
        },
      }),
      baseEvent({
        eventId: "raw-claude-tool-done",
        provider: "claudeAgent",
        type: "item.completed",
        itemId: RuntimeItemId.makeUnsafe("tool-1"),
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          title: "Read file",
          data: {
            output: "ok",
          },
        },
      }),
    ]);

    expect(normalized.map((event) => event.type)).toEqual(["tool-call", "tool-result"]);
    expect(normalized[0]?.payload).toMatchObject({
      toolKind: "mcp_tool_call",
      itemId: "tool-1",
    });
    expect(normalized[1]?.payload).toMatchObject({
      status: "completed",
      data: {
        output: "ok",
      },
    });
  });

  it("maps OpenCode permission, usage, finish, and error events", () => {
    const normalized = normalizeProviderRuntimeEvents([
      baseEvent({
        eventId: "raw-opencode-request",
        provider: "opencode",
        type: "request.opened",
        requestId: RuntimeRequestId.makeUnsafe("request-1"),
        payload: {
          requestType: "exec_command_approval",
          detail: "Run bun test",
          args: {
            command: "bun test",
          },
        },
      }),
      baseEvent({
        eventId: "raw-opencode-usage",
        provider: "opencode",
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens: 120,
            inputTokens: 80,
            outputTokens: 40,
          },
        },
      }),
      baseEvent({
        eventId: "raw-opencode-completed",
        provider: "opencode",
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: "stop",
          modelUsage: {
            model: "auto",
          },
        },
      }),
      baseEvent({
        eventId: "raw-opencode-error",
        provider: "opencode",
        type: "runtime.error",
        payload: {
          message: "provider crashed",
          class: "provider_error",
        },
      }),
    ]);

    expect(normalized.map((event) => event.type)).toEqual([
      "permission-request",
      "usage",
      "usage",
      "finish",
      "error",
    ]);
    expect(normalized[0]?.payload).toMatchObject({
      status: "pending",
      requestType: "exec_command_approval",
      requestId: "request-1",
    });
    expect(normalized[3]?.payload).toMatchObject({
      state: "completed",
      stopReason: "stop",
    });
    expect(normalized[4]?.payload).toMatchObject({
      message: "provider crashed",
      class: "provider_error",
    });
  });

  it("drops automatic dynamic tool request envelopes without hiding gated requests", () => {
    const automatic = normalizeProviderRuntimeEvents([
      baseEvent({
        eventId: "raw-dynamic-opened",
        provider: "codex",
        type: "request.opened",
        payload: { requestType: "dynamic_tool_call", detail: "moss_context" },
      }),
      baseEvent({
        eventId: "raw-dynamic-resolved",
        provider: "codex",
        type: "request.resolved",
        payload: { requestType: "dynamic_tool_call", resolution: { ok: true } },
      }),
    ]);
    expect(automatic).toEqual([]);

    const gated = normalizeProviderRuntimeEvent(
      baseEvent({
        eventId: "raw-dynamic-gated",
        provider: "codex",
        type: "request.opened",
        requestId: RuntimeRequestId.makeUnsafe("dynamic-request-1"),
        payload: { requestType: "dynamic_tool_call" },
      }),
    );
    expect(gated[0]).toMatchObject({
      type: "permission-request",
      payload: { requestId: "dynamic-request-1" },
    });
  });

  it("does not invent a session id for incomplete raw events", () => {
    const event = {
      eventId: EventId.makeUnsafe("raw-no-session"),
      provider: "codex",
      threadId,
      createdAt: "2026-07-01T00:00:00.000Z",
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "missing session",
      },
    } satisfies ProviderRuntimeEvent;

    expect(normalizeProviderRuntimeEvent(event)).toEqual([]);
    expect(normalizeProviderRuntimeEvent(event, { sessionId })).toHaveLength(1);
  });
});
