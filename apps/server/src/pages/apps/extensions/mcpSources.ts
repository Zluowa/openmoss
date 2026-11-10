// FILE: mcpSources.ts
// Purpose: Finds the MCP server an 应用页 names and talks to it for the
// viewer: Moss 应用 and Settings connectors through the connector proxy (it
// holds their tokens and refreshes them), local MCP servers from Moss's own
// `mcp/config.json` through the MCP SDK. Nothing here hands a credential,
// URL or session id to the page; results are plain tool output.
// Layer: Server pages/apps extensions

import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";

import {
  PAGE_APP_MCP_CALL_TIMEOUT_MS,
  PAGE_APP_MCP_MOSS_APPS_SERVER,
  type PageAppMcpServerKind,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";

import {
  MCP_CONNECTOR_PROTOCOL_VERSION,
  type McpConnectorProxyResult,
} from "../../../mcpConnectors/proxy";
import type { McpConnectorsShape } from "../../../mcpConnectors/Services/McpConnectors";

export interface PageAppMcpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly title?: string;
}

export interface PageAppMcpTool {
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly annotations: PageAppMcpToolAnnotations;
}

/** What `tools/call` answered, before Moss shapes it for the page. */
export interface PageAppMcpRawResult {
  readonly content: readonly unknown[];
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

export interface PageAppMcpSession {
  readonly listTools: (signal: AbortSignal) => Promise<ReadonlyArray<PageAppMcpTool>>;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<PageAppMcpRawResult>;
}

export interface PageAppMcpResolvedServer {
  /** The name the page used. */
  readonly server: string;
  /** Stable identity for grants, cache and audit: `moss-apps`, `connector:<id>`, `local:<name>`. */
  readonly key: string;
  readonly label: string;
  readonly kind: PageAppMcpServerKind | null;
  readonly session: PageAppMcpSession | null;
  /** Why `session` is null, written for the viewer. */
  readonly reason: string | null;
  /** The connector needs the viewer to sign in again in Settings. */
  readonly needsAuth: boolean;
}

export interface PageAppMcpSources {
  readonly resolve: (server: string) => Promise<PageAppMcpResolvedServer>;
  readonly dispose: () => Promise<void>;
}

const CLIENT_INFO = { name: "moss-page-apps", version: "1" };
const LOCAL_IDLE_MS = 5 * 60_000;
const MAX_LOCAL_CLIENTS = 4;
const TOOLS_PAGE_LIMIT = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeMcpTool(raw: unknown): PageAppMcpTool | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return null;
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  const bool = (key: string) =>
    typeof annotations[key] === "boolean" ? (annotations[key] as boolean) : undefined;
  const title =
    typeof raw.title === "string"
      ? raw.title
      : typeof annotations.title === "string"
        ? annotations.title
        : null;
  return {
    name: raw.name,
    title,
    description: typeof raw.description === "string" ? raw.description.slice(0, 2_000) : null,
    annotations: {
      ...(bool("readOnlyHint") === undefined ? {} : { readOnlyHint: bool("readOnlyHint")! }),
      ...(bool("destructiveHint") === undefined
        ? {}
        : { destructiveHint: bool("destructiveHint")! }),
      ...(bool("idempotentHint") === undefined ? {} : { idempotentHint: bool("idempotentHint")! }),
      ...(bool("openWorldHint") === undefined ? {} : { openWorldHint: bool("openWorldHint")! }),
    },
  };
}

export function normalizeMcpCallResult(raw: unknown): PageAppMcpRawResult {
  const result = isRecord(raw) ? raw : {};
  return {
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent: result.structuredContent ?? null,
    isError: result.isError === true,
  };
}

// ---------------------------------------------------------------------------
// Connector proxy sessions (Moss 应用 and Settings connectors)
// ---------------------------------------------------------------------------

type Forward = (request: {
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly sessionId?: string;
  readonly protocolVersion?: string;
  readonly signal?: AbortSignal;
}) => Promise<McpConnectorProxyResult>;

/** A JSON-RPC client over the connector proxy, one MCP session per server. */
export class ForwardedMcpSession implements PageAppMcpSession {
  private sessionId: string | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;

  constructor(
    private readonly forward: Forward,
    private readonly label: string,
  ) {}

  private async send(
    method: string,
    params: unknown,
    signal: AbortSignal,
    notify = false,
  ): Promise<unknown> {
    const body = notify
      ? { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }
      : { jsonrpc: "2.0", id: this.nextId++, method, ...(params === undefined ? {} : { params }) };
    const result = await this.forward({
      method: "POST",
      body,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
      signal,
    });
    if (result.sessionId) this.sessionId = result.sessionId;
    if (notify) return null;
    if (result.status === 404 && this.sessionId) {
      throw new SessionExpired();
    }
    if (result.body.kind !== "json") {
      throw new PageAppCapabilityError(
        "upstream_error",
        `${this.label} answered in a way Moss could not read.`,
      );
    }
    const message = result.body.value;
    if (!isRecord(message)) {
      throw new PageAppCapabilityError(
        "upstream_error",
        `${this.label} answered in a way Moss could not read.`,
      );
    }
    if (isRecord(message.error)) {
      const text =
        typeof message.error.message === "string" ? message.error.message : "The request failed.";
      throw new PageAppCapabilityError("upstream_error", text.slice(0, 500));
    }
    return message.result;
  }

