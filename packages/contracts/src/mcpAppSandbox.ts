// FILE: mcpAppSandbox.ts
// Purpose: Bounded, serializable contracts for the isolated MCP App desktop
// sandbox. Native MessagePort objects deliberately never cross this boundary.
// Layer: Shared contract

import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { McpAppResourceCsp } from "./mcpAppResource";

export const MCP_APP_SANDBOX_SCHEME = "moss-mcp-sandbox" as const;
export const MCP_APP_SANDBOX_PATH = "/ui" as const;
export const MCP_APP_SANDBOX_CONTENT_PATH = "/content" as const;
export const MCP_APP_SANDBOX_PORT_NAME = "mcp-app-host" as const;
export const MCP_APP_SANDBOX_NAVIGATION_PORT_NAME = "mcp-app-navigation" as const;
export const MCP_APP_SANDBOX_PORT_NAMES = [
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
] as const;
export const MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE = "state" as const;
export const MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE = "navigate" as const;
export const MCP_APP_SANDBOX_CONTENT_READY_TYPE = "moss_desktop:mcp-app-content-ready" as const;
export const MCP_APP_SANDBOX_CONTENT_INSTALL_TYPE = "moss_desktop:mcp-app-content-install" as const;
export const MCP_APP_SANDBOX_INNER_SANDBOX = "allow-scripts allow-same-origin allow-forms" as const;
export const MCP_APP_SANDBOX_PROXY_READY_METHOD = "ui/notifications/sandbox-proxy-ready" as const;
export const MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL =
  "moss_desktop:mcp-app-sandbox-host-message" as const;
export const MCP_APP_SANDBOX_GUEST_INIT_TYPE = "init" as const;
export const MCP_APP_SANDBOX_ACK_TYPE = "moss_desktop:mcp-app-sandbox-ack" as const;

export const MCP_APP_SANDBOX_MAX_GENERATION = 1_000_000 as const;
export const MCP_APP_SANDBOX_MAX_DIMENSION = 16_384 as const;
export const MCP_APP_SANDBOX_MAX_CSP_CHARS = 64_000;
export const MCP_APP_SANDBOX_MAX_MESSAGE_BYTES = 512 * 1024;
export const MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS = 32;
export const MCP_APP_SANDBOX_INIT_TIMEOUT_MS = 15_000;
export const MCP_APP_SANDBOX_PENDING_TTL_MS = 30_000 as const;
export const MCP_APP_FRAME_DEFAULT_HEIGHT = 240 as const;
export const MCP_APP_FRAME_MIN_HEIGHT = 200 as const;
export const MCP_APP_FRAME_MAX_HEIGHT = 720 as const;

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

/** The only fields the trusted renderer may ask main to register. */
export const McpAppSandboxRegisterInput = Schema.Struct({
  callId: BoundedIdentity,
  connectorId: Schema.optional(BoundedIdentity),
  containerDimensions: BoundedDimensions,
  csp: McpAppResourceCsp,
  generation: BoundedGeneration,
  heightHint: Schema.optional(BoundedHeightHint),
  isCollapsible: Schema.Boolean,
  minFrameHeight: Schema.optional(BoundedMinFrameHeight),
  prefersBorder: Schema.Boolean,
  resourceUri: BoundedUri,
  server: BoundedIdentity,
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
  const optionalKeys = ["connectorId", "heightHint", "minFrameHeight", "widgetDomain"] as const;
  if (!exactKeys(value, requiredKeys, optionalKeys)) return null;
  const candidate = value as Record<string, unknown>;
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
  return decode(McpAppSandboxRegisterInput, value, requiredKeys, optionalKeys);
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

/** Frozen Codex calculation, with non-finite values rejected by the caller. */
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
  return Math.min(
    Math.max(
      intrinsic === null
        ? (heightHint ?? MCP_APP_FRAME_DEFAULT_HEIGHT)
        : Math.max(intrinsic, heightHint ?? 0),
      minFrameHeight ?? MCP_APP_FRAME_MIN_HEIGHT,
    ),
    MCP_APP_FRAME_MAX_HEIGHT,
  );
}

export const MCP_APP_SANDBOX_CSP_KEYS = cspKeys;
