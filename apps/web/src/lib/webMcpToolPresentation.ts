// FILE: webMcpToolPresentation.ts
// Purpose: Reads which site a page-declared WebMCP call acted on, for the work-log row.
// Layer: Web work-log projection
// Why: a page tool can do anything the site can, so every call row names the site.
//      Providers report the call differently: Codex as `data.arguments` (or its MCP
//      result's arguments), Claude as a `ToolName: {json}` detail string that may be
//      clamped. The agent passes the origin it discovered; Moss checks it on the desktop.

const WEB_MCP_CALL_TOOL = "browser_webmcp_call";

/** Exact names only: bare, `moss_`-prefixed or `mcp__moss__`-qualified. */
export function isWebMcpCallToolName(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === WEB_MCP_CALL_TOOL ||
    normalized === `moss_${WEB_MCP_CALL_TOOL}` ||
    normalized === `mcp__moss__${WEB_MCP_CALL_TOOL}`
  );
}

function normalizedOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function webMcpCallOriginFromArguments(args: unknown): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  return normalizedOrigin((args as Record<string, unknown>).origin);
}

/** Claude's `mcp__moss__browser_webmcp_call: {"origin":"…",…}`, possibly clamped. */
export function webMcpCallOriginFromDetail(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  const separator = detail.indexOf(":");
  if (separator < 0 || !isWebMcpCallToolName(detail.slice(0, separator))) return null;
  const json = detail.slice(separator + 1).trim();
  try {
    const fromJson = webMcpCallOriginFromArguments(JSON.parse(json));
    if (fromJson) return fromJson;
  } catch {
    // Clamped detail: fall back to the origin field's own text.
  }
  const match = /"origin"\s*:\s*"([^"\\]{1,2048})"/u.exec(json);
  return normalizedOrigin(match?.[1]);
}
