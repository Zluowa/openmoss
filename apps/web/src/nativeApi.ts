import {
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  type NativeApi,
} from "@synara/contracts";

import {
  createWsNativeApi,
  type GuestShareOwnerApi,
  onWsServerCapabilitiesChange,
  readWsServerCapabilities,
} from "./wsNativeApi";

export type { GuestShareOwnerApi } from "./wsNativeApi";

let cachedDesktopApi: NativeApi | undefined;
let nativeApiDetached = false;

/**
 * For pages that render the app's components without a Moss server behind them (the guest
 * share page): no native API, so nothing opens the app's WebSocket. Calls that need the server
 * find none and fall back as they do before it connects.
 */
export function detachNativeApi(): void {
  nativeApiDetached = true;
}

/**
 * Owner-side guest share calls. The share is server state that only the WebSocket
 * surface carries, so this never consults a legacy `window.nativeApi` bridge.
 */
export function ensureGuestShareApi(): GuestShareOwnerApi {
  return createWsNativeApi().guestShare;
}

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined" || nativeApiDetached) return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  return createWsNativeApi();
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export function readNativeApiServerCapability(capability: string): boolean {
  if (typeof window === "undefined" || nativeApiDetached) return false;
  if (window.nativeApi) {
    if (capability === WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY) {
      return typeof window.nativeApi.projects?.provisionFromGitHub === "function";
    }
    if (capability === WS_PROJECT_FILE_WATCH_CAPABILITY) {
      return typeof window.nativeApi.projects?.onFileChange === "function";
    }
    return false;
  }
  return readWsServerCapabilities()?.includes(capability) === true;
}

export function onNativeApiServerCapabilitiesChange(
  listener: () => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (typeof window === "undefined" || nativeApiDetached) {
    if (options?.replayCurrent) listener();
    return () => undefined;
  }
  if (window.nativeApi) {
    if (options?.replayCurrent) listener();
    return () => undefined;
  }
  return onWsServerCapabilitiesChange(listener, options);
}
