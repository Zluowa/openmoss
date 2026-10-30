/**
 * Grok turn-end classification.
 *
 * Grok 1.0.52 (Linux box CLI) can emit `_x.ai/session/prompt_complete` as a
 * JSON-RPC *request* (has `id`) and may then resolve `session/prompt` with
 * `stopReason: "cancelled"` if the client never ACKs — even after a complete
 * assistant reply. Current 1.0.62 treats the same method as a fire-and-forget
 * notification and still answers `{ stopReason: "end_turn" }`.
 *
 * Moss must ACK both shapes, record the vendor terminal, and not treat a
 * successful reply as Interrupted.
 *
 * @module GrokAcpTurnCompletion
 */
import { classifyAcpPromptTurnCompletion } from "./AcpAdapterSupport.ts";

export const GROK_PROMPT_COMPLETE_METHODS = [
  "_x.ai/session/prompt_complete",
  "x.ai/session/prompt_complete",
] as const;

const SUCCESSFUL_GROK_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

export type GrokPromptTurnCompletion = ReturnType<typeof classifyAcpPromptTurnCompletion> & {
  readonly stopReason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Collapse 1.0.5x / JSON-output aliases onto the official ACP stopReason set.
 * `EndTurn`, `end_of_turn`, `stop`, and `completed` all mean a normal finish.
 */
export function normalizeGrokStopReason(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const collapsed = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
  switch (collapsed) {
    case "endturn":
    case "endofturn":
    case "stop":
    case "completed":
    case "complete":
    case "done":
    case "success":
      return "end_turn";
    case "maxtokens":
      return "max_tokens";
    case "maxturnrequests":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
    case "canceled":
    case "cancel":
    case "interrupted":
      return "cancelled";
    case "error":
    case "failed":
      return "error";
    default:
      return trimmed;
  }
}

export function isSuccessfulGrokStopReason(reason: string | null | undefined): boolean {
  return reason !== undefined && reason !== null && SUCCESSFUL_GROK_STOP_REASONS.has(reason);
}

function readStopReasonFromRecord(record: Record<string, unknown>): string | undefined {
  return normalizeGrokStopReason(readString(record.stopReason) ?? readString(record.stop_reason));
}

function isVendorTurnCompleteKind(kind: string | undefined): boolean {
  if (!kind) return false;
  const collapsed = kind.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    collapsed === "promptcomplete" || collapsed === "turncompleted" || collapsed === "turncomplete"
  );
}

function collectVendorCompletionCandidates(params: unknown): Record<string, unknown>[] {
  if (!isRecord(params)) return [];
  const candidates = [params];
  for (const key of ["update", "notification", "data"] as const) {
    const nested = params[key];
    if (isRecord(nested)) candidates.push(nested);
  }
  return candidates;
}

/**
 * Read the vendor terminal from `_x.ai/session/prompt_complete` (camelCase) or
 * `turn_completed` (snake_case). Ignores retry_state and other session extras.
 */
export function parseGrokVendorTurnCompletion(
  params: unknown,
): { readonly stopReason: string } | undefined {
  for (const candidate of collectVendorCompletionCandidates(params)) {
    const kind =
      readString(candidate.sessionUpdate) ??
      readString(candidate.type) ??
      readString(candidate.kind);
    if (kind !== undefined && !isVendorTurnCompleteKind(kind)) continue;
    const stopReason = readStopReasonFromRecord(candidate);
    if (stopReason === undefined) continue;
    const looksLikePromptComplete =
      isVendorTurnCompleteKind(kind) ||
      candidate.promptId !== undefined ||
      candidate.prompt_id !== undefined ||
      candidate.agentResult !== undefined ||
      candidate.agent_result !== undefined;
    if (!looksLikePromptComplete) continue;
    return { stopReason };
  }
  return undefined;
}

export function classifyGrokPromptTurnCompletion(input: {
  readonly officialStopReason: string | null | undefined;
  readonly vendorStopReason?: string | undefined;
  readonly hadAssistantContent: boolean;
  readonly userRequestedInterrupt: boolean;
  readonly failedToolDetail?: string | undefined;
}): GrokPromptTurnCompletion {
  const failedTool =
    input.failedToolDetail !== undefined ? { failedToolDetail: input.failedToolDetail } : {};
  const official = normalizeGrokStopReason(input.officialStopReason);
  const vendor = normalizeGrokStopReason(input.vendorStopReason);

  if (input.userRequestedInterrupt) {
    const completion = classifyAcpPromptTurnCompletion({
      stopReason: "cancelled",
      ...failedTool,
    });
    return { ...completion, stopReason: "cancelled" };
  }

  let effective = official;
  if (official === "cancelled" || official === undefined) {
    if (isSuccessfulGrokStopReason(vendor)) {
      effective = vendor;
    } else if (input.hadAssistantContent && vendor !== "error") {
      // 1.0.52: unanswered prompt_complete request → official cancelled after a
      // finished reply. Visible assistant text plus no user Stop is a completed turn.
      effective = "end_turn";
    }
  }

  const completion = classifyAcpPromptTurnCompletion({
    stopReason: effective,
    ...failedTool,
  });
  return { ...completion, stopReason: effective ?? null };
}
