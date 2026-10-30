// FILE: mcpAppHost.ts
// Purpose: MCP App host. Electron uses the desktop webview sandbox. A browser
// without that bridge renders Codex's HTMLIFrameElement path
// (mcp-sandbox-element.js `x`, widget.js `Jl`) from a fetched or recorded resource.

import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_APP_FRAME_DEFAULT_HEIGHT,
  MCP_APP_SANDBOX_INNER_SANDBOX,
  MCP_APP_SANDBOX_INIT_TIMEOUT_MS,
  MCP_APP_SANDBOX_MAX_DIMENSION,
  MCP_APP_SANDBOX_MAX_OUTSTANDING_REQUESTS,
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_MAX_MESSAGE_BYTES,
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxHostPortEnvelope,
  decodeMcpAppSandboxNavigationState,
  resolveMcpAppFrameHeight,
  ThreadId,
  type McpAppSandboxDescriptor,
  type McpAppSandboxDimensions,
  type McpAppSandboxRegisterInput,
} from "@synara/contracts";
import type { McpAppResourceReadyResult } from "@synara/contracts";

import type { WorkLogMcpToolResult } from "./toolCallDetails";
import { embeddedMcpAppHtml } from "./mcpAppBrowserFrame";
import { fetchMcpAppResource } from "./mcpAppResource";
import { APP_VERSION } from "~/branding";
import type { McpAppDisplayMode } from "./mcpAppDockRegistry";

const MAX_ARGUMENT_KEYS = 64;
const MAX_JSON_CHARS = 4_000;
const MAX_MESSAGE_BYTES = MCP_APP_SANDBOX_MAX_MESSAGE_BYTES;
const MAX_RESOURCE_MESSAGE_BYTES = MCP_APP_RESOURCE_MAX_HTML_BYTES + 4_096;
const SANDBOX_RESOURCE_READY_METHOD = "ui/notifications/sandbox-resource-ready";
const MCP_APP_TEARDOWN_TIMEOUT_MS = 1_000;
const MCP_APP_PORTAL_TARGET_SELECTOR = '[data-mcp-app-portal-target="true"]';

export type McpAppHostPhase =
  | "idle"
  | "loading"
  | "ready"
  | "no_content"
  | "too_large"
  | "resource_error"
  | "sandbox_error"
  | "browser_unavailable";

export interface McpAppHostSnapshot {
  readonly phase: McpAppHostPhase;
  readonly height: number;
  readonly displayMode: McpAppDisplayMode;
  readonly errorMessage?: string;
  readonly canRetry: boolean;
  readonly generation: number;
  readonly isCollapsible: boolean;
  readonly prefersBorder: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Present only for the browser iframe path. Desktop guests stay in the webview. */
  readonly browserHtml: string | null;
}

export interface McpAppHostIdentity {
  readonly threadId: string;
  readonly callId: string;
  readonly resourceUri: string;
  /** Renderer-only lifecycle identity; never serialized or exposed to the guest. */
  readonly lifecycleKey?: string;
}

