// FILE: serverBootSnapshots.ts
// Purpose: Associates each WebSocket-backed NativeApi instance with its transport's
//          opening config/settings stream snapshots without coupling data-query modules
//          to wsNativeApi's UI fallback imports or leaking WS snapshots to window.nativeApi bridges.
// Layer: Web data access
// Exports: ServerBootSnapshotSource, registerServerBootSnapshotSource, getServerBootSnapshotSource

import type { ServerConfig, ServerSettingsUpdatedPayload } from "@moss/contracts";

export interface ServerBootSnapshotSource {
  readonly readLatestServerConfigSnapshot: () => ServerConfig | null;
  readonly waitForInitialServerConfigSnapshot: (
    timeoutMs?: number,
  ) => Promise<ServerConfig | null> | null;
  readonly readLatestServerSettingsSnapshot: () => ServerSettingsUpdatedPayload["settings"] | null;
  readonly waitForInitialServerSettingsSnapshot: (
    timeoutMs?: number,
  ) => Promise<ServerSettingsUpdatedPayload["settings"] | null> | null;
}

const bootSnapshotSourceByApi = new WeakMap<object, ServerBootSnapshotSource>();

export function registerServerBootSnapshotSource(
  api: object,
  source: ServerBootSnapshotSource,
): void {
  bootSnapshotSourceByApi.set(api, source);
}

export function getServerBootSnapshotSource(api: object): ServerBootSnapshotSource | null {
  return bootSnapshotSourceByApi.get(api) ?? null;
}
