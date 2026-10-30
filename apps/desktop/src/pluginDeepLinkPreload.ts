// FILE: pluginDeepLinkPreload.ts
// Purpose: Exposes a typed, acknowledgement-backed plugin deep-link bridge to the renderer.
// Layer: Desktop preload helper

import type { DesktopBridge, DesktopPluginDeepLinkNavigationResult } from "@synara/contracts";

import { PLUGIN_DEEP_LINK_IPC_CHANNELS } from "./ipcChannels";
import { isDesktopPluginDeepLinkAudit, isDesktopPluginDeepLinkNavigation } from "./pluginDeepLink";

export { PLUGIN_DEEP_LINK_IPC_CHANNELS } from "./ipcChannels";

export interface PluginDeepLinkIpcRenderer {
  send(channel: string, payload?: unknown): void;
  invoke(channel: string): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

type PluginDeepLinkBridge = NonNullable<DesktopBridge["pluginDeepLinks"]>;

export function createPluginDeepLinkBridge(
  ipcRenderer: PluginDeepLinkIpcRenderer,
): PluginDeepLinkBridge {
  let listenerRegistered = false;

  return {
    onNavigate: (listener) => {
      if (listenerRegistered) {
        throw new Error("A plugin deep-link listener is already registered.");
      }
      listenerRegistered = true;
      const activeDeliveryIds = new Set<string>();
      let disposed = false;

      const handleNavigation = (_event: unknown, payload: unknown): void => {
        if (
          !isDesktopPluginDeepLinkNavigation(payload) ||
          activeDeliveryIds.has(payload.deliveryId)
        ) {
          return;
        }
        activeDeliveryIds.add(payload.deliveryId);
        void Promise.resolve()
          .then(() => (disposed ? false : listener(payload)))
          .then(
            (accepted): DesktopPluginDeepLinkNavigationResult => ({
              deliveryId: payload.deliveryId,
              accepted: accepted === true,
            }),
            (): DesktopPluginDeepLinkNavigationResult => ({
              deliveryId: payload.deliveryId,
              accepted: false,
            }),
          )
          .then((result) => {
            activeDeliveryIds.delete(payload.deliveryId);
            if (disposed) {
              return;
            }
            try {
              ipcRenderer.send(PLUGIN_DEEP_LINK_IPC_CHANNELS.result, result);
            } catch {
              // Main retains ownership and its ACK watchdog retries delivery.
            }
          })
          .catch(() => {
            activeDeliveryIds.delete(payload.deliveryId);
          });
      };

      ipcRenderer.on(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, handleNavigation);
      ipcRenderer.send(PLUGIN_DEEP_LINK_IPC_CHANNELS.subscribe);

      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        listenerRegistered = false;
        activeDeliveryIds.clear();
        ipcRenderer.removeListener(PLUGIN_DEEP_LINK_IPC_CHANNELS.navigate, handleNavigation);
        ipcRenderer.send(PLUGIN_DEEP_LINK_IPC_CHANNELS.unsubscribe);
      };
    },
    getLastAudit: async () => {
      const value = await ipcRenderer.invoke(PLUGIN_DEEP_LINK_IPC_CHANNELS.getLastAudit);
      return isDesktopPluginDeepLinkAudit(value) ? value : null;
    },
  };
}
