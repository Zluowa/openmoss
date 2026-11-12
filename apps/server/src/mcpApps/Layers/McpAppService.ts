/**
 * McpAppServiceLive - in-process state for interactive connectors (MCP Apps).
 *
 * Tool definitions are cached per thread + server (CLI-own servers), per connector, and for the
 * Moss gateway. Every MCP tool row passes `enrichRuntimeEvent` once, which binds widget calls to
 * their server and records them in the runtime result store under the server state dir.
 *
 * @module mcpApps/Layers/McpAppService
 */
import path from "node:path";

import type { McpConnector, ProviderRuntimeEvent } from "@moss/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { McpAppApprovalTokens } from "../approvalTokens.ts";
import { bindMcpToolRow, normalizeClaudeServerName, type McpAppRowContext } from "../binding.ts";
import { McpAppConnectorClient, type McpAppConnectorForward } from "../connectorClient.ts";
import { McpAppModelContextStore } from "../modelContext.ts";
import { McpAppResourceCache, McpAppResultStore } from "../resultStore.ts";
import {
  McpAppService,
  type McpAppCapturedCall,
  type McpAppConnectorDirectoryEntry,
  type McpAppGatewayRegistration,
  type McpAppGatewayResource,
  type McpAppServerIdentity,
  type McpAppServiceShape,
} from "../Services/McpAppService.ts";
import { mcpArgsHash, toolDefinitionFromMcp, type McpAppToolDefinition } from "../toolUi.ts";

export const MCP_APP_GATEWAY_SERVER_NAME = "moss";
const MAX_THREADS_WITH_TOOLS = 500;
const MAX_CAPTURED_CALLS = 500;
const MAX_PROXY_CAPTURES = 200;
const PROXY_CAPTURE_MATCH_WINDOW_MS = 10 * 60_000;
const MAX_TOOLS_PER_SERVER = 500;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function definitionsFrom(tools: ReadonlyArray<unknown>): McpAppToolDefinition[] {
  const definitions: McpAppToolDefinition[] = [];
  for (const tool of tools.slice(0, MAX_TOOLS_PER_SERVER)) {
    const definition = toolDefinitionFromMcp(tool);
    if (definition) definitions.push(definition);
  }
  return definitions;
}

const callKey = (threadId: string, callId: string) => `${threadId}\0${callId}`;

