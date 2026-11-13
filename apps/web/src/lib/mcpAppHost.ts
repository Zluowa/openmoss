// FILE: mcpAppHost.ts
// Purpose: Moss's interactive-connector host (SPEC §5). One controller per widget: it reads the
//          resource through the Moss server, registers the desktop sandbox, speaks the widget
//          protocol over a bounded MessagePort, answers every widget request, and lays the one
//          live frame over its transcript row or the side panel. Outside the desktop app it
//          reports `browser_unavailable` and the row shows the plain result instead.
// Layer: Web MCP App host
// Exports: McpAppHostController, BoundedMessagePortTransport, mapMossMcpResultToCallToolResult,
//          normalizeMcpToolArguments, requestMcpAppTeardown, McpAppHostSnapshot, McpAppHostPrompt

import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiHostStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_MAX_DIMENSION,
  MCP_APP_SANDBOX_MAX_MESSAGE_BYTES,
  MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS,
  MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxHostPortEnvelope,
  decodeMcpAppSandboxNavigationState,
  ThreadId,
  type McpAppSandboxDescriptor,
} from "@moss/contracts";

import { APP_VERSION } from "~/branding";
import type { McpAppDisplayMode } from "./mcpAppDockRegistry";
import {
  MCP_APP_INITIALIZE_TIMEOUT_MS,
  MCP_APP_PROXY_READY_RETRIES,
  MCP_APP_PROXY_READY_TIMEOUT_MS,
  MCP_APP_TOOL_RESULT_POLL_MS,
  MCP_APP_USER_ACTIVATION_WINDOW_MS,
} from "./mcpApps/constants";
import {
  decodeMcpAppSandboxBridgeEnvelope,
  readMcpAppDesktopBridge,
  type McpAppBinding,
  type McpAppDesktopBridge,
  type McpAppNeedsApproval,
  type McpAppPermissionName,
  type McpAppPermissions,
  type McpAppResourceRead,
  type McpAppSandboxPermissions,
  type McpAppToolResultResponse,
} from "./mcpApps/contracts";
import { McpAppFrameTracker } from "./mcpApps/frameTracker";
import { mcpAppResourceCacheKey, readMcpAppResourceOnce } from "./mcpApps/resourceCache";
import {
  chainMcpAppWheel,
  decodeMcpAppWheelMessage,
  type McpAppWheelDelta,
} from "./mcpApps/wheelChain";
import { MCP_APP_WEBVIEW_DISPLAY, styleMcpAppWebview } from "./mcpApps/webviewStyle";
import {
  buildMcpAppHostContext,
  MCP_APP_HOST_INFO_NAME,
  McpAppHostContextChannel,
} from "./mcpApps/hostContext";
import type { McpAppLinkPlan } from "./mcpApps/openLink";
import {
  isMcpAppLinkTrusted,
  readMcpAppPermissionDecision,
  trustMcpAppLink,
  writeMcpAppPermissionDecision,
} from "./mcpApps/preferences";
import {
  createMcpAppRequestHandlers,
  validateMcpAppCallToolResult,
  type McpAppDownloadItem,
  type McpAppRequestHandlerDeps,
} from "./mcpApps/requestHandlers";
import {
  callMcpAppRpc,
  downloadMcpAppResource,
  fetchMcpAppToolResult,
  postMcpAppModelContext,
  readMcpAppResource,
} from "./mcpApps/serverApi";
import {
  mcpAppHeightKey,
  readRememberedMcpAppHeight,
  createMcpAppFirstSizeSettler,
  rememberMcpAppHeight,
  resolveMcpAppReportedHeight,
} from "./mcpApps/sizing";
import type { WorkLogMcpToolResult } from "./toolCallDetails";

const MAX_ARGUMENT_KEYS = 64;
const MAX_JSON_CHARS = 4_000;
const MAX_MESSAGE_BYTES = MCP_APP_SANDBOX_MAX_MESSAGE_BYTES;
const MAX_RESOURCE_MESSAGE_BYTES = MCP_APP_RESOURCE_MAX_HTML_BYTES + 4_096;
const SANDBOX_RESOURCE_READY_METHOD = "ui/notifications/sandbox-resource-ready";
const MCP_APP_TEARDOWN_TIMEOUT_MS = 1_000;
const MCP_APP_PORTAL_TARGET_SELECTOR = '[data-mcp-app-portal-target="true"]';
/** Polls of `/tool-result` still answering "pending" after the call ended, before falling back. */
const MCP_APP_PENDING_AFTER_END_POLLS = 3;
const PERMISSION_NAMES: readonly McpAppPermissionName[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
];

export type McpAppHostPhase = "idle" | "loading" | "ready" | "failed" | "browser_unavailable";

export type McpAppHostPrompt =
  | {
      readonly kind: "approval";
      readonly toolName: string;
      readonly serverLabel: string;
      readonly reason?: string | undefined;
    }
  | { readonly kind: "permission"; readonly permissions: readonly McpAppPermissionName[] }
  | { readonly kind: "sign_in" };

export type McpAppHostDialog =
  | { readonly kind: "open_link"; readonly plan: Extract<McpAppLinkPlan, { action: "confirm" }> }
  | { readonly kind: "download"; readonly items: readonly McpAppDownloadItem[] };

export interface McpAppHostSnapshot {
  readonly phase: McpAppHostPhase;
  /** Row height: the widget's reported height, or a remembered one while it boots. */
  readonly height: number;
  /** True once the widget reported its own size in this generation. */
  readonly sized: boolean;
  readonly displayMode: McpAppDisplayMode;
  readonly generation: number;
  /** False only when the resource declared `prefersBorder: false`. */
  readonly prefersBorder: boolean;
  /** The app declared display modes without "fullscreen". */
  readonly fullscreenDeclined: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly prompt: McpAppHostPrompt | null;
  readonly dialog: McpAppHostDialog | null;
}

export interface McpAppHostIdentity {
  readonly threadId: string;
  readonly callId: string;
  readonly resourceUri: string;
  /** Renderer-only lifecycle identity; never serialized or exposed to the guest. */
  readonly lifecycleKey?: string;
}

export interface McpAppHostApi {
  readonly readResource: typeof readMcpAppResource;
  readonly toolResult: typeof fetchMcpAppToolResult;
  readonly rpc: typeof callMcpAppRpc;
  readonly modelContext: typeof postMcpAppModelContext;
  readonly resourceDownload: typeof downloadMcpAppResource;
}

