/**
 * Grok ACP inbound wire adapter.
 *
 * Grok 1.0.62 (the current Mac CLI) replies on official
 * `session/update agent_message_chunk` and emits `_x.ai/session_notification`
 * for `retry_state` / `turn_completed` / `prompt_complete`. That path does not
 * need this normalizer.
 *
 * Grok 1.0.52 may send `_x.ai/session/prompt_complete` as a JSON-RPC request
 * (has `id`). ACK and classification live in GrokAcpTurnCompletion / GrokAdapter;
 * this normalizer only rewrites countable `session/update` frames.
 *
 * Grok Build 0.2.x only: mixes official `session/update` frames with xAI
 * extension notifications (`_x.ai/session_notification`, `_x.ai/session/update`)
 * and vendor `sessionUpdate` kinds (`tool_call_delta_chunk`,
 * `pending_interaction`, `turn_completed`, …). Shapes are taken from live
 * recordings in azuriru3/grok-build-vscode ACP-NOTES (0.2.101) and
 * sr-web-studio/grok-build-unofficial acp-findings (0.2.112). Kept so a 0.2.x
 * binary cannot fail the prompt drain; it is not the 1.0.62 Thinking-stuck
 * root cause.
 *
 * @module GrokAcpIncoming
 */
import { ACP_SESSION_UPDATE_KINDS } from "./AcpRuntimeModel.ts";

export const GROK_SESSION_NOTIFICATION_METHODS = [
  "_x.ai/session_notification",
  "x.ai/session_notification",
  "_x.ai/session/update",
  "x.ai/session/update",
] as const;

const GROK_SESSION_NOTIFICATION_METHOD_SET = new Set<string>(GROK_SESSION_NOTIFICATION_METHODS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionUpdateKind(update: unknown): string | undefined {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") return undefined;
  const kind = update.sessionUpdate.trim();
  return kind.length > 0 ? kind : undefined;
}

function asSessionNotificationParams(
  params: Record<string, unknown>,
): { readonly sessionId: string; readonly update: Record<string, unknown> } | undefined {
  const update = isRecord(params.update) ? params.update : undefined;
  if (!update || sessionUpdateKind(update) === undefined) return undefined;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) return undefined;
  return { sessionId, update };
}

/**
 * Rewrite Grok's inbound JSON-RPC so Moss and the official ACP SDK see the same
 * countable `session/update` stream:
 *
 * - unwrap `_x.ai/session_notification` / `_x.ai/session/update` when they wrap
 *   a spec `sessionUpdate` (assistant text can arrive on that channel)
 * - retarget unknown vendor `sessionUpdate` kinds off `session/update` so they
 *   are not counted toward the prompt drain
 */
export function normalizeGrokIncomingAcpMessage(message: unknown): unknown {
  if (!isRecord(message) || typeof message.method !== "string") return message;
  const params = isRecord(message.params) ? message.params : undefined;
  if (!params) return message;

  if (GROK_SESSION_NOTIFICATION_METHOD_SET.has(message.method)) {
    const unwrapped = asSessionNotificationParams(params);
    const kind = unwrapped ? sessionUpdateKind(unwrapped.update) : undefined;
    if (unwrapped && kind && ACP_SESSION_UPDATE_KINDS.has(kind)) {
      return {
        ...message,
        method: "session/update",
        params: unwrapped,
      };
    }
    return message;
  }

  if (message.method !== "session/update") return message;
  const kind = sessionUpdateKind(params.update);
  if (kind && ACP_SESSION_UPDATE_KINDS.has(kind)) return message;
  return {
    ...message,
    method: "_x.ai/session_notification",
  };
}