export function makeMcpAppServiceState(options: {
  readonly resultsDirectory: string;
  /** Defaults to a `resources` folder beside `resultsDirectory`. */
  readonly resourcesDirectory?: string;
  readonly clientVersion?: string;
  readonly now?: () => number;
  readonly logWarning?: (message: string, fields?: Record<string, unknown>) => void;
}): McpAppServiceShape & { readonly stop: () => Promise<void> } {
  const now = options.now ?? Date.now;
  const results = new McpAppResultStore(options.resultsDirectory, {
    now,
    ...(options.logWarning ? { logWarning: options.logWarning } : {}),
  });
  const resources = new McpAppResourceCache(
    options.resourcesDirectory ?? path.join(path.dirname(options.resultsDirectory), "resources"),
    { now, ...(options.logWarning ? { logWarning: options.logWarning } : {}) },
  );
  const modelContext = new McpAppModelContextStore(now);
  const approvals = new McpAppApprovalTokens(now);

  const providerTools = new Map<string, Map<string, McpAppToolDefinition[]>>();
  const connectorTools = new Map<string, { defs: McpAppToolDefinition[]; fetchedAt: number }>();
  const connectorsByServer = new Map<string, McpAppConnectorDirectoryEntry>();
  const connectorsById = new Map<string, McpAppConnectorDirectoryEntry>();
  const connectorClients = new Map<string, McpAppConnectorClient>();
  const gatewayResources = new Map<string, McpAppGatewayResource>();
  let gatewayRegistration: McpAppGatewayRegistration | undefined;
  let gatewayDefinitions: McpAppToolDefinition[] | undefined;

  const captures = new Map<string, McpAppCapturedCall>();
  const proxyCaptures: Array<{
    readonly threadId: string;
    readonly server: string;
    readonly toolName: string;
    readonly argsHash: string;
    readonly result: Record<string, unknown>;
    readonly at: number;
  }> = [];
  const pendingCalls = new Set<string>();
  const threadServers = new Map<string, Set<string>>();
  const lastState = new Map<string, string>();

  const warnedSandboxTools = new Set<string>();
  /** Tool-level `_meta.ui.csp` / `permissions` are ignored (SPEC §2); say so once per tool. */
  const record = (scopeKey: string, tools: ReadonlyArray<unknown>) => {
    const definitions = definitionsFrom(tools);
    for (const definition of definitions) {
      const key = `${scopeKey}/${definition.name}`;
      if (!definition.declaresToolLevelSandbox || warnedSandboxTools.has(key)) continue;
      warnedSandboxTools.add(key);
      options.logWarning?.(
        `Tool '${definition.name}' declares _meta.ui.csp/permissions, which is ignored. Declare them on the UI resource instead.`,
      );
    }
    return definitions;
  };
  const shutdown = new AbortController();
  const refreshesInFlight = new Map<string, Promise<void>>();
  const lastRefreshAt = new Map<string, number>();

  const classifyServer = (server: string): McpAppServerIdentity => {
    if (server === MCP_APP_GATEWAY_SERVER_NAME) {
      return { kind: "gateway", server, serverKey: "moss", serverLabel: "Moss" };
    }
    const connector = connectorsByServer.get(server);
    if (connector) {
      return {
        kind: "connector",
        server,
        serverKey: connector.connectorId,
        serverLabel: connector.name.slice(0, 200),
        connectorId: connector.connectorId,
        connectorUrl: connector.url,
      };
    }
    return { kind: "provider", server, serverKey: server, serverLabel: server };
  };

  const gatewayTools = (): McpAppToolDefinition[] => {
    if (!gatewayRegistration) return [];
    gatewayDefinitions ??= definitionsFrom(gatewayRegistration.listTools());
    return gatewayDefinitions;
  };

  const providerToolsFor = (threadId: string, server: string) => {
    const thread = providerTools.get(threadId);
    if (!thread) return undefined;
    return thread.get(server) ?? thread.get(normalizeClaudeServerName(server));
  };

  const definitionFor = (
    threadId: string,
    server: string,
    tool: string,
  ): McpAppToolDefinition | undefined => {
    const identity = classifyServer(server);
    const lists: Array<ReadonlyArray<McpAppToolDefinition> | undefined> =
      identity.kind === "gateway"
        ? [gatewayTools(), providerToolsFor(threadId, server)]
        : identity.kind === "connector"
          ? [connectorTools.get(identity.connectorId)?.defs, providerToolsFor(threadId, server)]
          : [providerToolsFor(threadId, server)];
    for (const list of lists) {
      const found = list?.find((definition) => definition.name === tool);
      if (found) return found;
    }
    return undefined;
  };

  const capturedFor: McpAppRowContext["captured"] = (threadId, callId, server, tool, args) => {
    const exact = captures.get(callId);
    if (exact && (exact.result !== undefined || exact.input !== undefined)) {
      return {
        ...(exact.input ? { input: exact.input } : {}),
        ...(exact.result ? { result: exact.result } : {}),
      };
    }
    const hash = mcpArgsHash(args);
    const cutoff = now() - PROXY_CAPTURE_MATCH_WINDOW_MS;
    for (let index = proxyCaptures.length - 1; index >= 0; index -= 1) {
      const entry = proxyCaptures[index]!;
      if (entry.at < cutoff) break;
      if (
        entry.threadId === threadId &&
        entry.toolName === tool &&
        entry.argsHash === hash &&
        (entry.server === server ||
          normalizeClaudeServerName(entry.server) === normalizeClaudeServerName(server))
      ) {
        proxyCaptures.splice(index, 1);
        return { result: entry.result };
      }
    }
    return undefined;
  };

  const rowContext: McpAppRowContext = {
    classify: classifyServer,
    serversForThread: (threadId) => [
      MCP_APP_GATEWAY_SERVER_NAME,
      ...connectorsByServer.keys(),
      ...(providerTools.get(threadId)?.keys() ?? []),
    ],
    definition: definitionFor,
    captured: capturedFor,
  };

  const enrichRuntimeEvent = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    ) {
      return event;
    }
    let row;
    try {
      row = bindMcpToolRow(event, rowContext);
    } catch (error) {
      options.logWarning?.("Could not bind an interactive connector call.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return event;
    }
    if (!row) return event;
    const key = callKey(row.threadId, row.callId);
    const servers = threadServers.get(row.threadId) ?? new Set<string>();
    servers.add(row.binding.server ?? "");
    lruSet(threadServers, row.threadId, servers, MAX_THREADS_WITH_TOOLS);
    if (row.state === "pending") pendingCalls.add(key);
    else pendingCalls.delete(key);
    if (row.state === "failed") modelContext.dropCall(row.threadId, row.callId);
    const signature = `${row.state}:${row.result ? "r" : ""}:${row.binding.resourceUri}`;
    if (lastState.get(key) !== signature) {
      lruSet(lastState, key, signature, 4 * MAX_CAPTURED_CALLS);
      void results.put({
        threadId: row.threadId,
        callId: row.callId,
        binding: row.binding,
        state: row.state,
        input: row.input,
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        updatedAt: now(),
      });
    }
    if (row.state !== "pending") captures.delete(row.callId);
    return row.event;
  };

  const decorateConnectors = (
    connectors: ReadonlyArray<McpConnector>,
  ): ReadonlyArray<McpConnector> =>
    connectors.map((connector) => {
      const defs = connectorTools.get(connector.connectorId)?.defs;
      if (!defs) return connector;
      return {
        ...connector,
        interactiveToolCount: defs.filter((definition) => definition.resourceUri).length,
        tools: defs.map((definition) => ({
          name: definition.name,
          ...(definition.title ? { title: definition.title } : {}),
          hasUi: definition.resourceUri !== undefined,
          visibility: [...definition.visibility],
        })),
      };
    });

  const connectorClientFor = (connectorId: string, forward: McpAppConnectorForward) => {
    let client = connectorClients.get(connectorId);
    if (!client) {
      client = new McpAppConnectorClient(forward, options.clientVersion ?? "1.0.0");
      connectorClients.set(connectorId, client);
    }
    return client;
  };

  const refreshConnectorTools = (connectorId: string, forward: McpAppConnectorForward) => {
    const running = refreshesInFlight.get(connectorId);
    if (running) return running;
    if (shutdown.signal.aborted || now() - (lastRefreshAt.get(connectorId) ?? 0) < 60_000) {
      return Promise.resolve();
    }
    lastRefreshAt.set(connectorId, now());
    const refresh = (async () => {
      const client = connectorClientFor(connectorId, forward);
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = (await client.request(
          "tools/list",
          cursor ? { cursor } : undefined,
          shutdown.signal,
        )) as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (Array.isArray(result?.tools)) tools.push(...result.tools);
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      if (connectorsById.has(connectorId)) {
        connectorTools.set(connectorId, { defs: definitionsFrom(tools), fetchedAt: now() });
      }
    })()
      .catch(() => undefined)
      .finally(() => refreshesInFlight.delete(connectorId));
    refreshesInFlight.set(connectorId, refresh);
    return refresh;
  };

  return {
    results,
    resources,
    modelContext,
    approvals,
    refreshConnectorTools,
    stop: async () => {
      shutdown.abort();
      for (const client of connectorClients.values()) void client.close();
      connectorClients.clear();
      await Promise.all([results.flush(), resources.flush()]);
    },
    enrichRuntimeEvent,
    captureCall: (call) => lruSet(captures, call.callId, call, MAX_CAPTURED_CALLS),
    captureProxyCall: (input) => {
      const server =
        input.server ??
        (input.connectorId !== undefined
          ? connectorsById.get(input.connectorId)?.serverName
          : undefined);
      if (server === undefined) return;
      if (input.callIdHint) {
        lruSet(
          captures,
          input.callIdHint,
          {
            threadId: input.threadId,
            callId: input.callIdHint,
            server,
            toolName: input.toolName,
            input: input.arguments,
            result: input.result,
          },
          MAX_CAPTURED_CALLS,
        );
        return;
      }
      proxyCaptures.push({
        threadId: input.threadId,
        server,
        toolName: input.toolName,
        argsHash: mcpArgsHash(input.arguments),
        result: input.result,
        at: now(),
      });
      if (proxyCaptures.length > MAX_PROXY_CAPTURES) proxyCaptures.shift();
    },
    recordProviderTools: (threadId, server, tools, provider) => {
      const thread = providerTools.get(threadId) ?? new Map<string, McpAppToolDefinition[]>();
      thread.set(server, record(server, tools));
      lruSet(providerTools, threadId, thread, MAX_THREADS_WITH_TOOLS);
      if (provider !== undefined) {
        const rawTools = tools.flatMap((tool) =>
          tool !== null && typeof tool === "object" && !Array.isArray(tool)
            ? [tool as Record<string, unknown>]
            : [],
        );
        void resources.putTools({ provider, threadId, server }, rawTools);
      }
    },
    recordConnectorTools: (connectorId, tools) => {
      connectorTools.set(connectorId, { defs: record(connectorId, tools), fetchedAt: now() });
    },
    connectorTools: (connectorId) => connectorTools.get(connectorId)?.defs,
    connectorToolsFetchedAt: (connectorId) => connectorTools.get(connectorId)?.fetchedAt,
    providerTools: providerToolsFor,
    gatewayTools,
    setConnectorDirectory: (entries) => {
      const nextIds = new Set(entries.map((entry) => entry.connectorId));
      for (const [connectorId, previous] of connectorsById) {
        const next = entries.find((entry) => entry.connectorId === connectorId);
        // A removed or re-pointed connector loses its session and its cached tool list.
        if (!nextIds.has(connectorId) || next?.url !== previous.url) {
          void connectorClients.get(connectorId)?.close();
          connectorClients.delete(connectorId);
          connectorTools.delete(connectorId);
        }
      }
      connectorsByServer.clear();
      connectorsById.clear();
      for (const entry of entries) {
        connectorsByServer.set(entry.serverName, entry);
        connectorsById.set(entry.connectorId, entry);
      }
    },
    classifyServer,
    connectorClient: connectorClientFor,
    registerGateway: (registration) => {
      gatewayRegistration = registration;
      gatewayDefinitions = undefined;
    },
    gateway: () => gatewayRegistration,
    registerGatewayResource: (resource) => {
      gatewayResources.set(resource.uri, resource);
      return () => {
        if (gatewayResources.get(resource.uri) === resource) gatewayResources.delete(resource.uri);
      };
    },
    gatewayResources: () => [...gatewayResources.values()],
    callRecord: (threadId, callId) => Effect.promise(() => results.get(threadId, callId)),
    isCallPending: (threadId, callId) => pendingCalls.has(callKey(threadId, callId)),
    threadHasServer: (threadId, server) => threadServers.get(threadId)?.has(server) ?? false,
    decorateConnectors,
  };
}

export const McpAppServiceLive = Layer.effect(
  McpAppService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const service = makeMcpAppServiceState({
      resultsDirectory: path.join(config.stateDir, "mcp-apps", "results"),
      logWarning: (message, fields) => {
        void Effect.runPromise(Effect.logWarning(message, fields ?? {}));
      },
    });
    // Background connector listings stop and queued result writes finish before the server
    // scope closes.
    yield* Effect.addFinalizer(() => Effect.promise(() => service.stop()));
    return service;
  }),
);
