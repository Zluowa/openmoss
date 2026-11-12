// FILE: mcpAppSandbox.ts
// Purpose: Bounded, serializable contracts for the isolated MCP App desktop
// sandbox. Native MessagePort objects deliberately never cross this boundary.
// Layer: Shared contract

import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { McpAppResourceCsp } from "./mcpAppResource";

export const MCP_APP_SANDBOX_SCHEME = "moss-mcp-sandbox" as const;
/** The Moss proxy page every widget guest loads (`moss-mcp-sandbox://<label>/mcp_apps`). */
export const MCP_APP_SANDBOX_PATH = "/mcp_apps" as const;
export const MCP_APP_SANDBOX_PORT_NAME = "mcp-app-host" as const;
export const MCP_APP_SANDBOX_NAVIGATION_PORT_NAME = "mcp-app-navigation" as const;
export const MCP_APP_SANDBOX_PORT_NAMES = [
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
] as const;
export const MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE = "state" as const;
export const MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE = "navigate" as const;
/** Inner widget frame of the default (isolated, opaque-origin srcdoc) variant. */
export const MCP_APP_SANDBOX_INNER_SANDBOX = "allow-scripts allow-forms" as const;
/** Inner widget frame of the stable-origin variant (same origin as the proxy page). */
export const MCP_APP_SANDBOX_STABLE_INNER_SANDBOX =
  "allow-scripts allow-same-origin allow-forms" as const;
export const MCP_APP_SANDBOX_PROXY_READY_METHOD = "ui/notifications/sandbox-proxy-ready" as const;
export const MCP_APP_SANDBOX_RESOURCE_READY_METHOD =
  "ui/notifications/sandbox-resource-ready" as const;
/** Host-only streaming extension; the proxy turns it into `tool-input-partial`. */
export const MCP_APP_SANDBOX_TOOL_INPUT_DELTA_METHOD = "ui/notifications/tool-input-delta" as const;
export const MCP_APP_SANDBOX_TOOL_INPUT_PARTIAL_METHOD =
  "ui/notifications/tool-input-partial" as const;
export const MCP_APP_SANDBOX_TOOL_INPUT_METHOD = "ui/notifications/tool-input" as const;
/** Proxy -> widget print sidecar (`{type, phase: "before" | "after", theme?}`). */
export const MCP_APP_SANDBOX_PRINT_THEME_TYPE = "moss:print-theme" as const;
/**
 * Widget -> proxy -> host wheel sidecar (`{type, deltaX, deltaY}`, CSS pixels): wheel the
 * widget did not use, so the host scrolls the transcript the way an in-page frame would.
 */
export const MCP_APP_SANDBOX_WHEEL_TYPE = "moss:wheel" as const;
/** Largest wheel delta (per axis, per frame) the proxy and the host pass on. */
export const MCP_APP_SANDBOX_WHEEL_MAX_DELTA = 1_000 as const;
/**
 * What Moss records for a failed widget call that came with no error text of its own. Hosts
 * show it in the UI language; a message from the server or the agent CLI is shown as written.
 */
export const MCP_APP_DEFAULT_CALL_FAILED_MESSAGE = "The tool call failed." as const;
/** Marker of every shell -> host bridge envelope. */
export const MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE = "moss:mcp-app-message" as const;
export const MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL =
  "moss_desktop:mcp-app-sandbox-host-message" as const;
export const MCP_APP_SANDBOX_GUEST_INIT_TYPE = "init" as const;
export const MCP_APP_SANDBOX_ACK_TYPE = "moss_desktop:mcp-app-sandbox-ack" as const;

/**
 * Fixed origin of the sandbox's own assets (fonts). Every widget CSP lists it in
 * its resource directives, and every partition serves it.
 */
export const MCP_APP_SANDBOX_ASSET_ORIGIN = `${MCP_APP_SANDBOX_SCHEME}://assets` as const;
export const MCP_APP_SANDBOX_FONT_PATH = "/fonts/inter-latin.woff2" as const;
/** Inter (latin, variable 100-900) for `hostContext.styles.css.fonts`. */
export const MCP_APP_SANDBOX_FONT_URL =
  `${MCP_APP_SANDBOX_ASSET_ORIGIN}${MCP_APP_SANDBOX_FONT_PATH}` as const;