interface HostOptions {
  readonly projection: WorkLogMcpToolResult;
  readonly identity: McpAppHostIdentity;
  readonly theme: "light" | "dark";
  readonly dimensions?: McpAppSandboxDimensions;
  readonly onRequestDisplayMode?: (
    mode: McpAppDisplayMode,
  ) => Promise<McpAppDisplayMode> | McpAppDisplayMode;
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
 * Keep only standard CallToolResult blocks. Moss-only attachment/deferred
 * blocks are intentionally omitted and never expose their internal fields.
 */
export function mapMossMcpResultToCallToolResult(projection: WorkLogMcpToolResult): CallToolResult {
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

  const structuredContentValue = boundedJson(projection.result?.structuredContent);
  const structuredContent = isPlainRecord(structuredContentValue)
    ? structuredContentValue
    : undefined;
  const result: CallToolResult = {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
  if (projection.status !== "completed") {
    return {
      content: [{ type: "text", text: "Tool execution was not successful." }],
      isError: true,
    };
  }
  if (projection.error) return { ...result, isError: true };
  return result;
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
        !hasExactKeys(params, ["html", "sandbox"]) ||
        typeof (params as Record<string, unknown>).html !== "string" ||
        typeof (params as Record<string, unknown>).sandbox !== "string" ||
        (params as Record<string, unknown>).sandbox !== MCP_APP_SANDBOX_INNER_SANDBOX
      ) {
        return false;
      }
      const html = (params as Record<string, unknown>).html as string;
      const encoded = JSON.stringify(value);
      return (
        new TextEncoder().encode(html).byteLength <= MCP_APP_RESOURCE_MAX_HTML_BYTES &&
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

/** A bounded raw MessagePort transport; unlike the public debug transport it logs no payload. */
export class BoundedMessagePortTransport implements Transport {
  private closed = false;
  private started = false;
  private readonly inboundRequests = new Set<string>();
  private readonly outboundRequests = new Set<string>();
  private readonly listener: (event: MessageEvent) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(private readonly port: MessagePort) {
    this.listener = (event) => {
      if (this.closed) return;
      if (!boundedMessage(event.data)) {
        for (const port of event.ports ?? []) port.close();
        this.failClosed(new Error("MCP App bridge message was invalid."));
        return;
      }
      if (event.ports?.length) {
        for (const port of event.ports) port.close();
        this.failClosed(new Error("MCP App bridge transfer was invalid."));
        return;
      }
      const message = event.data as JSONRPCMessage & {
        readonly id?: string | number | null;
        readonly method?: string;
      };
      if (message.id !== undefined && message.id !== null) {
        const key = `${typeof message.id}:${String(message.id)}`;
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
        } else if (this.outboundRequests.delete(key)) {
          // The response completed a host-originated request.
        } else {
          this.failClosed(new Error("MCP App bridge response id was unexpected."));
          return;
        }
      }
      this.onmessage?.(event.data);
    };
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
    const key =
      request.id !== undefined && request.id !== null
        ? `${typeof request.id}:${String(request.id)}`
        : null;
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

function safeErrorMessage(error: unknown, kind: "resource" | "sandbox"): string {
  if (kind === "resource") return "Unable to load MCP app resource.";
  return "Unable to start MCP app sandbox.";
}

function initialDimensions(options: HostOptions): McpAppSandboxDimensions {
  const dimensions = options.dimensions ?? { width: 640, height: MCP_APP_FRAME_DEFAULT_HEIGHT };
  return { width: boundedDimension(dimensions.width), height: boundedDimension(dimensions.height) };
}

function resolveMcpAppPortalTarget(container: HTMLElement): HTMLElement | null {
  return (
    container.closest<HTMLElement>(MCP_APP_PORTAL_TARGET_SELECTOR) ??
    document.querySelector<HTMLElement>(MCP_APP_PORTAL_TARGET_SELECTOR) ??
    null
  );
}

function currentCssZoom(element: HTMLElement): number {
  const zoom = (element as HTMLElement & { readonly currentCSSZoom?: unknown }).currentCSSZoom;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
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
  // Moss's shared mobile SheetViewport owns z-index 50. Keep the frozen
  // desktop stack at 43, while lifting only the fullscreen App surface above
  // that existing mobile layer so the guest remains readable.
  return isMcpAppMobileViewport() ? "51" : "43";
}

function zeroSafeAreaInsets() {
  return { top: 0, right: 0, bottom: 0, left: 0 } as const;
}

function frameHeight(
  intrinsicHeight: number | null,
  heightHint: number | undefined,
  minFrameHeight: number | undefined,
): number {
  return resolveMcpAppFrameHeight({
    intrinsicHeight,
    ...(heightHint !== undefined ? { heightHint } : {}),
    ...(minFrameHeight !== undefined ? { minFrameHeight } : {}),
  });
}

function documentTheme(fallback: "light" | "dark"): "light" | "dark" {
  if (typeof document === "undefined") return fallback;
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return document.documentElement.classList.contains("dark") ? "dark" : fallback;
}

function webviewElement(): HTMLElement & {
  partition?: string;
  src?: string;
  webpreferences?: string;
} {
  return document.createElement("webview") as HTMLElement & {
    partition?: string;
    src?: string;
    webpreferences?: string;
  };
}

export class McpAppHostController {
  private snapshot: McpAppHostSnapshot = {
    phase: "idle",
    height: MCP_APP_FRAME_DEFAULT_HEIGHT,
    displayMode: "inline",
    canRetry: false,
    generation: 0,
    isCollapsible: true,
    prefersBorder: false,
    canGoBack: false,
    canGoForward: false,
    browserHtml: null,
  };
  private readonly listeners = new Set<() => void>();
  private abortController: AbortController | null = null;
  private descriptor: McpAppSandboxDescriptor | null = null;
  private bridge: AppBridge | null = null;
  private transport: BoundedMessagePortTransport | null = null;
  private webview: HTMLElement | null = null;
  private frameWrapper: HTMLDivElement | null = null;
  private navigationPortalTarget: HTMLDivElement | null = null;
  private portalTarget: HTMLElement | null = null;
  private geometryTarget: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private geometryMutationObserver: MutationObserver | null = null;
  private geometryOffsetParent: HTMLElement | null = null;
  private geometryScrollTarget: HTMLElement | null = null;
  private geometryScrollListener: (() => void) | null = null;
  private geometryWindowResizeListener: (() => void) | null = null;
  private geometryFollowFrame: number | null = null;
  private themeObserver: MutationObserver | null = null;
  private resizeFrame: number | null = null;
  private cleanupBridge: (() => void) | null = null;
  private currentContainer: HTMLElement | null = null;
  private inlineContainer: HTMLElement | null = null;
  private replyPort: MessagePort | null = null;
  private navigationPort: MessagePort | null = null;
  private navigationPortListener: ((event: MessageEvent) => void) | null = null;
  private generation = 0;
  private running = false;
  private frameVisible = true;
  private projection: WorkLogMcpToolResult;
  private theme: "light" | "dark";
  private toolDataSequence: Promise<void> = Promise.resolve();

  constructor(private readonly options: HostOptions) {
    this.projection = options.projection;
    this.theme = options.theme;
  }

  updateProjection(projection: WorkLogMcpToolResult): void {
    if (
      projection.callId !== this.options.identity.callId ||
      projection.server !== this.projection.server ||
      projection.app?.resourceUri !== this.options.identity.resourceUri
    ) {
      return;
    }
    if (projection === this.projection) return;
    this.projection = projection;
    if (this.running && this.bridge) {
      void this.enqueueToolData(this.bridge, this.generation).catch(() => {
        void this.failSandboxGeneration().catch(() => undefined);
      });
    }
  }

  updateTheme(theme: "light" | "dark"): void {
    if (this.theme === theme) return;
    this.theme = theme;
    if (!this.running || !this.bridge) return;
    try {
      this.bridge.setHostContext({ theme });
    } catch {
      void this.failSandboxGeneration().catch(() => undefined);
    }
  }

  getSnapshot(): McpAppHostSnapshot {
    return this.snapshot;
  }

  getNavigationPortalTarget(): HTMLElement | null {
    return this.navigationPortalTarget;
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
      void this.failSandboxGeneration().catch(() => undefined);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setFrameVisibility(visible: boolean): void {
    this.frameVisible = visible;
    const wrapper = this.frameWrapper;
    if (!wrapper) return;
    wrapper.style.visibility = visible ? "visible" : "hidden";
    wrapper.style.pointerEvents = visible ? "auto" : "none";
    if (!visible) {
      wrapper.style.display = "none";
      return;
    }
    wrapper.style.display = "block";
    if (this.running) this.scheduleGeometry();
  }

  /**
   * Apply the one live frame's geometry against a transcript or RightDock
   * target. The wrapper remains in the stable portal target for its entire
   * generation; moving an Electron webview between DOM parents would destroy
   * its guest.
   */
  layoutFrameTo(container: HTMLElement, displayMode: McpAppDisplayMode): boolean {
    const wrapper = this.frameWrapper;
    const portal = this.portalTarget;
    if (!wrapper || !portal || !this.bridge || !this.running) return false;
    this.geometryTarget = container;
    this.setUpGeometryObservers();
    if (!this.applyFrameGeometry(container, displayMode)) return false;
    this.setUpGeometryObservers();
    this.setSnapshot({ displayMode });
    this.followGeometryUntilSettled();
    return true;
  }

  private applyFrameGeometry(target: HTMLElement, displayMode: McpAppDisplayMode): boolean {
    const wrapper = this.frameWrapper;
    const portal = this.portalTarget;
    const bridge = this.bridge;
    if (!wrapper || !portal || !bridge || !this.running) return false;
    if (!target.isConnected || !portal.isConnected) {
      wrapper.style.display = "none";
      return false;
    }
    const isFullscreen = displayMode === "fullscreen";
    wrapper.style.position = isFullscreen ? "fixed" : "absolute";
    // Keep a hidden wrapper out of hit testing and paint, but temporarily
    // expose it while measuring so fixed geometry still uses its offset parent.
    wrapper.style.display = "block";
    const targetRect = target.getBoundingClientRect();
    const portalRect = portal.getBoundingClientRect();
    const zoom = currentCssZoom(portal);
    const offsetParentRect = wrapper.offsetParent?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
    };
    const left = isFullscreen
      ? (targetRect.left - offsetParentRect.left) / zoom
      : (targetRect.left - portalRect.left + portal.scrollLeft) / zoom;
    const top = isFullscreen
      ? (targetRect.top - offsetParentRect.top) / zoom
      : (targetRect.top - portalRect.top + portal.scrollTop) / zoom;
    const width = targetRect.width / zoom;
    const height = targetRect.height / zoom;
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.removeProperty("right");
    wrapper.style.removeProperty("bottom");
    wrapper.style.zIndex = isFullscreen ? fullscreenFrameZIndex() : "1";
    wrapper.style.visibility = this.frameVisible ? "visible" : "hidden";
    wrapper.style.pointerEvents = this.frameVisible ? "auto" : "none";
    wrapper.style.display = this.frameVisible ? "block" : "none";
    try {
      bridge.setHostContext({
        theme: documentTheme(this.theme),
        platform: "desktop",
        displayMode,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: {
          width: boundedDimension(width),
          height: boundedDimension(height),
        },
        safeAreaInsets:
          !isFullscreen && (this.snapshot.canGoBack || this.snapshot.canGoForward)
            ? { top: 48, right: 0, bottom: 0, left: 0 }
            : zeroSafeAreaInsets(),
      });
    } catch {
      return false;
    }
    return true;
  }

  private scheduleGeometry(): void {
    if (this.resizeFrame !== null || typeof window === "undefined") return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      const target = this.geometryTarget;
      if (!target || !this.bridge || !this.running) return;
      this.applyFrameGeometry(target, this.snapshot.displayMode);
      this.followGeometryUntilSettled();
    });
  }

  // The dock anchor can keep moving after layout is applied (open/close slide
  // transitions move it without changing its size, so ResizeObserver stays
  // silent). Track the anchor per frame until its rect holds still, then stop.
  private followGeometryUntilSettled(): void {
    if (this.geometryFollowFrame !== null || typeof window === "undefined") return;
    const deadline = Date.now() + 1_500;
    let lastRectKey = "";
    let stableFrames = 0;
    const step = () => {
      this.geometryFollowFrame = null;
      const target = this.geometryTarget;
      if (!target || !this.bridge || !this.running) return;
      const rect = target.getBoundingClientRect();
      const rectKey = `${rect.left},${rect.top},${rect.width},${rect.height}`;
      if (rectKey !== lastRectKey) {
        lastRectKey = rectKey;
        stableFrames = 0;
        this.applyFrameGeometry(target, this.snapshot.displayMode);
      } else {
        stableFrames += 1;
      }
      if (stableFrames >= 3 || Date.now() > deadline) return;
      this.geometryFollowFrame = window.requestAnimationFrame(step);
    };
    this.geometryFollowFrame = window.requestAnimationFrame(step);
  }

  private setUpGeometryObservers(): void {
    const portal = this.portalTarget;
    const target = this.geometryTarget;
    if (!portal || !target) return;
    if (typeof ResizeObserver !== "undefined") {
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.scheduleGeometry());
      }
      this.resizeObserver.disconnect();
      this.resizeObserver.observe(portal);
      this.resizeObserver.observe(target);
    }
    if (typeof MutationObserver !== "undefined") {
      const offsetParent =
        (this.frameWrapper?.offsetParent as HTMLElement | null | undefined) ?? null;
      if (this.geometryOffsetParent !== offsetParent) {
        this.geometryMutationObserver?.disconnect();
        this.geometryOffsetParent = offsetParent;
        if (offsetParent) {
          this.geometryMutationObserver ??= new MutationObserver(() => this.scheduleGeometry());
          this.geometryMutationObserver.observe(offsetParent, {
            attributes: true,
            attributeFilter: ["class", "style"],
          });
        }
      }
    }
    if (this.geometryScrollTarget !== portal) {
      this.geometryScrollTarget?.removeEventListener("scroll", this.geometryScrollListener!);
      this.geometryScrollListener = () => this.scheduleGeometry();
      portal.addEventListener("scroll", this.geometryScrollListener, { passive: true });
      this.geometryScrollTarget = portal;
    }
    if (!this.geometryWindowResizeListener) {
      this.geometryWindowResizeListener = () => this.scheduleGeometry();
      window.addEventListener("resize", this.geometryWindowResizeListener);
    }
  }

