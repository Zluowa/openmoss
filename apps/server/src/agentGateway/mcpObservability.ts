import { createHash } from "node:crypto";

import type { ProviderKind } from "@synara/contracts";
import { Effect } from "effect";

import { captureSentryException } from "../observability/sentry";

/**
 * Safe, bounded labels for the MCP boundary.  Keep raw JSON-RPC method names
 * and request payloads out of logs: a caller can otherwise smuggle arbitrary
 * user content into a diagnostic field.
 */
export type AgentGatewayMcpMethodClass =
  | "initialize"
  | "ping"
  | "tools-list"
  | "tools-call"
  | "initialized-notification"
  | "cancelled-notification"
  | "other";

export type AgentGatewayMcpReasonCode =
  | "request-started"
  | "accepted"
  | "invalid-credential"
  | "projection-thread-missing"
  | "projection-query-failed"
  | "provider-query-failed"
  | "provider-ownership-mismatch"
  | "startup-proof-used"
  | "invalid-jsonrpc"
  | "empty-batch"
  | "batch-too-large"
  | "duplicate-request-id"
  | "invalid-params"
  | "unsupported-method"
  | "capability-denied"
  | "caller-turn-inactive"
  | "tool-error"
  | "payload-too-large"
  | "route-response-failure";

export type AgentGatewayMcpBoundaryOutcome = "pending" | "accepted" | "rejected" | "failed";

export type AgentGatewayMcpBoundaryStage =
  | "auth"
  | "body"
  | "projection"
  | "provider-ownership"
  | "handler"
  | "response";

/**
 * Only non-secret identity and protocol metadata belongs in this event.  The
 * optional observer is used by deterministic tests; production also sends the
 * same event through Effect's structured logger.
 */
export interface AgentGatewayMcpBoundaryEvent {
  readonly phase: "request" | "response";
  readonly stage: AgentGatewayMcpBoundaryStage;
  readonly httpStatus: number | null;
  readonly outcome: AgentGatewayMcpBoundaryOutcome;
  readonly reasonCode: AgentGatewayMcpReasonCode;
  readonly methodClass: AgentGatewayMcpMethodClass;
  readonly callerThreadId?: string;
  readonly callerProvider?: ProviderKind;
  /** First 16 hex characters of SHA-256(token); never the token itself. */
  readonly sessionFingerprint?: string;
  readonly durationMs?: number;
}

export type AgentGatewayMcpBoundaryObserver = (event: AgentGatewayMcpBoundaryEvent) => void;

export function classifyAgentGatewayMcpMethod(method: unknown): AgentGatewayMcpMethodClass {
  switch (method) {
    case "initialize":
      return "initialize";
    case "ping":
      return "ping";
    case "tools/list":
      return "tools-list";
    case "tools/call":
      return "tools-call";
    case "notifications/initialized":
      return "initialized-notification";
    case "notifications/cancelled":
      return "cancelled-notification";
    default:
      return "other";
  }
}

export function fingerprintAgentGatewaySession(
  token: string | null | undefined,
): string | undefined {
  if (!token) return undefined;
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

/**
 * Observability must never be able to break authentication or MCP handling.
 * The callback is intentionally best-effort and the structured log only
 * contains the already-safe event shape above.
 */
export function observeAgentGatewayMcpBoundary(
  event: AgentGatewayMcpBoundaryEvent,
  observer?: AgentGatewayMcpBoundaryObserver,
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      observer?.(event);
      if (event.outcome === "failed") {
        // MCP failures are often converted into a successful HTTP 200 with an
        // isError payload, so the process-level Sentry handler cannot see them.
        // Emit only bounded protocol metadata; never forward the request,
        // thread id, token fingerprint, or tool payload.
        captureSentryException(new Error(`Agent gateway MCP failure (${event.reasonCode})`), {
          errorSource: "agent-gateway-mcp",
          stage: event.stage,
          reasonCode: event.reasonCode,
          methodClass: event.methodClass,
          httpStatus: event.httpStatus ?? "none",
        });
      }
    } catch {
      // Diagnostics are never on the request's correctness path.
    }
  }).pipe(Effect.andThen(Effect.logInfo("agent_gateway.mcp_boundary", event)));
}
