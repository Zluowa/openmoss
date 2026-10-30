// FILE: runtime.ts
// Purpose: Moss Apps state: the per-user identity, catalog cache, sign-ins,
//   and the one MCP connector every provider session uses to reach the user's
//   connected apps. Wrapped by the McpConnectors Effect layer so Moss Apps
//   ride the same agent-gateway proxy as user-added connectors.
// Layer: Moss Apps runtime (promise-based)
// Exports: MossAppsRuntime, MossAppsFailure, MOSS_APPS_CONNECTOR_ID,
//   MOSS_APPS_SERVER_NAME

import type {
  MossAppConnection,
  MossAppsConnectFieldsResult,
  MossAppsConnectResult,
  MossAppsListToolkitsInput,
  MossAppsListToolkitsResult,
  MossAppsStatus,
  MossAppToolkit,
} from "@synara/contracts";
import { MOSS_APPS_DISPLAY_NAME, MOSS_APPS_SERVER_NAME } from "@synara/shared/mossAppsPresentation";

import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  forwardMcpConnectorRequest,
  jsonRpcErrorResult,
  type McpConnectorProxyResult,
} from "../mcpConnectors/proxy.ts";
import type { McpConnectorForwardRequest } from "../mcpConnectors/runtime.ts";
import { ComposioClient, ComposioRequestError } from "./composioClient.ts";

/** Gateway connector id; provider sessions see the server as `moss_apps`. */
export const MOSS_APPS_CONNECTOR_ID = "moss_apps";
export { MOSS_APPS_DISPLAY_NAME, MOSS_APPS_SERVER_NAME };

const TOOLKIT_CACHE_TTL_MS = 5 * 60_000;
const CATALOG_CACHE_TTL_MS = 60 * 60_000;
const TOOLKIT_CACHE_MAX_ENTRIES = 64;
const CONNECTION_CACHE_TTL_MS = 15_000;
const DEFAULT_TOOLKIT_PAGE_SIZE = 48;

/** A failure whose message is written for the person connecting. */
export class MossAppsFailure extends Error {
  override readonly name = "MossAppsFailure";
}

export interface MossAppsRuntimeDeps {
  /** Project key for the hosted app backend; null leaves Moss Apps unconfigured. */
  readonly apiKey: string | null;
  /** Stable, opaque id of the Moss user whose apps these are. */
  readonly userId: () => Promise<string>;
  /** Where the hosted sign-in page returns the user once they finish. */
  readonly callbackUrl: () => string;
  /** Hands the Moss Apps connector (or nothing) to the agent gateway. */
  readonly publish: (registration: AgentGatewayConnectorRegistration | null) => void;
  readonly logWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly client?: ComposioClient;
  readonly now?: () => number;
}

function describe(error: unknown, fallback: string): MossAppsFailure {
  if (error instanceof MossAppsFailure) return error;
  if (error instanceof ComposioRequestError) {
    return new MossAppsFailure(
      error.status === 401 || error.status === 403
        ? "Moss Apps is not authorized on this server. Check its app-integration key."
        : error.message,
    );
  }
  return new MossAppsFailure(fallback);
}

/** The newest active connection of each app, keyed by app, in a stable order. */
function pinnedConnections(
  connections: ReadonlyArray<MossAppConnection>,
): Record<string, string[]> {
  const newest = new Map<string, MossAppConnection>();
  for (const connection of connections) {
    if (connection.status !== "active") continue;
    const current = newest.get(connection.toolkitSlug);
    if (!current || connection.createdAt > current.createdAt) {
      newest.set(connection.toolkitSlug, connection);
    }
  }
  return Object.fromEntries(
    [...newest.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([slug, connection]) => [slug, [connection.connectionId]]),
  );
}

/** The closing page names the app the browser comes back from; the slug is all it carries. */
function callbackUrlFor(base: string, toolkitSlug: string): string {
  const url = new URL(base);
  url.searchParams.set("app", toolkitSlug);
  return url.toString();
}

export class MossAppsRuntime {
  private readonly client: ComposioClient | null;
  private readonly now: () => number;
  private readonly toolkitCache = new Map<
    string,
    { readonly at: number; readonly value: MossAppsListToolkitsResult }
  >();
  private connections: { readonly at: number; readonly value: MossAppConnection[] } | null = null;
  private catalog:
    | { readonly at: number; readonly value: MossAppsListToolkitsResult }
    | { readonly pending: Promise<MossAppsListToolkitsResult> }
    | null = null;
  /** The hosted session and the connections it was pinned to. */
  private session: { readonly pins: string; readonly url: Promise<string> } | null = null;
  private agentAccess = false;
  private readonly credentialForms = new Map<
    string,
    { readonly at: number; readonly value: MossAppsConnectFieldsResult }
  >();

