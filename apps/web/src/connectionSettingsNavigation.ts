// FILE: connectionSettingsNavigation.ts
// Purpose: Tab selection shared by the Connections page and its settings deep links.
// Layer: UI model
// Exports: CONNECTION_TABS, ConnectionTab, SSH_SETTINGS_TARGET, connectionTabFromSearch

/**
 * Connections holds connections only: other devices this one controls, devices pairing
 * with this one, and SSH hosts. Controlling this computer is its own page (电脑操控);
 * the legacy `this` tab id is still accepted and resolves to that page.
 */
export const CONNECTION_TABS = ["devices", "pairing", "ssh", "this"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];
export const VISIBLE_CONNECTION_TABS = [
  "devices",
  "pairing",
  "ssh",
] as const satisfies ReadonlyArray<ConnectionTab>;
export const SSH_SETTINGS_TARGET = "setting-ssh-connections";

export function connectionTabFromSearch(
  search: Readonly<Record<string, unknown>>,
  previous: ConnectionTab = "devices",
): Exclude<ConnectionTab, "this"> {
  const explicit = VISIBLE_CONNECTION_TABS.find((tab) => tab === search.connectionTab);
  if (explicit) return explicit;
  if (search.target === SSH_SETTINGS_TARGET) return "ssh";
  return previous === "this" ? "devices" : previous;
}
