/**
 * AgentGatewayCredentialsLive - Live layer for agent gateway credentials.
 *
 * Issues opaque in-memory credentials. Tokens live for the provider session,
 * can be revoked independently, and intentionally do not survive a Moss
 * restart.
 *
 * @module agentGateway/Layers/AgentGatewayCredentials
 */
import { randomUUID } from "node:crypto";

import type { ProviderKind } from "@synara/contracts";
import { providerSupportsMcpConnectors } from "@synara/shared/mcpConnectors";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { formatHostForUrl, isWildcardHost } from "../../startupAccess.ts";
import {
  type AgentGatewayConnectorRegistration,
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewaySessionRegistry } from "../Services/AgentGatewaySessionRegistry.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "../inFlightRequestRegistry.ts";
import { ensureAgentGatewayStdioProxyScript } from "../stdioProxyScript.ts";
import { AgentGatewaySessionRegistryLive } from "./AgentGatewaySessionRegistry.ts";

export type NativeMcpStartupOutcome = "ready" | "timeout" | "inactive";

export type NativeMcpStartupRegistry = {
  /** Record a completed native MCP tools/list handshake for one session key. */
  note(sessionKey: string): void;
  /** Wait for the handshake; resolves "ready", "timeout", or "inactive". */
  awaitReady(sessionKey: string | null, timeoutMs: number): Promise<NativeMcpStartupOutcome>;
  /** Wake any waiters with "inactive" and drop the session state. */
  revoke(sessionKey: string): void;
};

/**
 * Tracks the asynchronous native MCP handshake per provider session. ACP
 * agents connect injected MCP servers after session/new resolves, so adapters
 * use this registry to keep the first prompt waiting until tools/list has been
 * served (or a bounded timeout elapses, which the caller treats as non-fatal).
 */
export function makeNativeMcpStartupRegistry(): NativeMcpStartupRegistry {
  type Waiter = (outcome: "ready" | "inactive") => void;
  const entries = new Map<string, { observed: boolean; waiters: Waiter[] }>();
  const wake = (sessionKey: string, outcome: "ready" | "inactive"): void => {
    const entry = entries.get(sessionKey);
    if (entry === undefined) return;
    const waiters = entry.waiters.splice(0);
    if (outcome === "inactive") entries.delete(sessionKey);
    for (const waiter of waiters) {
      try {
        waiter(outcome);
      } catch {
        // Waiter promises must never break credential bookkeeping.
      }
    }
  };
  return {
    note: (sessionKey) => {
      const entry = entries.get(sessionKey) ?? { observed: false, waiters: [] as Waiter[] };
      entry.observed = true;
      entries.set(sessionKey, entry);
      wake(sessionKey, "ready");
    },
    awaitReady: (sessionKey, timeoutMs) => {
      if (sessionKey === null) return Promise.resolve("inactive" as const);
      const entry = entries.get(sessionKey) ?? { observed: false, waiters: [] as Waiter[] };
      if (!entries.has(sessionKey)) entries.set(sessionKey, entry);
      if (entry.observed) return Promise.resolve("ready" as const);
      return new Promise<NativeMcpStartupOutcome>((resolve) => {
        let settled = false;
        const timer = setTimeout(
          () => {
            if (settled) return;
            settled = true;
            const current = entries.get(sessionKey);
            if (current !== undefined) {
              current.waiters = current.waiters.filter((waiter) => waiter !== onWaiter);
              // Drop purely-pending entries whose waiter gave up so the map does
              // not accumulate state for sessions that never complete startup.
              if (!current.observed && current.waiters.length === 0) {
                entries.delete(sessionKey);
              }
            }
            resolve("timeout");
          },
          Math.max(1, timeoutMs),
        );
        // Do not keep the process alive solely for this gate.
        timer.unref?.();
        const onWaiter: Waiter = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        entry.waiters.push(onWaiter);
      });
    },
    revoke: (sessionKey) => wake(sessionKey, "inactive"),
  };
}

export const AGENT_GATEWAY_MCP_PATH = "/mcp";
export const AGENT_GATEWAY_CONNECTORS_PATH = `${AGENT_GATEWAY_MCP_PATH}/connectors`;

export function agentGatewayConnectorUrl(mcpEndpointUrl: string, connectorId: string): string {
  return `${mcpEndpointUrl}/connectors/${encodeURIComponent(connectorId)}`;
}

interface AgentGatewayEndpoint {
  readonly url: string;
  readonly setListeningPort: (listeningPort: number) => void;
}

