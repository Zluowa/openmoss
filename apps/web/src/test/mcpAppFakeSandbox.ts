// FILE: mcpAppFakeSandbox.ts
// Purpose: Browser-lane stand-in for the desktop widget sandbox (B) and the server endpoints
//          (A): `window.desktopBridge.mcpApps`, the main-process port hand-off, a scripted widget
//          on the bridge port speaking B's envelope, and `fetch` answers for the widget routes.
//          The real host controller and UI run unchanged on top of it.
// Layer: Web test support
// Exports: installMcpAppFakeSandbox, FakeMcpAppSandbox, FakeMcpAppWidget

import {
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_PORT_NAMES,
} from "@moss/contracts";

type Json = Record<string, unknown>;

export interface FakeMcpAppWidget {
  readonly sandboxId: string;
  /** Every message the host sent to the widget, in order. */
  readonly received: Json[];
  /** Resolves once the widget answered `ui/initialize` and said `initialized`. */
  readonly initialized: Promise<void>;
  notify(method: string, params?: Json, userActivation?: boolean): void;
  request(method: string, params?: Json, userActivation?: boolean): Promise<Json>;
}

export interface FakeMcpAppSandboxOptions {
  readonly html?: string;
  readonly widgetHeight?: number;
  readonly toolResult?: () => Json;
  /** Resource-level `_meta.ui.permissions` (B's boolean shape). */
  readonly permissions?: Json;
  /**
   * Behave like a real guest: only measure (and report a size) while the webview is laid out
   * and painted — displayed, not visibility:hidden and not zero-area — and report again only
   * when the measured width changes (the ext-apps SDK reports on change only).
   */
  readonly measureLikeGuest?: boolean;
}

export interface FakeMcpAppSandbox {
  readonly widgets: FakeMcpAppWidget[];
  readonly resourceReads: () => number;
  readonly registrations: Json[];
  restore(): void;
}

function wrap(message: Json, userActivation = false) {
  return { type: "moss:mcp-app-message", message, userActivation };
}

