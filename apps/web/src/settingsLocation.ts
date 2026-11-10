// FILE: settingsLocation.ts
// Purpose: Turn any Settings open request (a caller, a search result, an old `/settings`
//          link) into a page the Settings dialog can show, following pages that moved.
// Layer: Settings navigation model
// Exports: SettingsLocation, resolveSettingsLocation, settingsLocationFromSearch

import { CONNECTION_TABS, type ConnectionTab } from "./connectionSettingsNavigation";
import { normalizeSettingsSection, type SettingsSectionId } from "./settingsNavigation";
import {
  PLUGIN_SETTINGS_TABS,
  type PluginSettingsTab,
  type SettingsOpenRequest,
} from "./settingsDialogStore";

export interface SettingsLocation {
  readonly section: SettingsSectionId;
  readonly target?: string | undefined;
  readonly provider?: string | undefined;
  readonly connectionTab?: Exclude<ConnectionTab, "this"> | undefined;
  readonly pluginTab?: PluginSettingsTab | undefined;
}

/**
 * Old sections that now live somewhere else. MCP connections and the agent MCP list moved
 * into Plugins › MCP, skills into Plugins › Skills, System tools into General.
 */
const SECTION_REDIRECTS: Readonly<Record<string, SettingsLocation>> = {
  connectors: { section: "plugins", pluginTab: "mcp" },
  integrations: { section: "plugins", pluginTab: "mcp" },
  skills: { section: "plugins", pluginTab: "skills" },
  advanced: { section: "general" },
  computer: { section: "computer-use" },
};

function isConnectionTab(value: unknown): value is ConnectionTab {
  return CONNECTION_TABS.some((tab) => tab === value);
}

function isPluginSettingsTab(value: unknown): value is PluginSettingsTab {
  return PLUGIN_SETTINGS_TABS.some((tab) => tab === value);
}

export function resolveSettingsLocation(request: SettingsOpenRequest = {}): SettingsLocation {
  const redirected =
    typeof request.section === "string" ? SECTION_REDIRECTS[request.section] : undefined;
  // Legacy "Control this computer" links meant the computer-use page.
  const legacyComputerTab = request.section === "connections" && request.connectionTab === "this";
  const base: SettingsLocation = legacyComputerTab
    ? { section: "computer-use" }
    : (redirected ?? { section: normalizeSettingsSection(request.section) });
  const connectionTab = isConnectionTab(request.connectionTab) ? request.connectionTab : undefined;
  const pluginTab = isPluginSettingsTab(request.pluginTab) ? request.pluginTab : base.pluginTab;
  return {
    section: base.section,
    ...(typeof request.target === "string" && request.target ? { target: request.target } : {}),
    ...(typeof request.provider === "string" && request.provider
      ? { provider: request.provider }
      : {}),
    ...(base.section === "connections" && connectionTab && connectionTab !== "this"
      ? { connectionTab }
      : {}),
    ...(base.section === "plugins" && pluginTab ? { pluginTab } : {}),
  };
}

/** Read a `/settings` (or `/settings/plugins-settings`) URL's search into a location. */
export function settingsLocationFromSearch(
  search: Readonly<Record<string, unknown>>,
  pathname?: string,
): SettingsLocation {
  const str = (key: string) => (typeof search[key] === "string" ? search[key] : undefined);
  if (pathname?.replace(/\/+$/, "") === "/settings/plugins-settings") {
    return resolveSettingsLocation({ section: "plugins", pluginTab: str("tab") });
  }
  return resolveSettingsLocation({
    section: str("section"),
    target: str("target"),
    provider: str("provider"),
    connectionTab: str("connectionTab"),
    pluginTab: str("tab"),
  });
}