export interface McpAppHostOptions {
  readonly projection: WorkLogMcpToolResult;
  readonly binding: McpAppBinding;
  readonly identity: McpAppHostIdentity;
  readonly theme: "light" | "dark";
  readonly locale: string;
  readonly styles: McpUiHostStyles;
  readonly paneAvailable?: () => boolean;
  readonly onRequestDisplayMode?: (
    mode: McpAppDisplayMode,
  ) => Promise<McpAppDisplayMode> | McpAppDisplayMode;
  readonly message: McpAppRequestHandlerDeps["message"];
  readonly openInApp?: (path: string) => void;
  readonly api?: Partial<McpAppHostApi>;
  readonly desktop?: McpAppDesktopBridge | null;
  readonly log?: (...parts: unknown[]) => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedJson(value: unknown): unknown | undefined {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_JSON_CHARS) {
      return undefined;
    }
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The durable projection as a standard CallToolResult — the fallback when the server has no
 * full result. Null while the call still runs: nothing is sent to a widget before it ends.
 */
export function mapMossMcpResultToCallToolResult(
  projection: WorkLogMcpToolResult,
): CallToolResult | null {
  if (projection.status === "inProgress") return null;
  const content: CallToolResult["content"] = [];
  for (const block of projection.result?.content ?? []) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "resource_link" && typeof block.name === "string" && block.name.length > 0) {
      content.push({
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        ...(block.title ? { title: block.title } : {}),
        ...(block.description ? { description: block.description } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {}),
      });
      continue;
    }
    if (block.type === "embedded_resource" && block.uri && typeof block.text === "string") {
      content.push({
        type: "resource",
        resource: {
          uri: block.uri,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          text: block.text,
        },
      });
    }
  }
  if (projection.status === "failed" || projection.error) {
    const message = projection.error?.message;
    return {
      content: content.length > 0 ? content : message ? [{ type: "text", text: message }] : [],
      isError: true,
    };
  }
  const structuredContentValue = boundedJson(projection.result?.structuredContent);
  return {
    content,
    ...(isPlainRecord(structuredContentValue) ? { structuredContent: structuredContentValue } : {}),
  };
}

export function normalizeMcpToolArguments(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_ARGUMENT_KEYS) return null;
  const normalized = boundedJson(value);
  return isPlainRecord(normalized) ? normalized : null;
}

export async function requestMcpAppTeardown(
  bridge: Pick<AppBridge, "teardownResource">,
  timeoutMs = MCP_APP_TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  let teardown: Promise<unknown>;
  try {
    teardown = Promise.resolve(bridge.teardownResource({}));
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([teardown.catch(() => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function boundedMessage(value: unknown, allowResourceReady = false): value is JSONRPCMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.method === SANDBOX_RESOURCE_READY_METHOD) {
      const params = candidate.params;
      if (
        !allowResourceReady ||
        !hasExactKeys(candidate, ["jsonrpc", "method", "params"], ["jsonrpc"]) ||
        (candidate.jsonrpc !== undefined && candidate.jsonrpc !== "2.0") ||
        !hasExactKeys(params, ["html"], ["permissions"]) ||
        typeof params.html !== "string" ||
        (params.permissions !== undefined && !isPlainRecord(params.permissions))
      ) {
        return false;
      }
      const encoded = JSON.stringify(value);
      return (
        new TextEncoder().encode(params.html).byteLength <= MCP_APP_RESOURCE_MAX_HTML_BYTES &&
        encoded !== undefined &&
        new TextEncoder().encode(encoded).byteLength <= MAX_RESOURCE_MESSAGE_BYTES
      );
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_MESSAGE_BYTES)
      return false;
  } catch {
    return false;
  }
  return JSONRPCMessageSchema.safeParse(value).success;
}

type RequestKey = string;

function requestKey(id: string | number): RequestKey {
  return `${typeof id}:${String(id)}`;
}

/** A bounded raw MessagePort transport; unlike the public debug transport it logs no payload. */
export class BoundedMessagePortTransport implements Transport {
  private closed = false;
  private started = false;
  private readonly inboundRequests = new Set<string>();
  private readonly outboundRequests = new Set<string>();
  private readonly activatedRequests = new Set<string>();
  private lastActivationAt = -Infinity;
  private readonly listener: (event: MessageEvent) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Sees every accepted inbound request method before the protocol handles it. */
  oninboundrequest?: (method: string) => void;
  /** Wheel the widget did not use (the proxy's `moss:wheel`); never reaches the protocol. */
  onwheel?: (delta: McpAppWheelDelta) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(
    private readonly port: MessagePort,
    private readonly now: () => number = Date.now,
  ) {
    this.listener = (event) => {
      if (this.closed) return;
      // Every shell -> host message arrives in B's envelope; anything else fails closed.
      const envelope = decodeMcpAppSandboxBridgeEnvelope(event.data);
      const wheel =
        envelope && !envelope.userActivation && !event.ports?.length
          ? decodeMcpAppWheelMessage(envelope.message)
          : null;
      if (wheel) {
        this.onwheel?.(wheel);
        return;
      }
      const data: unknown = envelope?.message;
      const userActivation = envelope?.userActivation === true;
      if (!envelope || !boundedMessage(data)) {
        for (const port of event.ports ?? []) port.close();
        this.failClosed(new Error("MCP App bridge message was invalid."));
        return;
      }
      if (event.ports?.length) {
        for (const port of event.ports) port.close();
        this.failClosed(new Error("MCP App bridge transfer was invalid."));
        return;
      }
      const message = data as JSONRPCMessage & {
        readonly id?: string | number | null;
        readonly method?: string;
      };
      if (userActivation) this.lastActivationAt = this.now();
      if (message.id !== undefined && message.id !== null) {
        const key = requestKey(message.id);
        if (typeof message.method === "string") {
          if (this.inboundRequests.has(key) || this.outboundRequests.has(key)) {
            this.failClosed(new Error("MCP App bridge request id was duplicated."));
            return;
          }
          if (
            this.inboundRequests.size + this.outboundRequests.size >=
            MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS
          ) {
            this.failClosed(new Error("MCP App bridge has too many outstanding requests."));
            return;
          }
          this.inboundRequests.add(key);
          if (userActivation) this.activatedRequests.add(key);
        } else if (this.outboundRequests.delete(key)) {
          // The response completed a host-originated request.
        } else {
          this.failClosed(new Error("MCP App bridge response id was unexpected."));
          return;
        }
      }
      if (typeof message.method === "string") this.oninboundrequest?.(message.method);
      this.onmessage?.(data);
    };
  }

  /**
   * True when the request carried a live user activation, or one arrived just before it
   * (within 250 ms) — the rule for fullscreen, auto-send and trusted links.
   */
  hadUserActivation(id: string | number | undefined): boolean {
    if (id !== undefined && this.activatedRequests.has(requestKey(id))) return true;
    return this.now() - this.lastActivationAt <= MCP_APP_USER_ACTIVATION_WINDOW_MS;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("MCP App bridge is closed.");
    if (this.started) return;
    this.started = true;
    this.port.addEventListener("message", this.listener);
    this.port.start();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || !boundedMessage(message, true))
      throw new Error("MCP App bridge message rejected.");
    const request = message as JSONRPCMessage & {
      readonly id?: string | number | null;
      readonly method?: string;
    };
    const key = request.id !== undefined && request.id !== null ? requestKey(request.id) : null;
    const isRequest = key !== null && typeof request.method === "string";
    const isResponse = key !== null && typeof request.method !== "string";
    if (isRequest) {
      if (this.inboundRequests.has(key) || this.outboundRequests.has(key)) {
        throw new Error("MCP App bridge request id was duplicated.");
      }
      if (
        this.inboundRequests.size + this.outboundRequests.size >=
        MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS
      ) {
        throw new Error("MCP App bridge has too many outstanding requests.");
      }
      this.outboundRequests.add(key);
    } else if (isResponse) {
      if (!this.inboundRequests.delete(key)) {
        throw new Error("MCP App bridge response id was unexpected.");
      }
      this.activatedRequests.delete(key);
    }
    try {
      this.port.postMessage(message);
    } catch {
      if (isRequest) this.outboundRequests.delete(key);
      this.onerror?.(new Error("MCP App bridge transport failed."));
      throw new Error("MCP App bridge transport failed.");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.inboundRequests.clear();
    this.outboundRequests.clear();
    this.activatedRequests.clear();
    this.port.removeEventListener("message", this.listener);
    this.port.close();
    this.onclose?.();
  }

  private failClosed(error: Error): void {
    if (this.closed) return;
    this.onerror?.(error);
    void this.close().catch(() => undefined);
  }
}

/** AppBridge whose host-context notifications go out only through the context channel. */
class MossAppBridge extends AppBridge {
  contextSendOpen = false;

  override sendHostContextChange(
    params: Parameters<AppBridge["sendHostContextChange"]>[0],
  ): Promise<void> | void {
    if (!this.contextSendOpen) return;
    return super.sendHostContextChange(params);
  }
}

/** Only one link or download dialog is open across all widgets. */
let activeDialogOwner: McpAppHostController | null = null;

function resolveMcpAppPortalTarget(container: HTMLElement): HTMLElement | null {
  return (
    container.closest<HTMLElement>(MCP_APP_PORTAL_TARGET_SELECTOR) ??
    document.querySelector<HTMLElement>(MCP_APP_PORTAL_TARGET_SELECTOR) ??
    null
  );
}

function boundedDimension(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), 0), MCP_APP_SANDBOX_MAX_DIMENSION)
    : 0;
}

function isMcpAppMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(max-width: 767px)").matches;
  }
  return window.innerWidth <= 767;
}

function fullscreenFrameZIndex(): string {
  // Moss's shared mobile SheetViewport owns z-index 50. Keep the desktop stack at 43 and lift
  // only the docked App surface above that mobile layer.
  return isMcpAppMobileViewport() ? "51" : "43";
}

function webviewElement(): HTMLElement {
  return document.createElement("webview");
}

function grantedList(permissions: McpAppPermissions): McpAppPermissionName[] {
  return PERMISSION_NAMES.filter((name) => permissions[name] !== undefined);
}

function sandboxPermissionsOf(names: readonly McpAppPermissionName[]): McpAppSandboxPermissions {
  const result: McpAppSandboxPermissions = {};
  for (const name of names) result[name] = true;
  return result;
}

function grantedNames(granted: McpAppSandboxPermissions | undefined): McpAppPermissionName[] {
  return PERMISSION_NAMES.filter((name) => granted?.[name] === true);
}

function permissionsOf(names: readonly McpAppPermissionName[]): McpAppPermissions {
  const result: McpAppPermissions = {};
  for (const name of names) result[name] = {};
  return result;
}

function toolDefinition(binding: McpAppBinding): Tool {
  return {
    name: binding.toolName,
    ...(binding.toolTitle ? { title: binding.toolTitle } : {}),
    inputSchema: { type: "object" },
    _meta: {
      ui: {
        resourceUri: binding.resourceUri,
        ...(binding.visibility.length > 0 ? { visibility: [...binding.visibility] } : {}),
      },
    },
  };
}

/** `null`: the widget went away before the person answered; nothing is remembered. */
type PromptAnswer = boolean | null;

export class McpAppHostController {
  private snapshot: McpAppHostSnapshot;
  private readonly listeners = new Set<() => void>();
  private abortController: AbortController | null = null;
  private descriptor: McpAppSandboxDescriptor | null = null;
  private bridge: MossAppBridge | null = null;
  private transport: BoundedMessagePortTransport | null = null;
  private contextChannel: McpAppHostContextChannel | null = null;
  private webview: HTMLElement | null = null;
  private frameWrapper: HTMLDivElement | null = null;
  private navigationPortalTarget: HTMLDivElement | null = null;
  private portalTarget: HTMLElement | null = null;
  private geometryTarget: HTMLElement | null = null;
  private tracker: McpAppFrameTracker | null = null;
  /** The transcript slot the frame returns to; it changes when the row remounts. */
  private inlineContainer: HTMLElement | null = null;
  private cleanupBridge: (() => void) | null = null;
  private currentContainer: HTMLElement | null = null;
  private replyPort: MessagePort | null = null;
  private navigationPort: MessagePort | null = null;
  private navigationPortListener: ((event: MessageEvent) => void) | null = null;
  private toolResultTimer: ReturnType<typeof setTimeout> | null = null;
  private proxyReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private initializeTimer: ReturnType<typeof setTimeout> | null = null;
  private proxyReadyRetriesLeft: number = MCP_APP_PROXY_READY_RETRIES;
  private resourceSent = false;
  private generation = 0;
  private running = false;
  private initialized = false;
  private inputSent = false;
  private resultSent = false;
  private deliveringToolData = false;
  /** `/tool-result` answers "pending" after the call already ended (bounded, then fallback). */
  private pendingAfterEnd = 0;
  private frameVisible = true;
  private projection: WorkLogMcpToolResult;
  private theme: "light" | "dark";
  private locale: string;
  private styles: McpUiHostStyles;
  private readonly heightKey: string;
  private readonly promptQueue: Array<{
    prompt: McpAppHostPrompt;
    resolve: (answer: PromptAnswer) => void;
  }> = [];
  private dialogResolver: ((answer: { dontAskAgain: boolean } | boolean | null) => void) | null =
    null;
  private readonly api: McpAppHostApi;

