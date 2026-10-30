// FILE: mossAppsPlugins.ts
// Purpose: Moss Apps as plugins. Codex has no separate Apps surface — an app is
//          a plugin whose content is a connected app — so every app in the
//          hosted catalog becomes a plugin entry in a "Moss Apps" marketplace.
//          The directory, plugin page, install (connect) and manage flows are
//          then the plugin ones, for every CLI.
// Layer: Web model
// Exports: marketplace identity helpers, category mapping, descriptor/detail
//          synthesis, directory entries

import type {
  MossAppConnection,
  MossAppToolkit,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
} from "@synara/contracts";

import type { ProviderPluginDirectoryEntry } from "./pluginLibraryModel";

export const MOSS_APPS_MARKETPLACE_NAME = "moss-apps";
export const MOSS_APPS_MARKETPLACE_DISPLAY_NAME = "Moss Apps";
const PLUGIN_ID_SUFFIX = `@${MOSS_APPS_MARKETPLACE_NAME}`;
/** The plugin page's app row needs a target; Moss Apps connect in-app, not by URL. */
const APP_INSTALL_TARGET_PREFIX = "moss-apps:";

export function mossAppPluginId(slug: string): string {
  return `${slug}${PLUGIN_ID_SUFFIX}`;
}

export function mossAppSlugFromPluginId(pluginId: string): string | null {
  return pluginId.endsWith(PLUGIN_ID_SUFFIX) ? pluginId.slice(0, -PLUGIN_ID_SUFFIX.length) : null;
}

export function isMossAppPlugin(plugin: Pick<ProviderPluginDescriptor, "id">): boolean {
  return mossAppSlugFromPluginId(plugin.id) !== null;
}

/**
 * The catalog's fine-grained categories folded onto the directory's sections —
 * the remote plugin catalog's categories, as Codex shows them — so an app sits
 * beside the plugins it competes with ("Productivity", "Communication", …).
 */
const DIRECTORY_CATEGORY_BY_APP_CATEGORY: Readonly<Record<string, string>> = {
  productivity: "Productivity",
  "project-management": "Productivity",
  "task-management": "Productivity",
  "team-collaboration": "Productivity",
  documents: "Productivity",
  notes: "Productivity",
  calendar: "Productivity",
  "scheduling-&-booking": "Productivity",
  spreadsheets: "Productivity",
  "file-management-&-storage": "Productivity",
  "contact-management": "Productivity",
  "team-chat": "Communication",
  email: "Communication",
  "email-newsletters": "Communication",
  "video-conferencing": "Communication",
  "phone-&-sms": "Communication",
  "developer-tools": "Developer Tools",
  databases: "Developer Tools",
  "ai-agents": "Developer Tools",
  "artificial-intelligence": "Developer Tools",
  "ai-web-scraping": "Developer Tools",
  "web-scraping-&-browser": "Developer Tools",
  "ai-chatbots": "Developer Tools",
  analytics: "Data & Analytics",
  "web-search-&-research": "Education & Research",
  "online-courses": "Education & Research",
  "people-&-contact-data": "Business & Operations",
  "seo-&-ai-visibility": "Business & Operations",
  crm: "Business & Operations",
  "sales-&-crm": "Business & Operations",
  "marketing-automation": "Business & Operations",
  "social-media-marketing": "Business & Operations",
  "social-media-accounts": "Business & Operations",
  "customer-support": "Business & Operations",
  ecommerce: "Business & Operations",
  "payment-processing": "Finance",
  accounting: "Finance",
  "images-&-design": "Creativity",
  "video-&-audio": "Creativity",
  "audio-&-speech": "Creativity",
  "places-&-weather": "Travel",
};

function categoryKey(category: string): string {
  return category.trim().toLowerCase().replaceAll(/\s+/g, "-");
}

export function mossAppDirectoryCategory(toolkit: Pick<MossAppToolkit, "categories">): string {
  for (const category of toolkit.categories) {
    const mapped = DIRECTORY_CATEGORY_BY_APP_CATEGORY[categoryKey(category)];
    if (mapped) return mapped;
  }
  return "Other";
}

/** The connection that makes an app "installed": the latest active one. */
export function activeMossAppConnection(
  connections: ReadonlyArray<MossAppConnection>,
  slug: string,
): MossAppConnection | null {
  let active: MossAppConnection | null = null;
  for (const connection of connections) {
    if (connection.toolkitSlug !== slug || connection.status !== "active") continue;
    if (!active || connection.createdAt > active.createdAt) active = connection;
  }
  return active;
}

export function mossAppPluginDescriptor(
  toolkit: MossAppToolkit,
  connection: MossAppConnection | null,
): ProviderPluginDescriptor {
  const connected = connection !== null;
  const description = toolkit.description.trim();
  return {
    id: mossAppPluginId(toolkit.slug),
    remotePluginId: null,
    name: toolkit.slug,
    version: null,
    localVersion: null,
    shareContext: null,
    availability: "AVAILABLE",
    keywords: [...toolkit.categories],
    source: { type: "remote" },
    installed: connected,
    enabled: connected,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_INSTALL",
    interface: {
      displayName: toolkit.name,
      shortDescription: description || null,
      longDescription: description || null,
      developerName: "Moss",
      category: mossAppDirectoryCategory(toolkit),
      capabilities: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: toolkit.logoUrl,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
  };
}

/** The plugin page for an app: its one app under Apps, nothing else bundled. */
export function mossAppPluginDetail(
  toolkit: MossAppToolkit,
  connection: MossAppConnection | null,
): ProviderPluginDetail {
  const summary = mossAppPluginDescriptor(toolkit, connection);
  return {
    marketplaceName: MOSS_APPS_MARKETPLACE_NAME,
    marketplacePath: null,
    summary,
    shareUrl: null,
    description: toolkit.description.trim() || null,
    skills: [],
    hooks: [],
    apps: [
      {
        id: toolkit.slug,
        name: toolkit.name,
        description: toolkit.description.trim() || null,
        installUrl: `${APP_INSTALL_TARGET_PREFIX}${toolkit.slug}`,
        category: summary.interface?.category ?? null,
      },
    ],
    appTemplates: [],
    mcpServers: [],
  };
}

/**
 * Directory entries for the whole app catalog — Moss Apps is Moss's own
 * marketplace, listed in full in its own section — the user's connected apps
 * first, then the catalog's order (most used first).
 */
export function mossAppDirectoryEntries(input: {
  readonly toolkits: ReadonlyArray<MossAppToolkit>;
  readonly connections: ReadonlyArray<MossAppConnection>;
}): ProviderPluginDirectoryEntry[] {
  const connected: ProviderPluginDirectoryEntry[] = [];
  const rest: ProviderPluginDirectoryEntry[] = [];
  for (const toolkit of input.toolkits) {
    const connection = activeMossAppConnection(input.connections, toolkit.slug);
    (connection ? connected : rest).push({
      plugin: mossAppPluginDescriptor(toolkit, connection),
      marketplaceName: MOSS_APPS_MARKETPLACE_NAME,
      marketplaceDisplayName: MOSS_APPS_MARKETPLACE_DISPLAY_NAME,
      marketplacePath: null,
      remoteMarketplaceName: MOSS_APPS_MARKETPLACE_NAME,
      bucket: "moss",
      provenance: "moss-apps",
      isFeatured: false,
      createdByYou: false,
      sharedWithYou: false,
    });
  }
  return [...connected, ...rest];
}