export const MCP_APP_SANDBOX_FONT_FACE_CSS = `@font-face { font-family: "Inter"; src: url("${MCP_APP_SANDBOX_FONT_URL}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`;

export const MCP_APP_SANDBOX_MAX_GENERATION = 1_000_000 as const;
export const MCP_APP_SANDBOX_MAX_DIMENSION = 16_384 as const;
export const MCP_APP_SANDBOX_MAX_CSP_CHARS = 64_000;
export const MCP_APP_SANDBOX_MAX_MESSAGE_BYTES = 512 * 1024;
export const MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS = 32;
/** Proxy flushes buffered host traffic to an isolated widget after this at the latest. */
export const MCP_APP_SANDBOX_READY_FLUSH_TIMEOUT_MS = 5_000 as const;
/** Wait for `sandbox-proxy-ready`, retried once with a fresh guest. */
export const MCP_APP_SANDBOX_PROXY_READY_TIMEOUT_MS = 30_000 as const;
export const MCP_APP_SANDBOX_PROXY_READY_RETRIES = 1 as const;
/** Wait for the widget's `initialized` (third-party servers get the extra slack). */
export const MCP_APP_SANDBOX_INIT_TIMEOUT_MS = 10_000;
export const MCP_APP_SANDBOX_INIT_TIMEOUT_SLACK_MS = 5_000 as const;
export const MCP_APP_SANDBOX_PENDING_TTL_MS = 30_000 as const;
export const MCP_APP_FRAME_DEFAULT_HEIGHT = 240 as const;
/** Inline widget heights are clamped to this; there is no lower clamp. */
export const MCP_APP_INLINE_MAX_HEIGHT = 5_000 as const;
/** `size-changed` heights at or below this are ignored while a remembered height is restored. */
export const MCP_APP_SIZE_EMPTY_THRESHOLD = 8 as const;
export const MCP_APP_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
export const MCP_APP_EXTERNAL_URL_SCHEMES = ["http:", "https:", "mailto:", "tel:", "sms:"] as const;
export const MCP_APP_SANDBOX_PERMISSION_KEYS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;
export type McpAppSandboxPermissionKey = (typeof MCP_APP_SANDBOX_PERMISSION_KEYS)[number];
/** A permission is requested/granted when its key is `true`. */
export type McpAppSandboxPermissions = {
  readonly [Key in McpAppSandboxPermissionKey]?: boolean | undefined;
};

const BoundedIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const BoundedDomain = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const BoundedUri = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).check(
  Schema.makeFilter(
    (value: string) =>
      !/[<>]/u.test(value) &&
      !/^(?:data|blob):/iu.test(value) &&
      !/(?:bearer\s+|authorization\s*[:=]|-----begin\s+private\s+key|(?:^|[\s_-])sk-[a-z0-9])/iu.test(
        value,
      ),
  ),
);
const BoundedGeneration = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(MCP_APP_SANDBOX_MAX_GENERATION),
);
const BoundedDimension = Schema.Number.check(Schema.isFinite())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(MCP_APP_SANDBOX_MAX_DIMENSION));
const BoundedHeightHint = Schema.Number.check(Schema.isFinite())
  .check(Schema.isGreaterThan(0))
  .check(Schema.isLessThanOrEqualTo(100_000));
const BoundedMinFrameHeight = Schema.Number.check(Schema.isFinite())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(100_000));
const BoundedTheme = Schema.Literals(["light", "dark"]);
const BoundedDimensions = Schema.Struct({
  height: BoundedDimension,
  width: BoundedDimension,
});

export type McpAppSandboxTheme = typeof BoundedTheme.Type;
export type McpAppSandboxDimensions = typeof BoundedDimensions.Type;

