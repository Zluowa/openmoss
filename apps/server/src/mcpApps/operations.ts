// FILE: operations.ts
// Purpose: The request-time work behind the interactive-connector endpoints (PLAN §2.2): widget
//   resource reads, the full tool result, widget JSON-RPC (tools, resources, prompts) with the
//   host rules of SPEC §6 and Moss's approval policy, model context, and resource downloads. Each
//   request is bound to the server that rendered the widget (thread + call id → binding); a widget
//   can never reach another server or see credentials.
// Layer: Server MCP Apps runtime (Effect; resolves services per request)
// Exports: readMcpAppResourceOperation, readMcpAppToolResult, runMcpAppRpc,
//   updateMcpAppModelContext, downloadMcpAppResource, refreshConnectorToolList

import {
  MCP_APP_DEFAULT_CALL_FAILED_MESSAGE,
  ThreadId,
  type McpAppModelContextInput,
  type McpAppModelContextResult,
  type McpAppResourceDownloadInput,
  type McpAppResourceDownloadResult,
  type McpAppResourceReadInput,
  type McpAppResourceReadResult,
  type McpAppRpcInput,
  type McpAppRpcResult,
  type McpAppToolResultInput,
  type McpAppToolResultResult,
} from "@moss/contracts";
import { Duration, Effect, Exit, Option, Semaphore } from "effect";

import { McpConnectors } from "../mcpConnectors/Services/McpConnectors.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { McpAppRpcFailure, type McpAppConnectorForward } from "./connectorClient.ts";
import { normalizeModelContextBlocks } from "./modelContext.ts";
import { parseMcpAppResourceReadResponse } from "./resourceContent.ts";
import type { McpAppCallRecord } from "./resultStore.ts";
import {
  McpAppService,
  type McpAppServerIdentity,
  type McpAppServiceShape,
} from "./Services/McpAppService.ts";
import {
  MCP_APP_JSON_RPC_INTERNAL_ERROR,
  MCP_APP_JSON_RPC_INVALID_REQUEST,
  MCP_APP_WIDGET_TOOL_CALL_TIMEOUT_MS,
  checkStructuredContent,
  mcpAppRefusalNotAppVisible,
  mcpAppRefusalUnknownTool,
  mcpArgsHash,
  sanitizeCallToolResult,
  stripReservedMcpAppMeta,
  toolAllowsApp,
  toolDefinitionFromMcp,
  type McpAppToolDefinition,
} from "./toolUi.ts";

const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** A connector's tool list is re-read at most this often for widget calls. */
const CONNECTOR_TOOLS_TTL_MS = 5 * 60_000;

/** A request the route answers with a 4xx and this message. */
export class McpAppRequestError extends Error {
  override readonly name = "McpAppRequestError";
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return "The request failed.";
}

const connectorForward = (connectorId: string) =>
  Effect.gen(function* () {
    const available = yield* Effect.serviceOption(McpConnectors);
    if (Option.isNone(available)) {
      return yield* Effect.fail(
        new McpAppRpcFailure(MCP_APP_JSON_RPC_INTERNAL_ERROR, "Connectors are unavailable."),
      );
    }
    const connectors = available.value;
    const forward: McpAppConnectorForward = (request) =>
      Effect.runPromise(
        connectors.forward(connectorId, {
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
          sessionId: request.sessionId,
          protocolVersion: request.protocolVersion,
        }),
        request.signal ? { signal: request.signal } : undefined,
      );
    return forward;
  });

const connectorRequest = (
  service: McpAppServiceShape,
  connectorId: string,
  method: string,
  params: Record<string, unknown> | undefined,
) =>
  Effect.gen(function* () {
    const forward = yield* connectorForward(connectorId);
    const client = service.connectorClient(connectorId, forward);
    return yield* Effect.tryPromise({
      try: (signal) => client.request(method, params, signal),
      catch: (cause) =>
        cause instanceof McpAppRpcFailure
          ? cause
          : new McpAppRpcFailure(MCP_APP_JSON_RPC_INTERNAL_ERROR, errorText(cause)),
    });
  });