  private ensure(signal: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      await this.send(
        "initialize",
        {
          protocolVersion: MCP_CONNECTOR_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        signal,
      );
      await this.send("notifications/initialized", undefined, signal, true);
    })().catch((error: unknown) => {
      this.ready = null;
      this.sessionId = null;
      throw error;
    });
    return this.ready;
  }

  private async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      await this.ensure(signal);
      try {
        return await this.send(method, params, signal);
      } catch (error) {
        if (!(error instanceof SessionExpired) || attempt > 0) {
          if (error instanceof SessionExpired)
            throw new PageAppCapabilityError("upstream_error", `${this.label} closed the session.`);
          throw error;
        }
        this.ready = null;
        this.sessionId = null;
      }
    }
  }

  async listTools(signal: AbortSignal): Promise<ReadonlyArray<PageAppMcpTool>> {
    const tools: PageAppMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TOOLS_PAGE_LIMIT; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
      for (const raw of list) {
        const tool = normalizeMcpTool(raw);
        if (tool) tools.push(tool);
      }
      cursor =
        isRecord(result) && typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PageAppMcpRawResult> {
    return normalizeMcpCallResult(
      await this.request("tools/call", { name, arguments: args }, signal),
    );
  }
}

class SessionExpired extends Error {}

// ---------------------------------------------------------------------------
// Local MCP servers (Moss's own `mcp/config.json`)
// ---------------------------------------------------------------------------

export interface LocalMcpServerConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly enabled: boolean;
}

