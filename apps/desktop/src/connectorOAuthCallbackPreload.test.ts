import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS } from "./connectorOAuthCallback";
import { createConnectorOAuthCallbackBridge } from "./connectorOAuthCallbackPreload";

class FakeIpcRenderer {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  send(channel: string): void {
    this.sent.push(channel);
  }

  on(channel: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({}, payload);
    }
  }
}

describe("createConnectorOAuthCallbackBridge", () => {
  it("subscribes once, fans out valid events, and unsubscribes after the last listener", () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createConnectorOAuthCallbackBridge(ipc);
    const first: unknown[] = [];
    const second: unknown[] = [];

    const removeFirst = bridge.onCallback((callback) => first.push(callback));
    const removeSecond = bridge.onCallback((callback) => second.push(callback));

    assert.deepStrictEqual(ipc.sent, [CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe]);

    const callback = {
      fullRedirectUrl: "https://example.com/callback?state=opaque&account_id=acct",
      returnTo: "/skills",
    };
    ipc.emit(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, callback);
    assert.deepStrictEqual(first, [callback]);
    assert.deepStrictEqual(second, [callback]);

    removeFirst();
    assert.deepStrictEqual(ipc.sent, [CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe]);
    removeSecond();
    assert.deepStrictEqual(ipc.sent, [
      CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe,
      CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.unsubscribe,
    ]);
    assert.equal(ipc.listeners.get(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event)?.size, 0);
  });

  it("drops malformed payloads and makes listener cleanup idempotent", () => {
    const ipc = new FakeIpcRenderer();
    const bridge = createConnectorOAuthCallbackBridge(ipc);
    const received: unknown[] = [];
    const remove = bridge.onCallback((callback) => received.push(callback));

    ipc.emit(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, {
      fullRedirectUrl: "javascript:alert(1)",
      returnTo: null,
    });
    ipc.emit(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, {
      fullRedirectUrl: "https://example.com/callback",
      returnTo: 42,
    });
    assert.deepStrictEqual(received, []);

    remove();
    remove();
    assert.deepStrictEqual(ipc.sent, [
      CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe,
      CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.unsubscribe,
    ]);
  });
});
