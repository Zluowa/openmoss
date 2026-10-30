// FILE: protocol.ts
// Purpose: Serve the small Moss-owned outer proxy shell and its fixed same-origin
// inner installer route. App HTML arrives only over the validated bridge at runtime.

import {
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_CONTENT_INSTALL_TYPE,
  MCP_APP_SANDBOX_CONTENT_PATH,
  MCP_APP_SANDBOX_CONTENT_READY_TYPE,
  MCP_APP_SANDBOX_INNER_SANDBOX,
  MCP_APP_SANDBOX_MAX_MESSAGE_BYTES,
  MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
  MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
  MCP_APP_SANDBOX_PATH,
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_PROXY_READY_METHOD,
  MCP_APP_SANDBOX_SCHEME,
  MCP_APP_RESOURCE_MAX_HTML_BYTES,
} from "@synara/contracts";

import { buildMcpAppSandboxCsp } from "./csp";
import { isExactMcpAppSandboxContentUrl } from "./policy";
import { McpAppSandboxRegistry } from "./registry";

const MCP_APP_CONTENT_INSTALLER_HTML = `<!doctype html>
<html lang="en" style="width:100%;height:100%;margin:0;overflow:hidden">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP App</title></head>
<body style="width:100%;height:100%;margin:0;overflow:hidden;background:transparent">
<script>
(() => {
  const maxHtmlBytes = ${MCP_APP_RESOURCE_MAX_HTML_BYTES};
  const origin = location.origin;
  const params = new URLSearchParams(location.search);
  const identity = {
    origin,
    sandboxId: location.hostname,
    generation: params.get("generation") || "",
    initId: params.get("init") || ""
  };
  const validIdentity = () => {
    const keys = [...params.keys()];
    let currentUrl;
    try { currentUrl = new URL(location.href); } catch { return false; }
    return origin !== "null" &&
      currentUrl.protocol === "${MCP_APP_SANDBOX_SCHEME}:" &&
      currentUrl.pathname === "${MCP_APP_SANDBOX_CONTENT_PATH}" &&
      currentUrl.username === "" && currentUrl.password === "" && currentUrl.port === "" &&
      currentUrl.hash === "" && currentUrl.hostname.length > 0 &&
      keys.length === 2 && keys[0] === "generation" && keys[1] === "init" &&
      Number.isSafeInteger(Number(identity.generation)) && Number(identity.generation) >= 0 &&
      identity.initId.length > 0 && identity.initId.length <= 200;
  };
  const exactKeys = (value, required) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === required.length && required.every((key) => keys.includes(key));
  };
  const utf8Bytes = (value) => {
    try { return new TextEncoder().encode(value).byteLength; } catch { return Infinity; }
  };
  if (!validIdentity()) return;
  let installed = false;
  const onInstall = (event) => {
    if (installed || event.source !== window.parent || event.origin !== origin || event.ports.length !== 0) return;
    const data = event.data;
    if (!exactKeys(data, ["generation", "html", "initId", "sandboxId", "type"]) ||
        data.type !== "${MCP_APP_SANDBOX_CONTENT_INSTALL_TYPE}" ||
        data.sandboxId !== identity.sandboxId || data.initId !== identity.initId ||
        data.generation !== Number(identity.generation) || typeof data.html !== "string" ||
        utf8Bytes(data.html) > maxHtmlBytes) return;
    installed = true;
    window.removeEventListener("message", onInstall);
    try {
      document.open();
      document.write(data.html);
      document.close();
    } catch {
      // A failed installation leaves the outer shell fail-closed with no App document.
    }
  };
  window.addEventListener("message", onInstall);
  try {
    window.parent.postMessage({
      type: "${MCP_APP_SANDBOX_CONTENT_READY_TYPE}",
      sandboxId: identity.sandboxId,
      initId: identity.initId,
      generation: Number(identity.generation)
    }, origin);
  } catch {
    window.removeEventListener("message", onInstall);
  }
})();
</script>
</body>
</html>`;

