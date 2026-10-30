// Codex 26.1007 browser MCP App frame.
// Source: webview/assets/mcp-sandbox-element-8c6f1f20ef59.js `x` (export `t`)
// and webview/assets/widget-9f8acfe83a1c.js `Jl` / `Qa(Sr, hr, mr)`.
// Desktop creates a <webview>. When that element is an HTMLIFrameElement
// (Codex browser host, client_type.browser = `codex_browser` in widget.js `bc`),
// the frame gets sandbox + referrerpolicy, then Jl sets allow / allowFullscreen.
// Moss web has no chatgpt.com `mcp-app-*` sandbox origin (sandbox-origin.js `p`),
// so allow-same-origin is omitted: that flag is only safe on Codex's dedicated
// origin, and would attach a srcdoc guest to the Moss origin.

import { MCP_APP_RESOURCE_MAX_HTML_BYTES } from "@synara/contracts";

import type { WorkLogMcpToolResult } from "./toolCallDetails";

/** Final sandbox token list from widget.js after the HTMLIFrameElement branch, minus allow-same-origin. */
export const CODEX_BROWSER_MCP_IFRAME_SANDBOX = "allow-scripts allow-forms";
/** mcp-sandbox-element.js `x`: `referrerpolicy=no-referrer`. */
export const CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY = "no-referrer";
/** widget.js Jl when no extra allow-list is present: `encrypted-media *`. */
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