/** Moss's own listing of a connector's tools; recorded for bindings and the directory. */
export const refreshConnectorToolList = (connectorId: string) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = asRecord(
        yield* connectorRequest(
          service,
          connectorId,
          "tools/list",
          cursor ? { cursor } : undefined,
        ),
      );
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    service.recordConnectorTools(connectorId, tools);
    return tools;
  });

/** The record that proves a widget belongs to (thread, call); fails closed when it is missing. */
const requireBinding = (
  service: McpAppServiceShape,
  threadId: string,
  callId: string,
  server: string,
) =>
  Effect.gen(function* () {
    const record = yield* service.callRecord(threadId, callId);
    if (!record) {
      return yield* Effect.fail(
        new McpAppRequestError(404, "Moss does not know this widget's tool call."),
      );
    }
    // Fail closed: a record without a server (unreadable or foreign) binds to nothing.
    if (record.binding.server === undefined || record.binding.server !== server) {
      return yield* Effect.fail(
        new McpAppRequestError(403, "A widget can only reach the server that rendered it."),
      );
    }
    return record;
  });

function identityFor(
  service: McpAppServiceShape,
  record: McpAppCallRecord | undefined,
  server: string,
) {
  const identity = service.classifyServer(server);
  // A Moss connector renamed since the call keeps its binding's connector.
  if (identity.kind !== "connector" && record?.binding.connectorUrl && record.binding.connectorId) {
    return {
      kind: "connector" as const,
      server,
      serverKey: record.binding.connectorId,
      serverLabel: record.binding.serverLabel ?? server,
      connectorId: record.binding.connectorId,
      connectorUrl: record.binding.connectorUrl,
    };
  }
  return identity;
}

// ── resources/read for the widget's own HTML ──────────────────────────────────────────────────

export const readMcpAppResourceOperation = (input: McpAppResourceReadInput) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    const record = yield* service.callRecord(input.threadId, input.callId);
    if (record) {
      // Fail closed, as requireBinding: a stored binding must name its server.
      if (record.binding.server === undefined || record.binding.server !== input.server) {
        return yield* Effect.fail(
          new McpAppRequestError(403, "A widget can only reach the server that rendered it."),
        );
      }
      if (record.binding.resourceUri !== input.resourceUri) {
        return yield* Effect.fail(
          new McpAppRequestError(403, "This widget declared a different resource."),
        );
      }
    }
    const identity = identityFor(service, record, input.server);
    if (identity.kind === "gateway") {
      const resource = service.gatewayResources().find((entry) => entry.uri === input.resourceUri);
      if (!resource) return { state: "no_content", resourceUri: input.resourceUri } as const;
      return parseMcpAppResourceReadResponse({
        response: {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: resource.text(),
              ...(resource.meta ? { _meta: resource.meta } : {}),
            },
          ],
        },
        resourceUri: input.resourceUri,
      });
    }
    if (identity.kind === "connector") {
      const response = yield* connectorRequest(service, identity.connectorId, "resources/read", {
        uri: input.resourceUri,
      });
      return parseMcpAppResourceReadResponse({
        response,
        resourceUri: input.resourceUri,
        stableOriginEligible: true,
      });
    }
    // A CLI-own server is read through the CLI's live session. The last good read is kept so a
    // widget re-created while that session is not running (after a restart) still loads; the next
    // live read refreshes it.
    const providerService = yield* ProviderService;
    const cacheKey = {
      provider: yield* threadProvider(input.threadId),
      threadId: input.threadId,
      server: input.server,
      resourceUri: input.resourceUri,
    };
    const cached = () => Effect.promise(() => service.resources.get(cacheKey));
    if (!(yield* providerSessionLive(providerService, input.threadId))) {
      const stored = yield* cached();
      if (stored) {
        // The widget is about to make calls: bring its session back now, not on the first one.
        yield* warmProviderSession(input.threadId, input.server);
        return stored;
      }
    }
    if (typeof providerService.readMcpAppResource !== "function") {
      return yield* Effect.fail(
        new McpAppRequestError(409, "Widget resources are unavailable for this provider."),
      );
    }
    const read = yield* Effect.exit(providerService.readMcpAppResource(input));
    if (Exit.isFailure(read)) {
      const stored = yield* cached();
      if (stored) return stored;
      return yield* Effect.failCause(read.cause);
    }
    const result: McpAppResourceReadResult =
      read.value.state === "ready" ? { ...read.value, stableOrigin: false } : read.value;
    if (result.state === "ready") void service.resources.put(cacheKey, result);
    return result;
  });

