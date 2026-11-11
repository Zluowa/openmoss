// FILE: protocol.ts
// Purpose: Serve the Moss proxy page (`moss-mcp-sandbox://<label>/mcp_apps`) and
// the sandbox's own font asset. Widget HTML arrives only over the validated
// bridge port at runtime; it is never served by this handler.
// Layer: Electron main-process support.
//
// Two-level model, behaviourally matching the reference host's proxy page:
//   proxy page (this document, real origin `moss-mcp-sandbox://<label>`)
//     └─ widget frame. Isolated (default): <iframe sandbox="allow-scripts allow-forms"
//        srcdoc=…>, opaque origin "null". Stable-origin: allow-same-origin and
//        document.write, origin = the proxy page's origin.
// The proxy relays JSON-RPC between the host's MessagePort and the widget frame,
// buffers host traffic until an isolated widget runs, heals streamed tool input,
// pins its own color-scheme to the host theme and drives the print theme.

import {
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_ASSET_ORIGIN,
  MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE,
  MCP_APP_SANDBOX_FONT_PATH,
  MCP_APP_SANDBOX_INNER_SANDBOX,
  MCP_APP_SANDBOX_MAX_MESSAGE_BYTES,
  MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
  MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
  MCP_APP_SANDBOX_PATH,
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_PRINT_THEME_TYPE,
  MCP_APP_SANDBOX_PROXY_READY_METHOD,
  MCP_APP_SANDBOX_READY_FLUSH_TIMEOUT_MS,
  MCP_APP_SANDBOX_RESOURCE_READY_METHOD,
  MCP_APP_SANDBOX_SCHEME,
  MCP_APP_SANDBOX_STABLE_INNER_SANDBOX,
  MCP_APP_SANDBOX_TOOL_INPUT_DELTA_METHOD,
  MCP_APP_SANDBOX_TOOL_INPUT_METHOD,
  MCP_APP_SANDBOX_TOOL_INPUT_PARTIAL_METHOD,
  type McpAppSandboxPermissions,
} from "@moss/contracts";

import { buildMcpAppSandboxCsp } from "./csp";
import type { McpAppSandboxVariant } from "./origin";
import { MCP_APP_JSON_HEALER_SOURCE, MCP_APP_PRINT_RECEIVER_HTML } from "./proxyScripts";
import type { McpAppSandboxRegistry } from "./registry";

export interface McpAppSandboxShellConfig {
  readonly variant: McpAppSandboxVariant;
  /** Permissions the widget may be delegated (declared and not withheld). */
  readonly permissions: McpAppSandboxPermissions;
  /** False when frame sites are allowed (fullscreen is withheld with them). */
  readonly allowFullscreen: boolean;
}