export function parseLocalMcpConfig(raw: string | null): Map<string, LocalMcpServerConfig> {
  const out = new Map<string, LocalMcpServerConfig>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;
  const source = parsed.mcpServers ?? parsed.servers;
  if (!isRecord(source)) return out;
  for (const [name, value] of Object.entries(source)) {
    if (!name.trim() || !isRecord(value)) continue;
    const env = isRecord(value.env)
      ? Object.fromEntries(
          Object.entries(value.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    out.set(name, {
      name,
      ...(typeof value.command === "string" && value.command.trim()
        ? { command: value.command }
        : {}),
      ...(Array.isArray(value.args)
        ? { args: value.args.filter((arg): arg is string => typeof arg === "string") }
        : {}),
      ...(env ? { env } : {}),
      ...(typeof value.cwd === "string" && value.cwd.trim() ? { cwd: value.cwd } : {}),
      ...(typeof value.url === "string" && /^https?:\/\//iu.test(value.url)
        ? { url: value.url }
        : {}),
      enabled: value.enabled !== false,
    });
  }
  return out;
}

/** Environment a local server starts with: what it configured, plus the basics to run. */
function localServerEnv(config: LocalMcpServerConfig): Record<string, string> {
  const keep = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...config.env };
}

interface SdkClient {
  connect(transport: unknown): Promise<void>;
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ tools: unknown[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

class LocalMcpSession implements PageAppMcpSession {
  private client: Promise<SdkClient> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  lastUsed = Date.now();

  constructor(
    readonly config: LocalMcpServerConfig,
    private readonly baseDir: string,
  ) {}

  private connect(): Promise<SdkClient> {
    this.client ??= (async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client(CLIENT_INFO, { capabilities: {} }) as unknown as SdkClient;
      if (this.config.url) {
        const { StreamableHTTPClientTransport } =
          await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        await client.connect(new StreamableHTTPClientTransport(new URL(this.config.url)));
      } else {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        await client.connect(
          new StdioClientTransport({
            command: this.config.command!,
            args: [...(this.config.args ?? [])],
            env: localServerEnv(this.config),
            cwd: this.config.cwd ? nodePath.resolve(this.baseDir, this.config.cwd) : this.baseDir,
            stderr: "ignore",
          }),
        );
      }
      return client;
    })().catch((error: unknown) => {
      this.client = null;
      throw new PageAppCapabilityError(
        "unavailable",
        `Moss could not start ${this.config.name}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
      );
    });
    return this.client;
  }

  private touch() {
    this.lastUsed = Date.now();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), LOCAL_IDLE_MS);
    this.idle.unref?.();
  }

  async listTools(signal: AbortSignal): Promise<ReadonlyArray<PageAppMcpTool>> {
    const client = await this.connect();
    this.touch();
    const tools: PageAppMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TOOLS_PAGE_LIMIT; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: 30_000,
      });
      for (const raw of result.tools) {
        const tool = normalizeMcpTool(raw);
        if (tool) tools.push(tool);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PageAppMcpRawResult> {
    const client = await this.connect();
    this.touch();
    try {
      return normalizeMcpCallResult(
        await client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: PAGE_APP_MCP_CALL_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      if (signal.aborted) throw new PageAppCapabilityError("cancelled", "The call was cancelled.");
      throw new PageAppCapabilityError(
        "upstream_error",
        error instanceof Error ? error.message.slice(0, 500) : `${this.config.name} failed.`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const client = this.client;
    this.client = null;
    if (client) await client.then((c) => c.close()).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PageAppMcpSourcesDeps {
  readonly connectors: McpConnectorsShape | null;
  /** Moss base dir; local servers come from `<baseDir>/mcp/config.json`. */
  readonly baseDir: string;
  readonly readLocalConfig?: () => Promise<string | null>;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

export function makePageAppMcpSources(deps: PageAppMcpSourcesDeps): PageAppMcpSources {
  const forwarded = new Map<string, ForwardedMcpSession>();
  const local = new Map<string, LocalMcpSession>();
  const readLocal =
    deps.readLocalConfig ??
    (() => readFile(nodePath.join(deps.baseDir, "mcp", "config.json"), "utf8").catch(() => null));

  const forwardedSession = (connectorId: string, label: string) => {
    let session = forwarded.get(connectorId);
    if (!session) {
      const connectors = deps.connectors!;
      session = new ForwardedMcpSession(
        (request) => Effect.runPromise(connectors.forward(connectorId, request)),
        label,
      );
      forwarded.set(connectorId, session);
    }
    return session;
  };

  const localSession = (config: LocalMcpServerConfig) => {
    const existing = local.get(config.name);
    if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) return existing;
    void existing?.close();
    if (local.size >= MAX_LOCAL_CLIENTS) {
      const oldest = [...local.values()].toSorted((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) {
        void oldest.close();
        local.delete(oldest.config.name);
      }
    }
    const session = new LocalMcpSession(config, deps.baseDir);
    local.set(config.name, session);
    return session;
  };

  const unavailable = (
    server: string,
    reason: string,
    extra?: Partial<PageAppMcpResolvedServer>,
  ): PageAppMcpResolvedServer => ({
    server,
    key: `missing:${server.toLowerCase()}`,
    label: server,
    kind: null,
    session: null,
    reason,
    needsAuth: false,
    ...extra,
  });

  const resolve = async (server: string): Promise<PageAppMcpResolvedServer> => {
    const wanted = server.trim().toLowerCase();
    const connectors = deps.connectors;
    if (wanted === PAGE_APP_MCP_MOSS_APPS_SERVER) {
      const label = "Moss 应用";
      if (!connectors)
        return unavailable(server, "这个 Moss 没有开启 Moss 应用。", {
          key: "moss-apps",
          label,
          kind: "moss-apps",
        });
      const status = await Effect.runPromise(connectors.mossApps.status());
      if (status.availability !== "ready")
        return unavailable(server, "这个 Moss 没有开启 Moss 应用。", {
          key: "moss-apps",
          label,
          kind: "moss-apps",
        });
      if (!status.agentAccess)
        return unavailable(server, "你还没有连接任何 Moss 应用。", {
          key: "moss-apps",
          label,
          kind: "moss-apps",
        });
      return {
        server,
        key: "moss-apps",
        label,
        kind: "moss-apps",
        session: forwardedSession(PAGE_APP_MCP_MOSS_APPS_SERVER, label),
        reason: null,
        needsAuth: false,
      };
    }
    if (connectors?.enabled) {
      const listed = await run(connectors.list());
      if (listed._tag === "Success") {
        const match = listed.success.find(
          (connector) =>
            connector.connectorId.toLowerCase() === wanted ||
            connector.name.toLowerCase() === wanted ||
            connector.serverName.toLowerCase() === wanted,
        );
        if (match) {
          const base = {
            server,
            key: `connector:${match.connectorId}`,
            label: match.name,
            kind: "connector" as const,
          };
          if (match.status !== "connected")
            return {
              ...base,
              session: null,
              reason: `${match.name} 需要在 Moss 设置里重新连接。`,
              needsAuth: true,
            };
          return {
            ...base,
            session: forwardedSession(match.connectorId, match.name),
            reason: null,
            needsAuth: false,
          };
        }
      }
    }
    const config = parseLocalMcpConfig(await readLocal());
    const entry = [...config.values()].find((candidate) => candidate.name.toLowerCase() === wanted);
    if (entry) {
      const base = {
        server,
        key: `local:${entry.name}`,
        label: entry.name,
        kind: "local" as const,
      };
      if (!entry.enabled)
        return {
          ...base,
          session: null,
          reason: `${entry.name} 在 Moss 里已停用。`,
          needsAuth: false,
        };
      if (!entry.command && !entry.url)
        return {
          ...base,
          session: null,
          reason: `${entry.name} 没有可启动的命令。`,
          needsAuth: false,
        };
      return { ...base, session: localSession(entry), reason: null, needsAuth: false };
    }
    return unavailable(server, `你的 Moss 里没有连接「${server}」。`);
  };

  return {
    resolve,
    dispose: async () => {
      await Promise.all([...local.values()].map((session) => session.close()));
      local.clear();
      forwarded.clear();
    },
  };
}