/** The thread's provider (the cache key keeps a provider switch from serving another's copy). */
const threadProvider = (threadId: string) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isNone(snapshotQuery)) return "unknown";
    const shell = yield* snapshotQuery.value
      .getThreadShellById(ThreadId.makeUnsafe(threadId))
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    if (Option.isNone(shell)) return "unknown";
    return String(shell.value.session?.providerName ?? shell.value.modelSelection.provider);
  });

/** Whether a provider runtime is running for the thread right now (no recovery is started). */
const providerSessionLive = (
  providerService: { readonly listSessions?: ProviderServiceShape["listSessions"] },
  threadId: string,
) =>
  typeof providerService.listSessions === "function"
    ? providerService.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.some(
            (session) => String(session.threadId) === threadId && session.status !== "closed",
          ),
        ),
        Effect.catch(() => Effect.succeed(false)),
      )
    : Effect.succeed(false);

/** How long a widget's call waits for its thread's agent session to come back (after a restart). */
export const MCP_APP_SESSION_RESUME_WAIT_MS = 90_000;

// One resume per thread: while a thread's agent session is not live, widget calls go through
// this gate one at a time, so the first one resumes the session (ProviderService recovers it)
// and the rest wait for it instead of each starting, and stopping, a session of their own.
const resumeGates = new Map<string, Semaphore.Semaphore>();
const resumeGate = (threadId: string) => {
  let gate = resumeGates.get(threadId);
  if (!gate) {
    if (resumeGates.size >= 256) resumeGates.clear();
    gate = Semaphore.makeUnsafe(1);
    resumeGates.set(threadId, gate);
  }
  return gate;
};

/**
 * Runs a provider-routed widget operation. A live session runs it at once; otherwise it waits
 * its turn behind the thread's resume (up to 90 s) and runs once the session is back.
 */
export const whenProviderSessionResumed = <A, E, R>(
  threadId: string,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | McpAppRpcFailure, R | ProviderService> =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    if (yield* providerSessionLive(providerService, threadId)) return yield* run;
    return yield* resumeGate(threadId)
      .withPermits(1)(run)
      .pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(MCP_APP_SESSION_RESUME_WAIT_MS),
          onTimeout: () =>
            Effect.fail(
              new McpAppRpcFailure(
                -32001,
                "The agent session for this conversation did not come back within 90 seconds.",
              ),
            ),
        }),
      );
  });

/**
 * Starts resuming a thread's agent session in the background when one of its widgets is shown
 * and the session is not live (after a restart), so the widget's first call finds it ready.
 */
const warmProviderSession = (threadId: string, server: string) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    if (typeof providerService.listMcpAppTools !== "function") return;
    if (yield* providerSessionLive(providerService, threadId)) return;
    yield* whenProviderSessionResumed(
      threadId,
      providerService.listMcpAppTools({ threadId: ThreadId.makeUnsafe(threadId), server }),
    ).pipe(Effect.ignore, Effect.forkDetach);
  }).pipe(Effect.ignore);

// ── full tool result ──────────────────────────────────────────────────────────────────────────