const MCP_APP_SHELL_HTML = `<!doctype html>
<html lang="en" style="width:100%;height:100%;margin:0;overflow:hidden">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP App</title></head>
<body style="width:100%;height:100%;margin:0;overflow:hidden;background:transparent">
<iframe id="mcp-app-frame" title="MCP App" sandbox="allow-scripts allow-same-origin allow-forms" style="display:block;width:100%;height:100%;margin:0;border:0;overflow:hidden"></iframe>
<script>
(() => {
  const frame = document.getElementById("mcp-app-frame");
  if (!(frame instanceof HTMLIFrameElement)) return;
  const params = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
  const identity = {
    origin: location.origin,
    sandboxId: location.hostname,
    initId: fragment.get("init") || "",
    generation: Number(params.get("generation"))
  };
  const innerUrl = location.origin + "${MCP_APP_SANDBOX_CONTENT_PATH}?generation=" +
    encodeURIComponent(String(identity.generation)) + "&init=" + encodeURIComponent(identity.initId);
  const bridgeChannel = new MessageChannel();
  const navigationChannel = new MessageChannel();
  const replyChannel = new MessageChannel();
  const bridgePort = bridgeChannel.port2;
  const navigationPort = navigationChannel.port2;
  const replyPort = replyChannel.port2;
  const pendingToInner = [];
  const pendingToHost = [];
  let innerReady = false;
  let appInstalled = false;
  let innerLoadSeen = false;
  let closed = false;
  let initialized = false;
  let acknowledged = false;
  let proxyReadySent = false;
  let resourceReadyConsumed = false;
  let installerReadyReceived = false;
  let installSent = false;
  let pendingHtml = null;
  let navigationState = null;
  let navigationObservedDocument = null;
  let navigationObserved = null;
  const navigationListeners = [];
  const ackTimer = setTimeout(() => failClosed(), 15000);

  const ownKeys = (value, required, optional = []) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key)) &&
      keys.every((key) => required.includes(key) || optional.includes(key));
  };
  const utf8Bytes = (value) => {
    try { return new TextEncoder().encode(value).byteLength; } catch { return Infinity; }
  };
  const boundedMessage = (value, allowResourceReady = false) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.method === "ui/notifications/sandbox-resource-ready") {
      if (!allowResourceReady ||
          !ownKeys(value, ["method", "params"], ["jsonrpc"]) ||
          (value.jsonrpc !== undefined && value.jsonrpc !== "2.0") ||
          !ownKeys(value.params, ["html", "sandbox"]) ||
          typeof value.params.html !== "string" ||
          value.params.sandbox !== "${MCP_APP_SANDBOX_INNER_SANDBOX}" ||
          utf8Bytes(value.params.html) > ${MCP_APP_RESOURCE_MAX_HTML_BYTES}) return false;
      return utf8Bytes(JSON.stringify(value)) <= ${MCP_APP_RESOURCE_MAX_HTML_BYTES + 4096};
    }
    try { return utf8Bytes(JSON.stringify(value)) <= ${MCP_APP_SANDBOX_MAX_MESSAGE_BYTES}; } catch { return false; }
  };
  const sameInnerOrigin = () => {
    try {
      return Boolean(frame.contentWindow && frame.contentWindow.location.origin === location.origin);
    } catch { return false; }
  };
  const onInitialInnerRoute = () => {
    try {
      return Boolean(frame.contentWindow && frame.contentWindow.location.href.split("#", 1)[0] === innerUrl);
    } catch { return false; }
  };
  const sendNavigationState = (canGoBack, canGoForward, force = false) => {
    const next = { canGoBack: canGoBack === true, canGoForward: canGoForward === true };
    if (!force && navigationState &&
        navigationState.canGoBack === next.canGoBack &&
        navigationState.canGoForward === next.canGoForward) return;
    navigationState = next;
    if (closed || !acknowledged) return;
    try {
      navigationPort.postMessage({
        type: "${MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE}",
        canGoBack: next.canGoBack,
        canGoForward: next.canGoForward
      });
    } catch { failClosed(); }
  };
  const removeNavigationListeners = () => {
    for (const [target, type, listener] of navigationListeners.splice(0)) {
      try { target.removeEventListener(type, listener); } catch {}
    }
    navigationObservedDocument = null;
    navigationObserved = null;
  };
  const detachNavigation = () => {
    removeNavigationListeners();
    sendNavigationState(false, false);
  };
  const publishNavigationState = (force = false) => {
    if (closed || !appInstalled || !sameInnerOrigin()) {
      sendNavigationState(false, false, force);
      return;
    }
    const observedDocument = navigationObservedDocument;
    const navigation = navigationObserved;
    if (!observedDocument || !navigation || observedDocument !== frame.contentDocument) {
      sendNavigationState(false, false, force);
      return;
    }
    try {
      sendNavigationState(navigation.canGoBack === true, navigation.canGoForward === true, force);
    } catch {
      sendNavigationState(false, false, force);
    }
  };
  const observeNavigation = () => {
    removeNavigationListeners();
    if (closed || !appInstalled || !sameInnerOrigin()) {
      sendNavigationState(false, false);
      return;
    }
    let observedDocument;
    let navigation;
    try {
      observedDocument = frame.contentDocument;
      navigation = frame.contentWindow && frame.contentWindow.navigation;
      if (!observedDocument || !navigation || typeof navigation.addEventListener !== "function") throw new Error("Navigation API unavailable");
      if (frame.contentWindow.location.origin !== location.origin) throw new Error("Inner origin changed");
    } catch {
      sendNavigationState(false, false);
      return;
    }
    navigationObservedDocument = observedDocument;
    navigationObserved = navigation;
    const listener = () => {
      if (navigationObservedDocument !== observedDocument || navigationObserved !== navigation || frame.contentDocument !== observedDocument) return;
      publishNavigationState();
    };
    for (const type of ["currententrychange", "navigatesuccess", "navigateerror"]) {
      try {
        navigation.addEventListener(type, listener);
        navigationListeners.push([navigation, type, listener]);
      } catch {
        removeNavigationListeners();
        sendNavigationState(false, false);
        return;
      }
    }
    publishNavigationState();
  };
  const flushToInner = () => {
    if (!frame.contentWindow || closed || !innerReady) return;
    while (pendingToInner.length > 0) postToInner(pendingToInner.shift());
  };
  const failClosed = () => {
    if (closed) return;
    closed = true;
    clearTimeout(ackTimer);
    removeNavigationListeners();
    try { frame.src = "about:blank"; } catch {}
    pendingToInner.length = 0;
    pendingToHost.length = 0;
    pendingHtml = null;
    innerReady = false;
    try { bridgePort.close(); } catch {}
    try { navigationPort.close(); } catch {}
    try { replyPort.close(); } catch {}
  };
  const postToHost = (value) => {
    if (closed || !boundedMessage(value)) return;
    if (!acknowledged) {
      if (pendingToHost.length < 64) pendingToHost.push(value);
      else failClosed();
      return;
    }
    try { bridgePort.postMessage(value); } catch { failClosed(); }
  };
  const sendProxyReady = () => {
    if (closed || !acknowledged || proxyReadySent) return;
    proxyReadySent = true;
    try {
      bridgePort.postMessage({ jsonrpc: "2.0", method: "${MCP_APP_SANDBOX_PROXY_READY_METHOD}", params: {} });
    } catch {
      failClosed();
      return;
    }
    while (!closed && pendingToHost.length > 0) {
      const next = pendingToHost.shift();
      if (!next) continue;
      try { bridgePort.postMessage(next); } catch { failClosed(); }
    }
  };
  const postToInner = (value) => {
    if (closed || !frame.contentWindow || !innerReady || !boundedMessage(value, false)) return;
    try { frame.contentWindow.postMessage(value, location.origin); } catch { failClosed(); }
  };
  const sendInstall = () => {
    if (closed || !acknowledged || !installerReadyReceived || installSent || pendingHtml === null || appInstalled) return;
    const html = pendingHtml;
    pendingHtml = null;
    installSent = true;
    detachNavigation();
    try {
      frame.contentWindow.postMessage({
        type: "${MCP_APP_SANDBOX_CONTENT_INSTALL_TYPE}",
        sandboxId: identity.sandboxId,
        initId: identity.initId,
        generation: identity.generation,
        html
      }, location.origin);
    } catch { failClosed(); }
  };
  const exactInstallerReady = (value) =>
    ownKeys(value, ["generation", "initId", "sandboxId", "type"]) &&
    value.type === "${MCP_APP_SANDBOX_CONTENT_READY_TYPE}" &&
    value.sandboxId === identity.sandboxId && value.initId === identity.initId &&
    value.generation === identity.generation;
  const sendInit = () => {
    if (initialized || closed) return;
    if (!identity.sandboxId || !identity.initId || !Number.isSafeInteger(identity.generation)) {
      failClosed();
      return;
    }
    initialized = true;
    try {
      window.postMessage(
        {
          type: "init",
          ports: {
            "${MCP_APP_SANDBOX_PORT_NAME}": bridgeChannel.port1,
            "${MCP_APP_SANDBOX_NAVIGATION_PORT_NAME}": navigationChannel.port1
          },
          replyPort: replyChannel.port1
        },
        location.origin,
        [bridgeChannel.port1, navigationChannel.port1, replyChannel.port1],
      );
    } catch { failClosed(); }
  };
  frame.addEventListener("load", () => {
    if (closed) return;
    if ((!appInstalled && !onInitialInnerRoute()) || (appInstalled && !sameInnerOrigin())) {
      detachNavigation();
      appInstalled = false;
      innerReady = false;
      return;
    }
    if (installSent && !appInstalled) {
      appInstalled = true;
      innerReady = true;
      observeNavigation();
      flushToInner();
      return;
    }
    if (appInstalled) {
      innerReady = true;
      observeNavigation();
      flushToInner();
      return;
    }
    innerLoadSeen = true;
    innerReady = false;
    sendNavigationState(false, false);
    sendInstall();
  });
  frame.addEventListener("error", () => {
    if (closed) return;
    detachNavigation();
    appInstalled = false;
    innerReady = false;
  });
  bridgePort.onmessage = (hostEvent) => {
    if (closed || !boundedMessage(hostEvent.data, true)) {
      failClosed();
      return;
    }
    const message = hostEvent.data;
    if (message.method === "ui/notifications/sandbox-resource-ready") {
      if (resourceReadyConsumed || installSent || appInstalled ||
          !ownKeys(message.params, ["html", "sandbox"]) ||
          message.params.sandbox !== "${MCP_APP_SANDBOX_INNER_SANDBOX}") {
        failClosed();
        return;
      }
      resourceReadyConsumed = true;
      pendingHtml = message.params.html;
      sendInstall();
      return;
    }
    if (frame.contentWindow && innerReady) postToInner(message);
    else if (pendingToInner.length < 64) pendingToInner.push(message);
    else failClosed();
  };
  bridgePort.onmessageerror = () => failClosed();
  bridgePort.start();
  navigationPort.onmessage = (navigationEvent) => {
    if (closed || navigationEvent.ports.length !== 0) {
      failClosed();
      return;
    }
    const command = navigationEvent.data;
    if (!ownKeys(command, ["delta", "type"]) || command.type !== "${MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE}" ||
        (command.delta !== -1 && command.delta !== 1)) {
      failClosed();
      return;
    }
    const observedDocument = navigationObservedDocument;
    const navigation = navigationObserved;
    if (!appInstalled || !observedDocument || !navigation || observedDocument !== frame.contentDocument) return;
    let canNavigate = false;
    try { canNavigate = command.delta === -1 ? navigation.canGoBack === true : navigation.canGoForward === true; } catch { canNavigate = false; }
    if (!canNavigate) {
      publishNavigationState();
      return;
    }
    try {
      const result = command.delta === -1 ? navigation.back() : navigation.forward();
      const finished = result && typeof result.finished?.then === "function" ? result.finished : result;
      Promise.resolve(finished).then(() => publishNavigationState()).catch(() => {
        detachNavigation();
      });
    } catch {
      detachNavigation();
    }
  };
  navigationPort.onmessageerror = () => failClosed();
  navigationPort.start();
  replyPort.onmessage = (replyEvent) => {
    if (closed || replyEvent.ports.length !== 0 || !ownKeys(replyEvent.data, ["initId", "sandboxId", "type", "portNames"])) {
      failClosed();
      return;
    }
    const data = replyEvent.data;
    if (
      data.type !== "${MCP_APP_SANDBOX_ACK_TYPE}" ||
      data.sandboxId !== identity.sandboxId ||
      data.initId !== identity.initId ||
      !Array.isArray(data.portNames) ||
      data.portNames.length !== ${MCP_APP_SANDBOX_PORT_NAMES.length} ||
      data.portNames[0] !== "${MCP_APP_SANDBOX_PORT_NAME}" ||
      data.portNames[1] !== "${MCP_APP_SANDBOX_NAVIGATION_PORT_NAME}" ||
      acknowledged
    ) {
      failClosed();
      return;
    }
    acknowledged = true;
    clearTimeout(ackTimer);
    sendNavigationState(false, false, true);
    sendProxyReady();
    if (innerLoadSeen) sendInstall();
  };
  replyPort.onmessageerror = () => failClosed();
  replyPort.start();
  window.addEventListener("message", (event) => {
    if (closed || event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (event.ports.length !== 0) {
      failClosed();
      return;
    }
    if (exactInstallerReady(event.data)) {
      if (installerReadyReceived || installSent || appInstalled) {
        failClosed();
        return;
      }
      installerReadyReceived = true;
      sendInstall();
      return;
    }
    if (event.data && typeof event.data === "object" && event.data.type === "${MCP_APP_SANDBOX_CONTENT_READY_TYPE}") {
      failClosed();
      return;
    }
    if (!boundedMessage(event.data, false)) {
      failClosed();
      return;
    }
    postToHost(event.data);
  });
  window.addEventListener("beforeunload", () => {
    if (closed) return;
    closed = true;
    clearTimeout(ackTimer);
    removeNavigationListeners();
    try { frame.src = "about:blank"; } catch {}
    pendingToInner.length = 0;
    pendingToHost.length = 0;
    pendingHtml = null;
    innerReady = false;
    try { bridgePort.close(); } catch {}
    try { navigationPort.close(); } catch {}
    try { replyPort.close(); } catch {}
  }, { once: true });
  frame.setAttribute("src", innerUrl);
  sendInit();
})();
</script>
</body>
</html>`;