export function installMcpAppFakeSandbox(
  options: FakeMcpAppSandboxOptions = {},
): FakeMcpAppSandbox {
  const widgets: FakeMcpAppWidget[] = [];
  const registrations: Json[] = [];
  let reads = 0;
  let counter = 0;
  const bridgeHolder = window as unknown as { desktopBridge?: Json | undefined };
  const previousBridge = bridgeHolder.desktopBridge;
  const previousFetch = window.fetch;

  const startWidget = (sandboxId: string, initId: string, origin: string, src: string) => {
    const bridge = new MessageChannel();
    const navigation = new MessageChannel();
    const reply = new MessageChannel();
    const received: Json[] = [];
    const pending = new Map<string | number, (value: Json) => void>();
    let nextId = 1;
    let resolveInitialized!: () => void;
    const initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    const port = bridge.port2;
    const post = (message: Json, activation = false) => port.postMessage(wrap(message, activation));
    const widget: FakeMcpAppWidget = {
      sandboxId,
      received,
      initialized,
      notify: (method, params = {}, activation = false) =>
        post({ jsonrpc: "2.0", method, params }, activation),
      request: (method, params = {}, activation = false) =>
        new Promise<Json>((resolve) => {
          const id = `w-${nextId++}`;
          pending.set(id, resolve);
          post({ jsonrpc: "2.0", id, method, params }, activation);
        }),
    };
    port.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as Json;
      received.push(message);
      if (message.id !== undefined && message.method === undefined) {
        pending.get(message.id as string)?.(message);
        pending.delete(message.id as string);
        return;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        // Host-originated requests (teardown): answer at once.
        post({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      if (message.method === "ui/notifications/sandbox-resource-ready") {
        void widget
          .request("ui/initialize", {
            protocolVersion: "2026-01-26",
            appInfo: { name: "fake-widget", version: "1.0.0" },
            appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
          })
          .then(() => {
            widget.notify("ui/notifications/initialized", {});
            if (options.measureLikeGuest) {
              let lastWidth = -1;
              let seen = false;
              const measure = () => {
                const webview = [...document.querySelectorAll("webview")].find(
                  (element) => element.getAttribute("src") === src,
                );
                if (!webview && seen) return;
                seen ||= webview !== undefined;
                const rect = webview?.getBoundingClientRect();
                const painted =
                  webview !== undefined &&
                  rect !== undefined &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  webview.getClientRects().length > 0 &&
                  getComputedStyle(webview).visibility === "visible";
                if (painted && Math.round(rect.width) !== lastWidth) {
                  lastWidth = Math.round(rect.width);
                  widget.notify("ui/notifications/size-changed", {
                    width: lastWidth,
                    height: options.widgetHeight ?? 180,
                  });
                }
                requestAnimationFrame(measure);
              };
              requestAnimationFrame(measure);
            } else {
              widget.notify("ui/notifications/size-changed", {
                width: 600,
                height: options.widgetHeight ?? 180,
              });
            }
            resolveInitialized();
          });
      }
    });
    port.start();
    reply.port2.start();
    navigation.port2.start();
    widgets.push(widget);
    // Main hands the trusted renderer the three ports once the guest loaded.
    const handOff = () => {
      const webview = [...document.querySelectorAll("webview")].find(
        (element) => element.getAttribute("src") === src,
      );
      if (!webview) {
        setTimeout(handOff, 10);
        return;
      }
      window.postMessage(
        {
          type: MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
          origin,
          initId,
          sandboxId,
          portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
        },
        window.location.origin,
        [bridge.port1, navigation.port1, reply.port1],
      );
      setTimeout(
        () => post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }),
        20,
      );
    };
    setTimeout(handOff, 0);
  };

  bridgeHolder.desktopBridge = {
    ...(previousBridge ?? {}),
    mcpApps: {
      register: async (input: Json) => {
        registrations.push(input);
        counter += 1;
        const sandboxId = `fake-${counter}`;
        const initId = `init-${counter}`;
        const origin = `moss-mcp-sandbox://${sandboxId}`;
        const src = `${origin}/mcp_apps?generation=${String(input.generation)}#init=${initId}`;
        startWidget(sandboxId, initId, origin, src);
        return {
          generation: input.generation,
          initId,
          origin,
          partition: `moss-mcp-${sandboxId}`,
          sandboxId,
          src,
        };
      },
      unregister: async () => true,
      requestPermissions: async (_id: string, permissions: Json) => ({ granted: permissions }),
      openExternal: async () => ({ opened: true }),
      saveDownload: async () => ({ saved: true }),
    },
  };

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/provider/mcp-app")) return previousFetch(input, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : {};
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("mcp-app-resource/read")) {
      reads += 1;
      return json({
        state: "ready",
        resourceUri: body.resourceUri,
        html: options.html ?? "<!doctype html><p>fake</p>",
        csp: {
          baseUriDomains: [],
          connectDomains: [],
          frameDomains: [],
          includeDefaultDomains: false,
          isTrusted: false,
          resourceDomains: [],
        },
        prefersBorder: true,
        isCollapsible: true,
        widgetDomain: null,
        stableOrigin: false,
        ...(options.permissions ? { permissions: options.permissions } : {}),
      });
    }
    if (url.includes("mcp-app/tool-result")) {
      return json(
        options.toolResult?.() ?? {
          status: "ready",
          input: { name: "Moss" },
          result: {
            content: [{ type: "text", text: "Hello, Moss!" }],
            structuredContent: { count: 3 },
          },
        },
      );
    }
    return json({ result: {} });
  }) as typeof fetch;

  return {
    widgets,
    registrations,
    resourceReads: () => reads,
    restore: () => {
      bridgeHolder.desktopBridge = previousBridge;
      window.fetch = previousFetch;
    },
  };
}
