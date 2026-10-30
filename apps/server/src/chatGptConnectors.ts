// FILE: chatGptConnectors.ts
// Purpose: Authenticated, fail-closed ChatGPT connector HTTP bridge for Codex Apps parity.
// Layer: Server utility
// Exports: createChatGptConnectorClient, normalizeConnectorTools

import { Buffer } from "node:buffer";

import {
  type ProviderAppConnectorDetail,
  type ProviderAppConnectorTerms,
  type ProviderAppTool,
} from "@synara/contracts";
import { MOSS_CONNECTOR_OAUTH_SCHEME } from "@synara/shared/desktopIdentity";
import { Schema } from "effect";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const PRODUCT_SKU_HEADER = "OAI-Product-Sku";
const PRODUCT_SKU = "CODEX";

const RawConnectorAuth = Schema.Struct({ type: Schema.String });
const RawConnectorBase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  supported_auth: Schema.Array(RawConnectorAuth),
  link_params_schema: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawConnectorAction = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  is_enabled: Schema.optional(Schema.Boolean),
  disabled_reason: Schema.optional(Schema.NullOr(Schema.String)),
  is_read_only: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(Schema.NullOr(Schema.String)),
  is_open_world: Schema.optional(Schema.Boolean),
  is_destructive: Schema.optional(Schema.Boolean),
});
export type RawConnectorAction = typeof RawConnectorAction.Type;

const RawConnectorWithActions = Schema.Struct({
  ...RawConnectorBase.fields,
  actions: Schema.Array(RawConnectorAction),
});

const RawConnectorTerms = Schema.Struct({
  blurbs: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
    }),
  ),
  personalization_default: Schema.optional(
    Schema.NullOr(Schema.Literals(["UNSET", "PERSONALIZE_ALWAYS", "NO_PERSONALIZATION"])),
  ),
  personalization_toggle_blurb: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawOAuthStartResponse = Schema.Struct({ redirect_url: Schema.String });
