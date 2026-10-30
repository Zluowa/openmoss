import { describe, expect, it } from "vitest";

import { formatGrokRetryWorkingLabel, parseGrokRetryState } from "./GrokAcpRetry.ts";

describe("parseGrokRetryState", () => {
  it("reads a 1.0.62 _x.ai/session_notification retry_state", () => {
    const retry = parseGrokRetryState({
      sessionId: "019f9a55-grok-wire-session",
      type: "retry_state",
      attempt: 3,
      max_attempts: 15,
      error: "tcp connect error / operation timed out",
    });

    expect(retry).toEqual({
      reason: "connection timed out",
      attempt: 3,
      maxAttempts: 15,
    });
    expect(formatGrokRetryWorkingLabel(retry!)).toBe("Retrying: connection timed out (3/15)");
  });

  it("reads the recorded Grok 1.0.62 retrying notification", () => {
    const retry = parseGrokRetryState({
      sessionId: "019f9a55-grok-wire-session",
      update: {
        sessionUpdate: "retry_state",
        type: "retrying",
        attempt: 1,
        max_retries: 15,
        reason: "tcp connect error / operation timed out connecting to cli-chat-proxy.grok.com",
      },
    });

    expect(retry).toEqual({
      reason: "connection timed out",
      attempt: 1,
      maxAttempts: 15,
    });
    expect(formatGrokRetryWorkingLabel(retry!)).toBe("Retrying: connection timed out (1/15)");
  });

  it("reads retry_state nested under update.sessionUpdate", () => {
    const retry = parseGrokRetryState({
      sessionId: "s",
      update: {
        sessionUpdate: "retry_state",
        attempt: 1,
        maxAttempts: 15,
        message: "ETIMEDOUT connecting to cli-chat-proxy.grok.com",
      },
    });

    expect(retry?.reason).toBe("connection timed out");
    expect(formatGrokRetryWorkingLabel(retry!)).toBe("Retrying: connection timed out (1/15)");
  });

  it("defaults a retry_state without an error string to connection timed out", () => {
    expect(parseGrokRetryState({ type: "retry_state" })).toEqual({
      reason: "connection timed out",
    });
    expect(formatGrokRetryWorkingLabel({ reason: "connection timed out" })).toBe(
      "Retrying: connection timed out",
    );
  });

  it("ignores non-retry extension notifications", () => {
    expect(
      parseGrokRetryState({ type: "turn_completed", stop_reason: "end_turn" }),
    ).toBeUndefined();
    expect(parseGrokRetryState({ type: "prompt_complete" })).toBeUndefined();
  });
});
