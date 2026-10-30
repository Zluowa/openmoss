// FILE: composioClient.ts
// Purpose: Minimal REST client for the hosted app-integration backend behind
//   Moss Apps (catalog, per-user connections, hosted sign-in links, and the
//   per-user tool-router MCP session).
// Safety: The project key is sent only to the backend origin. Responses are
//   narrowed field by field; nothing from them is executed.
// Exports: ComposioClient, ComposioRequestError, mapComposioToolkit,
//   mapComposioConnection, mapComposioCredentialForm

import type {
  MossAppConnection,
  MossAppConnectionStatus,
  MossAppCredentialField,
  MossAppCredentialScheme,
  MossAppSignIn,
  MossAppToolkit,
  MossAppsConnectFieldsResult,
} from "@synara/contracts";

export const COMPOSIO_API_ORIGIN = "https://backend.composio.dev";
const API_BASE = `${COMPOSIO_API_ORIGIN}/api/v3`;
const REQUEST_TIMEOUT_MS = 20_000;

export class ComposioRequestError extends Error {
  override readonly name = "ComposioRequestError";

  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Slugs that would start with a digit carry a leading "_" ("_1password"). */
const TOOLKIT_SLUG = /^_?[a-z0-9][a-z0-9_-]*$/u;
/** The backend's own meta toolkits are plumbing, not apps a Moss user connects. */
const isBackendToolkit = (slug: string) => slug === "composio" || slug.startsWith("composio_");
/** Moss Apps is Moss-branded: catalog copy that names the backend names Moss instead. */
const asMossCopy = (value: string) => value.replaceAll(/\bComposio\b/gu, "Moss");

/** Schemes where the user types their own values, in the order Moss offers them. */
const CREDENTIAL_SCHEMES: readonly MossAppCredentialScheme[] = ["API_KEY", "BEARER_TOKEN", "BASIC"];
const isCredentialScheme = (scheme: string): scheme is MossAppCredentialScheme =>
  (CREDENTIAL_SCHEMES as readonly string[]).includes(scheme);

function signInFor(raw: Json): MossAppSignIn {
  if (raw.no_auth === true) return "none";
  if (strings(raw.composio_managed_auth_schemes).length > 0) return "managed";
  if (strings(raw.auth_schemes).some((scheme) => isCredentialScheme(scheme.toUpperCase()))) {
    return "credentials";
  }
  return "setup";
}

const CREDENTIAL_FIELD_NAME = /^[a-z0-9_]+$/u;
const MAX_CREDENTIAL_FIELDS = 20;

/**
 * The fields a user fills in for an app's credential scheme: everything the
 * backend shows a person (its own form does the same), required first, minus
 * fields it marks deprecated.
 */
export function mapComposioCredentialForm(raw: unknown): MossAppsConnectFieldsResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.auth_config_details)) return null;
  const details = raw.auth_config_details.filter(isRecord);
  for (const scheme of CREDENTIAL_SCHEMES) {
    const detail = details.find((entry) => text(entry.mode).toUpperCase() === scheme);
    if (!detail) continue;
    const fields = isRecord(detail.fields) ? detail.fields : {};
    const initiation = isRecord(fields.connected_account_initiation)
      ? fields.connected_account_initiation
      : {};
    const listed = [
      ...(Array.isArray(initiation.required) ? initiation.required : []),
      ...(Array.isArray(initiation.optional) ? initiation.optional : []),
    ].filter(isRecord);
    const seen = new Set<string>();
    const form: MossAppCredentialField[] = [];
    for (const field of listed) {
      const name = text(field.name).trim();
      const label = asMossCopy(text(field.displayName ?? field.display_name).trim() || name);
      const description = asMossCopy(text(field.description).trim());
      if (!CREDENTIAL_FIELD_NAME.test(name) || name.length > 80 || seen.has(name)) continue;
      if (field.user_visible === false) continue;
      if (/\bdeprecated\b/iu.test(label) || /^deprecated\b/iu.test(description)) continue;
      seen.add(name);
      form.push({
        name,
        label: label.slice(0, 120),
        description: description.slice(0, 1_000),
        required: field.required === true,
        secret: field.is_secret === true,
      });
      if (form.length >= MAX_CREDENTIAL_FIELDS) break;
    }
    if (form.length === 0) continue;
    const help = text(detail.auth_hint_url ?? raw.auth_guide_url).trim();
    return {
      scheme,
      fields: form,
      helpUrl: help.startsWith("https://") && help.length <= 2_048 ? help : null,
    };
  }
  return null;
}