interface AgentGatewayStdioBootstrapRegistry {
  readonly issue: (sessionToken: string) => string | null;
  readonly exchange: (bootstrapToken: string) => string | null;
  readonly revokeSession: (sessionToken: string) => void;
}

const AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS = 30_000;

export function makeAgentGatewayStdioBootstrapRegistry(input: {
  readonly sessionIsActive: (sessionToken: string) => boolean;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): AgentGatewayStdioBootstrapRegistry {
  const randomId = input.randomId ?? randomUUID;
  const now = input.now ?? Date.now;
  const ttlMs = Math.max(1, input.ttlMs ?? AGENT_GATEWAY_STDIO_BOOTSTRAP_TTL_MS);
  const tokens = new Map<string, { readonly sessionToken: string; readonly expiresAt: number }>();
  return {
    issue: (sessionToken) => {
      if (!input.sessionIsActive(sessionToken)) return null;
      const bootstrapToken = `sagw_bootstrap_${randomId()}`;
      tokens.set(bootstrapToken, { sessionToken, expiresAt: now() + ttlMs });
      return bootstrapToken;
    },
    exchange: (bootstrapToken) => {
      const bootstrap = tokens.get(bootstrapToken);
      if (bootstrap === undefined) return null;
      tokens.delete(bootstrapToken);
      if (bootstrap.expiresAt <= now()) return null;
      return input.sessionIsActive(bootstrap.sessionToken) ? bootstrap.sessionToken : null;
    },
    revokeSession: (sessionToken) => {
      for (const [bootstrapToken, owner] of tokens) {
        if (owner.sessionToken === sessionToken) tokens.delete(bootstrapToken);
      }
    },
  };
}

/**
 * Connectors published for new sessions, and the ids each bearer was issued
 * with: a session may only reach the connectors it received.
 */
export function makeAgentGatewayConnectorRegistry(input: {
  readonly sessionIsActive: (token: string) => boolean;
}) {
  let registrations: ReadonlyArray<AgentGatewayConnectorRegistration> = [];
  const grants = new Map<string, ReadonlySet<string>>();
  return {
    set: (next: ReadonlyArray<AgentGatewayConnectorRegistration>) => {
      registrations = [...next];
    },
    /** The connectors a new bearer receives; Pi, Devin, and Antigravity get none. */
    grant: (
      token: string,
      provider: ProviderKind,
    ): ReadonlyArray<AgentGatewayConnectorRegistration> => {
      const granted = providerSupportsMcpConnectors(provider) ? registrations : [];
      if (granted.length > 0) {
        grants.set(token, new Set(granted.map((registration) => registration.connectorId)));
      }
      return granted;
    },
    canUse: (token: string, connectorId: string): boolean =>
      input.sessionIsActive(token) && (grants.get(token)?.has(connectorId) ?? false),
    revokeSession: (token: string) => {
      grants.delete(token);
    },
  };
}

// Providers run as local child processes, so they must target a host the HTTP
// server actually listens on. Wildcard binds cover loopback; an explicit host
// (e.g. `::1` or a LAN address) does not, so reuse it verbatim.
export function resolveAgentGatewayEndpointHost(configHost: string | undefined): string {
  if (configHost === undefined || isWildcardHost(configHost)) {
    return "127.0.0.1";
  }
  return formatHostForUrl(configHost);
}

export function makeAgentGatewayEndpoint(
  configHost: string | undefined,
  initialPort: number,
): AgentGatewayEndpoint {
  const endpointHost = resolveAgentGatewayEndpointHost(configHost);
  let port = initialPort;
  return {
    get url() {
      return `http://${endpointHost}:${port}${AGENT_GATEWAY_MCP_PATH}`;
    },
    setListeningPort: (listeningPort: number) => {
      port = listeningPort;
    },
  };
}

export const makeAgentGatewayCredentials = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sessionRegistry = yield* AgentGatewaySessionRegistry;
  const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();

  const endpoint = makeAgentGatewayEndpoint(config.host, config.port);
  const stdioProxyScriptPath = yield* ensureAgentGatewayStdioProxyScript(config.stateDir);
  const stdioBootstraps = makeAgentGatewayStdioBootstrapRegistry({
    sessionIsActive: (token) => sessionRegistry.verify(token) !== null,
  });

  const connectors = makeAgentGatewayConnectorRegistry({
    sessionIsActive: (token) => sessionRegistry.verify(token) !== null,
  });

  const issueSessionToken: AgentGatewayCredentialsShape["issueSessionToken"] = (
    threadId,
    provider,
    options,
  ) => sessionRegistry.issue(threadId, provider, options).token;

  const verifySessionToken: AgentGatewayCredentialsShape["verifySessionToken"] = (token) =>
    sessionRegistry.verify(token)?.threadId ?? null;

  // Native ACP agents connect injected MCP servers asynchronously after
  // session/new. Keyed by the same session identity as the bearer token so
  // adapters can gate their first prompt on a completed tools/list handshake
  // without any extra protocol from the agent.
  const mcpStartup = makeNativeMcpStartupRegistry();
  const noteNativeMcpStartup: AgentGatewayCredentialsShape["noteNativeMcpStartup"] = (token) => {
    const sessionKey = sessionRegistry.verify(token)?.sessionKey;
    if (sessionKey !== undefined) mcpStartup.note(sessionKey);
  };
  const awaitNativeMcpStartup: AgentGatewayCredentialsShape["awaitNativeMcpStartup"] = (
    token,
    timeoutMs,
  ) => mcpStartup.awaitReady(sessionRegistry.verify(token)?.sessionKey ?? null, timeoutMs);

  const revokeSessionToken = (token: string): void => {
    const session = sessionRegistry.verify(token);
    sessionRegistry.revoke(token);
    if (session) {
      mcpStartup.revoke(session.sessionKey);
    }
    connectors.revokeSession(token);
    stdioBootstraps.revokeSession(token);
    if (session) inFlightRequests.revokeSession(session.sessionKey);
  };

  const issueStdioBootstrapToken: AgentGatewayCredentialsShape["issueStdioBootstrapToken"] = (
    sessionToken,
  ) => {
    return stdioBootstraps.issue(sessionToken);
  };

  const exchangeStdioBootstrapToken: AgentGatewayCredentialsShape["exchangeStdioBootstrapToken"] = (
    bootstrapToken,
  ) => {
    return stdioBootstraps.exchange(bootstrapToken);
  };

  const cancelSessionTurnRequests: AgentGatewayCredentialsShape["cancelSessionTurnRequests"] = (
    token,
    turnId,
  ) => {
    const session = sessionRegistry.verify(token);
    if (!session) return Promise.resolve();
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  const retireSessionTurn: AgentGatewayCredentialsShape["retireSessionTurn"] = (token, turnId) => {
    const session = sessionRegistry.verify(token);
    if (!session) return Promise.resolve();
    // Retire synchronously before exposing the asynchronous drain barrier.
    // Requests racing the terminal event can no longer bind this bearer to B.
    sessionRegistry.retireWriteAuthority(token, turnId);
    return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
  };

  return {
    get mcpEndpointUrl() {
      return endpoint.url;
    },
    setListeningPort: endpoint.setListeningPort,
    issueSessionToken,
    verifySessionToken,
    verifySession: sessionRegistry.verify,
    issueStdioBootstrapToken,
    exchangeStdioBootstrapToken,
    bindWriteAuthority: sessionRegistry.bindWriteAuthority,
    verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
    registerInFlightRequest: inFlightRequests.register,
    cancelInFlightRequests: inFlightRequests.cancel,
    cancelSessionTurnRequests,
    retireSessionTurn,
    revokeSessionToken,
    noteNativeMcpStartup,
    awaitNativeMcpStartup,
    connectionForThread: (threadId, provider, options) => {
      const bearerToken = issueSessionToken(threadId, provider, options);
      const granted = connectors.grant(bearerToken, provider).map((registration) => ({
        name: registration.name,
        url: agentGatewayConnectorUrl(endpoint.url, registration.connectorId),
      }));
      return {
        url: endpoint.url,
        bearerToken,
        ...(granted.length > 0 ? { connectors: granted } : {}),
      };
    },
    stdioProxy: {
      command: process.execPath,
      args: [stdioProxyScriptPath],
    },
    setConnectorServers: connectors.set,
    canUseConnector: connectors.canUse,
  } satisfies AgentGatewayCredentialsShape;
});

export const AgentGatewayCredentialsLive = Layer.effect(
  AgentGatewayCredentials,
  makeAgentGatewayCredentials,
).pipe(Layer.provide(AgentGatewaySessionRegistryLive));

// Single shared composition so every consumer (HTTP gateway, provider
// adapters) reuses the same memoized in-memory session registry.
export const AgentGatewayCredentialsWithSecretsLive = AgentGatewayCredentialsLive.pipe(Layer.orDie);
