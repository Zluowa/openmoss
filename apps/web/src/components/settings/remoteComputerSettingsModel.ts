// FILE: remoteComputerSettingsModel.ts
// Purpose: Public device status, safe error copy and pairing display helpers.
// Layer: Connection settings model
import type { RemoteComputerState } from "@moss/contracts";
import { DateTime } from "effect";
import type { TranslationKey } from "~/localization";

export const REMOTE_COMPUTER_STATUS_KEYS: Record<RemoteComputerState["status"], TranslationKey> = {
  disconnected: "settings.connections.remote.disconnected",
  connecting: "settings.connections.remote.connecting",
  connected: "settings.connections.remote.connected",
  "needs-pairing": "settings.connections.remote.needsPairing",
  failed: "settings.connections.remote.failed",
};
const ERROR_KEYS: Record<string, TranslationKey> = {
  "invalid-address": "settings.connections.remote.error.address",
  "invalid-connection": "settings.connections.remote.error.fields",
  "secure-storage-unavailable": "settings.connections.remote.error.secureStorage",
  "needs-pairing": "settings.connections.remote.error.pairing",
  cancelled: "settings.connections.remote.error.cancelled",
  "connection-limit": "settings.connections.remote.error.limit",
  "connection-exists": "settings.connections.remote.error.exists",
  "invalid-response": "settings.connections.remote.error.response",
  "storage-failed": "settings.connections.remote.error.storage",
};
export function remoteComputerErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.keys(ERROR_KEYS).find((key) => message.includes(key));
  return code ? ERROR_KEYS[code]! : "settings.connections.remote.error.connection";
}

/** The main process revalidates this boundary before any network request. */
export function normalizeRemoteComputerOrigin(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function pairingExpiryLabel(value: unknown, locale: string): string | null {
  const date = DateTime.isDateTime(value)
    ? DateTime.toDateUtc(value)
    : typeof value === "string"
      ? new Date(value)
      : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : null;
}