const BoundedPermissions = Schema.Struct({
  camera: Schema.optional(Schema.Boolean),
  clipboardWrite: Schema.optional(Schema.Boolean),
  geolocation: Schema.optional(Schema.Boolean),
  microphone: Schema.optional(Schema.Boolean),
});

/** The only fields the trusted renderer may ask main to register. */
export const McpAppSandboxRegisterInput = Schema.Struct({
  callId: BoundedIdentity,
  connectorId: Schema.optional(BoundedIdentity),
  /** Remote connector URL; only read when `stableOrigin` is true. */
  connectorUrl: Schema.optional(BoundedDomain),
  containerDimensions: BoundedDimensions,
  csp: McpAppResourceCsp,
  generation: BoundedGeneration,
  heightHint: Schema.optional(BoundedHeightHint),
  isCollapsible: Schema.Boolean,
  minFrameHeight: Schema.optional(BoundedMinFrameHeight),
  /** Resource-level `_meta.ui.permissions` the widget declared. */
  permissions: Schema.optional(BoundedPermissions),
  prefersBorder: Schema.Boolean,
  resourceUri: BoundedUri,
  server: BoundedIdentity,
  /** Origin key: connector id, `moss` for the gateway, the CLI server name. Defaults to `server`. */
  serverKey: Schema.optional(BoundedIdentity),
  /** The resource declared `_meta.ui.domain` and the server is a Moss connector with a URL. */
  stableOrigin: Schema.optional(Schema.Boolean),
  theme: BoundedTheme,
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  widgetDomain: Schema.optional(Schema.NullOr(BoundedDomain)),
});
export type McpAppSandboxRegisterInput = typeof McpAppSandboxRegisterInput.Type;