const RawOAuthCallbackResponse = Schema.Struct({
  link: Schema.Struct({
    connector_id: Schema.String,
    name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export interface ChatGptConnectorAuthContext {
  readonly token: string;
}

export interface ChatGptConnectorClientOptions {
  readonly resolveAuth: (refreshToken: boolean) => Promise<ChatGptConnectorAuthContext>;
  readonly fetchImpl?: ConnectorFetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export type ConnectorFetch = (...args: Parameters<typeof fetch>) => Promise<Response>;

export interface ChatGptConnectorClient {
  readonly readConnector: (connectorId: string) => Promise<ProviderAppConnectorDetail>;
  readonly readTools: (connectorId: string) => Promise<{ tools: ProviderAppTool[] }>;
  readonly readTerms: (connectorId: string) => Promise<ProviderAppConnectorTerms>;
  readonly connectNoAuth: (input: {
    readonly connectorId: string;
    readonly name: string;
  }) => Promise<void>;
  readonly startOAuth: (input: {
    readonly connectorId: string;
    readonly name: string;
    readonly callbackUrl: string;
    readonly postAuthUrl: string;
  }) => Promise<string>;
  readonly reauthenticate: (input: {
    readonly callbackUrl: string;
    readonly linkId: string;
    readonly postAuthUrl: string;
    readonly requestedScopes: ReadonlyArray<string> | null;
  }) => Promise<string>;
  readonly completeOAuth: (fullRedirectUrl: string) => Promise<{ appId: string; appName: string }>;
}

export function createChatGptConnectorClient(
  options: ChatGptConnectorClientOptions,
): ChatGptConnectorClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("ChatGPT connectors are unavailable in this runtime.");
  }
  const baseUrl = normalizeTrustedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const request = async <A>(input: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly decode?: (payload: unknown) => A;
  }): Promise<A | undefined> => {
    const send = async (refreshToken: boolean) => {
      const auth = await options.resolveAuth(refreshToken);
      const token = normalizeToken(auth.token);
      return requestOnce({
        fetchImpl,
        url: new URL(input.path.replace(/^\/+/, ""), `${baseUrl}/`).toString(),
        method: input.method,
        ...(input.body === undefined ? {} : { body: input.body }),
        token,
        timeoutMs,
      });
    };

    let response = await send(false);
    if (response.status === 401 || response.status === 403) {
      response = await send(true);
    }
    if (!response.ok) {
      throw new Error(`ChatGPT connector request failed with status ${response.status}.`);
    }
    if (!input.decode) return undefined;
    const payload = await readJsonResponse(response);
    try {
      return input.decode(payload);
    } catch {
      throw new Error("ChatGPT returned an invalid connector response.");
    }
  };

  return {
    readConnector: async (connectorId) => {
      const id = normalizeConnectorId(connectorId);
      const raw = await request({
        path: `/aip/connectors/${encodeURIComponent(id)}?include_logo=false&include_actions=false`,
        method: "GET",
        decode: decodeWith(RawConnectorBase),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return normalizeConnectorDetail(raw);
    },

    readTools: async (connectorId) => {
      const id = normalizeConnectorId(connectorId);
      const raw = await request({
        path: `/aip/connectors/${encodeURIComponent(id)}?include_logo=false&include_actions=true`,
        method: "GET",
        decode: decodeWith(RawConnectorWithActions),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return { tools: normalizeConnectorTools(raw.actions) };
    },

    readTerms: async (connectorId) => {
      const id = normalizeConnectorId(connectorId);
      const raw = await request({
        path: `/aip/connectors/${encodeURIComponent(id)}/tos`,
        method: "GET",
        decode: decodeWith(RawConnectorTerms),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return {
        blurbs: raw.blurbs,
        personalizationDefault: raw.personalization_default ?? null,
        personalizationToggleBlurb: raw.personalization_toggle_blurb ?? null,
      };
    },

    connectNoAuth: async ({ connectorId, name }) => {
      await request({
        path: "/aip/connectors/links/noauth",
        method: "POST",
        body: {
          connector_id: normalizeConnectorId(connectorId),
          name: normalizeNonEmpty(name, "connector name"),
          action_names: [],
        },
      });
    },

    startOAuth: async ({ connectorId, name, callbackUrl, postAuthUrl }) => {
      const raw = await request({
        path: "/aip/connectors/links/oauth",
        method: "POST",
        body: {
          connector_id: normalizeConnectorId(connectorId),
          name: normalizeNonEmpty(name, "connector name"),
          action_names: null,
          callback_url: normalizeConnectorCallbackUrl(callbackUrl),
          post_auth_url: normalizeWebUrl(postAuthUrl, "connector post-auth URL"),
        },
        decode: decodeWith(RawOAuthStartResponse),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return normalizeWebUrl(raw.redirect_url, "connector OAuth redirect URL");
    },

    reauthenticate: async ({ callbackUrl, linkId, postAuthUrl, requestedScopes }) => {
      const raw = await request({
        path: "/aip/connectors/links/oauth/reauth",
        method: "POST",
        body: {
          callback_url: normalizeConnectorCallbackUrl(callbackUrl),
          link_id: normalizeNonEmpty(linkId, "connector link id"),
          post_auth_url: normalizeWebUrl(postAuthUrl, "connector post-auth URL"),
          requested_scopes:
            requestedScopes === null
              ? null
              : requestedScopes.map((scope) => normalizeNonEmpty(scope, "connector scope")),
        },
        decode: decodeWith(RawOAuthStartResponse),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return normalizeWebUrl(raw.redirect_url, "connector OAuth redirect URL");
    },

    completeOAuth: async (fullRedirectUrl) => {
      const raw = await request({
        path: "/aip/connectors/links/oauth/callback",
        method: "POST",
        body: {
          full_redirect_url: normalizeOAuthCompletionRedirectUrl(fullRedirectUrl),
        },
        decode: decodeWith(RawOAuthCallbackResponse),
      });
      if (!raw) throw new Error("ChatGPT returned an invalid connector response.");
      return {
        appId: normalizeConnectorId(raw.link.connector_id),
        appName: normalizeNonEmpty(raw.link.name ?? "App", "connector name"),
      };
    },
  };
}

export function normalizeConnectorTools(
  actions: ReadonlyArray<RawConnectorAction>,
): ProviderAppTool[] {
  return actions
    .filter(
      (action) => action.is_enabled !== false || action.disabled_reason === "disabled_by_admin",
    )
    .map((action) => {
      const visibility = normalizeVisibility(action.visibility);
      return {
        name: normalizeNonEmpty(action.name, "connector action name"),
        description: action.description ?? null,
        disabledReason: action.disabled_reason ?? null,
        visibility,
        accessBadges: [
          action.is_read_only === true ? "READ" : visibility ? `${visibility} WRITE` : "WRITE",
          ...(action.is_open_world === true ? ["OPEN WORLD"] : []),
          ...(action.is_destructive === true ? ["DESTRUCTIVE"] : []),
        ],
      } satisfies ProviderAppTool;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function normalizeConnectorDetail(raw: typeof RawConnectorBase.Type): ProviderAppConnectorDetail {
  const supported = new Set(raw.supported_auth.map((entry) => entry.type.trim().toUpperCase()));
  const authMode = supported.has("OAUTH")
    ? "OAUTH"
    : supported.has("NONE")
      ? "NONE"
      : "UNSUPPORTED";
  return {
    id: normalizeConnectorId(raw.id),
    name: normalizeNonEmpty(raw.name, "connector name"),
    status: raw.status ?? null,
    authMode,
    requiresLinkParameters: hasLinkParameters(raw.link_params_schema),
  };
}

function hasLinkParameters(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const properties = value.properties;
  if (isRecord(properties) && Object.keys(properties).length > 0) return true;
  return Array.isArray(value.required) && value.required.length > 0;
}

function normalizeVisibility(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[:/_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function normalizeConnectorId(value: string): string {
  const normalized = normalizeNonEmpty(value, "connector id");
  if (
    normalized.includes("\\") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    }) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid connector id.");
  }
  return normalized;
}

function normalizeNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("No ChatGPT session token is available.");
  return token;
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 120_000) {
    throw new Error("Invalid ChatGPT connector timeout.");
  }
  return value;
}

function normalizeTrustedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unsafe ChatGPT connector base URL.");
  }
  const host = url.hostname.toLowerCase();
  const trustedHttpsHost =
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com");
  const trustedLoopback =
    url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !((url.protocol === "https:" && trustedHttpsHost) || trustedLoopback)
  ) {
    throw new Error("Unsafe ChatGPT connector base URL.");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeConnectorCallbackUrl(value: string): string {
  const expected = `${MOSS_CONNECTOR_OAUTH_SCHEME}://connector/oauth_callback`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unsafe connector callback URL.");
  }
  if (
    value !== expected ||
    url.protocol !== `${MOSS_CONNECTOR_OAUTH_SCHEME}:` ||
    url.hostname !== "connector" ||
    url.pathname !== "/oauth_callback" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Unsafe connector callback URL.");
  }
  return value;
}

function normalizeOAuthCompletionRedirectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unsafe connector callback URL.");
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    throw new Error("Unsafe connector callback URL.");
  }
  return url.toString();
}

function normalizeWebUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Unsafe ${label}.`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(`Unsafe ${label}.`);
  }
  return url.toString();
}

async function requestOnce(input: {
  readonly fetchImpl: ConnectorFetch;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly token: string;
  readonly timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const accountId = extractChatGptAccountId(input.token);
    return await input.fetchImpl(input.url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "Codex Desktop",
        [PRODUCT_SKU_HEADER]: PRODUCT_SKU,
        ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new Error("ChatGPT connector request timed out.");
    }
    throw new Error("ChatGPT connector request failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("ChatGPT returned an invalid connector response.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("ChatGPT returned an invalid connector response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("ChatGPT returned an invalid connector response.");
  }
}

function extractChatGptAccountId(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)) return null;
    const auth = decoded["https://api.openai.com/auth"];
    if (!isRecord(auth)) return null;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

function decodeWith<S extends Schema.Top>(schema: S): (payload: unknown) => S["Type"] {
  return Schema.decodeUnknownSync(schema as never) as (payload: unknown) => S["Type"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
