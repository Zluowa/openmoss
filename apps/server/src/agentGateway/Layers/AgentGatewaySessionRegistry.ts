import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewayCapability,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
  type AgentGatewayWriteAuthority,
} from "../Services/AgentGatewaySessionRegistry.ts";

const PROVIDER_SESSION_CAPABILITIES = [
  "thread:read",
  "thread:write",
  "automation:write",
  "diagnostics:read",
  "browser:control",
  "device:control",
] as const;

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  interface RegisteredSession {
    identity: AgentGatewaySessionIdentity;
    retiredWriteTurnId: string | undefined;
    /** Turns retired while the bearer stayed live (turn-scoped bearers only). */
    readonly retiredTurnIds: Set<string>;
  }
  const MAX_RETIRED_TURN_IDS = 512;
  const sessions = new Map<string, RegisteredSession>();
  const sessionsByKey = new Map<string, RegisteredSession>();

  const disabledComputerThreads = new Set<string>();
  const visibleIdentity = (identity: AgentGatewaySessionIdentity): AgentGatewaySessionIdentity =>
    disabledComputerThreads.has(identity.threadId)
      ? {
          ...identity,
          capabilities: new Set(
            [...identity.capabilities].filter((capability) => capability !== "computer:control"),
          ),
        }
      : identity;
  return {
    setComputerControlEnabled: (threadId, enabled) => {
      if (enabled) disabledComputerThreads.delete(threadId);
      else {
        disabledComputerThreads.add(threadId);
        for (const row of sessionsByKey.values()) {
          if (row.identity.threadId !== threadId) continue;
          row.identity = {
            ...row.identity,
            capabilities: new Set(
              [...row.identity.capabilities].filter(
                (capability) => capability !== "computer:control",
              ),
            ),
          };
        }
      }
    },
    computerControlProvisioned: (threadId, provider) => {
      const candidates = [...sessionsByKey.values()].filter(
        (row) => row.identity.threadId === threadId && row.identity.provider === provider,
      );
      return candidates.at(-1)?.identity.capabilities.has("computer:control") ?? false;
    },
    issue: (threadId, provider, issueOptions) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        capabilities: new Set<AgentGatewayCapability>([
          ...PROVIDER_SESSION_CAPABILITIES,
          ...(issueOptions?.additionalCapabilities ?? []).filter(
            (capability) =>
              capability !== "computer:control" || !disabledComputerThreads.has(threadId),
          ),
        ]),
      };
      const registered: RegisteredSession = {
        identity,
        retiredWriteTurnId: undefined,
        retiredTurnIds: new Set(),
      };
      sessions.set(token, registered);
      sessionsByKey.set(sessionKey, registered);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token)?.identity;
      return identity ? visibleIdentity(identity) : null;
    },
    bindWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered || registered.retiredWriteTurnId !== undefined) return null;
      if (registered.retiredTurnIds.has(turnId)) return null;
      const { identity } = registered;
      if (identity.nativeTurnId !== undefined && identity.nativeTurnId !== turnId) return null;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const registered = sessionsByKey.get(authority.sessionKey);
      const identity = registered?.identity;
      return (
        identity !== undefined &&
        registered?.retiredWriteTurnId === undefined &&
        !registered?.retiredTurnIds.has(authority.turnId) &&
        (identity.nativeTurnId === undefined || identity.nativeTurnId === authority.turnId) &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider
      );
    },
    observeNativeTurn: (token, turnId) => {
      const row = sessions.get(token);
      if (!row || row.identity.provider !== "codex" || row.retiredWriteTurnId !== undefined) return;
      const prior = row.identity.nativeTurnId;
      if (prior != null) {
        // A second native parent turn on one bearer must retire the old claim even if
        // the earlier terminal notification was lost. Neither turn may use it now.
        if (turnId !== null && turnId !== prior) row.retiredWriteTurnId = prior;
        return;
      }
      // The identity captured at ingress must keep the turn it had at that instant.
      row.identity = { ...row.identity, nativeTurnId: turnId };
    },
    retireWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered) return false;
      if (registered.retiredWriteTurnId !== undefined) {
        return registered.retiredWriteTurnId === turnId;
      }
      // Record A even when it never called a gateway tool. This is the
      // critical case: a detached request from A must not arrive during B and
      // become the first request to bind this credential.
      registered.retiredWriteTurnId = turnId;
      return true;
    },
    retireTurnKeepingSession: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered || registered.retiredWriteTurnId !== undefined) return false;
      registered.retiredTurnIds.add(turnId);
      if (registered.retiredTurnIds.size > MAX_RETIRED_TURN_IDS) {
        const oldest = registered.retiredTurnIds.values().next().value;
        if (oldest !== undefined) registered.retiredTurnIds.delete(oldest);
      }
      // Requests already admitted keep the identity they captured; new ones see no active
      // turn until the adapter observes the next native turn start.
      registered.identity = {
        ...registered.identity,
        turnScoped: true,
        ...(registered.identity.nativeTurnId === turnId ? { nativeTurnId: null } : {}),
      };
      return true;
    },
    isTurnRetired: (token, turnId) => {
      const registered = sessions.get(token);
      return (
        registered !== undefined &&
        (registered.retiredWriteTurnId === turnId || registered.retiredTurnIds.has(turnId))
      );
    },
    revoke: (token) => {
      const registered = sessions.get(token);
      if (!registered) return;
      sessions.delete(token);
      sessionsByKey.delete(registered.identity.sessionKey);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