/** Main-owned authority returned to the trusted renderer. */
export const McpAppSandboxDescriptor = Schema.Struct({
  generation: BoundedGeneration,
  initId: BoundedIdentity,
  origin: Schema.String.check(Schema.isMaxLength(512)),
  partition: Schema.String.check(Schema.isMaxLength(255)),
  sandboxId: BoundedIdentity,
  src: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type McpAppSandboxDescriptor = typeof McpAppSandboxDescriptor.Type;

export const McpAppSandboxUnregisterInput = Schema.Struct({
  generation: BoundedGeneration,
  initId: BoundedIdentity,
  sandboxId: BoundedIdentity,
});
export type McpAppSandboxUnregisterInput = typeof McpAppSandboxUnregisterInput.Type;

/** Main -> trusted preload marker. Ports are transferred separately. */
export const McpAppSandboxHostPortEnvelope = Schema.Struct({
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  initId: BoundedIdentity,
  portNames: Schema.Array(BoundedIdentity),
  sandboxId: BoundedIdentity,
  type: Schema.Literal(MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL),
});
export type McpAppSandboxHostPortEnvelope = typeof McpAppSandboxHostPortEnvelope.Type;

/** Guest -> main init marker; raw named/reply ports are carried by transfer. */
export const McpAppSandboxGuestInitEnvelope = Schema.Struct({
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  initId: BoundedIdentity,
  portNames: Schema.Array(BoundedIdentity),
  type: Schema.Literal(MCP_APP_SANDBOX_GUEST_INIT_TYPE),
});
export type McpAppSandboxGuestInitEnvelope = typeof McpAppSandboxGuestInitEnvelope.Type;

export const McpAppSandboxNavigationState = Schema.Struct({
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  type: Schema.Literal(MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE),
});
export type McpAppSandboxNavigationState = typeof McpAppSandboxNavigationState.Type;

export const McpAppSandboxNavigationCommand = Schema.Struct({
  delta: Schema.Union([Schema.Literal(-1), Schema.Literal(1)]),
  type: Schema.Literal(MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE),
});
export type McpAppSandboxNavigationCommand = typeof McpAppSandboxNavigationCommand.Type;

const exactKeys = (
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Object.keys(value);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return (
    requiredKeys.every((key) => ownKeys.includes(key)) &&
    ownKeys.every((key) => allowedKeys.has(key))
  );
};

const decode = <A>(
  schema: Schema.Schema<A>,
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): A | null => {
  if (!exactKeys(value, requiredKeys, optionalKeys)) return null;
  try {
    return Schema.decodeUnknownSync(schema as never)(value) as A;
  } catch {
    return null;
  }
};

const cspKeys = [
  "baseUriDomains",
  "connectDomains",
  "frameDomains",
  "includeDefaultDomains",
  "isTrusted",
  "resourceDomains",
] as const;
const dimensionsKeys = ["height", "width"] as const;

function isNormalizedDomain(value: unknown, allowWebSocket: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return false;
  if (value !== value.trim() || /[\p{Cc}\s;,"']/u.test(value)) return false;
  if (value === "blob:" || value === "data:") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hostname === "") return false;
  if (parsed.protocol !== "https:" && !(allowWebSocket && parsed.protocol === "wss:")) {
    return false;
  }
  return (
    parsed.hostname === parsed.hostname.toLowerCase() &&
    (!parsed.hostname.includes("*") || parsed.hostname.startsWith("*."))
  );
}

function isWidgetDomain(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return false;
  if (value !== value.trim() || /[\p{Cc}\s;,"']/u.test(value)) return false;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.hostname.length > 0 &&
    !parsed.hostname.includes("*")
  );
}

function isNormalizedCsp(value: unknown): value is typeof McpAppResourceCsp.Type {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.includeDefaultDomains !== "boolean" ||
    typeof candidate.isTrusted !== "boolean"
  )
    return false;
  for (const [key, allowWebSocket] of [
    ["baseUriDomains", false],
    ["connectDomains", true],
    ["frameDomains", false],
    ["resourceDomains", false],
  ] as const) {
    const entries = candidate[key];
    if (!Array.isArray(entries) || entries.length > 32) return false;
    if (!entries.every((entry) => isNormalizedDomain(entry, allowWebSocket))) return false;
  }
  return true;
}

export function decodeMcpAppSandboxRegisterInput(
  value: unknown,
): McpAppSandboxRegisterInput | null {
  const requiredKeys = [
    "callId",
    "containerDimensions",
    "csp",
    "generation",
    "isCollapsible",
    "prefersBorder",
    "resourceUri",
    "server",
    "theme",
    "threadId",
  ] as const;
  const optionalKeys = [
    "connectorId",
    "connectorUrl",
    "heightHint",
    "minFrameHeight",
    "permissions",
    "serverKey",
    "stableOrigin",
    "widgetDomain",
  ] as const;
  if (!exactKeys(value, requiredKeys, optionalKeys)) return null;
  const candidate = { ...(value as Record<string, unknown>) };
  if (candidate.permissions !== undefined) {
    const permissions = normalizeMcpAppSandboxPermissions(candidate.permissions);
    if (!permissions) return null;
    candidate.permissions = permissions;
  }
  if (candidate.connectorUrl !== undefined && !isConnectorUrl(candidate.connectorUrl)) return null;
  if (!exactKeys(candidate.containerDimensions, dimensionsKeys)) return null;
  if (!exactKeys(candidate.csp, cspKeys)) return null;
  if (!isNormalizedCsp(candidate.csp)) return null;
  try {
    const encodedCsp = JSON.stringify(candidate.csp);
    if (
      encodedCsp === undefined ||
      new TextEncoder().encode(encodedCsp).byteLength > MCP_APP_SANDBOX_MAX_CSP_CHARS
    ) {
      return null;
    }
  } catch {
    return null;
  }
  if (
    candidate.widgetDomain !== undefined &&
    candidate.widgetDomain !== null &&
    !isWidgetDomain(candidate.widgetDomain)
  )
    return null;
  return decode(McpAppSandboxRegisterInput, candidate, requiredKeys, optionalKeys);
}

function isConnectorUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return false;
  if (value !== value.trim() || /[\p{Cc}\s]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Accepts the MCP Apps shape (`{camera: {}}`) and plain booleans; returns the
 * requested keys as `true`. Unknown keys or other values reject the whole map.
 */
export function normalizeMcpAppSandboxPermissions(value: unknown): McpAppSandboxPermissions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: Partial<Record<McpAppSandboxPermissionKey, boolean>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(MCP_APP_SANDBOX_PERMISSION_KEYS as readonly string[]).includes(key)) return null;
    if (entry === undefined || entry === null || entry === false) continue;
    if (entry === true || (typeof entry === "object" && !Array.isArray(entry))) {
      result[key as McpAppSandboxPermissionKey] = true;
      continue;
    }
    return null;
  }
  return result;
}

/**
 * Shell -> host message on the bridge port. Host -> shell traffic stays raw
 * JSON-RPC; only the upward direction carries the widget's user activation.
 */
export interface McpAppSandboxBridgeEnvelope {
  readonly type: typeof MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE;
  readonly message: Readonly<Record<string, unknown>>;
  /** True when the widget's message was sent with an active user activation. */
  readonly userActivation: boolean;
}

export function decodeMcpAppSandboxBridgeEnvelope(
  value: unknown,
): McpAppSandboxBridgeEnvelope | null {
  if (!exactKeys(value, ["message", "type", "userActivation"])) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE) return null;
  const message = candidate.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  if (typeof candidate.userActivation !== "boolean") return null;
  return {
    type: MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE,
    message: message as Readonly<Record<string, unknown>>,
    userActivation: candidate.userActivation,
  };
}

