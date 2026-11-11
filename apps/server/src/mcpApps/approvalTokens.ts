// FILE: approvalTokens.ts
// Purpose: One-time approval tokens for widget `tools/call` (PLAN §2.2): the host shows Moss's
//   approval UI, then repeats the call with the token. A token is valid once, for two minutes, and
//   only for the same thread, server, tool and arguments.
// Layer: Server MCP Apps runtime (in-memory)
// Exports: McpAppApprovalTokens, MCP_APP_APPROVAL_TOKEN_TTL_MS

import { randomBytes } from "node:crypto";

export const MCP_APP_APPROVAL_TOKEN_TTL_MS = 2 * 60_000;
const MAX_OUTSTANDING_TOKENS = 256;

interface TokenScope {
  readonly threadId: string;
  readonly server: string;
  readonly toolName: string;
  readonly argsHash: string;
}

export class McpAppApprovalTokens {
  private readonly tokens = new Map<string, TokenScope & { readonly expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(scope: TokenScope): string {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, { ...scope, expiresAt: this.now() + MCP_APP_APPROVAL_TOKEN_TTL_MS });
    return token;
  }

  /** True once for a live token whose scope matches exactly; the token is spent either way. */
  consume(token: string, scope: TokenScope): boolean {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    this.tokens.delete(token);
    return (
      entry.expiresAt > this.now() &&
      entry.threadId === scope.threadId &&
      entry.server === scope.server &&
      entry.toolName === scope.toolName &&
      entry.argsHash === scope.argsHash
    );
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
    while (this.tokens.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
  }
}
