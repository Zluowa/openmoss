// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

import { MCP_CONNECTORS_BETA_FEATURE } from "@moss/shared/betaFeatures";

import { isBetaFeatureOn } from "~/betaFeatures";
import { KEYBINDINGS_ICON_NAME } from "~/lib/icons";

export const SETTINGS_SECTION_IDS = [
  "general",
  "plugins",
  "import",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "history",
  "voice",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "connectors",
  "connections",
  "computer-use",
  "integrations",
  "advanced",
] as const;

// The legacy computer id remains accepted by callers, but resolves to the computer-use page.
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number] | "computer";
export type SettingsNavGroupId = "personal" | "integrations" | "coding" | "archived";

/**
 * Deep-link scroll targets inside settings panels. Each id is shared by its DOM owner and callers
 * that navigate with `?target=…`; the settings route resolves every target after the active panel
 * mounts.
 */
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  providerInstalls: "provider-installs",
  environmentPanel: "environment-panel",
} as const;

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
  /**
   * Maturity label shown beside the section name, in the sidebar and on the
   * panel's own heading. Absent for a settled feature; one source so the two
   * places can never disagree about what is still in beta.
   */
  badge?: string;
};

/**
 * Sections retained for old links while their controls live elsewhere: Connectors,
 * MCP connections and Agent skills are tabs of Plugins, System tools moved into
 * General (About) and Keybindings. `resolveSettingsLocation` redirects them.
 */
export const CODEX_RESOURCE_LEGACY_SECTIONS = [
  "connectors",
  "skills",
  "integrations",
  "advanced",
] as const satisfies ReadonlyArray<SettingsSectionId>;

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "personal", label: "Personal" },
  { id: "integrations", label: "Integrations" },
  { id: "coding", label: "Coding" },
  { id: "archived", label: "Archived" },
] as const;

/** Sections that exist only where their Beta-only feature is on. */
const SETTINGS_SECTION_BETA_FEATURES: Partial<Record<SettingsSectionId, string>> = {
  connectors: MCP_CONNECTORS_BETA_FEATURE,
};

/** False for a Beta-only section on Stable: no nav entry, search result, or deep link. */
export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): boolean {
  const feature = SETTINGS_SECTION_BETA_FEATURES[section];
  return feature === undefined || isOn(feature);
}

const ALL_SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "personal",
    label: "General",
    description: "Defaults for new chats, navigation and updates.",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "import",
    group: "personal",
    label: "Import",
    description: "Bring projects, skills and chats from other AI apps.",
    icon: "arrow-inbox",
    eyebrow: "Bring existing work",
  },
  {
    id: "profile",
    group: "personal",
    label: "Profile",
    description: "Your activity and a shareable stats card.",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "personal",
    label: "Appearance",
    description: "Theme, fonts and density.",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "personal",
    label: "Notifications",
    description: "How Moss tells you when work finishes.",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "personal",
    label: "Chat behavior",
    description: "Replies, follow-ups and confirmations.",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "shortcuts",
    group: "personal",
    label: "Keybindings",
    description: "Change the shortcut for any command.",
    icon: KEYBINDINGS_ICON_NAME,
    eyebrow: "Key bindings",
  },
  {
    id: "usage",
    group: "personal",
    label: "Usage & limits",
    description: "Remaining quota for each account.",
    icon: "gauge",
    eyebrow: "Provider limits",
  },
  {
    id: "voice",
    group: "personal",
    label: "Voice",
    description: "Voice chat, microphone and shortcut.",
    icon: "voice-settings",
    eyebrow: "Live conversation",
  },
  {
    id: "plugins",
    group: "integrations",
    label: "Plugins",
    description: "Manage plugins, apps, MCP and skills.",
    icon: "puzzle",
    eyebrow: "Plugins and apps",
  },
  {
    id: "computer-use",
    group: "integrations",
    label: "Computer use",
    description: "Manage how Moss uses other apps on this computer.",
    icon: "cursor-3",
    eyebrow: "Computer use",
  },
  {
    id: "appsnap",
    group: "integrations",
    label: "AppSnap",
    description: "Show Moss the window in front.",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "history",
    group: "integrations",
    label: "Computer History",
    description: "Your private, encrypted app and website timeline.",
    icon: "computer-history",
    eyebrow: "Local timeline",
  },
  {
    id: "connections",
    group: "integrations",
    label: "Connections",
    description: "Other devices, pairing and SSH.",
    icon: "connectors-1",
    eyebrow: "Remote computers",
  },
  {
    id: "connectors",
    group: "integrations",
    label: "Connectors",
    description: "Services your agents can sign in to.",
    icon: "connectors-1",
    eyebrow: "Remote MCP servers",
  },
  {
    id: "integrations",
    group: "integrations",
    label: "MCP connections",
    description: "Let other agents work with Moss tasks.",
    icon: "plugin-1",
    eyebrow: "External agents",
  },
  {
    id: "providers",
    group: "coding",
    label: "Agent providers",
    description: "Sign in, install and order your coding agents.",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "models",
    group: "coding",
    label: "Models & writing",
    description: "Commit message style and the model that writes it.",
    icon: "brain",
    eyebrow: "Model configuration",
  },
  {
    id: "skills",
    group: "coding",
    label: "Agent skills",
    description: "Reusable workflows for your agents.",
    icon: "building-blocks",
    eyebrow: "Reusable workflows",
  },
  {
    id: "worktrees",
    group: "coding",
    label: "Managed worktrees",
    description: "Workspaces Moss created for tasks.",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "advanced",
    group: "personal",
    label: "System tools",
    description: "Recovery tools and version details.",
    icon: "toolbox",
    eyebrow: "System tools",
  },
  {
    id: "archived",
    group: "archived",
    label: "Archived threads",
    description: "Find and restore archived chats.",
    icon: "archive",
    eyebrow: "Thread management",
  },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = ALL_SETTINGS_NAV_ITEMS.filter(
  (item) =>
    isSettingsSectionAvailable(item.id) &&
    !(CODEX_RESOURCE_LEGACY_SECTIONS as readonly string[]).includes(item.id),
);

/**
 * Stable DOM id for a settings row, derived from its (string) title. Shared by the row that
 * renders the anchor and by the search index that deep-links to it via `?target=…`, so the
 * two can't drift. Panels stay mounted and render null while inactive, so the slug only needs
 * to be unique within a section.
 */
export function settingRowAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `setting-${slug}`;
}

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (value === "computer") return "computer-use";
  if (typeof value !== "string") {
    return "general";
  }
  return (
    SETTINGS_SECTION_IDS.find(
      (candidate) => candidate === value && isSettingsSectionAvailable(candidate),
    ) ?? "general"
  );
}
