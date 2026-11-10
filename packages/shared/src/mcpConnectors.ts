// FILE: mcpConnectors.ts
// Purpose: The Connectors catalog plus the URL and server-name rules shared by server and web.
// Layer: Shared runtime utility
// Exports: MCP_CONNECTOR_CATEGORIES, MCP_CONNECTOR_PRESETS, findMcpConnectorPreset,
//   isMcpConnectorPresetListed, mcpConnectorCategoriesForRegion, normalizeMcpConnectorUrl, splitMcpConnectorUrlApiKey,
//   defaultMcpConnectorName, mcpConnectorSlug, mcpConnectorServerName

/** Catalog shelves, in display order. "life" holds travel and daily-life services. */
export const MCP_CONNECTOR_CATEGORIES = ["popular", "developer", "productivity", "life"] as const;
export type McpConnectorCategory = (typeof MCP_CONNECTOR_CATEGORIES)[number];

/** Where a preset's service runs: "cn" services serve mainland China. */
export type McpConnectorRegion = "cn" | "global";

/** Shelves in display order for a region: mainland users see daily-life services first. */
export function mcpConnectorCategoriesForRegion(
  region: McpConnectorRegion,
): ReadonlyArray<McpConnectorCategory> {
  return region === "cn"
    ? ["life", ...MCP_CONNECTOR_CATEGORIES.filter((category) => category !== "life")]
    : MCP_CONNECTOR_CATEGORIES;
}

/**
 * How a server takes the user's API key instead of OAuth: as a URL query
 * parameter (Amap's `?key=`, Baidu's `?ak=`) or as an `Authorization: Bearer`
 * header (McDonald's China).
 */
export type McpConnectorApiKeyPlacement =
  | { readonly kind: "query"; readonly param: string }
  | { readonly kind: "bearer" };

export interface McpConnectorPreset {
  /** Stable catalog key; also the slug of the provider-facing server name. */
  readonly id: string;
  readonly name: string;
  readonly category: McpConnectorCategory;
  readonly description: string;
  /** The vendor's hosted Streamable HTTP endpoint, in normalized form (see below). */
  readonly url: string;
  /** The vendor's own page about this MCP server. */
  readonly docsUrl: string;
  /**
   * The server registers no clients itself, so the user brings their own
   * OAuth app (client ID and secret), created at `appSetupUrl`.
   */
  readonly requiresOwnApp?: boolean;
  readonly appSetupUrl?: string;
  /** The server takes an API key the user pastes, sent as described here. */
  readonly apiKey?: McpConnectorApiKeyPlacement;
  /** The vendor's page where the user creates that key. */
  readonly apiKeyUrl?: string;
  /** Defaults to "global". */
  readonly region?: McpConnectorRegion;
  /** Site whose favicon stands for the vendor when the endpoint's own is wrong. */
  readonly iconHost?: string;
  /**
   * Kept out of the catalog (and out of Moss service plugins) until its
   * sign-in has been verified end to end. A pasted URL still matches it.
   */
  readonly unlisted?: boolean;
}

/** Whether the catalog offers this preset; unverified ones stay hidden. */
export function isMcpConnectorPresetListed(preset: McpConnectorPreset): boolean {
  return preset.unlisted !== true;
}

/**
 * Hosted MCP servers that work with one click: each accepts an anonymous
 * client through OAuth dynamic client registration or needs no sign-in.
 * Vercel documents an allowlist of reviewed clients but admitted Moss end to
 * end (2026-10-14); until it reviews Moss, its consent page says "An MCP client".
 * Slack registers no clients, so its preset asks for the user's own Slack app.
 * Vendors that refuse registration outright (Figma) or need an app Moss has
 * not registered (GitHub, Asana) are absent; a custom URL can still use the
 * user's own app.
 *
 * The "life" presets are mainland China services that take an API key or
 * token from the vendor's console instead of OAuth. Their endpoints were
 * checked against the vendors' docs on 2026-11-02; several refuse requests
 * from outside mainland China.
 */