  constructor(private readonly deps: MossAppsRuntimeDeps) {
    this.client = deps.client ?? (deps.apiKey ? new ComposioClient(deps.apiKey) : null);
    this.now = deps.now ?? Date.now;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** Publishes the connector when the user already has connected apps. */
  async init(): Promise<void> {
    if (!this.client) {
      this.deps.publish(null);
      return;
    }
    await this.listConnections().catch((error: unknown) => {
      this.deps.logWarning("Could not read Moss Apps connections at startup.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  status(): MossAppsStatus {
    return {
      availability: this.client ? "ready" : "unconfigured",
      agentAccess: this.agentAccess,
    };
  }

  async listToolkits(input: MossAppsListToolkitsInput): Promise<MossAppsListToolkitsResult> {
    const client = this.requireClient();
    if (input.all) return this.listCatalog(client);
    const request = {
      search: input.search?.trim() || undefined,
      category: input.category,
      cursor: input.cursor,
      limit: input.limit ?? DEFAULT_TOOLKIT_PAGE_SIZE,
    };
    const key = JSON.stringify(request);
    const cached = this.toolkitCache.get(key);
    if (cached && this.now() - cached.at < TOOLKIT_CACHE_TTL_MS) return cached.value;
    let value: MossAppsListToolkitsResult;
    try {
      value = await client.listToolkits(request);
    } catch (error) {
      throw describe(error, "Moss could not load apps.");
    }
    this.toolkitCache.delete(key);
    this.toolkitCache.set(key, { at: this.now(), value });
    while (this.toolkitCache.size > TOOLKIT_CACHE_MAX_ENTRIES) {
      const oldest = this.toolkitCache.keys().next().value;
      if (oldest === undefined) break;
      this.toolkitCache.delete(oldest);
    }
    return value;
  }

  /** The whole catalog (~1.7k apps), walked once an hour and shared by concurrent callers. */
  private listCatalog(client: ComposioClient): Promise<MossAppsListToolkitsResult> {
    const cached = this.catalog;
    if (cached && "value" in cached && this.now() - cached.at < CATALOG_CACHE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    if (cached && "pending" in cached) return cached.pending;
    const pending = client
      .listCatalog()
      .then((value) => {
        this.catalog = { at: this.now(), value };
        return value;
      })
      .catch((error: unknown) => {
        this.catalog = null;
        throw describe(error, "Moss could not load apps.");
      });
    this.catalog = { pending };
    return pending;
  }

  /** An app from the catalog already loaded (even past its refresh time); never fetches. */
  cachedToolkit(toolkitSlug: string): MossAppToolkit | null {
    const cached = this.catalog;
    if (!cached || !("value" in cached)) return null;
    return cached.value.toolkits.find((toolkit) => toolkit.slug === toolkitSlug) ?? null;
  }

  async listConnections(options: { readonly fresh?: boolean } = {}): Promise<MossAppConnection[]> {
    const client = this.requireClient();
    const cached = this.connections;
    if (!options.fresh && cached && this.now() - cached.at < CONNECTION_CACHE_TTL_MS) {
      return cached.value;
    }
    let value: MossAppConnection[];
    try {
      value = await client.listConnections(await this.deps.userId());
    } catch (error) {
      throw describe(error, "Moss could not load your connected apps.");
    }
    this.connections = { at: this.now(), value };
    this.publishAccess(value.some((connection) => connection.status === "active"));
    return value;
  }

  /** What a user enters to connect an app with their own credentials. */
  async connectFields(toolkitSlug: string): Promise<MossAppsConnectFieldsResult> {
    const client = this.requireClient();
    const cached = this.credentialForms.get(toolkitSlug);
    if (cached && this.now() - cached.at < CATALOG_CACHE_TTL_MS) return cached.value;
    let form: MossAppsConnectFieldsResult | null;
    try {
      form = await client.credentialForm(toolkitSlug);
    } catch (error) {
      throw describe(error, "Moss could not load this app's sign-in.");
    }
    if (!form) throw new MossAppsFailure("This app does not sign in with a key or login.");
    this.credentialForms.set(toolkitSlug, { at: this.now(), value: form });
    while (this.credentialForms.size > TOOLKIT_CACHE_MAX_ENTRIES) {
      const oldest = this.credentialForms.keys().next().value;
      if (oldest === undefined) break;
      this.credentialForms.delete(oldest);
    }
    return form;
  }

  async connect(
    toolkitSlug: string,
    credentials?: Readonly<Record<string, string>>,
  ): Promise<MossAppsConnectResult> {
    const client = this.requireClient();
    const existing = (await this.listConnections({ fresh: true })).find(
      (connection) => connection.toolkitSlug === toolkitSlug && connection.status === "active",
    );
    if (existing) return { signInUrl: null, connection: existing };
    if (credentials) return this.connectWithCredentials(client, toolkitSlug, credentials);
    try {
      const authConfigId = await client.ensureManagedAuthConfig(toolkitSlug);
      const link = await client.startConnection({
        userId: await this.deps.userId(),
        toolkitSlug,
        authConfigId,
        callbackUrl: callbackUrlFor(this.deps.callbackUrl(), toolkitSlug),
      });
      this.connections = null;
      return { signInUrl: link.redirectUrl, connection: link.connection };
    } catch (error) {
      throw describe(error, "Moss could not start the sign-in for this app.");
    }
  }

  /** Only the form's own fields are sent on, and every required one must be filled. */
  private async connectWithCredentials(
    client: ComposioClient,
    toolkitSlug: string,
    credentials: Readonly<Record<string, string>>,
  ): Promise<MossAppsConnectResult> {
    const form = await this.connectFields(toolkitSlug);
    const values: Record<string, string> = {};
    for (const field of form.fields) {
      const value = credentials[field.name]?.trim() ?? "";
      if (value) values[field.name] = value;
      else if (field.required) throw new MossAppsFailure(`Enter ${field.label}.`);
    }
    if (Object.keys(values).length === 0) {
      throw new MossAppsFailure("Enter the details this app asks for.");
    }
    try {
      const authConfigId = await client.ensureCredentialAuthConfig(toolkitSlug, form.scheme);
      const connection = await client.connectWithCredentials({
        userId: await this.deps.userId(),
        toolkitSlug,
        authConfigId,
        scheme: form.scheme,
        values,
      });
      this.connections = null;
      return { signInUrl: null, connection };
    } catch (error) {
      throw describe(error, "Moss could not connect this app with those details.");
    }
  }

  async disconnect(connectionId: string): Promise<boolean> {
    const client = this.requireClient();
    const owned = (await this.listConnections({ fresh: true })).some(
      (connection) => connection.connectionId === connectionId,
    );
    // Only this user's connections may be removed through this server.
    if (!owned) return false;
    try {
      await client.deleteConnection(connectionId);
    } catch (error) {
      throw describe(error, "Moss could not disconnect this app.");
    }
    await this.listConnections({ fresh: true }).catch(() => undefined);
    return true;
  }

  /** Proxies one MCP exchange to the user's tool-router session. */
  async forward(request: McpConnectorForwardRequest): Promise<McpConnectorProxyResult> {
    const client = this.client;
    if (!client) {
      return jsonRpcErrorResult(request.body, "Moss Apps is not set up on this server.", 404);
    }
    const send = async () =>
      forwardMcpConnectorRequest(
        {
          url: await this.sessionUrl(),
          method: request.method,
          body: request.body,
          sessionId: request.sessionId,
          protocolVersion: request.protocolVersion,
          accessToken: client.bearerToken,
          signal: request.signal,
        },
        MOSS_APPS_DISPLAY_NAME,
      );
    try {
      const first = await send();
      if (first.status !== 404 && first.status !== 410) return first;
      // The hosted session expired: start a new one once and retry.
      this.session = null;
      return await send();
    } catch (error) {
      this.session = null;
      this.deps.logWarning("Moss Apps request failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonRpcErrorResult(request.body, "Moss could not reach your apps. Try again shortly.");
    }
  }

  /**
   * The hosted session pins the user's connections when it is created, so a
   * connected or disconnected app needs a new one before agents see it.
   */
  private async sessionUrl(): Promise<string> {
    const client = this.requireClient();
    const connections = await this.listConnections().catch(() => this.connections?.value ?? []);
    const pinned = pinnedConnections(connections);
    const pins = JSON.stringify(pinned);
    if (this.session?.pins !== pins) {
      const url = this.deps
        .userId()
        .then((userId) => client.createToolRouterSession(userId, pinned))
        .then((session) => session.mcpUrl);
      const entry = { pins, url };
      this.session = entry;
      url.catch(() => {
        if (this.session === entry) this.session = null;
      });
    }
    return this.session.url;
  }

  private publishAccess(agentAccess: boolean): void {
    if (agentAccess === this.agentAccess) return;
    this.agentAccess = agentAccess;
    this.deps.publish(
      agentAccess ? { name: MOSS_APPS_SERVER_NAME, connectorId: MOSS_APPS_CONNECTOR_ID } : null,
    );
  }

  private requireClient(): ComposioClient {
    if (!this.client) throw new MossAppsFailure("Moss Apps is not set up on this server.");
    return this.client;
  }
}
