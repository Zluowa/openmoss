// FILE: pluginsCatalog.ts
// Purpose: Discover Moss/Moss canonical plugins under `.moss/plugins` and
//          expose them through the same provider plugin marketplace shape that
//          Codex Desktop uses. This keeps the UI/interaction contract codec-like
//          while the backing source remains Moss's portable harness.
// Layer: Server provider discovery helper
// Exports: discoverMossPluginCatalog, readMossPluginDetail,
//          isMossPluginMarketplacePath

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  ProviderPluginAppSummary,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderPluginInterface,
  ProviderPluginMarketplaceDescriptor,
  ProviderPluginMarketplaceLoadError,
  ProviderSkillDescriptor,
} from "@synara/contracts";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";
import {
  isSafeEntryName,
  readMossPluginManifest,
  type MossPluginIR,
} from "@synara/shared/mossResourceRegistry";
import { collectSkillMarkdownPaths, readSkillDescriptor } from "./skillsCatalog.ts";

export interface MossPluginCatalogResult {
  readonly marketplace: ProviderPluginMarketplaceDescriptor | null;
  readonly loadErrors: ProviderPluginMarketplaceLoadError[];
}

interface ParsedMossPlugin {
  readonly descriptor: ProviderPluginDescriptor;
  readonly detail: ProviderPluginDetail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = readString(entry);
        return text ? [text] : [];
      })
    : [];
}

function pickInterface(
  manifest: Record<string, unknown>,
  fallback: { name: string; description?: string | undefined },
): ProviderPluginInterface {
  const rawInterface = isRecord(manifest.interface) ? manifest.interface : {};
  const displayName = readString(rawInterface.displayName) ?? readString(manifest.displayName);
  const shortDescription =
    readString(rawInterface.shortDescription) ??
    readString(manifest.shortDescription) ??
    fallback.description;
  const longDescription =
    readString(rawInterface.longDescription) ??
    readString(manifest.longDescription) ??
    fallback.description;
  const developerName =
    readString(rawInterface.developerName) ?? readString(manifest.developerName);
  const category = readString(rawInterface.category) ?? readString(manifest.category) ?? "Moss";
  const capabilities = readStringArray(rawInterface.capabilities ?? manifest.capabilities);
  const defaultPrompt = readStringArray(rawInterface.defaultPrompt ?? manifest.defaultPrompt);
  const websiteUrl = readString(rawInterface.websiteUrl) ?? readString(manifest.websiteUrl);
  const privacyPolicyUrl =
    readString(rawInterface.privacyPolicyUrl) ?? readString(manifest.privacyPolicyUrl);
  const termsOfServiceUrl =
    readString(rawInterface.termsOfServiceUrl) ?? readString(manifest.termsOfServiceUrl);
  const brandColor = readString(rawInterface.brandColor) ?? readString(manifest.brandColor);
  const composerIcon = readString(rawInterface.composerIcon) ?? readString(manifest.composerIcon);
  const composerIconUrl =
    readString(rawInterface.composerIconUrl) ?? readString(manifest.composerIconUrl);
  const logo = readString(rawInterface.logo) ?? readString(manifest.logo);
  const logoDark = readString(rawInterface.logoDark) ?? readString(manifest.logoDark);
  const logoUrl = readString(rawInterface.logoUrl) ?? readString(manifest.logoUrl);
  const logoUrlDark = readString(rawInterface.logoUrlDark) ?? readString(manifest.logoUrlDark);
  const screenshots = readStringArray(rawInterface.screenshots ?? manifest.screenshots);
  const screenshotUrls = readStringArray(rawInterface.screenshotUrls ?? manifest.screenshotUrls);

  const iface: ProviderPluginInterface = {
    displayName: displayName ?? fallback.name,
    shortDescription: shortDescription ?? null,
    longDescription: longDescription ?? null,
    developerName: developerName ?? null,
    category,
    capabilities,
    websiteUrl: websiteUrl ?? null,
    privacyPolicyUrl: privacyPolicyUrl ?? null,
    termsOfServiceUrl: termsOfServiceUrl ?? null,
    defaultPrompt: defaultPrompt.length > 0 ? defaultPrompt : null,
    brandColor: brandColor ?? null,
    composerIcon: composerIcon ?? null,
    composerIconUrl: composerIconUrl ?? null,
    logo: logo ?? null,
    logoDark: logoDark ?? null,
    logoUrl: logoUrl ?? null,
    logoUrlDark: logoUrlDark ?? null,
    screenshots,
    screenshotUrls,
  };
  return iface;
}

function parseApps(value: unknown): ProviderPluginAppSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = readString(entry.id);
    const name = readString(entry.name);
    if (!id || !name) return [];
    const description = readString(entry.description);
    const installUrl = readString(entry.installUrl);
    const category = readString(entry.category);
    return [
      {
        id,
        name,
        description: description ?? null,
        installUrl: installUrl ?? null,
        category: category ?? null,
      },
    ];
  });
}

