import { describe, expect, it } from "vitest";

import { normalizeGrokIncomingAcpMessage } from "./GrokAcpIncoming.ts";
import {
  grokAgentMessageChunk,
  grokExtNotificationFrame,
  grokExtRequestFrame,
  grokPromptCompleteEndTurn,
  grokRetryStateNotification,
  grokSessionUpdateFrame,
  grokToolCallDeltaChunk,
  grokTurnCompletedUpdate,
  grokUserMessageChunk,
  grokWrappedAgentMessageNotification,
} from "./testing/grokAcpWireFixtures.ts";

describe("normalizeGrokIncomingAcpMessage", () => {
  it("keeps official session/update chunks that carry Grok _meta", () => {
    const frame = grokSessionUpdateFrame(grokUserMessageChunk);
    expect(normalizeGrokIncomingAcpMessage(frame)).toEqual(frame);
    expect(normalizeGrokIncomingAcpMessage(grokSessionUpdateFrame(grokAgentMessageChunk))).toEqual(
      grokSessionUpdateFrame(grokAgentMessageChunk),
    );
  });

  it("retargets vendor sessionUpdate kinds off session/update", () => {
    expect(normalizeGrokIncomingAcpMessage(grokSessionUpdateFrame(grokToolCallDeltaChunk))).toEqual(
      {
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: grokToolCallDeltaChunk,
      },
    );
    expect(
      normalizeGrokIncomingAcpMessage(grokSessionUpdateFrame(grokTurnCompletedUpdate)),
    ).toEqual({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: grokTurnCompletedUpdate,
    });
  });

  it("unwraps _x.ai/session_notification when it wraps assistant text", () => {
    expect(
      normalizeGrokIncomingAcpMessage(
        grokExtNotificationFrame("_x.ai/session_notification", grokWrappedAgentMessageNotification),
      ),
    ).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: grokWrappedAgentMessageNotification,
    });
  });

  it("leaves a 1.0.62 retry_state notification on the extension channel", () => {
    const frame = grokExtNotificationFrame(
      "_x.ai/session_notification",
      grokRetryStateNotification,
    );
    expect(normalizeGrokIncomingAcpMessage(frame)).toEqual(frame);
  });

  it("leaves a 1.0.52 prompt_complete request on the extension channel", () => {
    const frame = grokExtRequestFrame(
      "pc-1",
      "_x.ai/session/prompt_complete",
      grokPromptCompleteEndTurn,
    );
    expect(normalizeGrokIncomingAcpMessage(frame)).toEqual(frame);
  });

  it("leaves non-session Grok extension notifications untouched", () => {
    const frame = grokExtNotificationFrame("_x.ai/queue/changed", {
      sessionId: grokUserMessageChunk.sessionId,
      entries: [],
    });
    expect(normalizeGrokIncomingAcpMessage(frame)).toEqual(frame);
  });
});