export interface McpAppSandboxProtocolResponse {
  readonly statusCode: number;
  readonly mimeType: "text/html";
  readonly data: string;
  readonly headers: Record<string, string>;
}

function contentLookupUrl(requestUrl: URL): string | null {
  const generation = requestUrl.searchParams.get("generation");
  const initId = requestUrl.searchParams.get("init");
  if (generation === null || initId === null) return null;
  return `${requestUrl.protocol}//${requestUrl.host}${MCP_APP_SANDBOX_PATH}?generation=${encodeURIComponent(generation)}#init=${encodeURIComponent(initId)}`;
}

export function resolveMcpAppSandboxProtocolRequest(
  requestUrl: string,
  registry: McpAppSandboxRegistry,
  partition?: string,
): McpAppSandboxProtocolResponse | null {
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
  const lookupOptions = partition === undefined ? {} : { partition };
  if (parsed.pathname === MCP_APP_SANDBOX_PATH) {
    const registration = registry.lookupByUrl(requestUrl, lookupOptions);
    if (!registration) return null;
    const csp = buildMcpAppSandboxCsp(registration.input.csp);
    if (!csp) return null;
    return {
      statusCode: 200,
      mimeType: "text/html",
      data: MCP_APP_SHELL_HTML,
      headers: {
        ...csp.headers,
        "Content-Type": "text/html; charset=utf-8",
      },
    };
  }
  if (parsed.pathname !== MCP_APP_SANDBOX_CONTENT_PATH || parsed.hash !== "") return null;
  const lookupUrl = contentLookupUrl(parsed);
  if (!lookupUrl) return null;
  const registration = registry.lookupByUrl(lookupUrl, lookupOptions);
  if (!registration || !isExactMcpAppSandboxContentUrl(requestUrl, registration.descriptor)) {
    return null;
  }
  const csp = buildMcpAppSandboxCsp(registration.input.csp, { frameAncestors: "'self'" });
  if (!csp) return null;
  return {
    statusCode: 200,
    mimeType: "text/html",
    data: MCP_APP_CONTENT_INSTALLER_HTML,
    headers: {
      ...csp.headers,
      "Content-Type": "text/html; charset=utf-8",
    },
  };
}

export const MCP_APP_SANDBOX_SHELL_HTML = MCP_APP_SHELL_HTML;
export const MCP_APP_SANDBOX_CONTENT_HTML = MCP_APP_CONTENT_INSTALLER_HTML;