export const MCP_CONNECTOR_PRESETS = [
  {
    id: "supabase",
    name: "Supabase",
    category: "popular",
    description: "Query Postgres, manage projects, and deploy Edge Functions.",
    url: "https://mcp.supabase.com/mcp",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "popular",
    description: "Manage projects and deployments, and read deployment logs.",
    url: "https://mcp.vercel.com/",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
  },
  {
    id: "workos",
    name: "WorkOS",
    category: "developer",
    description: "Manage users, organizations, SSO, and AuthKit in your dashboard.",
    url: "https://mcp.workos.com/mcp",
    docsUrl: "https://workos.com/docs/mcp",
  },
  {
    id: "convex",
    name: "Convex",
    category: "developer",
    // The hosted server only guides setup; deployment tools run in the local
    // `npx convex mcp start` server, which connectors cannot reach.
    description: "Start Convex apps and get setup and scaling guidance.",
    url: "https://mcp.convex.dev/mcp",
    docsUrl: "https://docs.convex.dev/ai/overview",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "developer",
    description: "Build with Workers, KV, R2, and D1 on your account.",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    docsUrl:
      "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
  },
  {
    id: "slack",
    name: "Slack",
    category: "popular",
    description: "Search, read, and post in your workspace. Needs your own Slack app.",
    url: "https://mcp.slack.com/mcp",
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    requiresOwnApp: true,
    appSetupUrl: "https://api.slack.com/apps",
  },
  {
    id: "linear",
    name: "Linear",
    category: "popular",
    description: "Find, create, and update issues, projects, and comments.",
    url: "https://mcp.linear.app/mcp",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "notion",
    name: "Notion",
    category: "popular",
    description: "Search, read, and edit pages and databases.",
    url: "https://mcp.notion.com/mcp",
    docsUrl: "https://developers.notion.com/guides/mcp/overview",
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "developer",
    description: "Investigate errors, issues, and releases.",
    url: "https://mcp.sentry.dev/mcp",
    docsUrl: "https://mcp.sentry.dev/",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "popular",
    description: "Work with customers, payments, and Stripe docs.",
    url: "https://mcp.stripe.com/",
    docsUrl: "https://docs.stripe.com/mcp",
  },
  {
    id: "neon",
    name: "Neon",
    category: "developer",
    description: "Manage serverless Postgres projects and branches.",
    url: "https://mcp.neon.tech/mcp",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    category: "productivity",
    description: "Work with Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v1/mcp",
    docsUrl: "https://www.atlassian.com/platform/rovo-mcp",
  },
  {
    id: "todoist",
    name: "Todoist",
    category: "productivity",
    description: "Find, add, and complete tasks and projects.",
    url: "https://ai.todoist.net/mcp",
    docsUrl: "https://github.com/Doist/todoist-mcp",
  },
  {
    id: "posthog",
    name: "PostHog",
    category: "developer",
    description: "Query product analytics, feature flags, and errors.",
    url: "https://mcp.posthog.com/mcp",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
  },
  {
    id: "netlify",
    name: "Netlify",
    category: "developer",
    description: "Create, deploy, and manage Netlify sites.",
    url: "https://netlify-mcp.netlify.app/mcp",
    docsUrl:
      "https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/",
  },
  {
    id: "railway",
    name: "Railway",
    category: "developer",
    description: "Deploy and manage Railway projects and services.",
    url: "https://mcp.railway.com/",
    docsUrl: "https://docs.railway.com/ai/mcp-server",
  },
  {
    id: "prisma",
    name: "Prisma",
    category: "developer",
    description: "Manage Prisma Postgres databases and backups.",
    url: "https://mcp.prisma.io/mcp",
    docsUrl: "https://www.prisma.io/docs/ai/tools/mcp-server",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    category: "developer",
    description: "Search models, datasets, Spaces, and papers.",
    url: "https://huggingface.co/mcp",
    docsUrl: "https://huggingface.co/docs/hub/agents-mcp",
  },
  {
    id: "amap",
    name: "高德地图",
    category: "life",
    description: "Search places, plan routes, check weather, and geocode addresses.",
    url: "https://mcp.amap.com/mcp",
    docsUrl: "https://lbs.amap.com/api/mcp-server/summary",
    apiKey: { kind: "query", param: "key" },
    apiKeyUrl: "https://console.amap.com/dev/key/app",
    region: "cn",
  },
  {
    id: "baidu_maps",
    name: "百度地图",
    category: "life",
    description: "Search places, plan routes, and geocode addresses.",
    url: "https://mcp.map.baidu.com/mcp",
    docsUrl: "https://lbs.baidu.com/faq/api?title=mcpserver/base",
    apiKey: { kind: "query", param: "ak" },
    apiKeyUrl: "https://lbsyun.baidu.com/apiconsole/key",
    region: "cn",
  },
  {
    id: "tencent_maps",
    name: "腾讯地图",
    category: "life",
    description: "Search places, plan routes, check weather, and geocode addresses.",
    url: "https://mcp.map.qq.com/mcp?format=0",
    docsUrl: "https://lbs.qq.com/service/MCPServer/MCPServerGuide/overview",
    apiKey: { kind: "query", param: "key" },
    apiKeyUrl: "https://lbs.qq.com/dev/console/application/mine",
    region: "cn",
  },
  {
    id: "didi",
    name: "滴滴出行",
    category: "life",
    // The production endpoint places real, billed ride orders.
    description: "Estimate fares, book rides, and track drivers. Orders are real.",
    url: "https://mcp.didichuxing.com/mcp-servers",
    docsUrl: "https://mcp.didichuxing.com/",
    apiKey: { kind: "query", param: "key" },
    apiKeyUrl: "https://mcp.didichuxing.com/",
    region: "cn",
  },
  {
    id: "mcdonalds_cn",
    name: "麦当劳中国",
    category: "life",
    description: "Browse menus and coupons, and place pickup or delivery orders.",
    url: "https://mcp.mcd.cn/",
    docsUrl: "https://open.mcd.cn/mcp/doc",
    apiKey: { kind: "bearer" },
    apiKeyUrl: "https://open.mcd.cn/mcp",
    region: "cn",
    // mcd.cn serves a stock React favicon; the brand site carries the mark.
    iconHost: "mcdonalds.com",
  },
  {
    id: "luckin",
    name: "瑞幸咖啡",
    category: "life",
    // Signs in with MCP OAuth (the server answers 401 with resource metadata);
    // whether it registers clients dynamically is unverified from outside China,
    // so the preset and its service plugin stay hidden until a sign-in works.
    description: "Find stores and drinks, apply coupons, and place pickup orders.",
    url: "https://gwmcp.lkcoffee.com/order/user/mcp",
    docsUrl: "https://open.lkcoffee.com/docs",
    region: "cn",
    iconHost: "lkcoffee.com",
    unlisted: true,
  },
] as const satisfies readonly McpConnectorPreset[];