  constructor(private readonly options: McpAppHostOptions) {
    this.projection = options.projection;
    this.theme = options.theme;
    this.locale = options.locale;
    this.styles = options.styles;
    this.heightKey = mcpAppHeightKey(options.identity.threadId, options.identity.callId);
    this.api = {
      readResource: options.api?.readResource ?? readMcpAppResource,
      toolResult: options.api?.toolResult ?? fetchMcpAppToolResult,
      rpc: options.api?.rpc ?? callMcpAppRpc,
      modelContext: options.api?.modelContext ?? postMcpAppModelContext,
      resourceDownload: options.api?.resourceDownload ?? downloadMcpAppResource,
    };
    this.snapshot = {
      phase: "idle",
      height: readRememberedMcpAppHeight(this.heightKey) ?? 0,
      sized: false,
      displayMode: "inline",
      generation: 0,
      prefersBorder: true,
      fullscreenDeclined: false,
      canGoBack: false,
      canGoForward: false,
      prompt: null,
      dialog: null,
    };
  }

  // ── public state ──

  getSnapshot(): McpAppHostSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNavigationPortalTarget(): HTMLElement | null {
    return this.navigationPortalTarget;
  }

  updateProjection(projection: WorkLogMcpToolResult): void {
    if (projection.callId !== this.options.identity.callId || projection === this.projection)
      return;
    this.projection = projection;
    // A failed call shows its plain result, whatever the server stored (SPEC §3).
    if (projection.status === "failed") {
      if (this.snapshot.phase !== "failed" && this.snapshot.phase !== "browser_unavailable") {
        void this.fail();
      }
      return;
    }
    if (this.running && this.initialized) void this.deliverToolData(this.generation);
    else this.armInitializeTimeout(this.generation);
  }

  /**
   * Third-party widgets must say `initialized` within 10 s + 5 s once the resource is sent and
   * the tool result is in; Moss's own widgets are never timed out.
   */
  private armInitializeTimeout(generation: number): void {
    if (
      this.initializeTimer !== null ||
      this.initialized ||
      !this.resourceSent ||
      this.options.binding.isFirstParty ||
      this.projection.status === "inProgress" ||
      generation !== this.generation
    ) {
      return;
    }
    this.initializeTimer = setTimeout(() => {
      this.initializeTimer = null;
      if (!this.initialized && generation === this.generation) void this.fail();
    }, MCP_APP_INITIALIZE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.initializeTimer !== null) clearTimeout(this.initializeTimer);
    this.initializeTimer = null;
    if (this.proxyReadyTimer !== null) clearTimeout(this.proxyReadyTimer);
    this.proxyReadyTimer = null;
  }

