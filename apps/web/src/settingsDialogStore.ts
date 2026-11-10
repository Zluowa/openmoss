// FILE: settingsDialogStore.ts
// Purpose: Open/close state for the floating Settings dialog. Settings is a modal over the
//          current screen (like Claude desktop), so where it points lives here instead of
//          in the URL; `/settings?…` deep links are translated into an open request.
// Layer: Web UI store (framework-free: callers anywhere can open Settings without pulling
//        React, icons or the settings taxonomy into their module graph)
// Exports: settingsDialogStore, openSettings, closeSettings, navigateSettings, types

import { createStore } from "zustand/vanilla";

export const PLUGIN_SETTINGS_TABS = ["plugins", "apps", "mcp", "skills"] as const;
export type PluginSettingsTab = (typeof PLUGIN_SETTINGS_TABS)[number];

/**
 * What a caller asks Settings to show. Values are loose strings on purpose: old links and
 * search results pass ids that `resolveSettingsLocation` maps to the page that owns them.
 */
export interface SettingsOpenRequest {
  readonly section?: string | undefined;
  /** DOM id inside the page to scroll to after it mounts. */
  readonly target?: string | undefined;
  /** Provider row to focus on the Agent providers page. */
  readonly provider?: string | undefined;
  readonly connectionTab?: string | undefined;
  readonly pluginTab?: PluginSettingsTab | string | undefined;
}

export interface SettingsDialogState {
  readonly isOpen: boolean;
  readonly request: SettingsOpenRequest;
  /** Bumped on every open so a repeat deep link to the same target scrolls again. */
  readonly openEpoch: number;
}

export const settingsDialogStore = createStore<SettingsDialogState>(() => ({
  isOpen: false,
  request: {},
  openEpoch: 0,
}));

/** Open Settings over the current screen, optionally at a page/row. */
export function openSettings(request: SettingsOpenRequest = {}): void {
  settingsDialogStore.setState((state) => ({
    isOpen: true,
    request,
    openEpoch: state.openEpoch + 1,
  }));
}

/** Move within an open dialog (nav click, tab change, search result). */
export function navigateSettings(request: SettingsOpenRequest): void {
  settingsDialogStore.setState({ request });
}

export function closeSettings(): void {
  settingsDialogStore.setState({ isOpen: false });
}