export type McpConnectorPresetId = (typeof MCP_CONNECTOR_PRESETS)[number]["id"];

export function findMcpConnectorPreset(id: string): McpConnectorPreset | undefined {
  return MCP_CONNECTOR_PRESETS.find((preset) => preset.id === id);
}

export const MCP_CONNECTOR_MAX_URL_LENGTH = 2048;
export const MCP_CONNECTOR_MAX_NAME_LENGTH = 60;
const MAX_SLUG_LENGTH = 24;

/**
 * Provider-facing server names end with this suffix so a connector never
 * shares a name with a server the user configured in Codex or Claude
 * directly: Codex deep-merges same-named tables into one invalid entry.
 */
export const MCP_CONNECTOR_SERVER_NAME_SUFFIX = "_connector";

export type McpConnectorUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/** Accepts only public HTTPS endpoints without credentials; drops any fragment. */
export function normalizeMcpConnectorUrl(raw: string): McpConnectorUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Enter the server URL." };
  if (trimmed.length > MCP_CONNECTOR_MAX_URL_LENGTH) {
    return { ok: false, reason: "The URL is too long." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Enter a full URL, like https://mcp.example.com/mcp." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "The URL must start with https://." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Remove the user name or password from the URL." };
  }
  if (!parsed.hostname.includes(".")) {
    return { ok: false, reason: "Use the server's public address." };
  }
  parsed.hash = "";
  return { ok: true, url: parsed.href };
}