/** `saveDownload` input: exactly one of `text` or `base64`. */
export interface McpAppSandboxDownloadInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly text?: string;
  readonly base64?: string;
}

export interface McpAppSandboxDownloadPayload {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export function decodeMcpAppSandboxDownloadInput(
  value: unknown,
): McpAppSandboxDownloadPayload | null {
  if (!exactKeys(value, ["fileName", "mimeType"], ["text", "base64"])) return null;
  const { fileName, mimeType, text, base64 } = value as Record<string, unknown>;
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 1_000) return null;
  if (typeof mimeType !== "string" || mimeType.length > 255 || /[\r\n]/u.test(mimeType)) {
    return null;
  }
  if ((text === undefined) === (base64 === undefined)) return null;
  if (text !== undefined) {
    if (typeof text !== "string" || text.length > MCP_APP_DOWNLOAD_MAX_BYTES) return null;
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MCP_APP_DOWNLOAD_MAX_BYTES) return null;
    return { fileName, mimeType, bytes };
  }
  if (typeof base64 !== "string" || base64.length % 4 !== 0) return null;
  if (base64.length > Math.ceil(MCP_APP_DOWNLOAD_MAX_BYTES / 3) * 4) return null;
  if (!BASE64_PATTERN.test(base64)) return null;
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength > MCP_APP_DOWNLOAD_MAX_BYTES) return null;
  return { fileName, mimeType, bytes };
}

/** `window.desktopBridge.mcpApps` (trusted renderer only). */
export interface McpAppSandboxDesktopBridge {
  readonly register: (input: McpAppSandboxRegisterInput) => Promise<McpAppSandboxDescriptor | null>;
  readonly unregister: (input: McpAppSandboxUnregisterInput) => Promise<boolean>;
  /**
   * Grant exactly `permissions` (after the user approved them) to the widgets of
   * `sandboxId`. Only keys the registered resources declared are granted, and
   * none to a widget that declares frame sites. Returns what is now granted.
   */
  readonly requestPermissions: (
    sandboxId: string,
    permissions: McpAppSandboxPermissions,
  ) => Promise<{ readonly granted: McpAppSandboxPermissions }>;
  /** http, https, mailto, tel and sms only; opens with the system shell. */
  readonly openExternal: (url: string) => Promise<{ readonly opened: boolean }>;
  /** Save dialog (default folder Downloads), then writes the file. */
  readonly saveDownload: (
    input: McpAppSandboxDownloadInput,
  ) => Promise<{ readonly saved: boolean }>;
}