  updateTheme(theme: "light" | "dark"): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.updateContext({ theme });
  }

  updateLocale(locale: string): void {
    if (this.locale === locale) return;
    this.locale = locale;
    this.updateContext({ locale });
  }

  updateStyles(styles: McpUiHostStyles): void {
    if (JSON.stringify(styles) === JSON.stringify(this.styles)) return;
    this.styles = styles;
    this.updateContext({ styles });
  }

  /** Answer the inline prompt shown for this widget (approval, permission, sign-in). */
  respondPrompt(answer: boolean): void {
    const head = this.promptQueue.shift();
    head?.resolve(answer);
    this.setSnapshot({ prompt: this.promptQueue[0]?.prompt ?? null });
  }

  /** Answer the open-link or download dialog. */
  respondDialog(answer: { dontAskAgain: boolean } | boolean | null): void {
    const resolve = this.dialogResolver;
    this.dialogResolver = null;
    if (activeDialogOwner === this) activeDialogOwner = null;
    this.setSnapshot({ dialog: null });
    resolve?.(answer);
  }

  /** Traverse only the live inner App document after checking its current state. */
  navigate(delta: -1 | 1): void {
    const port = this.navigationPort;
    if (!port || !this.running) return;
    const permitted = delta === -1 ? this.snapshot.canGoBack : this.snapshot.canGoForward;
    if (!permitted) return;
    try {
      port.postMessage({ type: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE, delta });
    } catch {
      void this.fail();
    }
  }

  setFrameVisibility(visible: boolean): void {
    this.frameVisible = visible;
    if (this.tracker) {
      this.tracker.setVisible(visible);
      return;
    }
    const wrapper = this.frameWrapper;
    if (!wrapper) return;
    wrapper.style.visibility = visible ? "visible" : "hidden";
    wrapper.style.pointerEvents = visible ? "auto" : "none";
    wrapper.style.display = visible ? "block" : "none";
  }

  /** The slot this widget's row currently renders; the frame follows it while inline. */
  getInlineContainer(): HTMLElement | null {
    return this.inlineContainer;
  }

  /**
   * A (re)mounted row hands its slot over. Starts the widget the first time; afterwards the
   * live frame just moves to the new slot (rows remount when a turn folds or the list
   * virtualises), so the widget keeps its state.
   */
  attachInline(container: HTMLElement): void {
    this.inlineContainer = container;
    this.currentContainer = container;
    if (this.snapshot.phase === "idle") {
      void this.start(container).catch(() => undefined);
      return;
    }
    if (this.snapshot.displayMode !== "inline") return;
    if (this.running) {
      this.layoutFrameTo(container, "inline");
      return;
    }
    // Still starting (the row remounted before `initialized`): the parked frame follows the new
    // slot too. Left on the old, detached slot it is hidden with display:none, the guest stops
    // being laid out, and the widget never finishes starting (the 15 s timeout then fails it).
    this.tracker?.follow(container, "inline");
  }

  /** The row unmounted; keep the widget but hide its frame until a slot comes back. */
  detachInline(container: HTMLElement): void {
    if (this.inlineContainer !== container) return;
    this.inlineContainer = null;
    if (this.snapshot.displayMode === "inline") this.tracker?.setVisible(false);
  }

  /**
   * Lay the one live frame over a transcript or side-panel target. The wrapper stays in the
   * stable portal target for its whole generation; moving a webview would destroy its guest.
   */
  layoutFrameTo(container: HTMLElement, displayMode: McpAppDisplayMode): boolean {
    if (!this.frameWrapper || !this.tracker || !this.bridge || !this.running) return false;
    this.geometryTarget = container;
    if (!this.tracker.follow(container, displayMode)) return false;
    this.tracker.setVisible(this.frameVisible);
    this.setSnapshot({ displayMode });
    return true;
  }

  // ── lifecycle ──

  async start(container: HTMLElement): Promise<void> {
    this.proxyReadyRetriesLeft = MCP_APP_PROXY_READY_RETRIES;
    await this.run(container);
  }

  private async run(container: HTMLElement): Promise<void> {
    await this.teardown();
    this.inlineContainer = container;
    this.frameVisible = true;
    this.currentContainer = container;
    this.geometryTarget = container;
    const binding = this.options.binding;
    const desktop =
      this.options.desktop === undefined ? readMcpAppDesktopBridge() : this.options.desktop;
    if (!desktop) {
      this.setSnapshot({ phase: "browser_unavailable" });
      return;
    }
    if (this.projection.status === "failed") {
      this.setSnapshot({ phase: "failed" });
      return;
    }
    this.portalTarget = resolveMcpAppPortalTarget(container);
    if (!this.portalTarget || binding.resourceUri !== this.options.identity.resourceUri) {
      this.setSnapshot({ phase: "failed" });
      return;
    }
    const generation = this.generation;
    const remembered = readRememberedMcpAppHeight(this.heightKey);
    this.inputSent = false;
    this.resultSent = false;
    this.pendingAfterEnd = 0;
    this.initialized = false;
    this.resourceSent = false;
    this.setSnapshot({
      phase: "loading",
      generation,
      displayMode: "inline",
      height: remembered ?? 0,
      sized: false,
    });
    const abortController = new AbortController();
    this.abortController = abortController;
    const stale = () => abortController.signal.aborted || generation !== this.generation;

    let resource: McpAppResourceRead;
    try {
      // One read per widget resource for the page lifetime (remounts reuse it).
      resource = await readMcpAppResourceOnce(
        mcpAppResourceCacheKey({
          threadId: this.options.identity.threadId,
          serverKey: binding.serverKey,
          resourceUri: binding.resourceUri,
        }),
        () =>
          this.api.readResource({
            threadId: this.options.identity.threadId,
            callId: this.options.identity.callId,
            server: binding.server,
            resourceUri: binding.resourceUri,
            source: binding.source,
            toolName: binding.toolName,
            ...(binding.connectorId ? { connectorId: binding.connectorId } : {}),
          }),
      );
    } catch {
      if (!stale()) this.setSnapshot({ phase: "failed" });
      return;
    }
    if (stale()) return;
    if (resource.state !== "ready") {
      this.setSnapshot({ phase: "failed" });
      return;
    }
    const prefersBorder = resource.prefersBorder !== false;
    this.setSnapshot({ prefersBorder });

    const declared = grantedList(resource.permissions);
    const approved = await this.resolvePermissions(resource);
    if (stale()) return;

    let registered: McpAppSandboxDescriptor | null;
    try {
      registered = await desktop.register({
        callId: this.options.identity.callId,
        containerDimensions: { width: 640, height: 0 },
        csp: resource.csp,
        generation,
        isCollapsible: resource.isCollapsible,
        prefersBorder,
        resourceUri: binding.resourceUri,
        server: binding.server,
        theme: this.theme,
        threadId: ThreadId.makeUnsafe(this.options.identity.threadId),
        widgetDomain: resource.domain,
        serverKey: binding.serverKey,
        stableOrigin: resource.stableOrigin,
        ...(binding.connectorId ? { connectorId: binding.connectorId } : {}),
        ...(binding.connectorUrl ? { connectorUrl: binding.connectorUrl } : {}),
        ...(declared.length > 0 ? { permissions: sandboxPermissionsOf(declared) } : {}),
      });
    } catch {
      registered = null;
    }
    if (!registered) {
      if (!stale()) this.setSnapshot({ phase: "failed" });
      return;
    }
    if (stale()) {
      await desktop
        .unregister({
          sandboxId: registered.sandboxId,
          initId: registered.initId,
          generation: registered.generation,
        })
        .catch(() => undefined);
      return;
    }
    this.descriptor = registered;
    // requestPermissions replaces the partition's grant: always send the full approved set
    // (`{}` revokes). Widgets with frame sites get nothing, so they are never asked.
    const granted = await this.applyPermissionGrant(
      desktop,
      registered.sandboxId,
      declared,
      approved,
      resource.csp.frameDomains.length > 0,
    );
    if (stale()) return;
    await this.connectSandbox(container, registered, resource, granted, desktop, generation);
  }

  /** The partition's grant after replacing it with the approved set; what the widget may use. */
  private async applyPermissionGrant(
    desktop: McpAppDesktopBridge,
    sandboxId: string,
    declared: readonly McpAppPermissionName[],
    approved: readonly McpAppPermissionName[],
    hasFrameSites: boolean,
  ): Promise<McpAppPermissionName[]> {
    if (declared.length === 0 || hasFrameSites || !desktop.requestPermissions) return [];
    const answer = await desktop
      .requestPermissions(sandboxId, sandboxPermissionsOf(approved))
      .catch(() => null);
    return grantedNames(answer?.granted).filter((name) => approved.includes(name));
  }

  private async resolvePermissions(
    resource: Extract<McpAppResourceRead, { state: "ready" }>,
  ): Promise<McpAppPermissionName[]> {
    const requested = grantedList(resource.permissions);
    // Any embedded frame site withholds device access (SPEC §4).
    if (requested.length === 0 || resource.csp.frameDomains.length > 0) return [];
    const serverKey = this.options.binding.serverKey;
    const decision = readMcpAppPermissionDecision(serverKey);
    if (decision === "denied") return [];
    if (decision && requested.every((name) => decision[name] !== undefined)) return requested;
    const allowed = await this.enqueuePrompt({ kind: "permission", permissions: requested });
    // Unanswered (the widget went away): ask again on the next mount.
    if (allowed === null) return [];
    writeMcpAppPermissionDecision(serverKey, allowed ? permissionsOf(requested) : "denied");
    return allowed ? requested : [];
  }

  private enqueuePrompt(prompt: McpAppHostPrompt): Promise<PromptAnswer> {
    return new Promise((resolve) => {
      this.promptQueue.push({ prompt, resolve });
      if (this.promptQueue.length === 1) this.setSnapshot({ prompt });
    });
  }

  private openDialog<T>(dialog: McpAppHostDialog): Promise<T | null> {
    if (activeDialogOwner !== null || this.dialogResolver) return Promise.resolve(null);
    activeDialogOwner = this;
    return new Promise((resolve) => {
      this.dialogResolver = (answer) => resolve((answer ?? null) as T | null);
      this.setSnapshot({ dialog });
    });
  }

  private paneAvailable(): boolean {
    return (this.options.paneAvailable?.() ?? false) && !this.snapshot.fullscreenDeclined;
  }

  private buildHandlers(desktop: McpAppDesktopBridge) {
    const binding = this.options.binding;
    return createMcpAppRequestHandlers({
      threadId: this.options.identity.threadId,
      callId: this.options.identity.callId,
      binding,
      api: {
        rpc: this.api.rpc,
        modelContext: this.api.modelContext,
        resourceDownload: this.api.resourceDownload,
      },
      desktop,
      askApproval: (request: McpAppNeedsApproval) =>
        this.enqueuePrompt({
          kind: "approval",
          toolName: request.toolName,
          serverLabel: request.serverLabel,
          reason: request.reason,
        }).then((answer) => answer === true),
      askSignIn: () => this.enqueuePrompt({ kind: "sign_in" }).then((answer) => answer === true),
      confirmLink: (plan) =>
        this.openDialog<{ dontAskAgain: boolean }>({ kind: "open_link", plan }).then((answer) =>
          answer && typeof answer === "object" ? answer : null,
        ),
      isLinkTrusted: (trustKey) => isMcpAppLinkTrusted(binding.serverKey, trustKey),
      trustLink: (trustKey) => trustMcpAppLink(binding.serverKey, trustKey),
      openInApp: (path) => this.options.openInApp?.(path),
      appOrigin: typeof window === "undefined" ? null : window.location.origin,
      confirmDownload: (items) =>
        this.openDialog<boolean>({ kind: "download", items }).then((answer) => answer === true),
      displayMode: () => this.snapshot.displayMode,
      paneAvailable: () => this.paneAvailable(),
      setDisplayMode: async (mode) => {
        const actual = await this.options.onRequestDisplayMode?.(mode);
        return actual ?? this.snapshot.displayMode;
      },
      message: this.options.message,
      ...(this.options.log ? { log: this.options.log } : {}),
    });
  }

  private async connectSandbox(
    container: HTMLElement,
    registered: McpAppSandboxDescriptor,
    resource: Extract<McpAppResourceRead, { state: "ready" }>,
    granted: readonly McpAppPermissionName[],
    desktop: McpAppDesktopBridge,
    generation: number,
  ): Promise<void> {
    const binding = this.options.binding;
    const abortController = this.abortController;
    const stale = () =>
      !abortController || abortController.signal.aborted || generation !== this.generation;
    const webview = webviewElement();
    webview.dataset.mcpAppSandbox = "true";
    // Displayed from the start (the wrapper is parked, fully clipped, until `initialized`): a
    // guest that is not displayed does not lay out, so the widget could not measure itself.
    styleMcpAppWebview(webview);
    webview.setAttribute("partition", registered.partition);
    webview.setAttribute(
      "webpreferences",
      "nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,plugins=no,allowRunningInsecureContent=no",
    );
    const frameWrapper = document.createElement("div");
    frameWrapper.dataset.mcpAppFrameWrapper = "true";
    frameWrapper.style.width = "100%";
    frameWrapper.style.height = "100%";
    frameWrapper.style.minHeight = "0";
    frameWrapper.style.position = "absolute";
    frameWrapper.style.display = "none";
    frameWrapper.style.zIndex = "1";
    frameWrapper.append(webview);
    const navigationPortalTarget = document.createElement("div");
    navigationPortalTarget.dataset.mcpAppNavigationPortal = "true";
    navigationPortalTarget.style.position = "absolute";
    navigationPortalTarget.style.inset = "0";
    navigationPortalTarget.style.zIndex = "50";
    navigationPortalTarget.style.pointerEvents = "none";
    frameWrapper.append(navigationPortalTarget);
    this.webview = webview;
    this.frameWrapper = frameWrapper;
    this.navigationPortalTarget = navigationPortalTarget;

    const capabilities: McpUiHostCapabilities = {
      serverTools: {},
      serverResources: {},
      openLinks: {},
      message: { text: {} },
      updateModelContext: { text: {}, image: {} },
      logging: {},
      downloadFile: {},
      sandbox: { permissions: permissionsOf(granted) },
    };
    const channel = new McpAppHostContextChannel(
      buildMcpAppHostContext({
        theme: this.theme,
        locale: this.locale,
        styles: this.styles,
        displayMode: "inline",
        paneAvailable: this.paneAvailable(),
        width: container.getBoundingClientRect().width || 640,
        height: 0,
        callId: this.options.identity.callId,
        tool: toolDefinition(binding),
      }),
      (diff) => {
        const bridge = this.bridge;
        if (!bridge) return;
        bridge.contextSendOpen = true;
        try {
          void Promise.resolve(bridge.sendHostContextChange(diff)).catch(() => this.fail());
        } finally {
          bridge.contextSendOpen = false;
        }
      },
    );
    this.contextChannel = channel;
    const bridge = new MossAppBridge(
      null,
      { name: MCP_APP_HOST_INFO_NAME, version: APP_VERSION },
      capabilities,
      { hostContext: channel.snapshot() },
    );
    this.bridge = bridge;
    const handlers = this.buildHandlers(desktop);
    const activation = (extra: { requestId?: string | number } | undefined) =>
      this.transport?.hadUserActivation(extra?.requestId) ?? false;
    bridge.oncalltool = (params) => handlers.callTool(params);
    bridge.onreadresource = (params) => handlers.readResource(params) as never;
    bridge.onlistresources = (params) => handlers.listResources(params) as never;
    bridge.onlistresourcetemplates = (params) => handlers.listResourceTemplates(params) as never;
    bridge.onlistprompts = (params) => handlers.listPrompts(params) as never;
    bridge.setRequestHandler(
      ListToolsRequestSchema,
      (request) => handlers.listTools(request.params) as never,
    );
    bridge.onmessage = (params, extra) => handlers.message(params, activation(extra));
    bridge.onopenlink = (params, extra) => handlers.openLink(params, activation(extra));
    bridge.ondownloadfile = (params) => handlers.downloadFile(params);
    bridge.onrequestdisplaymode = (params, extra) =>
      handlers.requestDisplayMode(params, activation(extra));
    bridge.onupdatemodelcontext = (params) => handlers.updateModelContext(params);
    bridge.onloggingmessage = (params) => handlers.logging(params);

    let handoffReceived = false;
    let rejectHandoff: ((reason?: unknown) => void) | null = null;
    let removeHandoffListener: (() => void) | null = null;
    const handoff = new Promise<{
      readonly bridgePort: MessagePort;
      readonly navigationPort: MessagePort;
      readonly replyPort: MessagePort;
    }>((resolve, reject) => {
      rejectHandoff = reject;
      const onMessage = (event: MessageEvent) => {
        const candidate = event.data as { readonly type?: unknown } | null;
        if (candidate?.type !== MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL) return;
        const identityCandidate = candidate as {
          readonly origin?: unknown;
          readonly sandboxId?: unknown;
          readonly initId?: unknown;
        };
        if (
          identityCandidate.origin !== registered.origin ||
          identityCandidate.sandboxId !== registered.sandboxId ||
          identityCandidate.initId !== registered.initId
        ) {
          // Several cards share the trusted window; never close another card's ports.
          return;
        }
        const envelope = decodeMcpAppSandboxHostPortEnvelope(event.data);
        const trustedOrigin = window.location.origin;
        const valid =
          !handoffReceived &&
          event.source === window &&
          trustedOrigin !== "null" &&
          event.origin === trustedOrigin &&
          envelope !== null &&
          envelope.origin === registered.origin &&
          envelope.sandboxId === registered.sandboxId &&
          envelope.initId === registered.initId &&
          envelope.portNames.length === MCP_APP_SANDBOX_PORT_NAMES.length &&
          envelope.portNames.every((name, index) => name === MCP_APP_SANDBOX_PORT_NAMES[index]) &&
          event.ports.length === envelope.portNames.length + 1;
        if (!valid) {
          for (const port of event.ports) port.close();
          return;
        }
        handoffReceived = true;
        window.removeEventListener("message", onMessage);
        const [bridgePort, navigationPort, replyPort] = event.ports;
        if (!bridgePort || !navigationPort || !replyPort) {
          for (const port of event.ports) port.close();
          reject(new Error("MCP App bridge transfer was incomplete."));
          return;
        }
        try {
          replyPort.start();
          replyPort.postMessage({
            type: MCP_APP_SANDBOX_ACK_TYPE,
            sandboxId: registered.sandboxId,
            initId: registered.initId,
            portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
          });
        } catch (error) {
          for (const port of event.ports) port.close();
          reject(error);
          return;
        }
        resolve({ bridgePort, navigationPort, replyPort });
      };
      window.addEventListener("message", onMessage);
      removeHandoffListener = () => window.removeEventListener("message", onMessage);
    });

    const clearInitializedTimeout = () => this.clearTimers();
    const sandboxReady = () => {
      if (this.resourceSent || stale()) return;
      this.resourceSent = true;
      if (this.proxyReadyTimer !== null) clearTimeout(this.proxyReadyTimer);
      this.proxyReadyTimer = null;
      void bridge
        .sendSandboxResourceReady({
          html: resource.html,
          ...(granted.length > 0 ? { permissions: permissionsOf(granted) } : {}),
        })
        .catch(() => this.fail());
      this.armInitializeTimeout(generation);
    };
    const initialized = () => {
      if (this.initialized || stale()) return;
      this.initialized = true;
      clearInitializedTimeout();
      const modes = bridge.getAppCapabilities()?.availableDisplayModes;
      const fullscreenDeclined =
        Array.isArray(modes) && modes.length > 0 && !modes.includes("fullscreen");
      this.setSnapshot({ fullscreenDeclined });
      if (fullscreenDeclined) this.updateContext({ availableDisplayModes: ["inline"] });
      channel.markInitialized();
      webview.style.display = MCP_APP_WEBVIEW_DISPLAY;
      this.running = true;
      this.setSnapshot({ phase: "ready" });
      const slot = this.inlineContainer;
      if (slot) this.layoutFrameTo(slot, "inline");
      else this.tracker?.setVisible(false);
      void this.deliverToolData(generation);
    };
    // The card opens once, at the height the widget settles on, not in start-up steps.
    const firstSize = createMcpAppFirstSizeSettler({
      apply: (height) => {
        if (stale() || this.snapshot.displayMode === "fullscreen") return;
        rememberMcpAppHeight(this.heightKey, height);
        this.setSnapshot({ height, sized: true });
      },
    });
    const sizeChanged = (event: { readonly width?: number; readonly height?: number }) => {
      if (stale() || this.snapshot.displayMode === "fullscreen") return;
      const restoring = !this.snapshot.sized && this.snapshot.height > 0;
      const height = resolveMcpAppReportedHeight(event.height, restoring);
      if (height === null) return;
      firstSize.report(height);
    };
    bridge.addEventListener("sandboxready", sandboxReady);
    bridge.addEventListener("initialized", initialized);
    bridge.addEventListener("sizechange", sizeChanged);
    this.cleanupBridge = () => {
      clearInitializedTimeout();
      firstSize.cancel();
      bridge.removeEventListener("sandboxready", sandboxReady);
      bridge.removeEventListener("initialized", initialized);
      bridge.removeEventListener("sizechange", sizeChanged);
      removeHandoffListener?.();
      removeHandoffListener = null;
      rejectHandoff?.(new Error("MCP App bridge closed."));
      rejectHandoff = null;
    };
    this.portalTarget?.append(frameWrapper);
    if (this.portalTarget) {
      this.tracker = new McpAppFrameTracker(frameWrapper, this.portalTarget, {
        zIndexFor: (mode) => (mode === "fullscreen" ? fullscreenFrameZIndex() : "1"),
        onDimensions: (dimensions, mode) =>
          this.updateContext({
            displayMode: mode,
            containerDimensions:
              mode === "fullscreen"
                ? {
                    width: boundedDimension(dimensions.width),
                    height: boundedDimension(dimensions.height),
                  }
                : { width: boundedDimension(dimensions.width), maxHeight: 5_000 },
          }),
      });
      if (this.inlineContainer) {
        this.tracker.setVisible(false);
        this.tracker.follow(this.inlineContainer, "inline");
      }
    }
    // A webview's first navigation is reliable only once it is connected to the DOM.
    webview.setAttribute("src", registered.src);
    this.proxyReadyTimer = setTimeout(() => {
      this.proxyReadyTimer = null;
      if (stale() || this.resourceSent) return;
      if (this.proxyReadyRetriesLeft > 0) {
        // One retry with a fresh guest (new registration, new webview).
        this.proxyReadyRetriesLeft -= 1;
        this.generation = Math.min(this.generation + 1, 1_000_000);
        void this.run(container).catch(() => undefined);
        return;
      }
      void this.fail();
    }, MCP_APP_PROXY_READY_TIMEOUT_MS);
    try {
      const ports = await handoff;
      if (stale()) {
        ports.bridgePort.close();
        ports.navigationPort.close();
        ports.replyPort.close();
        return;
      }
      this.replyPort = ports.replyPort;
      this.navigationPort = ports.navigationPort;
      const navigationListener = (event: MessageEvent) => {
        const state =
          event.ports.length === 0 ? decodeMcpAppSandboxNavigationState(event.data) : null;
        if (!state) {
          ports.navigationPort.close();
          void this.fail();
          return;
        }
        if (stale() || this.navigationPort !== ports.navigationPort) {
          ports.navigationPort.close();
          return;
        }
        this.setSnapshot({ canGoBack: state.canGoBack, canGoForward: state.canGoForward });
      };
      this.navigationPortListener = navigationListener;
      ports.navigationPort.addEventListener("message", navigationListener);
      ports.navigationPort.start();
      const transport = new BoundedMessagePortTransport(ports.bridgePort);
      transport.oninboundrequest = (method) => {
        if (method === "ui/initialize") channel.markInitializeAnswered();
      };
      // Only an inline widget chains to the transcript; the side panel has nothing to scroll.
      transport.onwheel = (delta) => {
        if (stale() || this.snapshot.displayMode !== "inline") return;
        chainMcpAppWheel(this.inlineContainer, delta);
      };
      this.transport = transport;
      await bridge.connect(transport);
    } catch {
      if (stale()) return;
      await this.fail();
      return;
    }
  }

  private updateContext(partial: Partial<McpUiHostContext>): void {
    const channel = this.contextChannel;
    const bridge = this.bridge;
    if (!channel || !bridge) return;
    channel.update(partial);
    // Keep the bridge's own copy current so `ui/initialize` answers with it; the bridge's
    // notification is suppressed — the channel sends the diff once the widget is initialized.
    bridge.setHostContext(channel.snapshot());
  }

  private async deliverToolData(generation: number): Promise<void> {
    const bridge = this.bridge;
    if (!bridge || generation !== this.generation || this.resultSent || this.deliveringToolData) {
      return;
    }
    this.deliveringToolData = true;
    try {
      let server: McpAppToolResultResponse;
      try {
        server = await this.api.toolResult({
          threadId: this.options.identity.threadId,
          callId: this.options.identity.callId,
        });
      } catch {
        server = { status: "missing" };
      }
      if (generation !== this.generation || this.bridge !== bridge) return;
      if (server.status === "failed") {
        // The server says the call failed: the plain result, not a live widget.
        await this.fail();
        return;
      }
      if (!this.inputSent) {
        const args =
          server.status === "ready"
            ? server.input
            : (normalizeMcpToolArguments(this.projection.arguments) ?? {});
        this.inputSent = true;
        await bridge.sendToolInput({ arguments: args });
      }
      let result: CallToolResult | null = null;
      const ended = this.projection.status !== "inProgress";
      if (server.status === "pending") this.pendingAfterEnd += ended ? 1 : 0;
      if (server.status === "ready") {
        result = server.result;
      } else if (
        !ended ||
        (server.status === "pending" && this.pendingAfterEnd < MCP_APP_PENDING_AFTER_END_POLLS)
      ) {
        // Still running: send nothing yet. Ask again shortly; a projection update also retries.
        this.scheduleToolResultCheck(generation);
        return;
      } else if (this.projection.status === "failed") {
        // The call failed and the server kept no result the widget could use (for example
        // structuredContent that is not an object): show the plain result instead.
        await this.fail();
        return;
      } else {
        result = mapMossMcpResultToCallToolResult(this.projection);
      }
      if (!result) return;
      const validated = validateMcpAppCallToolResult(result);
      if (!validated) {
        this.options.log?.(
          `[${this.options.binding.serverLabel}] Tool '${this.options.binding.toolName}' returned structuredContent that is not an object.`,
        );
        await this.fail();
        return;
      }
      this.resultSent = true;
      await bridge.sendToolResult(validated);
    } catch {
      if (generation === this.generation) await this.fail();
    } finally {
      this.deliveringToolData = false;
    }
  }

  private scheduleToolResultCheck(generation: number): void {
    if (this.toolResultTimer !== null) return;
    this.toolResultTimer = setTimeout(() => {
      this.toolResultTimer = null;
      if (generation === this.generation && this.running) void this.deliverToolData(generation);
    }, MCP_APP_TOOL_RESULT_POLL_MS);
  }

  /**
   * Unload the app while it is out of sight (the side panel's residency policy): the app is told
   * first, as on any teardown, and the host returns to idle. The next attach starts it again from
   * its tool result. A new generation keeps late callbacks of the unloaded one out.
   */
  async suspend(): Promise<void> {
    if (this.snapshot.phase === "idle") return;
    this.generation = Math.min(this.generation + 1, 1_000_000);
    await this.teardown();
    this.setSnapshot({ phase: "idle" });
  }

  async retry(container = this.currentContainer): Promise<void> {
    if (!container) return;
    this.generation = Math.min(this.generation + 1, 1_000_000);
    await this.run(container);
  }

  async teardown(): Promise<void> {
    const wasRunning = this.running;
    this.abortController?.abort();
    this.abortController = null;
    if (this.toolResultTimer !== null) clearTimeout(this.toolResultTimer);
    this.toolResultTimer = null;
    this.clearTimers();
    this.tracker?.dispose();
    this.tracker = null;
    try {
      this.cleanupBridge?.();
    } catch {
      // A partially initialized bridge must not prevent descriptor/guest cleanup.
    }
    this.cleanupBridge = null;
    // Pending prompts and dialogs belong to this generation.
    while (this.promptQueue.length > 0) this.promptQueue.shift()?.resolve(null);
    if (this.dialogResolver) this.respondDialog(null);
    const bridge = this.bridge;
    const transport = this.transport;
    const navigationPort = this.navigationPort;
    const navigationPortListener = this.navigationPortListener;
    const descriptor = this.descriptor;
    const webview = this.webview;
    const frameWrapper = this.frameWrapper;
    this.bridge = null;
    this.transport = null;
    this.contextChannel = null;
    this.navigationPort = null;
    this.navigationPortListener = null;
    this.descriptor = null;
    this.webview = null;
    this.frameWrapper = null;
    this.portalTarget = null;
    this.geometryTarget = null;
    // Close the privileged navigation channel before any graceful await so an old generation
    // cannot publish navigation state after teardown has yielded.
    try {
      if (navigationPortListener) {
        navigationPort?.removeEventListener("message", navigationPortListener);
      }
      navigationPort?.close();
    } catch {
      // Already closed.
    }
    if (wasRunning && bridge) await requestMcpAppTeardown(bridge);
    try {
      await bridge?.close();
    } catch {
      // The peer may have closed already.
    }
    try {
      await transport?.close();
    } catch {
      // MessagePort.close can report a terminal error.
    }
    try {
      this.replyPort?.close();
    } catch {
      // The port may have been transferred to main already.
    }
    this.replyPort = null;
    const desktop =
      this.options.desktop === undefined ? readMcpAppDesktopBridge() : this.options.desktop;
    if (descriptor && desktop) {
      try {
        await desktop.unregister({
          sandboxId: descriptor.sandboxId,
          initId: descriptor.initId,
          generation: descriptor.generation,
        });
      } catch {
        // Main owns the final teardown; renderer cleanup must still complete.
      }
    }
    this.running = false;
    this.initialized = false;
    // Remove only this generation's frame: a replacement may already share the container.
    try {
      frameWrapper?.remove();
      webview?.remove();
    } catch {
      // The host container may already have been detached.
    }
    this.navigationPortalTarget = null;
    this.setSnapshot({
      displayMode: "inline",
      canGoBack: false,
      canGoForward: false,
      prompt: null,
      dialog: null,
    });
  }

  private async fail(): Promise<void> {
    if (this.snapshot.phase === "failed") return;
    // The card shows its text result at once; the guest's teardown (a goodbye to the widget
    // and an unregister round trip to the desktop shell) finishes behind it.
    const teardown = this.teardown();
    this.setSnapshot({ phase: "failed" });
    await teardown;
  }

  private setSnapshot(partial: Partial<McpAppHostSnapshot>): void {
    const next = { ...this.snapshot, ...partial };
    const keys = Object.keys(partial) as Array<keyof McpAppHostSnapshot>;
    if (keys.every((key) => this.snapshot[key] === next[key])) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function mcpAppSandboxSource(sandboxId: string): string {
  return `${MCP_APP_SANDBOX_SCHEME}://${sandboxId}`;
}

export { MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL };
