// FILE: constants.ts
// Purpose: Timing and size limits of the Moss interactive-connector host (SPEC §5–§10,
//          SPEC-protocol §4). B owns the sandbox copies in @moss/contracts/mcpAppSandbox.
// Layer: Web MCP App host constants

/** Inline widgets never grow past this height (SPEC-protocol §4.2). */
export const MCP_APP_INLINE_MAX_HEIGHT = 5_000;
/** Reported heights at or below this are "empty" and ignored while a remembered height holds. */
export const MCP_APP_EMPTY_HEIGHT_THRESHOLD = 8;
/** Widget height transition (Claude `duration-base ease-out`). */
export const MCP_APP_HEIGHT_TRANSITION = "height 200ms cubic-bezier(0.165, 0.84, 0.44, 1)" as const;
/**
 * Third-party widgets must say `initialized` within this long once the resource is sent and the
 * tool result is in (10 000 ms + 5 000 ms slack). Moss's own widgets have no such limit.
 */
export const MCP_APP_INITIALIZE_TIMEOUT_MS = 10_000 + 5_000;
/** A display-mode request must follow a real click or key press this closely. */
export const MCP_APP_USER_ACTIVATION_WINDOW_MS = 250;
/** `ui/message` replace-prompt toast. */
export const MCP_APP_MESSAGE_REPLACE_TOAST_MS = 6_500;
/** Same `ui/message` text inside this window is ignored. */
export const MCP_APP_MESSAGE_DEDUPE_MS = 5_250;
/** The open-link confirm button arms after the dialog has been visible this long. */
export const MCP_APP_OPEN_LINK_ARM_MS = 400;
/** Widget `tools/call` budget; the server enforces 240 s, the client allows some slack. */
export const MCP_APP_TOOL_CALL_TIMEOUT_MS = 250_000;
/** Other widget requests to the server. */
export const MCP_APP_RPC_TIMEOUT_MS = 30_000;
/** While a call still runs, re-ask the server for its full result this often. */
export const MCP_APP_TOOL_RESULT_POLL_MS = 1_000;
/** Remembered widget heights kept per device. */
export const MCP_APP_REMEMBERED_HEIGHTS_MAX = 500;
/** Hidden connectors kept per device (Claude keeps the last 100). */
export const MCP_APP_HIDDEN_CONNECTORS_MAX = 100;
export const MCP_APP_CLOSED_TOOLS_MAX = 200;
/** structuredContent sent to a widget (SPEC §3). */
export const MCP_APP_STRUCTURED_CONTENT_MAX_CHARS = 262_144;
export const MCP_APP_STRUCTURED_CONTENT_MAX_DEPTH = 64;
/** Logger names recorded from widget logging. */
export const MCP_APP_LOGGER_NAME_MAX = 64;

/**
 * Inter served from the sandbox asset origin (B's `MCP_APP_SANDBOX_FONT_URL` and
 * `MCP_APP_SANDBOX_FONT_FACE_CSS`). One local copy until B merges; then import B's.
 */
export const MCP_APP_SANDBOX_FONT_URL =
  "moss-mcp-sandbox://assets/fonts/inter-latin.woff2" as const;
export const MCP_APP_SANDBOX_FONT_FACE_CSS = `@font-face { font-family: "Inter"; src: url("${MCP_APP_SANDBOX_FONT_URL}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;
/** Wait for `sandbox-proxy-ready`; on timeout the host retries once with a fresh guest. */
export const MCP_APP_PROXY_READY_TIMEOUT_MS = 30_000;
export const MCP_APP_PROXY_READY_RETRIES = 1;