  async start(container: HTMLElement): Promise<void> {
    await this.teardown();
    this.frameVisible = true;
    this.currentContainer = container;
    this.inlineContainer = container;
    this.portalTarget = resolveMcpAppPortalTarget(container);
    this.geometryTarget = container;
    if (!this.portalTarget) {
      this.setSnapshot({
        phase: "sandbox_error",
        errorMessage: "MCP App host is unavailable.",
        canRetry: false,
      });
      return;
    }
    const desktopBridge = window.desktopBridge?.mcpApps;
    const descriptor = this.projection.app;
    if (!descriptor) {
      this.setSnapshot({ phase: "idle", canRetry: false, browserHtml: null });
      return;
    }
    if (this.options.identity.resourceUri !== descriptor.resourceUri) {
      this.setSnapshot({
        phase: "resource_error",
        errorMessage: "Unable to load MCP app resource.",
        canRetry: false,
        browserHtml: null,
      });
      return;
    }
    if (!desktopBridge) {
      await this.startBrowserFrame(descriptor);
      return;
    }
    const startGeneration = this.generation;
    const threadId = ThreadId.makeUnsafe(this.options.identity.threadId);
    this.setSnapshot({
      phase: "loading",
      canRetry: false,
      generation: startGeneration,
      displayMode: "inline",
    });
    const abortController = new AbortController();
    this.abortController = abortController;
    const resourceInput = {
      callId: this.options.identity.callId,
      resourceUri: this.options.identity.resourceUri,
      server: this.projection.server,
      source: descriptor.source,
      threadId,
      ...(descriptor.connectorId ? { connectorId: descriptor.connectorId } : {}),
    } as const;
    let resource:
      | McpAppResourceReadyResult
      | Extract<
          Awaited<ReturnType<typeof fetchMcpAppResource>>,
          { state: "no_content" | "too_large" }
        >;
    try {
      resource = await fetchMcpAppResource(resourceInput, { signal: abortController.signal });
    } catch (error) {
      if (abortController.signal.aborted || startGeneration !== this.generation) return;
      this.setSnapshot({
        phase: "resource_error",
        errorMessage: safeErrorMessage(error, "resource"),
        canRetry: false,
      });
      return;
    }
    if (abortController.signal.aborted || startGeneration !== this.generation) return;
    if (resource.state === "too_large") {
      this.setSnapshot({
        phase: "too_large",
        errorMessage: "Failed to load MCP app: HTML exceeds the maximum supported size.",
        canRetry: false,
      });
      return;
    }
    if (resource.state === "no_content") {
      this.setSnapshot({
        phase: "no_content",
        errorMessage: "MCP app returned no HTML content",
        canRetry: false,
      });
      return;
    }
    const registerInput: McpAppSandboxRegisterInput = {
      callId: this.options.identity.callId,
      containerDimensions: initialDimensions(this.options),
      csp: resource.csp,
      generation: startGeneration,
      isCollapsible: resource.isCollapsible,
      prefersBorder: resource.prefersBorder,
      resourceUri: resource.resourceUri,
      server: resourceInput.server,
      theme: this.theme,
      threadId,
      ...(resource.heightHint !== undefined ? { heightHint: resource.heightHint } : {}),
      ...(resource.minFrameHeight !== undefined ? { minFrameHeight: resource.minFrameHeight } : {}),
      ...(resource.widgetDomain !== null ? { widgetDomain: resource.widgetDomain } : {}),
      ...(descriptor.connectorId ? { connectorId: descriptor.connectorId } : {}),
    };
    let registered: McpAppSandboxDescriptor | null;
    try {
      registered = await desktopBridge.register(registerInput);
    } catch {
      registered = null;
    }
    if (!registered) {
      if (!abortController.signal.aborted && startGeneration === this.generation) {
        this.setSnapshot({
          phase: "sandbox_error",
          errorMessage: "Unable to start MCP app sandbox.",
          canRetry: true,
        });
      }
      return;
    }
    if (abortController.signal.aborted || startGeneration !== this.generation) {
      try {
        await desktopBridge.unregister({
          sandboxId: registered.sandboxId,
          initId: registered.initId,
          generation: registered.generation,
        });
      } catch {
        // Stale generations are terminal; cleanup is best effort.
      }
      return;
    }
    this.descriptor = registered;
    this.setSnapshot({
      isCollapsible: resource.isCollapsible,
      prefersBorder: resource.prefersBorder,
      height: frameHeight(null, resource.heightHint, resource.minFrameHeight),
    });
    const webview = webviewElement();
    webview.dataset.mcpAppSandbox = "true";
    webview.style.display = "none";
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.border = "0";
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
    const fail = () => {
      void this.failSandboxGeneration().catch(() => undefined);
    };
    this.webview = webview;
    this.frameWrapper = frameWrapper;
    this.navigationPortalTarget = navigationPortalTarget;
    const bridge = new AppBridge(
      null,
      { name: "Moss", version: APP_VERSION },
      {},
      {
        hostContext: {
          theme: this.theme,
          platform: "desktop",
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen"],
          containerDimensions: initialDimensions(this.options),
          safeAreaInsets: zeroSafeAreaInsets(),
        },
      },
    );
    this.bridge = bridge;
    bridge.onrequestdisplaymode = async ({ mode }) => {
      if (mode !== "inline" && mode !== "fullscreen") {
        return { mode: this.snapshot.displayMode };
      }
      try {
        const actual = await this.options.onRequestDisplayMode?.(mode);
        return { mode: actual ?? this.snapshot.displayMode };
      } catch {
        return { mode: "inline" };
      }
    };
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
          // Several cards may share the trusted window. Never close another
          // card's transferred ports merely because this listener saw them.
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
        const bridgePort = event.ports[0];
        const navigationPort = event.ports[1];
        const replyPort = event.ports[2];
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
    let initializedTimeout: number | null = null;
    let resourceReadySent = false;
    let initializedHandled = false;
    const clearInitializedTimeout = () => {
      if (initializedTimeout !== null) {
        window.clearTimeout(initializedTimeout);
        initializedTimeout = null;
      }
    };
    const sandboxReady = () => {
      if (
        resourceReadySent ||
        startGeneration !== this.generation ||
        abortController.signal.aborted
      ) {
        return;
      }
      resourceReadySent = true;
      void bridge
        .sendSandboxResourceReady({
          html: resource.html,
          sandbox: MCP_APP_SANDBOX_INNER_SANDBOX,
        })
        .catch(fail);
    };
    const initialized = () => {
      if (
        initializedHandled ||
        startGeneration !== this.generation ||
        abortController.signal.aborted
      ) {
        return;
      }
      initializedHandled = true;
      clearInitializedTimeout();
      void (async () => {
        await this.enqueueToolData(bridge, startGeneration);
        if (startGeneration !== this.generation || abortController.signal.aborted) return;
        webview.style.display = "block";
        this.running = true;
        this.setSnapshot({ phase: "ready", canRetry: false });
        this.layoutFrameTo(container, "inline");
      })().catch(fail);
    };
    const sizeChanged = (event: { readonly width?: number; readonly height?: number }) => {
      const height = event.height;
      if (height !== undefined && (!Number.isFinite(height) || height < 0)) return;
      if (startGeneration !== this.generation || abortController.signal.aborted) return;
      this.setSnapshot({
        height: frameHeight(height ?? null, resource.heightHint, resource.minFrameHeight),
      });
    };
    bridge.addEventListener("sandboxready", sandboxReady);
    bridge.addEventListener("initialized", initialized);
    bridge.addEventListener("sizechange", sizeChanged);
    this.cleanupBridge = () => {
      clearInitializedTimeout();
      if (this.resizeFrame !== null) {
        window.cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = null;
      }
      bridge.removeEventListener("sandboxready", sandboxReady);
      bridge.removeEventListener("initialized", initialized);
      bridge.removeEventListener("sizechange", sizeChanged);
      this.themeObserver?.disconnect();
      this.themeObserver = null;
      removeHandoffListener?.();
      removeHandoffListener = null;
      rejectHandoff?.(new Error("MCP App bridge closed."));
      rejectHandoff = null;
    };
    initializedTimeout = window.setTimeout(() => {
      if (!this.running && startGeneration === this.generation && !abortController.signal.aborted) {
        fail();
      }
    }, MCP_APP_SANDBOX_INIT_TIMEOUT_MS);
    this.portalTarget?.append(frameWrapper);
    // A webview's initial navigation is reliable only after it is connected
    // to the DOM. The main-process attach listener is already installed.
    webview.setAttribute("src", registered.src);
    try {
      const ports = await handoff;
      if (abortController.signal.aborted || startGeneration !== this.generation) {
        ports.bridgePort.close();
        ports.navigationPort.close();
        ports.replyPort.close();
        return;
      }
      this.replyPort = ports.replyPort;
      this.navigationPort = ports.navigationPort;
      const navigationListener = (event: MessageEvent) => {
        if (event.ports.length !== 0) {
          ports.navigationPort.close();
          void this.failSandboxGeneration().catch(() => undefined);
          return;
        }
        const state = decodeMcpAppSandboxNavigationState(event.data);
        if (!state) {
          ports.navigationPort.close();
          void this.failSandboxGeneration().catch(() => undefined);
          return;
        }
        if (
          startGeneration !== this.generation ||
          abortController.signal.aborted ||
          this.navigationPort !== ports.navigationPort
        ) {
          ports.navigationPort.close();
          return;
        }
        if (
          this.snapshot.canGoBack === state.canGoBack &&
          this.snapshot.canGoForward === state.canGoForward
        ) {
          return;
        }
        this.setSnapshot({
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
        });
        this.scheduleGeometry();
      };
      this.navigationPortListener = navigationListener;
      ports.navigationPort.addEventListener("message", navigationListener);
      ports.navigationPort.start();
      const transport = new BoundedMessagePortTransport(ports.bridgePort);
      this.transport = transport;
      await bridge.connect(transport);
    } catch {
      if (abortController.signal.aborted || startGeneration !== this.generation) return;
      await this.failSandboxGeneration();
      return;
    }
    this.setUpGeometryObservers();
    if (typeof MutationObserver !== "undefined") {
      let lastTheme = this.theme;
      this.themeObserver = new MutationObserver(() => {
        const nextTheme = documentTheme(this.theme);
        if (nextTheme === lastTheme || !this.running || startGeneration !== this.generation) return;
        lastTheme = nextTheme;
        try {
          bridge.setHostContext({ theme: nextTheme });
        } catch {
          fail();
        }
      });
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme"],
      });
    }
  }

  private enqueueToolData(bridge: AppBridge, generation: number): Promise<void> {
    const next = this.toolDataSequence.then(() => this.sendToolData(bridge, generation));
    // Keep the queue usable after a terminal send failure without creating an
    // unhandled rejection for a later generation.
    this.toolDataSequence = next.catch(() => undefined);
    return next;
  }

  private async sendToolData(bridge: AppBridge, generation: number): Promise<void> {
    if (generation !== this.generation || !this.bridge || this.bridge !== bridge) return;
    const args = normalizeMcpToolArguments(this.projection.arguments);
    if (!args) {
      await bridge.sendToolResult({
        content: [{ type: "text", text: "Tool input was unavailable." }],
        isError: true,
      });
      return;
    }
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(mapMossMcpResultToCallToolResult(this.projection));
  }

  async retry(container = this.currentContainer): Promise<void> {
    if (!container || !this.snapshot.canRetry) return;
    this.generation = Math.min(this.generation + 1, 1_000_000);
    await this.start(container);
  }

  async teardown(): Promise<void> {
    const wasRunning = this.running;
    const container = this.currentContainer;
    this.abortController?.abort();
    this.abortController = null;
    if (this.geometryFollowFrame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.geometryFollowFrame);
    }
    this.geometryFollowFrame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.geometryMutationObserver?.disconnect();
    this.geometryMutationObserver = null;
    this.geometryOffsetParent = null;
    if (this.geometryScrollTarget && this.geometryScrollListener) {
      this.geometryScrollTarget.removeEventListener("scroll", this.geometryScrollListener);
    }
    if (this.geometryWindowResizeListener) {
      window.removeEventListener("resize", this.geometryWindowResizeListener);
    }
    this.geometryScrollTarget = null;
    this.geometryScrollListener = null;
    this.geometryWindowResizeListener = null;
    try {
      this.cleanupBridge?.();
    } catch {
      // A partially initialized bridge must not prevent descriptor/guest cleanup.
    }
    this.cleanupBridge = null;
    const bridge = this.bridge;
    const transport = this.transport;
    const navigationPort = this.navigationPort;
    const navigationPortListener = this.navigationPortListener;
    const descriptor = this.descriptor;
    const webview = this.webview;
    const frameWrapper = this.frameWrapper;
    this.bridge = null;
    this.transport = null;
    this.navigationPort = null;
    this.navigationPortListener = null;
    this.descriptor = null;
    this.webview = null;
    this.frameWrapper = null;
    this.portalTarget = null;
    this.geometryTarget = null;
    // Isolate and close the privileged navigation channel synchronously before
    // any graceful bridge/transport await. An old generation must not be able
    // to publish navigation state after teardown has yielded.
    try {
      if (navigationPortListener) {
        navigationPort?.removeEventListener("message", navigationPortListener);
      }
      navigationPort?.close();
    } catch {
      // Continue cleanup even when the privileged navigation port is already closed.
    }
    if (wasRunning && bridge) {
      await requestMcpAppTeardown(bridge);
    }
    try {
      await bridge?.close();
    } catch {
      // Continue cleanup even when a peer already closed the bridge.
    }
    try {
      await transport?.close();
    } catch {
      // Continue cleanup even when MessagePort.close reports a terminal error.
    }
    try {
      this.replyPort?.close();
    } catch {
      // The port may have been transferred to main already.
    }
    this.replyPort = null;
    this.toolDataSequence = Promise.resolve();
    if (descriptor && window.desktopBridge?.mcpApps) {
      try {
        await window.desktopBridge.mcpApps.unregister({
          sandboxId: descriptor.sandboxId,
          initId: descriptor.initId,
          generation: descriptor.generation,
        });
      } catch {
        // Main owns the final teardown; renderer cleanup must still complete.
      }
    }
    this.running = false;
    // Only remove the webview owned by this generation. A different card can
    // mount a replacement into the shared transcript container while graceful
    // teardown waits for the app's teardownResource acknowledgement; clearing
    // the whole container would then delete that newer guest.
    try {
      frameWrapper?.remove();
      webview?.remove();
    } catch {
      // The host container may already have been detached.
    }
    if (this.currentContainer === container) this.currentContainer = null;
    if (this.inlineContainer === container) this.inlineContainer = null;
    this.navigationPortalTarget = null;
    this.setSnapshot({
      displayMode: "inline",
      canGoBack: false,
      canGoForward: false,
      browserHtml: null,
    });
  }

  /**
   * Codex widget.js `Jl` iframe branch. Fetch the resource the same way the
   * desktop host does; a replayed tool result can still carry the HTML as an
   * embedded resource when no live `mcpServer/resource/read` session exists.
   */
  private async startBrowserFrame(
    descriptor: NonNullable<WorkLogMcpToolResult["app"]>,
  ): Promise<void> {
    const startGeneration = this.generation;
    const threadId = ThreadId.makeUnsafe(this.options.identity.threadId);
    this.setSnapshot({
      phase: "loading",
      canRetry: false,
      generation: startGeneration,
      displayMode: "inline",
      browserHtml: null,
    });
    const abortController = new AbortController();
    this.abortController = abortController;
    const resourceInput = {
      callId: this.options.identity.callId,
      resourceUri: this.options.identity.resourceUri,
      server: this.projection.server,
      source: descriptor.source,
      threadId,
      ...(descriptor.connectorId ? { connectorId: descriptor.connectorId } : {}),
    } as const;
    let html: string | null = null;
    let height: number = MCP_APP_FRAME_DEFAULT_HEIGHT;
    let prefersBorder = false;
    let isCollapsible = true;
    try {
      const resource = await fetchMcpAppResource(resourceInput, { signal: abortController.signal });
      if (abortController.signal.aborted || startGeneration !== this.generation) return;
      if (resource.state === "too_large") {
        this.setSnapshot({
          phase: "too_large",
          errorMessage: "Failed to load MCP app: HTML exceeds the maximum supported size.",
          canRetry: false,
          browserHtml: null,
        });
        return;
      }
      if (resource.state === "no_content") {
        // Codex widget.js `Jl` only paints a live `mcpServer/resource/read`.
        // A settled Moss replay has no app-server session, so the same card
        // uses the tool result's embedded HTML resource instead of an empty frame.
        html = embeddedMcpAppHtml(this.projection);
        if (!html) {
          this.setSnapshot({
            phase: "no_content",
            errorMessage: "MCP app returned no HTML content",
            canRetry: false,
            browserHtml: null,
          });
          return;
        }
      } else {
        html = resource.html;
        height = frameHeight(null, resource.heightHint, resource.minFrameHeight);
        prefersBorder = resource.prefersBorder;
        isCollapsible = resource.isCollapsible;
      }
    } catch (error) {
      if (abortController.signal.aborted || startGeneration !== this.generation) return;
      html = embeddedMcpAppHtml(this.projection);
      if (!html) {
        this.setSnapshot({
          phase: "resource_error",
          errorMessage: safeErrorMessage(error, "resource"),
          canRetry: false,
          browserHtml: null,
        });
        return;
      }
    }
    if (abortController.signal.aborted || startGeneration !== this.generation || !html) return;
    this.running = true;
    this.setSnapshot({
      phase: "ready",
      canRetry: false,
      browserHtml: html,
      height,
      prefersBorder,
      isCollapsible,
      displayMode: "inline",
    });
  }

  private async failSandboxGeneration(): Promise<void> {
    if (this.snapshot.phase === "sandbox_error") return;
    await this.teardown();
    // Keep the failed generation retryable while ensuring no guest, port, or
    // descriptor survives the failure path.
    this.setSnapshot({
      phase: "sandbox_error",
      errorMessage: "Unable to start MCP app sandbox.",
      canRetry: true,
    });
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