/** Query parameters that carry an API key in a pasted MCP server URL. */
const URL_API_KEY_PARAMS = new Set(["key", "ak", "api_key", "apikey", "token", "access_token"]);

export interface McpConnectorUrlApiKey {
  readonly param: string;
  readonly value: string;
}

/**
 * Splits an API key out of a normalized URL (`https://mcp.amap.com/mcp?key=…`)
 * so the key can be stored as a secret and the rest shown and matched safely.
 * The first non-empty key-like query parameter wins; the URL is returned
 * unchanged when there is none.
 */
export function splitMcpConnectorUrlApiKey(url: string): {
  readonly url: string;
  readonly apiKey: McpConnectorUrlApiKey | null;
} {
  const parsed = new URL(url);
  for (const [param, value] of parsed.searchParams) {
    if (!URL_API_KEY_PARAMS.has(param.toLowerCase()) || !value.trim()) continue;
    parsed.searchParams.delete(param);
    return { url: parsed.href, apiKey: { param, value: value.trim() } };
  }
  return { url, apiKey: null };
}

/** A readable default name for a custom server: its host without `mcp.`/`api.`/`www.`. */
export function defaultMcpConnectorName(url: string): string {
  const host = new URL(url).hostname.replace(/^(?:mcp|api|www)\./u, "");
  return host.slice(0, MCP_CONNECTOR_MAX_NAME_LENGTH);
}

/**
 * Lowercase letters, digits, and single underscores, starting with a letter.
 * Names that could pass for Moss's own server (`moss…`) get a prefix,
 * because tool policy treats `moss` tools as trusted.
 */
export function mcpConnectorSlug(name: string): string {
  let slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (!/^[a-z]/u.test(slug)) slug = `mcp_${slug}`.replace(/_+$/u, "");
  if (slug.startsWith("moss")) slug = `custom_${slug}`;
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/_+$/u, "");
}

/** The MCP server name providers see, e.g. `supabase_connector`. */
export function mcpConnectorServerName(slug: string): string {
  return `${slug}${MCP_CONNECTOR_SERVER_NAME_SUFFIX}`;
}

/** `@` mentions of a connector reference `connector://<serverName>`. */
export const MCP_CONNECTOR_MENTION_PATH_PREFIX = "connector://";

export function mcpConnectorMentionPath(serverName: string): string {
  return `${MCP_CONNECTOR_MENTION_PATH_PREFIX}${serverName}`;
}

export function isMcpConnectorMentionPath(path: string): boolean {
  return path.startsWith(MCP_CONNECTOR_MENTION_PATH_PREFIX);
}

/** The provider-facing server name, or null for anything that is not a valid one. */
export function serverNameFromMcpConnectorMentionPath(path: string): string | null {
  if (!isMcpConnectorMentionPath(path)) return null;
  const serverName = path.slice(MCP_CONNECTOR_MENTION_PATH_PREFIX.length);
  return /^[a-z][a-z0-9_]*$/u.test(serverName) ? serverName : null;
}

/**
 * Providers whose sessions receive connector servers. ACP agents that only
 * speak stdio MCP skip them at session start; Pi, Devin, and Antigravity never
 * receive them.
 */
const MCP_CONNECTOR_PROVIDERS = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "droid",
  "omp",
]);

export function providerSupportsMcpConnectors(provider: string): boolean {
  return MCP_CONNECTOR_PROVIDERS.has(provider);
}