async function parseSkills(plugin: MossPluginIR): Promise<ProviderSkillDescriptor[]> {
  const skills = new Map<string, ProviderSkillDescriptor>();
  // Use the same validated, hydrated components as execution. Both the standard
  // `skills: "./skills/"` and legacy descriptor arrays now describe real files.
  for (const component of plugin.components) {
    if (component.kind !== "skill" || !component.sourcePath?.startsWith("./")) continue;
    if (component.metadata.disabledReason) continue;
    const sourcePath = nodePath.resolve(plugin.absolutePluginRoot, component.sourcePath);
    const relativePath = nodePath.relative(plugin.absolutePluginRoot, sourcePath);
    if (relativePath.startsWith("..") || nodePath.isAbsolute(relativePath)) continue;
    const sourceStat = await fs.lstat(sourcePath).catch(() => null);
    if (!sourceStat || sourceStat.isSymbolicLink()) continue;
    const paths = sourceStat.isFile()
      ? [sourcePath]
      : await collectSkillMarkdownPaths(sourcePath, { followSymlinks: false });
    for (const skillPath of paths) {
      const skill = await readSkillDescriptor({ skillPath, scope: "moss" });
      if (!skill) continue;
      skills.set(skill.path, {
        ...skill,
        enabled: plugin.enabled && component.enabled && skill.enabled,
      });
    }
  }
  return [...skills.values()];
}

async function parseMossPlugin(input: {
  readonly marketplacePath: string;
  readonly manifestPath: string;
  readonly entryName: string;
}): Promise<ParsedMossPlugin> {
  const plugin = await readMossPluginManifest({
    projectPath: nodePath.resolve(input.marketplacePath, "..", ".."),
    pluginRoot: nodePath.dirname(input.manifestPath),
  });
  const unreadable = plugin.validation.errors.find(
    (error) => error.code === "manifest-missing" || error.code === "manifest-invalid-json",
  );
  if (unreadable) throw new Error(unreadable.message);
  const manifest = plugin.manifest as Record<string, unknown>;
  const name = readString(manifest.name) ?? input.entryName;
  const description = readString(manifest.description);
  const version = readString(manifest.version);
  const keywords = readStringArray(manifest.keywords);
  const iface = pickInterface(manifest, { name, description });
  // Canonical Moss resources need an unmistakable identity boundary. A copied
  // provider id may remain in plugin.json as metadata, but it must never make a
  // `.moss` resource addressable through Codex's native mutation APIs.
  const id = `moss:${input.entryName}`;
  const descriptor: ProviderPluginDescriptor = {
    id,
    remotePluginId: null,
    name,
    version: version ?? null,
    localVersion: version ?? null,
    shareContext: null,
    availability: manifest.availability === "DISABLED_BY_ADMIN" ? "DISABLED_BY_ADMIN" : "AVAILABLE",
    keywords,
    source: {
      type: "local",
      path: plugin.absoluteManifestPath,
    },
    installed: true,
    enabled: plugin.enabled,
    installPolicy: "INSTALLED_BY_DEFAULT",
    installPolicySource: null,
    authPolicy: manifest.authPolicy === "ON_INSTALL" ? "ON_INSTALL" : "ON_USE",
    interface: iface,
  };
  const detail: ProviderPluginDetail = {
    marketplaceName: "Moss",
    marketplacePath: input.marketplacePath,
    summary: descriptor,
    shareUrl: null,
    description: description ?? null,
    skills: await parseSkills(plugin),
    hooks: [],
    apps: parseApps(manifest.apps),
    appTemplates: [],
    mcpServers: readStringArray(manifest.mcpServers),
  };
  return { descriptor, detail };
}

export function isMossPluginMarketplacePath(path: string): boolean {
  const resolved = nodePath.resolve(path);
  return (
    nodePath.basename(resolved) === "plugins" &&
    nodePath.basename(nodePath.dirname(resolved)) === ".moss"
  );
}

export async function discoverMossPluginCatalog(input: {
  readonly cwd?: string | null;
}): Promise<MossPluginCatalogResult> {
  if (!input.cwd) return { marketplace: null, loadErrors: [] };
  const layout = getMossSourceLayout(input.cwd);
  const loadErrors: ProviderPluginMarketplaceLoadError[] = [];
  const entries = await fs.readdir(layout.pluginsRoot, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return { marketplace: null, loadErrors };
  }

  const plugins: ProviderPluginDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue;
    const manifestPath = nodePath.join(layout.pluginsRoot, entry.name, "plugin.json");
    try {
      const parsed = await parseMossPlugin({
        marketplacePath: layout.pluginsRoot,
        manifestPath,
        entryName: entry.name,
      });
      plugins.push(parsed.descriptor);
    } catch (error) {
      loadErrors.push({
        marketplacePath: manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (plugins.length === 0) return { marketplace: null, loadErrors };
  return {
    marketplace: {
      name: "Moss",
      path: layout.pluginsRoot,
      interface: { displayName: "Moss" },
      plugins: plugins.toSorted((left, right) =>
        (left.interface?.displayName ?? left.name).localeCompare(
          right.interface?.displayName ?? right.name,
        ),
      ),
    },
    loadErrors,
  };
}

export async function readMossPluginDetail(input: {
  readonly marketplacePath: string;
  readonly pluginName: string;
}): Promise<ProviderPluginDetail> {
  if (!isMossPluginMarketplacePath(input.marketplacePath)) {
    throw new Error("Not a Moss plugin marketplace path.");
  }
  const entries = await fs.readdir(input.marketplacePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue;
    const manifestPath = nodePath.join(input.marketplacePath, entry.name, "plugin.json");
    try {
      const parsed = await parseMossPlugin({
        marketplacePath: input.marketplacePath,
        manifestPath,
        entryName: entry.name,
      });
      if (parsed.descriptor.name === input.pluginName) {
        return parsed.detail;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Moss plugin '${input.pluginName}' was not found.`);
}
