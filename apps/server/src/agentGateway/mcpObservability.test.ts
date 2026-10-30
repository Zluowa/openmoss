import { describe, expect, it } from "vitest";

import {
  classifyAgentGatewayMcpMethod,
  fingerprintAgentGatewaySession,
  observeAgentGatewayMcpBoundary,
  type AgentGatewayMcpBoundaryEvent,
} from "./mcpObservability.ts";
import { Effect } from "effect";

describe("agent gateway MCP boundary observability", () => {
  it("uses bounded protocol classes and a non-reversible token fingerprint", () => {
    expect(classifyAgentGatewayMcpMethod("initialize")).toBe("initialize");
    expect(classifyAgentGatewayMcpMethod("user-content-as-method")).toBe("other");
    const token = "sagw_session_sensitive-token-value";
    const fingerprint = fingerprintAgentGatewaySession(token);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toBe(token);
    expect(
      JSON.stringify({
        method: classifyAgentGatewayMcpMethod("user-content-as-method"),
        fingerprint,
      }),
    ).not.toContain("user-content-as-method");
  });

  it("does not let an observer failure affect the request effect", async () => {
    const event: AgentGatewayMcpBoundaryEvent = {
      phase: "response",
      stage: "response",
      httpStatus: 401,
      outcome: "rejected",
      reasonCode: "invalid-credential",
      methodClass: "tools-call",
      callerThreadId: "thread-safe-log-test",
      callerProvider: "codex",
      sessionFingerprint: "0123456789abcdef",
      durationMs: 1,
    };
    const result = await Effect.runPromise(
      observeAgentGatewayMcpBoundary(event, () => {
        throw new Error("observer failure must stay out of the request path");
      }),
    );
    expect(result).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("observer failure");
    expect(JSON.stringify(event)).not.toContain("Authorization");
    expect(JSON.stringify(event)).not.toContain("secret");
  });
});
