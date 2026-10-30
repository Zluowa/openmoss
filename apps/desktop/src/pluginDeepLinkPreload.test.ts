import { describe, expect, it, vi } from "vitest";

import {
  PLUGIN_DEEP_LINK_IPC_CHANNELS,
  createPluginDeepLinkBridge,
  type PluginDeepLinkIpcRenderer,
} from "./pluginDeepLinkPreload";

class FakeIpcRenderer implements PluginDeepLinkIpcRenderer {
  readonly sent: Array<{ channel: string; payload?: unknown }> = [];
  readonly listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  auditResult: unknown = null;
  throwOnResult = false;

  invoke(channel: string): Promise<unknown> {
    expect(channel).toBe(PLUGIN_DEEP_LINK_IPC_CHANNELS.getLastAudit);
    return Promise.resolve(this.auditResult);
  }

  send(channel: string, payload?: unknown): void {
    if (this.throwOnResult && channel === PLUGIN_DEEP_LINK_IPC_CHANNELS.result) {
      throw new Error("renderer IPC is already torn down");
    }
    this.sent.push({ channel, payload });
  }

  on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({}, payload);
    }
  }
}

const navigation = {
  deliveryId: "plugin-deep-link-1",
  route: "/skills/plugins/browser%40openai-curated",
  coldStart: false,
  source: "open-url",
} as const;

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createPluginDeepLinkBridge", () => {
  it("subscribes, ACKs a successful router PUSH, and disposes idempotently", async () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    const listener = vi.fn(async () => true);

    const dispose = bridge.onNavigate(listener);
    expect(ipc.sent).toEqual([{ channel: PLUGIN_DEEP_LINK_IPC_CHANNELS.subscribe }]);

    ipc.emit(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, navigation);
    await flushPromises();
    expect(listener).toHaveBeenCalledWith(navigation);
    expect(ipc.sent.at(-1)).toEqual({
      channel: PLUGIN_DEEP_LINK_IPC_CHANNELS.result,
      payload: { deliveryId: navigation.deliveryId, accepted: true },
    });

    dispose();
    dispose();
    expect(
      ipc.sent.filter((entry) => entry.channel === PLUGIN_DEEP_LINK_IPC_CHANNELS.unsubscribe),
    ).toHaveLength(1);
    expect(ipc.listeners.get(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate)?.size).toBe(0);
  });

  it.each([
    ["returns false", async () => false],
    [
      "rejects",
      async () => {
        throw new Error("router unavailable");
      },
    ],
  ])("NACKs and leaves retry ownership with main when the handler %s", async (_name, handler) => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    bridge.onNavigate(handler);

    ipc.emit(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, navigation);
    await flushPromises();

    expect(ipc.sent.at(-1)).toEqual({
      channel: PLUGIN_DEEP_LINK_IPC_CHANNELS.result,
      payload: { deliveryId: navigation.deliveryId, accepted: false },
    });
  });

  it("rejects malformed main-process payloads before calling the router", async () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    const listener = vi.fn(async () => true);
    bridge.onNavigate(listener);

    ipc.emit(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, {
      deliveryId: "plugin-deep-link-1",
      route: "/settings",
      coldStart: false,
      source: "open-url",
    });
    await flushPromises();

    expect(listener).not.toHaveBeenCalled();
    expect(ipc.sent.some((entry) => entry.channel === PLUGIN_DEEP_LINK_IPC_CHANNELS.result)).toBe(
      false,
    );
  });

  it("permits only one active renderer subscriber", () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    bridge.onNavigate(async () => true);

    expect(() => bridge.onNavigate(async () => true)).toThrow(
      "A plugin deep-link listener is already registered.",
    );
  });

  it("reads only the strict raw-safe latest-delivery audit", async () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    ipc.auditResult = {
      deliveryIdSha256: "a".repeat(64),
      coldStart: true,
      source: "initial-argv",
      rendererAcknowledged: true,
    };
    await expect(bridge.getLastAudit()).resolves.toEqual(ipc.auditResult);

    ipc.auditResult = {
      deliveryIdSha256: "plugin-deep-link-1",
      coldStart: true,
      source: "initial-argv",
      rendererAcknowledged: true,
    };
    await expect(bridge.getLastAudit()).resolves.toBeNull();
  });

  it("does not send a stale result after disposal", async () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createPluginDeepLinkBridge(ipc);
    let release: ((accepted: boolean) => void) | undefined;
    const dispose = bridge.onNavigate(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );

    ipc.emit(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, navigation);
    await flushPromises();
    dispose();
    release?.(true);
    await flushPromises();

    expect(
      ipc.sent.filter((entry) => entry.channel === PLUGIN_DEEP_LINK_IPC_CHANNELS.result),
    ).toHaveLength(0);
  });

  it("contains result-send teardown errors so main can recover through its watchdog", async () => {
    const ipc = new FakeIpcRenderer();
    ipc.throwOnResult = true;
    const bridge = createPluginDeepLinkBridge(ipc);
    bridge.onNavigate(async () => true);

    ipc.emit(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, navigation);
    await flushPromises();

    expect(
      ipc.sent.filter((entry) => entry.channel === PLUGIN_DEEP_LINK_IPC_CHANNELS.result),
    ).toHaveLength(0);
  });
});