export function mapComposioToolkit(raw: unknown): MossAppToolkit | null {
  if (!isRecord(raw)) return null;
  const slug = text(raw.slug).trim().toLowerCase();
  const name = text(raw.name).trim();
  if (!TOOLKIT_SLUG.test(slug) || slug.length > 120 || !name || isBackendToolkit(slug)) {
    return null;
  }
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const logo = text(meta.logo).trim();
  const categories = Array.isArray(meta.categories)
    ? meta.categories
        .map((category) => (isRecord(category) ? text(category.name).trim() : ""))
        .filter((category) => category.length > 0 && category.length <= 80)
    : [];
  return {
    slug,
    name: asMossCopy(name).slice(0, 120),
    description: asMossCopy(text(meta.description).trim()).slice(0, 2_000),
    logoUrl: logo.startsWith("https://") && logo.length <= 2_048 ? logo : null,
    categories: [...new Set(categories)].slice(0, 16),
    toolsCount: count(meta.tools_count),
    signIn: signInFor(raw),
  };
}

const CONNECTION_STATUS: Record<string, MossAppConnectionStatus> = {
  ACTIVE: "active",
  INITIALIZING: "pending",
  INITIATED: "pending",
  FAILED: "failed",
  EXPIRED: "expired",
  INACTIVE: "inactive",
};