export const readMcpAppToolResult = (input: McpAppToolResultInput) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    if (service.isCallPending(input.threadId, input.callId)) return { status: "pending" } as const;
    const record = yield* service.callRecord(input.threadId, input.callId);
    if (!record) return { status: "missing" } as const;
    if (record.state === "pending") return { status: "pending" } as const;
    // A failed call never reaches a widget; the host shows the text fallback (SPEC §3, §10).
    if (record.state === "failed") {
      return {
        status: "failed",
        message: record.error ?? MCP_APP_DEFAULT_CALL_FAILED_MESSAGE,
      } satisfies McpAppToolResultResult;
    }
    if (!record.result) return { status: "missing" } as const;
    const toolName = record.binding.toolName ?? "tool";
    const check = checkStructuredContent(toolName, record.result.structuredContent);
    if (!check.ok) {
      return { status: "failed", message: check.message } satisfies McpAppToolResultResult;
    }
    return {
      status: "ready",
      input: record.input ?? {},
      result: sanitizeCallToolResult(record.result),
    } satisfies McpAppToolResultResult;
  });

// ── widget JSON-RPC ───────────────────────────────────────────────────────────────────────────

function rpcError(code: number, message: string, data?: unknown): McpAppRpcResult {
  return { error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** The current tool list of the widget's server (definitions with `_meta.ui`). */
const currentTools = (
  service: McpAppServiceShape,
  identity: McpAppServerIdentity,
  threadId: string,
  options: { readonly fresh: boolean },
) =>
  Effect.gen(function* () {
    if (identity.kind === "gateway") {
      return { raw: service.gateway()?.listTools() ?? [], defs: service.gatewayTools() };
    }
    if (identity.kind === "connector") {
      const fetchedAt = service.connectorToolsFetchedAt(identity.connectorId);
      const cached = service.connectorTools(identity.connectorId);
      if (
        !options.fresh &&
        cached &&
        fetchedAt !== undefined &&
        Date.now() - fetchedAt < CONNECTOR_TOOLS_TTL_MS
      ) {
        return { raw: cached.map((definition) => definition.raw), defs: cached };
      }
      const raw = yield* refreshConnectorToolList(identity.connectorId);
      return { raw, defs: service.connectorTools(identity.connectorId) ?? [] };
    }
    // A CLI-own server: the CLI's own listing while it runs; the last listing kept on disk while
    // it does not (after a restart the session is not live, and a resumed CLI may list only its
    // discovery cache, which leaves widget-only tools out); a resume to list when neither exists.
    const providerService = yield* ProviderService;
    const provider = yield* threadProvider(threadId);
    const toolsKey = { provider, threadId, server: identity.server };
    const toList = (raw: ReadonlyArray<Record<string, unknown>>) => ({
      raw,
      defs: raw.flatMap((tool) => {
        const definition = toolDefinitionFromMcp(tool);
        return definition ? [definition] : [];
      }),
    });
    const cached = service.providerTools(threadId, identity.server);
    if (!options.fresh && cached) {
      const raw = cached.map((definition) => definition.raw);
      void service.resources.putTools(toolsKey, raw);
      return { raw, defs: cached };
    }
    const stored = yield* Effect.promise(() => service.resources.getTools(toolsKey));
    if (!options.fresh && stored && !(yield* providerSessionLive(providerService, threadId))) {
      service.recordProviderTools(threadId, identity.server, stored);
      return toList(stored);
    }
    if (typeof providerService.listMcpAppTools !== "function") {
      return toList(stored ?? []);
    }
    const listed = yield* Effect.exit(
      providerService.listMcpAppTools({
        threadId: ThreadId.makeUnsafe(threadId),
        server: identity.server,
      }),
    );
    if (Exit.isFailure(listed)) {
      if (stored) return toList(stored);
      return yield* Effect.failCause(listed.cause);
    }
    const raw = listed.value.find((entry) => entry.server === identity.server)?.tools ?? [];
    // A listing that lost tools the stored one had (a resumed CLI's discovery cache) does not
    // replace it; a listing that names every stored tool does.
    const storedNames = new Set(stored?.map((tool) => String(tool.name)));
    const listedNames = new Set(raw.map((tool) => String(tool.name)));
    const complete = [...storedNames].every((name) => listedNames.has(name));
    const effective = complete || !stored ? raw : stored;
    for (const entry of listed.value) {
      if (entry.server !== identity.server) {
        service.recordProviderTools(threadId, entry.server, entry.tools, provider);
      }
    }
    service.recordProviderTools(threadId, identity.server, effective, provider);
    return toList(effective);
  });

/** Moss's approval policy for a model call, applied to the widget's call (SPEC §6). */
const needsApproval = (threadId: string, definition: McpAppToolDefinition) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isNone(snapshotQuery)) return true;
    const shell = yield* snapshotQuery.value
      .getThreadShellById(ThreadId.makeUnsafe(threadId))
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    // Full access already consents to tool calls; every other mode asks unless read-only.
    const runtimeMode = Option.isSome(shell) ? shell.value.runtimeMode : "approval-required";
    return runtimeMode !== "full-access" && definition.readOnlyHint !== true;
  });

const callTool = (
  service: McpAppServiceShape,
  identity: McpAppServerIdentity,
  threadId: string,
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Effect.Effect<Record<string, unknown>, unknown, ProviderService> => {
  if (identity.kind === "gateway") {
    const gateway = service.gateway();
    if (!gateway) {
      return Effect.fail(
        new McpAppRpcFailure(MCP_APP_JSON_RPC_INTERNAL_ERROR, "Moss tools are not ready."),
      );
    }
    return gateway.callTool({ threadId, name, arguments: args, ...(meta ? { meta } : {}) });
  }
  if (identity.kind === "connector") {
    return connectorRequest(service, identity.connectorId, "tools/call", {
      name,
      arguments: args,
      ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        const record = asRecord(result);
        return record
          ? Effect.succeed(record)
          : Effect.fail(
              new McpAppRpcFailure(
                MCP_APP_JSON_RPC_INTERNAL_ERROR,
                "The server sent a malformed result.",
              ),
            );
      }),
    );
  }
  return Effect.gen(function* () {
    const providerService = yield* ProviderService;
    if (typeof providerService.callMcpAppTool !== "function") {
      return yield* Effect.fail(
        new McpAppRpcFailure(
          MCP_APP_JSON_RPC_INTERNAL_ERROR,
          "This provider cannot run widget tool calls.",
        ),
      );
    }
    return yield* whenProviderSessionResumed(
      threadId,
      providerService.callMcpAppTool({
        threadId: ThreadId.makeUnsafe(threadId),
        server: identity.server,
        toolName: name,
        arguments: args,
        ...(meta ? { meta } : {}),
      }),
    );
  });
};

const forwardOther = (
  service: McpAppServiceShape,
  identity: McpAppServerIdentity,
  threadId: string,
  method: Exclude<McpAppRpcInput["method"], "tools/call" | "tools/list">,
  params: Record<string, unknown>,
): Effect.Effect<unknown, unknown, ProviderService> => {
  if (identity.kind === "connector") {
    return connectorRequest(service, identity.connectorId, method, params);
  }
  if (identity.kind === "gateway") {
    const resources = service.gatewayResources();
    if (method === "resources/list") {
      return Effect.succeed({
        resources: resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          mimeType: resource.mimeType,
          ...(resource.meta ? { _meta: resource.meta } : {}),
        })),
      });
    }
    if (method === "resources/read") {
      const resource = resources.find((entry) => entry.uri === params.uri);
      if (!resource) {
        return Effect.fail(
          new McpAppRpcFailure(-32002, `Resource not found: ${String(params.uri)}`),
        );
      }
      return Effect.succeed({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text(),
            ...(resource.meta ? { _meta: resource.meta } : {}),
          },
        ],
      });
    }
    if (method === "resources/templates/list") return Effect.succeed({ resourceTemplates: [] });
    return Effect.succeed({ prompts: [] });
  }
  return Effect.gen(function* () {
    const providerService = yield* ProviderService;
    if (method === "resources/read" && typeof params.uri === "string") {
      if (typeof providerService.readMcpResourceContents !== "function") {
        return yield* Effect.fail(
          new McpAppRpcFailure(
            JSON_RPC_METHOD_NOT_FOUND,
            "This host cannot read resources of this server.",
          ),
        );
      }
      return yield* providerService.readMcpResourceContents({
        threadId: ThreadId.makeUnsafe(threadId),
        server: identity.server,
        uri: params.uri,
      });
    }
    if (
      (method === "resources/list" || method === "resources/templates/list") &&
      typeof providerService.listMcpAppTools === "function"
    ) {
      const servers = yield* providerService.listMcpAppTools({
        threadId: ThreadId.makeUnsafe(threadId),
        server: identity.server,
      });
      const entry = servers.find((candidate) => candidate.server === identity.server);
      if (entry?.resources !== undefined && method === "resources/list") {
        return { resources: entry.resources };
      }
      if (entry?.resourceTemplates !== undefined && method === "resources/templates/list") {
        return { resourceTemplates: entry.resourceTemplates };
      }
    }
    return yield* Effect.fail(
      new McpAppRpcFailure(
        JSON_RPC_METHOD_NOT_FOUND,
        `Method not found: ${method} is not available for this server, because its agent CLI gives a host no way to reach it.`,
      ),
    );
  });
};

/** A provider adapter wraps the JSON-RPC refusal it means in its request error's `cause`. */
function rpcFailureOf(error: unknown): McpAppRpcFailure | undefined {
  if (error instanceof McpAppRpcFailure) return error;
  const cause = (error as { readonly cause?: unknown } | null)?.cause;
  return cause instanceof McpAppRpcFailure ? cause : undefined;
}

function failureToRpc(error: unknown, identity?: McpAppServerIdentity): McpAppRpcResult {
  const failure = rpcFailureOf(error);
  if (failure) {
    error = failure;
  }
  if (error instanceof McpAppRpcFailure) {
    // A connector that needs a new sign-in: the host shows its sign-in card, then retries once.
    const authRequired =
      (error.data as { readonly authRequired?: unknown } | undefined)?.authRequired === true;
    return rpcError(
      error.code,
      error.message,
      authRequired && identity?.kind === "connector"
        ? { authRequired: true, connectorId: identity.connectorId }
        : error.data,
    );
  }
  return rpcError(MCP_APP_JSON_RPC_INTERNAL_ERROR, errorText(error));
}

export const runMcpAppRpc = (input: McpAppRpcInput) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    const record = yield* requireBinding(service, input.threadId, input.callId, input.server);
    const identity = identityFor(service, record, input.server);
    const params = input.params ?? {};
    const safeParams = {
      ...params,
      ...(params._meta !== undefined ? { _meta: stripReservedMcpAppMeta(params._meta) } : {}),
    };

    if (input.method === "tools/list") {
      const tools = yield* currentTools(service, identity, input.threadId, { fresh: false });
      return {
        result: {
          tools: tools.raw.map((tool) => {
            const record = asRecord(tool) ?? {};
            const meta = stripReservedMcpAppMeta(record._meta);
            return { ...record, ...(meta ? { _meta: meta } : {}) };
          }),
        },
      } satisfies McpAppRpcResult;
    }

    if (input.method === "tools/call") {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!name || name.length > 256) {
        return rpcError(
          MCP_APP_JSON_RPC_INVALID_REQUEST,
          "tools/call needs a tool name of at most 256 characters.",
        );
      }
      const args = asRecord(params.arguments) ?? {};
      let tools = yield* currentTools(service, identity, input.threadId, { fresh: false });
      let definition = tools.defs.find((entry) => entry.name === name);
      // The server may have added the tool since Moss last listed it.
      if (!definition) {
        tools = yield* currentTools(service, identity, input.threadId, { fresh: true });
        definition = tools.defs.find((entry) => entry.name === name);
      }
      if (!definition)
        return rpcError(MCP_APP_JSON_RPC_INVALID_REQUEST, mcpAppRefusalUnknownTool(name));
      if (!toolAllowsApp(definition)) {
        return rpcError(MCP_APP_JSON_RPC_INVALID_REQUEST, mcpAppRefusalNotAppVisible(name));
      }
      const scope = {
        threadId: input.threadId,
        server: input.server,
        toolName: name,
        argsHash: mcpArgsHash(args),
      };
      if (yield* needsApproval(input.threadId, definition)) {
        const approved =
          input.approvalToken !== undefined &&
          service.approvals.consume(input.approvalToken, scope);
        if (!approved) {
          const toolLabel = definition.title ?? name;
          return {
            needsApproval: {
              token: service.approvals.issue(scope),
              toolName: name,
              serverLabel: identity.serverLabel,
              reason: `${identity.serverLabel} 的小组件想使用 ${toolLabel}`,
            },
          } satisfies McpAppRpcResult;
        }
      }
      const meta = stripReservedMcpAppMeta(params._meta);
      return yield* callTool(service, identity, input.threadId, name, args, meta).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(MCP_APP_WIDGET_TOOL_CALL_TIMEOUT_MS),
          onTimeout: () =>
            Effect.fail(
              new McpAppRpcFailure(
                -32001,
                "The tool may have run, but it did not answer within 240 seconds.",
              ),
            ),
        }),
        Effect.map((result): McpAppRpcResult => {
          const check = checkStructuredContent(name, result.structuredContent);
          if (!check.ok) return rpcError(MCP_APP_JSON_RPC_INTERNAL_ERROR, check.message);
          return { result: sanitizeCallToolResult(result) };
        }),
        Effect.catch((error) => Effect.succeed(failureToRpc(error, identity))),
      );
    }

    return yield* forwardOther(service, identity, input.threadId, input.method, safeParams).pipe(
      Effect.map((result): McpAppRpcResult => ({ result })),
      Effect.catch((error) => Effect.succeed(failureToRpc(error, identity))),
    );
  }).pipe(
    Effect.catch((error) =>
      error instanceof McpAppRequestError
        ? Effect.fail(error)
        : Effect.succeed(failureToRpc(error)),
    ),
  );