export function decodeMcpAppSandboxDescriptor(value: unknown): McpAppSandboxDescriptor | null {
  return decode(McpAppSandboxDescriptor, value, [
    "generation",
    "initId",
    "origin",
    "partition",
    "sandboxId",
    "src",
  ]);
}

export function decodeMcpAppSandboxUnregisterInput(
  value: unknown,
): McpAppSandboxUnregisterInput | null {
  return decode(McpAppSandboxUnregisterInput, value, ["generation", "initId", "sandboxId"]);
}

export function decodeMcpAppSandboxHostPortEnvelope(
  value: unknown,
): McpAppSandboxHostPortEnvelope | null {
  if (!hasExactRawPortNames(value)) return null;
  const decoded = decode(McpAppSandboxHostPortEnvelope, value, [
    "origin",
    "initId",
    "portNames",
    "sandboxId",
    "type",
  ]);
  return decoded && exactPortNames(decoded.portNames) ? decoded : null;
}

export function decodeMcpAppSandboxGuestInitEnvelope(
  value: unknown,
): McpAppSandboxGuestInitEnvelope | null {
  if (!hasExactRawPortNames(value)) return null;
  const decoded = decode(McpAppSandboxGuestInitEnvelope, value, [
    "origin",
    "initId",
    "portNames",
    "type",
  ]);
  return decoded && exactPortNames(decoded.portNames) ? decoded : null;
}

export function decodeMcpAppSandboxNavigationState(
  value: unknown,
): McpAppSandboxNavigationState | null {
  return decode(McpAppSandboxNavigationState, value, ["canGoBack", "canGoForward", "type"]);
}

export function decodeMcpAppSandboxNavigationCommand(
  value: unknown,
): McpAppSandboxNavigationCommand | null {
  return decode(McpAppSandboxNavigationCommand, value, ["delta", "type"]);
}

function exactPortNames(value: readonly string[]): boolean {
  return (
    value.length === MCP_APP_SANDBOX_PORT_NAMES.length &&
    value.every((name, index) => name === MCP_APP_SANDBOX_PORT_NAMES[index])
  );
}

function hasExactRawPortNames(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const portNames = (value as { readonly portNames?: unknown }).portNames;
  return (
    Array.isArray(portNames) &&
    portNames.length === MCP_APP_SANDBOX_PORT_NAMES.length &&
    portNames.every((name, index) => name === MCP_APP_SANDBOX_PORT_NAMES[index])
  );
}

/**
 * Inline frame height: the widget's own height (or the hint before it reports
 * one), at least `minFrameHeight`, rounded up and clamped to 5 000 px. There is
 * no lower clamp beyond that.
 */
export function resolveMcpAppFrameHeight(input: {
  readonly intrinsicHeight: number | null;
  readonly heightHint?: number;
  readonly minFrameHeight?: number;
}): number {
  const intrinsic = input.intrinsicHeight;
  const heightHint = input.heightHint;
  const minFrameHeight = input.minFrameHeight;
  if (
    (intrinsic !== null && !Number.isFinite(intrinsic)) ||
    (heightHint !== undefined && !Number.isFinite(heightHint)) ||
    (minFrameHeight !== undefined && !Number.isFinite(minFrameHeight))
  )
    return MCP_APP_FRAME_DEFAULT_HEIGHT;
  if (intrinsic !== null && intrinsic < 0) return MCP_APP_FRAME_DEFAULT_HEIGHT;
  if (heightHint !== undefined && heightHint <= 0) return MCP_APP_FRAME_DEFAULT_HEIGHT;
  if (minFrameHeight !== undefined && minFrameHeight < 0) return MCP_APP_FRAME_DEFAULT_HEIGHT;
  const height = Math.max(
    intrinsic === null
      ? (heightHint ?? MCP_APP_FRAME_DEFAULT_HEIGHT)
      : Math.max(intrinsic, heightHint ?? 0),
    minFrameHeight ?? 0,
  );
  return Math.min(Math.ceil(height), MCP_APP_INLINE_MAX_HEIGHT);
}

export const MCP_APP_SANDBOX_CSP_KEYS = cspKeys;
