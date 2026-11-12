// FILE: resourceContent.ts
// Purpose: Parses an MCP `resources/read` answer for a widget's `ui://` resource into the bounded
//   runtime result every provider back-end returns (Codex app-server, Agent SDK, Moss connectors,
//   the Moss gateway). HTML is runtime-only and never persisted.
// Layer: Server MCP Apps runtime (pure)
// Exports: parseMcpAppResourceReadResponse, normalizeMcpAppResourceContents

import {
  MCP_APP_RESOURCE_MAX_DOMAIN_CHARS,
  MCP_APP_RESOURCE_MAX_DOMAIN_ENTRIES,
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
  type McpAppResourceCsp,
  type McpAppResourceMimeType,
  type McpAppResourcePermissions,
  type McpAppResourceReadResult,
} from "@moss/contracts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The legacy MCP Apps MIME Claude still accepts; Moss reads it as the profile form. */
const LEGACY_MCP_APP_MIME_TYPE = "text/html+mcp";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Brings each content item to the text form the parser reads: a base64 `blob` of an HTML MIME is
 * decoded as UTF-8, and `text/html+mcp` becomes `text/html;profile=mcp-app`. Other items pass
 * through unchanged.
 */
export function normalizeMcpAppResourceContents(contents: ReadonlyArray<unknown>): unknown[] {
  return contents.map((entry) => {
    const content = asObject(entry);
    if (!content) return entry;
    const rawMime = typeof content.mimeType === "string" ? content.mimeType.trim() : undefined;
    const mimeType = rawMime === LEGACY_MCP_APP_MIME_TYPE ? "text/html;profile=mcp-app" : rawMime;
    const isHtml =
      mimeType !== undefined &&
      (MCP_APP_RESOURCE_HTML_MIME_TYPES as readonly string[]).includes(mimeType);
    if (
      isHtml &&
      typeof content.text !== "string" &&
      typeof content.blob === "string" &&
      // A base64 string longer than 4/3 of the cap cannot decode within it.
      content.blob.length <= Math.ceil((MCP_APP_RESOURCE_MAX_HTML_BYTES * 4) / 3) + 4 &&
      BASE64_PATTERN.test(content.blob)
    ) {
      const { blob, ...rest } = content;
      return { ...rest, mimeType, text: Buffer.from(blob as string, "base64").toString("utf8") };
    }
    return mimeType === rawMime ? content : { ...content, mimeType };
  });
}

export function parseMcpAppResourceReadResponse(input: {
  readonly response: unknown;
  readonly resourceUri: string;
  readonly expectedOriginCallId?: string;
  /**
   * The server is a Moss connector with a known URL: a declared `_meta.ui.domain` then opts the
   * widget into the connector-stable origin (SPEC §4). Local and CLI servers never get one.
   */
  readonly stableOriginEligible?: boolean;
}): McpAppResourceReadResult {
  const response = asObject(input.response);
  if (!response || !Array.isArray(response.contents)) {
    throw new Error("mcpServer/resource/read returned malformed contents.");
  }
  const contents = normalizeMcpAppResourceContents(response.contents);
  if (input.expectedOriginCallId !== undefined) {
    if (response.originCallId !== input.expectedOriginCallId) {
      throw new Error("MCP resource read did not confirm its originating tool call");
    }
  }
  for (const entry of contents) {
    const content = asObject(entry);
    const mimeType = content?.mimeType;
    if (
      typeof mimeType !== "string" ||
      !(MCP_APP_RESOURCE_HTML_MIME_TYPES as readonly string[]).includes(mimeType)
    ) {
      continue;
    }
    // Stop at the first supported representation. A blob-only
    // supported item is a terminal no-content result; do not search past it.
    if (typeof content?.text !== "string") {
      return { state: "no_content", resourceUri: input.resourceUri };
    }
    const html = content.text;
    const sizeBytes = Buffer.byteLength(html, "utf8");
    if (sizeBytes > MCP_APP_RESOURCE_MAX_HTML_BYTES) {
      return {
        state: "too_large",
        resourceUri: input.resourceUri,
        sizeBytes,
      };
    }
    const metadata = mcpAppResourceMetadata(content["_meta"]);
    const permissions = mcpAppResourcePermissions(content["_meta"]);
    const declaredDomain = boundedMcpAppResourceString(
      asObject(asObject(content["_meta"])?.ui)?.domain,
      MCP_APP_RESOURCE_MAX_DOMAIN_CHARS,
    );
    return {
      state: "ready",
      resourceUri: input.resourceUri,
      html,
      sizeBytes,
      mimeType: mimeType as McpAppResourceMimeType,
      ...metadata,
      ...(input.expectedOriginCallId !== undefined
        ? { originCallId: input.expectedOriginCallId }
        : {}),
      ...(permissions ? { permissions } : {}),
      stableOrigin: input.stableOriginEligible === true && declaredDomain !== undefined,
    };
  }
  return { state: "no_content", resourceUri: input.resourceUri };
}

const MCP_APP_RESOURCE_HTML_MIME_TYPES: readonly McpAppResourceMimeType[] = [
  "text/html",
  "text/html;profile=mcp-app",
  "text/html+skybridge",
];
const MCP_APP_RESOURCE_DOMAIN_SEPARATOR_PATTERN = /[\s;,"']/u;
const MCP_APP_RESOURCE_ENCODED_WILDCARD_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)?%2a(?=\.)/iu;

