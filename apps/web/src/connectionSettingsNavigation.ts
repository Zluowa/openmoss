// FILE: connectionSettingsNavigation.ts
// Purpose: URL selection shared by the connection hub and its settings deep links.
// Layer: Route/UI model
export const CONNECTION_TABS = ["this", "devices", "ssh"] as const;
export type ConnectionTab = (typeof CONNECTION_TABS)[number];
export const SSH_SETTINGS_TARGET = "setting-ssh-connections";
export function connectionTabFromSearch(
  search: Readonly<Record<string, unknown>>,
  previous: ConnectionTab = "this",
): ConnectionTab {
  if (search.section === "computer") return "this";
  const explicit = CONNECTION_TABS.find((tab) => tab === search.connectionTab);
  if (explicit) return explicit;
  return search.target === SSH_SETTINGS_TARGET ? "ssh" : previous;
}
