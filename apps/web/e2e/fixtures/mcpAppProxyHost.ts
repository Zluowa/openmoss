// FILE: mcpAppProxyHost.ts
// Purpose: Minimal trusted host page for the desktop sandbox e2e. It drives
// window.desktopBridge.mcpApps and the bridge MessagePort directly, so the
// tests cover the desktop boundary (registry, proxy page, preloads, policy)
// without depending on the web host implementation.

import {
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_RESOURCE_READY_METHOD,
  decodeMcpAppSandboxBridgeEnvelope,
  type McpAppSandboxBridgeEnvelope,
  type McpAppSandboxDescriptor,
  type McpAppSandboxRegisterInput,
} from "@moss/contracts";

import { styleMcpAppWebview } from "../../src/lib/mcpApps/webviewStyle";

type Received = { readonly at: number; readonly envelope: McpAppSandboxBridgeEnvelope };

interface Mounted {
  readonly descriptor: McpAppSandboxDescriptor;
  readonly webview: HTMLElement;
  readonly received: Received[];
  readonly navigation: unknown[];
  bridgePort: MessagePort | null;
  invalid: unknown[];
}

const mounted = new Map<string, Mounted>();

function bridge() {
  const value = window.desktopBridge?.mcpApps;
  if (!value) throw new Error("desktopBridge.mcpApps is unavailable");
  return value;
}

function baseInput(overrides: Partial<McpAppSandboxRegisterInput>): McpAppSandboxRegisterInput {
  return {
    callId: "proxy-call",
    containerDimensions: { height: 400, width: 600 },
    csp: {
      baseUriDomains: [],
      connectDomains: [],
      frameDomains: [],
      includeDefaultDomains: false,
      isTrusted: false,
      resourceDomains: [],
    },
    generation: 0,
    isCollapsible: true,
    prefersBorder: true,
    resourceUri: "ui://fixture/proxy",
    server: "proxy-server",
    theme: "light",
    threadId: "proxy-thread",
    ...overrides,
  };
}

function isEnvelope(value: unknown): value is McpAppSandboxBridgeEnvelope {
  if (!value || typeof value !== "object") return false;
  return decodeMcpAppSandboxBridgeEnvelope(value) !== null;
}

const descriptorWidth = (overrides: Partial<McpAppSandboxRegisterInput>) =>
  overrides.containerDimensions?.width ?? 600;
const descriptorHeight = (overrides: Partial<McpAppSandboxRegisterInput>) =>
  overrides.containerDimensions?.height ?? 400;

async function mount(overrides: Partial<McpAppSandboxRegisterInput>) {
  const descriptor = await bridge().register(baseInput(overrides));
  if (!descriptor) return null;
  const entry: Mounted = {
    descriptor,
    webview: document.createElement("webview"),
    received: [],
    navigation: [],
    bridgePort: null,
    invalid: [],
  };
  mounted.set(descriptor.initId, entry);
  const handoff = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("port hand-off timed out")), 20_000);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (data?.type !== MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL) return;
      if (data.initId !== descriptor.initId || data.sandboxId !== descriptor.sandboxId) return;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      const [bridgePort, navigationPort, replyPort] = event.ports;
      if (!bridgePort || !navigationPort || !replyPort) {
        reject(new Error("incomplete port hand-off"));
        return;
      }
      entry.bridgePort = bridgePort;
      bridgePort.onmessage = (message) => {
        if (isEnvelope(message.data)) {
          entry.received.push({ at: performance.now(), envelope: message.data });
        } else {
          entry.invalid.push(message.data);
        }
      };
      bridgePort.start();
      navigationPort.onmessage = (message) => entry.navigation.push(message.data);
      navigationPort.start();
      replyPort.start();
      replyPort.postMessage({
        type: MCP_APP_SANDBOX_ACK_TYPE,
        sandboxId: descriptor.sandboxId,
        initId: descriptor.initId,
        portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
      });
      resolve();
    };
    window.addEventListener("message", onMessage);
  });
  const webview = entry.webview;
  webview.setAttribute("partition", descriptor.partition);
  webview.setAttribute(
    "webpreferences",
    "nodeIntegration=no,contextIsolation=yes,sandbox=yes,webSecurity=yes,disableDialogs=yes,plugins=no,allowRunningInsecureContent=no",
  );
  // The product's webview style inside a slot the size of the registered container.
  const slot = document.createElement("div");
  slot.style.cssText = `width:${descriptorWidth(overrides)}px;height:${descriptorHeight(overrides)}px`;
  styleMcpAppWebview(webview);
  slot.append(webview);
  document.body.append(slot);
  webview.setAttribute("src", descriptor.src);
  await handoff;
  return descriptor;
}

function entryFor(initId: string): Mounted {
  const entry = mounted.get(initId);
  if (!entry?.bridgePort) throw new Error(`no mounted widget ${initId}`);
  return entry;
}

const host = {
  ready: true,
  mount,
  send(initId: string, message: unknown) {
    entryFor(initId).bridgePort!.postMessage(message);
  },
  sendResource(initId: string, html: string, permissions?: Record<string, unknown>) {
    host.send(initId, {
      jsonrpc: "2.0",
      method: MCP_APP_SANDBOX_RESOURCE_READY_METHOD,
      params: permissions === undefined ? { html } : { html, permissions },
    });
  },
  received(initId: string) {
    const entry = entryFor(initId);
    return entry.received.map((item) => ({ at: item.at, ...item.envelope }));
  },
  invalid(initId: string) {
    return entryFor(initId).invalid;
  },
  navigation(initId: string) {
    return entryFor(initId).navigation;
  },
  now: () => performance.now(),
  async unmount(initId: string) {
    const entry = mounted.get(initId);
    if (!entry) return false;
    mounted.delete(initId);
    entry.bridgePort?.close();
    (entry.webview.parentElement ?? entry.webview).remove();
    return bridge().unregister({
      sandboxId: entry.descriptor.sandboxId,
      initId: entry.descriptor.initId,
      generation: entry.descriptor.generation,
    });
  },
  requestPermissions: (sandboxId: string, permissions: Record<string, boolean>) =>
    bridge().requestPermissions(sandboxId, permissions),
  openExternal: (url: string) => bridge().openExternal(url),
  saveDownload: (input: { fileName: string; mimeType: string; text?: string; base64?: string }) =>
    bridge().saveDownload(input),
  bridgeKeys: () => Object.keys(bridge()).toSorted(),
};

Object.assign(window, { __proxyHost: host });
document.body.dataset.proxyHost = "ready";