function boundedMcpAppResourceString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxChars ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeMcpAppResourceDomain(
  value: unknown,
  allowWebSocket: boolean,
): string | undefined {
  const raw = boundedMcpAppResourceString(value, MCP_APP_RESOURCE_MAX_DOMAIN_CHARS);
  if (!raw || MCP_APP_RESOURCE_DOMAIN_SEPARATOR_PATTERN.test(raw)) return undefined;
  if (raw === "blob:" || raw === "data:") return raw;

  const candidate = raw.replace(MCP_APP_RESOURCE_ENCODED_WILDCARD_PATTERN, "$1*");
  const urlValue = /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate) ? candidate : `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && !(allowWebSocket && parsed.protocol === "wss:")) ||
    parsed.hostname === "*" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return undefined;
  }
  const hostname = parsed.hostname.replace(/^%2a(?=\.)/iu, "*");
  if (hostname.includes("*") && !hostname.startsWith("*.")) return undefined;
  return `${parsed.protocol}//${hostname}${parsed.port.length > 0 ? `:${parsed.port}` : ""}`;
}

function normalizeMcpAppResourceDomainList(value: unknown, allowWebSocket: boolean): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MCP_APP_RESOURCE_MAX_DOMAIN_ENTRIES)) {
    const domain = normalizeMcpAppResourceDomain(entry, allowWebSocket);
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      normalized.push(domain);
    }
  }
  return normalized;
}

function mcpAppResourceCspFromMetadata(metadata: Record<string, unknown>): McpAppResourceCsp {
  const ui = asObject(metadata.ui);
  const mcpAppCsp = asObject(ui?.csp);
  const openaiWidgetCsp = asObject(metadata["openai/widgetCSP"]);
  const resourceDomains = normalizeMcpAppResourceDomainList(
    mcpAppCsp?.resourceDomains ??
      openaiWidgetCsp?.resourceDomains ??
      openaiWidgetCsp?.resource_domains,
    false,
  );
  const connectDomains = [
    ...normalizeMcpAppResourceDomainList(
      mcpAppCsp?.connectDomains ??
        openaiWidgetCsp?.connectDomains ??
        openaiWidgetCsp?.connect_domains,
      true,
    ),
    ...resourceDomains,
  ].filter((domain, index, domains) => domains.indexOf(domain) === index);
  return {
    baseUriDomains: normalizeMcpAppResourceDomainList(
      mcpAppCsp?.baseUriDomains ??
        openaiWidgetCsp?.baseUriDomains ??
        openaiWidgetCsp?.base_uri_domains,
      false,
    ),
    connectDomains: connectDomains.slice(0, MCP_APP_RESOURCE_MAX_DOMAIN_ENTRIES),
    frameDomains: normalizeMcpAppResourceDomainList(
      mcpAppCsp?.frameDomains ?? openaiWidgetCsp?.frameDomains ?? openaiWidgetCsp?.frame_domains,
      false,
    ),
    includeDefaultDomains: false,
    isTrusted: mcpAppCsp !== undefined || openaiWidgetCsp !== undefined,
    resourceDomains,
  };
}

function mcpAppResourceNumericMetadata(
  value: unknown,
  kind: "positive" | "nonNegative",
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value > 100_000 ||
    (kind === "positive" ? value <= 0 : value < 0)
  ) {
    return undefined;
  }
  return value;
}

function mcpAppResourceMetadata(metadata: unknown): {
  readonly csp: McpAppResourceCsp;
  readonly heightHint?: number;
  readonly minFrameHeight?: number;
  readonly prefersBorder: boolean;
  readonly isCollapsible: boolean;
  readonly widgetDomain: string | null;
} {
  const record = asObject(metadata) ?? {};
  const ui = asObject(record.ui);
  const openaiHeight = mcpAppResourceNumericMetadata(record["openai/widgetHeightHint"], "positive");
  const openaiMinHeight = mcpAppResourceNumericMetadata(
    record["openai/widgetMinFrameHeight"],
    "nonNegative",
  );
  const openaiPrefersBorder = record["openai/widgetPrefersBorder"];
  const uiPrefersBorder = ui?.prefersBorder;
  const widgetDomain =
    boundedMcpAppResourceString(ui?.domain, MCP_APP_RESOURCE_MAX_DOMAIN_CHARS) ??
    boundedMcpAppResourceString(record["openai/widgetDomain"], MCP_APP_RESOURCE_MAX_DOMAIN_CHARS) ??
    null;
  return {
    csp: mcpAppResourceCspFromMetadata(record),
    ...(openaiHeight !== undefined ? { heightHint: openaiHeight } : {}),
    ...(openaiMinHeight !== undefined ? { minFrameHeight: openaiMinHeight } : {}),
    // Claude's Code tab draws the card unless the widget says `prefersBorder: false`, so a
    // widget that declares nothing gets the 1 px border (light and dark alike).
    prefersBorder:
      typeof openaiPrefersBorder === "boolean"
        ? openaiPrefersBorder
        : typeof uiPrefersBorder === "boolean"
          ? uiPrefersBorder
          : true,
    isCollapsible: record["openai/widgetShowCodexWidgetInline"] !== true,
    widgetDomain,
  };
}

/** Resource-level `_meta.ui.permissions`; only `true` members are kept (Claude's shape `{}`). */
function mcpAppResourcePermissions(metadata: unknown): McpAppResourcePermissions | undefined {
  const permissions = asObject(asObject(asObject(metadata)?.ui)?.permissions);
  if (!permissions) return undefined;
  const granted = (key: string) =>
    permissions[key] === true || asObject(permissions[key]) !== undefined;
  const result: { -readonly [K in keyof McpAppResourcePermissions]: McpAppResourcePermissions[K] } =
    {};
  if (granted("camera")) result.camera = true;
  if (granted("microphone")) result.microphone = true;
  if (granted("geolocation")) result.geolocation = true;
  if (granted("clipboardWrite")) result.clipboardWrite = true;
  return Object.keys(result).length > 0 ? result : undefined;
}
