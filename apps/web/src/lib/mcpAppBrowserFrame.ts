// Browser MCP App frame: an iframe with sandbox, referrerpolicy, allow and allowFullscreen.
// Moss web has no dedicated sandbox origin for MCP Apps, so allow-same-origin is
// omitted: that flag is only safe on a dedicated origin, and would attach a srcdoc
// guest to the Moss origin.

import { MCP_APP_RESOURCE_MAX_HTML_BYTES } from "@synara/contracts";

import type { WorkLogMcpToolResult } from "./toolCallDetails";

/** Sandbox tokens for the iframe; no allow-same-origin (see above). */
export const CODEX_BROWSER_MCP_IFRAME_SANDBOX = "allow-scripts allow-forms";
/** `referrerpolicy=no-referrer`. */
export const CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY = "no-referrer";
/** Default allow-list when the app asks for nothing extra: `encrypted-media *`. */
export const CODEX_BROWSER_MCP_IFRAME_ALLOW = "encrypted-media *";

const HTML_MIME = /^text\/html(?:;.*|\+skybridge)?$/i;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Recorded MCP App HTML carried on the tool result.
 * Codex reads the live resource (`mcpServer/resource/read`); a replayed Moss
 * thread can still render when the result includes an `embedded_resource`
 * whose mime is an MCP App HTML type (`McpAppResourceMimeType`).
 */
export function embeddedMcpAppHtml(
  projection: Pick<WorkLogMcpToolResult, "app" | "result">,
): string | null {
  const resourceUri = projection.app?.resourceUri;
  if (!resourceUri) return null;
  for (const block of projection.result?.content ?? []) {
    if (block.type !== "embedded_resource") continue;
    if (!HTML_MIME.test(block.mimeType ?? "")) continue;
    if (block.uri !== undefined && block.uri !== resourceUri) continue;
    const text = block.text?.trim();
    if (!text) continue;
    if (utf8ByteLength(text) > MCP_APP_RESOURCE_MAX_HTML_BYTES) continue;
    return text;
  }
  return null;
}
