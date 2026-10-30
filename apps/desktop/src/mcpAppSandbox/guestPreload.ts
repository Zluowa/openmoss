// FILE: guestPreload.ts
// Purpose: Forward the isolated outer-shell port handoff to main exactly once.
// No raw port is exposed through contextBridge and no generic IPC is exposed.

import { ipcRenderer } from "electron";

const MCP_APP_SANDBOX_SCHEME = "moss-mcp-sandbox";
const MCP_APP_SANDBOX_PATH = "/ui";
const MCP_APP_SANDBOX_PORT_NAME = "mcp-app-host";
const MCP_APP_SANDBOX_NAVIGATION_PORT_NAME = "mcp-app-navigation";
const MCP_APP_SANDBOX_INIT_TYPE = "init";
const MCP_APP_IPC_CHANNEL = "moss_desktop:mcp-app-guest-message";

type PortLike = {
  readonly postMessage: (...args: never[]) => void;
  readonly start: () => void;
  readonly close: () => void;
};

function isPort(value: unknown): value is PortLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { postMessage?: unknown }).postMessage === "function" &&
    typeof (value as { start?: unknown }).start === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function closePorts(ports: readonly PortLike[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // Terminal/duplicate transfers are fail-closed and idempotent.
    }
  }
}

function exactKeys(value: unknown, required: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200
  );
}

function guestIdentity(): {
  readonly origin: string;
  readonly sandboxId: string;
  readonly initId: string;
} | null {
  const origin = window.location.origin;
  if (origin === "null" || window.location.protocol !== `${MCP_APP_SANDBOX_SCHEME}:`) return null;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  const initId = fragment.get("init");
  if (
    url.pathname !== MCP_APP_SANDBOX_PATH ||
    url.hostname.length === 0 ||
    url.searchParams.has("init") ||
    !boundedIdentity(initId)
  ) {
    return null;
  }
  return { origin, sandboxId: url.hostname, initId };
}

const identity = guestIdentity();
if (identity) {
  let initialized = false;
  const onInit = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (event.source !== window || event.origin !== identity.origin) {
      closePorts(event.ports as readonly PortLike[]);
      return;
    }
    if (initialized) {
      closePorts(event.ports as readonly PortLike[]);
      return;
    }
    if (
      !exactKeys(data, ["ports", "replyPort", "type"]) ||
      data.type !== MCP_APP_SANDBOX_INIT_TYPE ||
      !exactKeys(data.ports, [MCP_APP_SANDBOX_PORT_NAME, MCP_APP_SANDBOX_NAVIGATION_PORT_NAME]) ||
      !isPort(data.ports[MCP_APP_SANDBOX_PORT_NAME]) ||
      !isPort(data.ports[MCP_APP_SANDBOX_NAVIGATION_PORT_NAME]) ||
      !isPort(data.replyPort) ||
      event.ports.length !== 3 ||
      event.ports[0] !== data.ports[MCP_APP_SANDBOX_PORT_NAME] ||
      event.ports[1] !== data.ports[MCP_APP_SANDBOX_NAVIGATION_PORT_NAME] ||
      event.ports[2] !== data.replyPort ||
      !event.ports.includes(data.ports[MCP_APP_SANDBOX_PORT_NAME] as MessagePort) ||
      !event.ports.includes(data.ports[MCP_APP_SANDBOX_NAVIGATION_PORT_NAME] as MessagePort) ||
      !event.ports.includes(data.replyPort as MessagePort)
    ) {
      closePorts(event.ports as readonly PortLike[]);
      return;
    }
    const payload = {
      type: MCP_APP_SANDBOX_INIT_TYPE,
      origin: identity.origin,
      initId: identity.initId,
      portNames: [MCP_APP_SANDBOX_PORT_NAME, MCP_APP_SANDBOX_NAVIGATION_PORT_NAME],
    } as const;
    initialized = true;
    window.removeEventListener("message", onInit);
    try {
      ipcRenderer.postMessage(MCP_APP_IPC_CHANNEL, payload, [...event.ports]);
    } catch {
      closePorts(event.ports as readonly PortLike[]);
    }
  };
  window.addEventListener("message", onInit);
}
