import { describe, expect, it } from "vitest";

import {
  classifyGrokPromptTurnCompletion,
  normalizeGrokStopReason,
  parseGrokVendorTurnCompletion,
} from "./GrokAcpTurnCompletion.ts";

describe("normalizeGrokStopReason", () => {
  it("maps 1.0.5x / JSON-output aliases onto official ACP reasons", () => {
    expect(normalizeGrokStopReason("end_turn")).toBe("end_turn");
    expect(normalizeGrokStopReason("EndTurn")).toBe("end_turn");
    expect(normalizeGrokStopReason("end_of_turn")).toBe("end_turn");
    expect(normalizeGrokStopReason("stop")).toBe("end_turn");
    expect(normalizeGrokStopReason("completed")).toBe("end_turn");
    expect(normalizeGrokStopReason("cancelled")).toBe("cancelled");
    expect(normalizeGrokStopReason("canceled")).toBe("cancelled");
    expect(normalizeGrokStopReason("error")).toBe("error");
  });
});

describe("parseGrokVendorTurnCompletion", () => {
  it("reads a 1.0.52 _x.ai/session/prompt_complete payload", () => {
    expect(
      parseGrokVendorTurnCompletion({
        sessionId: "019f9a55-grok-wire-session",
        promptId: "prompt-52",
        stopReason: "end_turn",
        agentResult: null,
      }),
    ).toEqual({ stopReason: "end_turn" });
  });

  it("reads a 1.0.62 turn_completed snake_case update", () => {
    expect(
      parseGrokVendorTurnCompletion({
        sessionId: "019f9a55-grok-wire-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-62",
          stop_reason: "end_turn",
          agent_result: null,
        },
      }),
    ).toEqual({ stopReason: "end_turn" });
  });

  it("ignores retry_state even when it carries a reason string", () => {
    expect(
      parseGrokVendorTurnCompletion({
        sessionId: "019f9a55-grok-wire-session",
        update: {
          sessionUpdate: "retry_state",
          type: "retrying",
          attempt: 1,
          max_retries: 15,
          reason: "tcp connect error / operation timed out",
        },
      }),
    ).toBeUndefined();
  });
});

describe("classifyGrokPromptTurnCompletion", () => {
  it("keeps 1.0.62 official end_turn as completed", () => {
    expect(
      classifyGrokPromptTurnCompletion({
        officialStopReason: "end_turn",
        hadAssistantContent: true,
        userRequestedInterrupt: false,
      }),
    ).toEqual({ state: "completed", stopReason: "end_turn" });
  });

  it("does not mark a 1.0.52 finished reply as cancelled", () => {
    expect(
      classifyGrokPromptTurnCompletion({
        officialStopReason: "cancelled",
        vendorStopReason: "end_turn",
        hadAssistantContent: true,
        userRequestedInterrupt: false,
      }),
    ).toEqual({ state: "completed", stopReason: "end_turn" });
  });

  it("treats official cancelled plus visible assistant text as completed when vendor is missing", () => {
    expect(
      classifyGrokPromptTurnCompletion({
        officialStopReason: "cancelled",
        hadAssistantContent: true,
        userRequestedInterrupt: false,
      }),
    ).toEqual({ state: "completed", stopReason: "end_turn" });
  });

  it("keeps a real user Stop as cancelled even after assistant text", () => {
    expect(
      classifyGrokPromptTurnCompletion({
        officialStopReason: "cancelled",
        vendorStopReason: "end_turn",
        hadAssistantContent: true,
        userRequestedInterrupt: true,
      }),
    ).toEqual({ state: "cancelled", stopReason: "cancelled" });
  });

  it("keeps an empty cancelled turn cancelled", () => {
    expect(
      classifyGrokPromptTurnCompletion({
        officialStopReason: "cancelled",
        hadAssistantContent: false,
        userRequestedInterrupt: false,
      }),
    ).toEqual({ state: "cancelled", stopReason: "cancelled" });
  });
});
