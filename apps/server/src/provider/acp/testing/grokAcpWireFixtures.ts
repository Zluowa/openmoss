/**
 * Recorded Grok ACP frames (not live traffic).
 *
 * 1.0.62 fixtures (`grokRetryStateNotification`) match the current Mac CLI:
 * official `session/update` plus `_x.ai/session_notification` retry_state.
 * 1.0.52 fixtures (`grokPromptCompleteEndTurn`) match the older Linux CLI that
 * can send `_x.ai/session/prompt_complete` as a JSON-RPC request.
 *
 * 0.2.x fixtures (vendor sessionUpdate kinds, `_x.ai/hooks/run`) match published
 * wire notes from grok 0.2.101 / 0.2.112. They are version-limited and are not
 * the 1.0.62 Thinking-stuck root cause.
 *
 * @module grokAcpWireFixtures
 */

export const GROK_WIRE_SESSION_ID = "019f9a55-grok-wire-session";

export const grokUserMessageChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "你好，回一句短回复" },
    _meta: { modelId: "grok-4.6", promptIndex: 0 },
  },
} as const;

export const grokToolCallDeltaChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "tool_call_delta_chunk",
    tool_call_id: "call-wire-0",
    tool_index: 0,
    name: "read_file",
  },
} as const;

export const grokPendingInteraction = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "pending_interaction",
    tool_call_id: "call-wire-0",
    kind: "permission",
  },
} as const;

export const grokAgentThoughtChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "agent_thought_chunk",
    messageId: "msg_thought_1",
    content: { type: "text", text: "先确认用户要一句短回复。" },
  },
} as const;

export const grokAgentMessageChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_reply_1",
    content: { type: "text", text: "收到，我在。" },
    _meta: { modelId: "grok-4.6", promptIndex: 0 },
  },
} as const;

export const grokWrappedAgentMessageNotification = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_reply_1b",
    content: { type: "text", text: " 补充一句。" },
  },
} as const;

export const grokRetryStateNotification = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "retry_state",
    type: "retrying",
    attempt: 3,
    max_retries: 15,
    reason: "tcp connect error / operation timed out",
  },
} as const;

export const grokTurnCompletedUpdate = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "turn_completed",
    prompt_id: "prompt-wire-1",
    stop_reason: "end_turn",
    usage: { inputTokens: 19762, outputTokens: 36, totalTokens: 19798 },
  },
} as const;

/** Grok 4.7 thought + one-character reply used by 1.0.5x / 1.0.62 completion tests. */
export const grokHaoThoughtChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "agent_thought_chunk",
    messageId: "msg_thought_hao",
    content: { type: "text", text: "用户只要一个字。" },
  },
} as const;

export const grokHaoMessageChunk = {
  sessionId: GROK_WIRE_SESSION_ID,
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_hao",
    content: { type: "text", text: "好" },
  },
} as const;

/** 1.0.52 `_x.ai/session/prompt_complete` body (camelCase, often sent as a request). */
export const grokPromptCompleteEndTurn = {
  sessionId: GROK_WIRE_SESSION_ID,
  promptId: "prompt-wire-52",
  stopReason: "end_turn",
  agentResult: null,
} as const;

export function grokExtRequestFrame(id: string, method: string, params: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method,
    params,
  };
}

export const grokHookRunParams = {
  sessionId: GROK_WIRE_SESSION_ID,
  hookCallbackId: "moss-plan-guard",
  hookEventName: "pre_tool_use",
  toolName: "read_file",
} as const;

export function grokSessionUpdateFrame(params: unknown) {
  return {
    jsonrpc: "2.0" as const,
    method: "session/update",
    params,
  };
}

export function grokExtNotificationFrame(method: string, params: unknown) {
  return {
    jsonrpc: "2.0" as const,
    method,
    params,
  };
}

export function grokHookRunRequestFrame(id: string, method = "_x.ai/hooks/run") {
  return {
    jsonrpc: "2.0" as const,
    id,
    method,
    params: grokHookRunParams,
  };
}