// ── model context ─────────────────────────────────────────────────────────────────────────────

export const updateMcpAppModelContext = (input: McpAppModelContextInput) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    const record = yield* service.callRecord(input.threadId, input.callId);
    if (!record) {
      return {
        error: { message: "This app's tool call is not known to the host." },
      } satisfies McpAppModelContextResult;
    }
    const toolName = record.binding.toolName ?? input.toolName;
    if (toolName !== input.toolName) {
      return {
        error: { message: "This app can only share context for its own tool." },
      } satisfies McpAppModelContextResult;
    }
    if (record.state === "failed") {
      return {
        error: {
          message: "This app's tool call failed, so what the app shares is not given to the model.",
        },
      } satisfies McpAppModelContextResult;
    }
    const normalized = normalizeModelContextBlocks({
      content: input.content,
      structuredContent: input.structuredContent,
      toolName,
    });
    if (!normalized.ok)
      return { error: { message: normalized.message } } satisfies McpAppModelContextResult;
    const updated = service.modelContext.update({
      threadId: input.threadId,
      callId: input.callId,
      toolName,
      blocks: normalized.blocks,
    });
    return updated.ok
      ? ({} satisfies McpAppModelContextResult)
      : { error: { message: updated.message } };
  });

// ── resource downloads ────────────────────────────────────────────────────────────────────────

export const downloadMcpAppResource = (input: McpAppResourceDownloadInput) =>
  Effect.gen(function* () {
    const service = yield* McpAppService;
    let record: McpAppCallRecord | undefined;
    if (input.callId !== undefined) {
      record = yield* requireBinding(service, input.threadId, input.callId, input.server);
    } else if (!service.threadHasServer(input.threadId, input.server)) {
      return yield* Effect.fail(
        new McpAppRequestError(403, "A widget can only download from the server that rendered it."),
      );
    }
    const identity = identityFor(service, record, input.server);
    return yield* forwardOther(service, identity, input.threadId, "resources/read", {
      uri: input.uri,
    }).pipe(
      Effect.map((result): McpAppResourceDownloadResult => {
        const contents = asRecord(result)?.contents;
        return Array.isArray(contents)
          ? { contents: contents.flatMap((entry) => (asRecord(entry) ? [asRecord(entry)!] : [])) }
          : { error: { message: "The server sent no file contents." } };
      }),
      Effect.catch((error) =>
        Effect.succeed<McpAppResourceDownloadResult>({
          error: { message: errorText(rpcFailureOf(error) ?? error) },
        }),
      ),
    );
  });