function scriptJson(value: unknown): string {
  // Safe inside a <script> element: no "</script", "<!--" or line separators.
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/**
 * The proxy page's script. Every value it depends on is baked in by main, so a
 * widget cannot influence its configuration through the URL.
 */
function proxyScript(config: McpAppSandboxShellConfig): string {
  const settings = {
    variant: config.variant,
    innerSandbox:
      config.variant === "stable"
        ? MCP_APP_SANDBOX_STABLE_INNER_SANDBOX
        : MCP_APP_SANDBOX_INNER_SANDBOX,
    permissions: config.permissions,
    allowFullscreen: config.allowFullscreen,
    maxHtmlBytes: MCP_APP_RESOURCE_MAX_HTML_BYTES,
    maxMessageBytes: MCP_APP_SANDBOX_MAX_MESSAGE_BYTES,
    flushTimeoutMs: MCP_APP_SANDBOX_READY_FLUSH_TIMEOUT_MS,
    printThemeType: MCP_APP_SANDBOX_PRINT_THEME_TYPE,
    receiverHtml: MCP_APP_PRINT_RECEIVER_HTML,
    scheme: `${MCP_APP_SANDBOX_SCHEME}:`,
    path: MCP_APP_SANDBOX_PATH,
    portName: MCP_APP_SANDBOX_PORT_NAME,
    navigationPortName: MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
    portNames: MCP_APP_SANDBOX_PORT_NAMES,
    ackType: MCP_APP_SANDBOX_ACK_TYPE,
    envelopeType: MCP_APP_SANDBOX_BRIDGE_MESSAGE_TYPE,
    navigationStateType: MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
    navigationCommandType: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
    proxyReadyMethod: MCP_APP_SANDBOX_PROXY_READY_METHOD,
    resourceReadyMethod: MCP_APP_SANDBOX_RESOURCE_READY_METHOD,
    deltaMethod: MCP_APP_SANDBOX_TOOL_INPUT_DELTA_METHOD,
    partialMethod: MCP_APP_SANDBOX_TOOL_INPUT_PARTIAL_METHOD,
    toolInputMethod: MCP_APP_SANDBOX_TOOL_INPUT_METHOD,
  };
  return `(() => {
"use strict";
const config = ${scriptJson(settings)};
${MCP_APP_JSON_HEALER_SOURCE}

// Captured before any widget runs. A stable-origin widget shares this realm's
// origin and could patch prototypes later; bound originals keep the ports and
// the activation reading out of its reach.
const callOf = (fn) => Function.prototype.call.bind(fn);
const portPost = callOf(MessagePort.prototype.postMessage);
const portClose = callOf(MessagePort.prototype.close);
const portStart = callOf(MessagePort.prototype.start);
const getterOf = (proto, name) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    return descriptor && descriptor.get ? callOf(descriptor.get) : null;
  } catch { return null; }
};
const activationIsActive = typeof UserActivation === "function" ? getterOf(UserActivation.prototype, "isActive") : null;
const eventActivation = getterOf(MessageEvent.prototype, "userActivation");
// Reading event fields through the original getters means a patched getter can
// never run with a bridge port's event as \`this\` (whose target is the port).
const eventData = getterOf(MessageEvent.prototype, "data");
const eventPortsGetter = getterOf(MessageEvent.prototype, "ports");
const eventSource = getterOf(MessageEvent.prototype, "source");
const eventOrigin = getterOf(MessageEvent.prototype, "origin");
const portCount = (event) => {
  const ports = eventPortsGetter(event);
  return ports ? ports.length : 0;
};
const ownActivation = navigator.userActivation || null;
const isStable = config.variant === "stable";
const INNER_ORIGIN = isStable ? location.origin : "null";

const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
const identity = {
  origin: location.origin,
  sandboxId: location.hostname,
  initId: fragment.get("init") || "",
  generation: Number(params.get("generation")),
};
const bridgeChannel = new MessageChannel();
const navigationChannel = new MessageChannel();
const replyChannel = new MessageChannel();
const bridgePort = bridgeChannel.port2;
const navigationPort = navigationChannel.port2;
const replyPort = replyChannel.port2;
const pendingToHost = [];
let closed = false;
let acknowledged = false;
let proxyReadySent = false;
let initSent = false;
let navigationState = null;
let observedDocument = null;
let observedNavigation = null;
const navigationListeners = [];
const ackTimer = setTimeout(() => failClosed(), 15000);

const ownKeys = (value, required, optional) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const extra = optional || [];
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || extra.includes(key));
};
const utf8Bytes = (value) => {
  try { return new TextEncoder().encode(value).byteLength; } catch { return Infinity; }
};
const boundedMessage = (value, limit) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try { return utf8Bytes(JSON.stringify(value)) <= limit; } catch { return false; }
};

// ---- widget frame --------------------------------------------------------
const createInner = () => {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", config.innerSandbox);
  frame.style.cssText = "display:block;width:100%;height:100%;border:0;margin:0;padding:0;overflow:hidden;background-color:transparent";
  return frame;
};
// A blank placeholder keeps the layout identical before the first injection.
let inner = createInner();
document.body.appendChild(inner);
let innerReady = false;
let channelDead = false;
let pendingForInner = [];

const postToInner = (data) => {
  const target = inner.contentWindow;
  if (!target) return;
  try { target.postMessage(data, isStable ? location.origin : "*"); } catch {}
};
// Flush on the earliest of: the widget's first message, the frame's first load,
// or the flush timeout. Safe to call repeatedly.
const markInnerReady = () => {
  if (closed || channelDead || innerReady || !inner.contentWindow) return;
  innerReady = true;
  const queued = pendingForInner;
  pendingForInner = [];
  for (const message of queued) postToInner(message);
};
const isPartial = (data) => Boolean(data) && data.method === config.partialMethod;
const sendToInner = (data) => {
  if (closed || channelDead || !inner.contentWindow) return;
  if (isStable || innerReady) {
    postToInner(data);
    return;
  }
  // Long streams before the widget runs keep only the newest partial input.
  const last = pendingForInner[pendingForInner.length - 1];
  if (pendingForInner.length >= 64 && isPartial(data) && isPartial(last)) {
    pendingForInner[pendingForInner.length - 1] = data;
    return;
  }
  if (pendingForInner.length >= 256) {
    failClosed();
    return;
  }
  pendingForInner.push(data);
};
const allowFor = (requested) => {
  const features = [];
  const mapping = [["camera", "camera"], ["microphone", "microphone"], ["geolocation", "geolocation"], ["clipboardWrite", "clipboard-write"]];
  if (requested && typeof requested === "object" && !Array.isArray(requested)) {
    for (const [key, feature] of mapping) {
      if (requested[key] !== undefined && requested[key] !== null && requested[key] !== false && config.permissions[key] === true) {
        features.push(feature + " *");
      }
    }
  }
  // fullscreen's default allowlist never matches an opaque origin.
  if (!isStable && config.allowFullscreen) features.unshift("fullscreen *");
  return features.join("; ");
};
const injectIsolated = (html, allow) => {
  const frame = createInner();
  if (allow) frame.setAttribute("allow", allow);
  innerReady = false;
  channelDead = false;
  // Traffic queued for a superseded document dies with it.
  pendingForInner = [];
  let ownLoadSeen = false;
  frame.addEventListener("load", () => {
    if (frame !== inner) return;
    if (!ownLoadSeen) {
      ownLoadSeen = true;
      markInnerReady();
      return;
    }
    // A second load is a navigation the proxy did not start: the channel is dead.
    channelDead = true;
    innerReady = false;
    pendingForInner = [];
  });
  setTimeout(() => { if (frame === inner) markInnerReady(); }, config.flushTimeoutMs);
  // srcdoc before insertion, so the element's first load is the widget's.
  frame.srcdoc = html + config.receiverHtml;
  inner.replaceWith(frame);
  inner = frame;
};
const injectStable = (html, allow) => {
  const frame = createInner();
  if (allow) frame.setAttribute("allow", allow);
  detachNavigation();
  inner.after(frame);
  if (document.hasFocus() && document.activeElement === inner) frame.focus({ preventScroll: true });
  inner.remove();
  inner = frame;
  // Forces layout so the widget's first script sees its real width.
  void inner.offsetWidth;
  const widgetDocument = inner.contentDocument;
  if (!widgetDocument) return;
  widgetDocument.open();
  widgetDocument.write(html + config.receiverHtml);
  widgetDocument.close();
  observeNavigation();
};

// ---- streamed tool input --------------------------------------------------
const healer = createMossJsonHealer();
const handleDelta = (params) => {
  const delta = params && params.delta;
  if (typeof delta !== "string" || delta.length === 0) return;
  healer.write(delta);
  let args;
  try { args = JSON.parse(healer.healed()); } catch {
    console.error("[moss-widget-proxy] healed tool-input-delta did not parse");
    return;
  }
  if (typeof args !== "object" || args === null) {
    console.error("[moss-widget-proxy] healed tool-input-delta was not an object");
    return;
  }
  sendToInner({ jsonrpc: "2.0", method: config.partialMethod, params: { arguments: args } });
};

// ---- theme pinning and print ---------------------------------------------
let printSaved = null;
const applyHostTheme = (theme) => {
  let value;
  if (theme === "light" || theme === "dark") value = theme;
  else if (theme !== null && theme !== undefined) value = "";
  else return;
  if (printSaved) {
    printSaved.outerScheme = value;
    return;
  }
  document.documentElement.style.colorScheme = value;
};
const sniffHostTheme = (data) => {
  const result = data.result;
  if (result && typeof result === "object" && result.hostContext && typeof result.hostContext === "object") {
    applyHostTheme(result.hostContext.theme);
  } else if (data.method === "ui/notifications/host-context-changed" && data.params && typeof data.params === "object") {
    applyHostTheme(data.params.theme);
  }
};
window.addEventListener("beforeprint", () => {
  if (printSaved || closed) return;
  sendToInner({ type: config.printThemeType, phase: "before" });
  printSaved = { outerScheme: document.documentElement.style.colorScheme };
  document.documentElement.style.colorScheme = "light";
});
window.addEventListener("afterprint", () => {
  if (!printSaved) return;
  const saved = printSaved;
  printSaved = null;
  sendToInner({ type: config.printThemeType, phase: "after", theme: saved.outerScheme });
  document.documentElement.style.colorScheme = saved.outerScheme;
});

// ---- navigation (stable-origin widgets only) ------------------------------
const sendNavigationState = (canGoBack, canGoForward, force) => {
  const next = { canGoBack: canGoBack === true, canGoForward: canGoForward === true };
  if (!force && navigationState && navigationState.canGoBack === next.canGoBack && navigationState.canGoForward === next.canGoForward) return;
  navigationState = next;
  if (closed || !acknowledged) return;
  try {
    portPost(navigationPort, { type: config.navigationStateType, canGoBack: next.canGoBack, canGoForward: next.canGoForward });
  } catch { failClosed(); }
};
function detachNavigation() {
  for (const [target, type, listener] of navigationListeners.splice(0)) {
    try { target.removeEventListener(type, listener); } catch {}
  }
  observedDocument = null;
  observedNavigation = null;
  sendNavigationState(false, false, false);
}
const publishNavigation = () => {
  if (closed || !isStable || !observedNavigation || observedDocument !== inner.contentDocument) {
    sendNavigationState(false, false, false);
    return;
  }
  try {
    sendNavigationState(observedNavigation.canGoBack === true, observedNavigation.canGoForward === true, false);
  } catch { sendNavigationState(false, false, false); }
};
function observeNavigation() {
  if (!isStable || closed) return;
  let widgetDocument;
  let navigation;
  try {
    widgetDocument = inner.contentDocument;
    navigation = inner.contentWindow && inner.contentWindow.navigation;
    if (!widgetDocument || !navigation || typeof navigation.addEventListener !== "function") return;
  } catch { return; }
  observedDocument = widgetDocument;
  observedNavigation = navigation;
  const listener = () => publishNavigation();
  for (const type of ["currententrychange", "navigatesuccess", "navigateerror"]) {
    try {
      navigation.addEventListener(type, listener);
      navigationListeners.push([navigation, type, listener]);
    } catch {}
  }
  publishNavigation();
}

// ---- host port -------------------------------------------------------------
const failClosed = () => {
  if (closed) return;
  closed = true;
  clearTimeout(ackTimer);
  for (const [target, type, listener] of navigationListeners.splice(0)) {
    try { target.removeEventListener(type, listener); } catch {}
  }
  pendingForInner = [];
  pendingToHost.length = 0;
  channelDead = true;
  try { inner.removeAttribute("srcdoc"); inner.src = "about:blank"; } catch {}
  for (const port of [bridgePort, navigationPort, replyPort]) {
    try { portClose(port); } catch {}
  }
};
const postToHost = (message, userActivation) => {
  if (closed) return;
  const envelope = { type: config.envelopeType, message, userActivation: userActivation === true };
  if (!acknowledged) {
    if (pendingToHost.length < 64) pendingToHost.push(envelope);
    else failClosed();
    return;
  }
  try { portPost(bridgePort, envelope); } catch { failClosed(); }
};
const sendProxyReady = () => {
  if (closed || !acknowledged || proxyReadySent) return;
  proxyReadySent = true;
  try {
    portPost(bridgePort, { type: config.envelopeType, message: { jsonrpc: "2.0", method: config.proxyReadyMethod, params: {} }, userActivation: false });
  } catch {
    failClosed();
    return;
  }
  while (!closed && pendingToHost.length > 0) {
    try { portPost(bridgePort, pendingToHost.shift()); } catch { failClosed(); }
  }
};
const handleHostMessage = (data) => {
  sniffHostTheme(data);
  if (data.method === config.resourceReadyMethod) {
    const resource = data.params;
    // csp and sandbox are ignored: the policy comes from this page's response headers.
    if (!ownKeys(resource, ["html"], ["permissions", "csp", "sandbox"]) ||
        typeof resource.html !== "string" || utf8Bytes(resource.html) > config.maxHtmlBytes) {
      failClosed();
      return;
    }
    const allow = allowFor(resource.permissions);
    if (isStable) injectStable(resource.html, allow);
    else injectIsolated(resource.html, allow);
    return;
  }
  if (data.method === config.deltaMethod) {
    handleDelta(data.params);
    return;
  }
  if (data.method === config.toolInputMethod) healer.reset();
  sendToInner(data);
};
bridgePort.onmessage = (event) => {
  if (closed) return;
  const data = eventData(event);
  const isResource = data && typeof data === "object" && data.method === config.resourceReadyMethod;
  const limit = isResource ? config.maxHtmlBytes + 4096 : config.maxMessageBytes;
  if (portCount(event) !== 0 || !boundedMessage(data, limit)) {
    failClosed();
    return;
  }
  handleHostMessage(data);
};
bridgePort.onmessageerror = () => failClosed();
portStart(bridgePort);
navigationPort.onmessage = (event) => {
  if (closed) return;
  const command = eventData(event);
  if (portCount(event) !== 0 || !ownKeys(command, ["delta", "type"]) ||
      command.type !== config.navigationCommandType || (command.delta !== -1 && command.delta !== 1)) {
    failClosed();
    return;
  }
  const navigation = observedNavigation;
  if (!isStable || !navigation || observedDocument !== inner.contentDocument) {
    publishNavigation();
    return;
  }
  let canNavigate = false;
  try { canNavigate = command.delta === -1 ? navigation.canGoBack === true : navigation.canGoForward === true; } catch {}
  if (!canNavigate) {
    publishNavigation();
    return;
  }
  try {
    const result = command.delta === -1 ? navigation.back() : navigation.forward();
    const finished = result && result.finished && typeof result.finished.then === "function" ? result.finished : result;
    Promise.resolve(finished).then(() => publishNavigation()).catch(() => publishNavigation());
  } catch { publishNavigation(); }
};
navigationPort.onmessageerror = () => failClosed();
portStart(navigationPort);
replyPort.onmessage = (event) => {
  if (closed) return;
  const data = eventData(event);
  if (portCount(event) !== 0 || acknowledged || !ownKeys(data, ["initId", "sandboxId", "type", "portNames"]) ||
      data.type !== config.ackType || data.sandboxId !== identity.sandboxId || data.initId !== identity.initId ||
      !Array.isArray(data.portNames) || data.portNames.length !== config.portNames.length ||
      data.portNames.some((name, index) => name !== config.portNames[index])) {
    failClosed();
    return;
  }
  acknowledged = true;
  clearTimeout(ackTimer);
  sendNavigationState(false, false, true);
  sendProxyReady();
};
replyPort.onmessageerror = () => failClosed();
portStart(replyPort);

// ---- widget -> host relay --------------------------------------------------
window.addEventListener("message", (event) => {
  if (closed || !event.isTrusted) return;
  const source = eventSource(event);
  if (source === window) return;
  if (channelDead || source === null || source !== inner.contentWindow || eventOrigin(event) !== INNER_ORIGIN) return;
  // A message from the widget proves its scripts run: flush the buffer first.
  markInnerReady();
  if (portCount(event) !== 0) {
    failClosed();
    return;
  }
  const data = eventData(event);
  if (!boundedMessage(data, config.maxMessageBytes)) {
    failClosed();
    return;
  }
  let active = false;
  try {
    const stamped = eventActivation ? eventActivation(event) : null;
    active = Boolean(stamped && activationIsActive && activationIsActive(stamped));
  } catch {}
  try {
    active = active || Boolean(ownActivation && activationIsActive && activationIsActive(ownActivation));
  } catch {}
  postToHost(data, active);
});
window.addEventListener("beforeunload", () => failClosed(), { once: true });

// ---- port hand-off to the trusted host --------------------------------------
if (!identity.sandboxId || !identity.initId || !Number.isSafeInteger(identity.generation) ||
    location.protocol !== config.scheme || location.pathname !== config.path) {
  failClosed();
} else if (!initSent) {
  initSent = true;
  try {
    window.postMessage(
      {
        type: "init",
        ports: { [config.portName]: bridgeChannel.port1, [config.navigationPortName]: navigationChannel.port1 },
        replyPort: replyChannel.port1,
      },
      location.origin,
      [bridgeChannel.port1, navigationChannel.port1, replyChannel.port1],
    );
  } catch { failClosed(); }
}
})();`;
}

export function buildMcpAppSandboxShellHtml(config: McpAppSandboxShellConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moss widget</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{display:flex;flex-direction:column}*{box-sizing:border-box}iframe{flex-grow:1}</style>
</head>
<body>
<script>${proxyScript(config)}</script>
</body>
</html>`;
}

export type McpAppSandboxProtocolResponse =
  | {
      readonly kind: "shell";
      readonly statusCode: 200;
      readonly mimeType: "text/html";
      readonly data: string;
      readonly headers: Record<string, string>;
    }
  | {
      readonly kind: "font";
      readonly statusCode: 200;
      readonly mimeType: "font/woff2";
      readonly headers: Record<string, string>;
    };

export const MCP_APP_SANDBOX_FONT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=86400",
  "Content-Type": "font/woff2",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

/** True for the exact asset URLs the sandbox serves to every widget. */
export function isMcpAppSandboxAssetUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    `${parsed.protocol}//${parsed.host}` === MCP_APP_SANDBOX_ASSET_ORIGIN &&
    parsed.pathname === MCP_APP_SANDBOX_FONT_PATH &&
    parsed.search === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}

export function resolveMcpAppSandboxProtocolRequest(
  requestUrl: string,
  registry: McpAppSandboxRegistry,
  partition?: string,
  method = "GET",
): McpAppSandboxProtocolResponse | null {
  if (method !== "GET") return null;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${MCP_APP_SANDBOX_SCHEME}:` ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }
  if (isMcpAppSandboxAssetUrl(requestUrl)) {
    return {
      kind: "font",
      statusCode: 200,
      mimeType: "font/woff2",
      headers: MCP_APP_SANDBOX_FONT_HEADERS,
    };
  }
  if (parsed.pathname !== MCP_APP_SANDBOX_PATH) return null;
  const registration = registry.lookupByUrl(
    requestUrl,
    partition === undefined ? {} : { partition },
  );
  if (!registration) return null;
  const csp = buildMcpAppSandboxCsp(registration.policy);
  if (!csp) return null;
  return {
    kind: "shell",
    statusCode: 200,
    mimeType: "text/html",
    data: buildMcpAppSandboxShellHtml({
      variant: registration.variant,
      permissions: registration.policy.permissions,
      allowFullscreen: !registration.policy.withholdDevicePermissions,
    }),
    headers: {
      ...csp.headers,
      "Content-Type": "text/html; charset=utf-8",
    },
  };
}
