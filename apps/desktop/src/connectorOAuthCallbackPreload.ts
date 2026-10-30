// FILE: connectorOAuthCallbackPreload.ts
// Purpose: Exposes a ref-counted, removable connector OAuth event subscription to the renderer.
// Layer: Desktop preload helper
// Depends on: Connector OAuth callback validation and IPC channel constants.

import type { DesktopBridge, DesktopConnectorOAuthCallback } from "@synara/contracts";
import {
  CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS,
  isDesktopConnectorOAuthCallback,
} from "./connectorOAuthCallback";

export interface ConnectorOAuthCallbackIpcRenderer {
  send(channel: string): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
}

export function createConnectorOAuthCallbackBridge(
  ipcRenderer: ConnectorOAuthCallbackIpcRenderer,
): NonNullable<DesktopBridge["connectorOAuth"]> {
  const subscriptions = new Set<{
    readonly listener: (callback: DesktopConnectorOAuthCallback) => void;
  }>();

  const handleCallback = (_event: unknown, payload: unknown): void => {
    if (!isDesktopConnectorOAuthCallback(payload)) {
      return;
    }
    // Snapshot so a listener may unsubscribe itself without changing this delivery pass.
    for (const subscription of Array.from(subscriptions)) {
      subscription.listener(payload);
    }
  };

  return {
    onCallback(listener) {
      let active = true;
      const subscription = { listener };
      if (subscriptions.size === 0) {
        ipcRenderer.on(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, handleCallback);
        ipcRenderer.send(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe);
      }
      subscriptions.add(subscription);

      return () => {
        if (!active) {
          return;
        }
        active = false;
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) {
          ipcRenderer.removeListener(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, handleCallback);
          ipcRenderer.send(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.unsubscribe);
        }
      };
    },
  };
}