export function mapComposioConnection(raw: unknown): MossAppConnection | null {
  if (!isRecord(raw)) return null;
  const connectionId = text(raw.id).trim();
  const toolkitSlug = isRecord(raw.toolkit) ? text(raw.toolkit.slug).trim().toLowerCase() : "";
  const createdAt = text(raw.created_at).trim();
  if (!connectionId || connectionId.length > 120 || !TOOLKIT_SLUG.test(toolkitSlug)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return {
    connectionId,
    toolkitSlug,
    status: CONNECTION_STATUS[text(raw.status).toUpperCase()] ?? "inactive",
    createdAt: new Date(createdAt).toISOString(),
  };
}

export interface ComposioToolkitPage {
  readonly toolkits: MossAppToolkit[];
  readonly nextCursor: string | null;
  readonly totalItems: number;
}

export interface ComposioConnectLink {
  /** Null when the app needs no sign-in and the connection is already active. */
  readonly redirectUrl: string | null;
  readonly connection: MossAppConnection;
}

export interface ComposioToolRouterSession {
  readonly sessionId: string;
  readonly mcpUrl: string;
}

export class ComposioClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  /** Sent by the Moss connector proxy as the upstream bearer for tool-router MCP. */
  get bearerToken(): string {
    return this.apiKey;
  }

  async listToolkits(input: {
    readonly search?: string | undefined;
    readonly category?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<ComposioToolkitPage> {
    const query = new URLSearchParams({ limit: String(input.limit), sort_by: "usage" });
    if (input.search) query.set("search", input.search);
    if (input.category) query.set("category", input.category);
    if (input.cursor) query.set("cursor", input.cursor);
    const page = await this.request("GET", `/toolkits?${query}`);
    const items = Array.isArray(page.items) ? page.items : [];
    const cursor = text(page.next_cursor).trim();
    return {
      toolkits: items.flatMap((item) => mapComposioToolkit(item) ?? []),
      nextCursor: cursor.length > 0 ? cursor : null,
      totalItems: count(page.total_items),
    };
  }

  async listConnections(userId: string): Promise<MossAppConnection[]> {
    const connections: MossAppConnection[] = [];
    let cursor = "";
    // A user has at most a few hundred connections; bound the walk regardless.
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const query = new URLSearchParams({ user_ids: userId, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request("GET", `/connected_accounts?${query}`);
      const items = Array.isArray(page.items) ? page.items : [];
      connections.push(...items.flatMap((item) => mapComposioConnection(item) ?? []));
      cursor = text(page.next_cursor).trim();
      if (!cursor) break;
    }
    return connections;
  }

  private async enabledAuthConfigs(toolkitSlug: string): Promise<Json[]> {
    const query = new URLSearchParams({ toolkit_slug: toolkitSlug, limit: "20" });
    const existing = await this.request("GET", `/auth_configs?${query}`);
    const items = Array.isArray(existing.items) ? existing.items : [];
    return items.filter(
      (item): item is Json =>
        isRecord(item) && item.status !== "DISABLED" && item.is_disabled !== true,
    );
  }

  /**
   * Returns the project's OAuth sign-in config for a toolkit: one an admin set
   * up with Moss's own OAuth app (its name and logo on the provider's consent
   * screen) before a managed one, which is created on first use.
   */
  async ensureManagedAuthConfig(toolkitSlug: string): Promise<string> {
    const oauth = (await this.enabledAuthConfigs(toolkitSlug)).filter(
      (item) => !isCredentialScheme(text(item.auth_scheme).toUpperCase()) && text(item.id).trim(),
    );
    const chosen = oauth.find((item) => item.is_composio_managed === false) ?? oauth[0];
    if (chosen) return text(chosen.id).trim();
    const created = await this.request("POST", "/auth_configs", {
      toolkit: { slug: toolkitSlug },
      auth_config: { type: "use_composio_managed_auth" },
    });
    const id = isRecord(created.auth_config) ? text(created.auth_config.id).trim() : "";
    if (!id) throw new ComposioRequestError("The app did not return a sign-in config.", null);
    return id;
  }

  /** The fields a user fills in to connect an app with their own credentials. */
  async credentialForm(toolkitSlug: string): Promise<MossAppsConnectFieldsResult | null> {
    return mapComposioCredentialForm(
      await this.request("GET", `/toolkits/${encodeURIComponent(toolkitSlug)}`),
    );
  }

  /** The project's config for an app's credential scheme, created on first use. */
  async ensureCredentialAuthConfig(
    toolkitSlug: string,
    scheme: MossAppCredentialScheme,
  ): Promise<string> {
    for (const item of await this.enabledAuthConfigs(toolkitSlug)) {
      if (text(item.auth_scheme).toUpperCase() !== scheme) continue;
      const id = text(item.id).trim();
      if (id) return id;
    }
    // The user supplies the values when connecting, so the config itself holds none.
    const created = await this.request("POST", "/auth_configs", {
      toolkit: { slug: toolkitSlug },
      auth_config: { type: "use_custom_auth", authScheme: scheme, credentials: {} },
    });
    const id = isRecord(created.auth_config) ? text(created.auth_config.id).trim() : "";
    if (!id) throw new ComposioRequestError("The app did not return a sign-in config.", null);
    return id;
  }

  /** Connects an app with the values the user entered; the backend checks them where it can. */
  async connectWithCredentials(input: {
    readonly userId: string;
    readonly toolkitSlug: string;
    readonly authConfigId: string;
    readonly scheme: MossAppCredentialScheme;
    readonly values: Readonly<Record<string, string>>;
  }): Promise<MossAppConnection> {
    const created = await this.request("POST", "/connected_accounts", {
      auth_config: { id: input.authConfigId },
      connection: {
        user_id: input.userId,
        state: { authScheme: input.scheme, val: { ...input.values, status: "ACTIVE" } },
      },
    });
    const connectionId = text(created.id).trim();
    if (!connectionId) {
      throw new ComposioRequestError("The app did not accept these credentials.", null);
    }
    return {
      connectionId,
      toolkitSlug: input.toolkitSlug,
      status: CONNECTION_STATUS[text(created.status).toUpperCase()] ?? "active",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Walks the whole catalog by usage. The plugin directory files every app
   * under its category and searches locally, so it needs all of it at once.
   */
  async listCatalog(maxPages = 30): Promise<ComposioToolkitPage> {
    const toolkits: MossAppToolkit[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let totalItems = 0;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.listToolkits({ cursor, limit: 100 });
      totalItems = page.totalItems;
      for (const toolkit of page.toolkits) {
        if (seen.has(toolkit.slug)) continue;
        seen.add(toolkit.slug);
        toolkits.push(toolkit);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { toolkits, nextCursor: null, totalItems };
  }

  /**
   * Starts a sign-in and returns the backend's redirect, which goes straight to
   * the app's own consent page — unlike a hosted connect link, it shows no
   * backend-branded screen in between, so the flow reads as Moss end to end.
   * Apps without sign-in come back active with no redirect.
   */
  async startConnection(input: {
    readonly userId: string;
    readonly toolkitSlug: string;
    readonly authConfigId: string;
    readonly callbackUrl: string;
  }): Promise<ComposioConnectLink> {
    const created = await this.request("POST", "/connected_accounts", {
      auth_config: { id: input.authConfigId },
      connection: { user_id: input.userId, callback_url: input.callbackUrl },
    });
    const connectionId = text(created.id).trim();
    const redirectUrl = text(created.redirect_url).trim();
    const status =
      CONNECTION_STATUS[text(created.status).toUpperCase()] ?? (redirectUrl ? "pending" : "active");
    if (!connectionId || (redirectUrl && !redirectUrl.startsWith("https://"))) {
      throw new ComposioRequestError("The app did not return a sign-in page.", null);
    }
    if (!redirectUrl && status !== "active") {
      throw new ComposioRequestError("The app did not return a sign-in page.", null);
    }
    return {
      redirectUrl: redirectUrl || null,
      connection: {
        connectionId,
        toolkitSlug: input.toolkitSlug,
        status,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.request("DELETE", `/connected_accounts/${encodeURIComponent(connectionId)}`);
  }

  /**
   * A session for the user's agents. It is pinned to the connections Moss made
   * (unpinned, it resolves each app through a sign-in config of its own, finds
   * no connection there and hands the agent a backend-branded sign-in link),
   * and it cannot start or remove connections: connecting happens in Moss.
   */
  async createToolRouterSession(
    userId: string,
    connections: Readonly<Record<string, ReadonlyArray<string>>> = {},
  ): Promise<ComposioToolRouterSession> {
    const created = await this.request("POST", "/tool_router/session", {
      user_id: userId,
      ...(Object.keys(connections).length > 0 ? { connected_accounts: connections } : {}),
      manage_connections: { enable: false },
    });
    const sessionId = text(created.session_id).trim();
    const mcpUrl = isRecord(created.mcp) ? text(created.mcp.url).trim() : "";
    if (!sessionId || !mcpUrl.startsWith(`${COMPOSIO_API_ORIGIN}/`)) {
      throw new ComposioRequestError("The app backend did not return an MCP session.", null);
    }
    return { sessionId, mcpUrl };
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API_BASE}${path}`, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ComposioRequestError(
        error instanceof Error && error.name === "TimeoutError"
          ? "The app backend did not answer in time."
          : "Moss could not reach the app backend.",
        null,
      );
    }
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* A non-JSON body is reported by status below. */
    }
    if (!response.ok) {
      const message =
        isRecord(parsed) && isRecord(parsed.error) ? text(parsed.error.message).trim() : "";
      throw new ComposioRequestError(
        message || `The app backend answered HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!isRecord(parsed)) {
      throw new ComposioRequestError("The app backend returned an unreadable answer.", null);
    }
    return parsed;
  }
}
