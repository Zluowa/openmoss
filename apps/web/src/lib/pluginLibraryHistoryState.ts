// FILE: pluginLibraryHistoryState.ts
// Purpose: Owns serializable Browse/Detail/Manage history snapshots for the plugin library.
// Layer: Web routing state

import type { ProviderKind } from "@synara/contracts";
import { isProviderKind } from "@synara/shared/providerInstances";

import type { LibraryBucket, LibraryTab } from "./pluginLibraryModel";
import { isCanonicalPluginLibraryPath } from "./pluginLibraryRouteModel";

export const PLUGIN_LIBRARY_SETTINGS_PATH = "/settings/plugins-settings";
export const PLUGIN_LIBRARY_ENTRY_SNAPSHOT_KEYS = [
  "sourcePath",
  "initialHostId",
  "initialTab",
  "activeBucket",
  "selectedSectionId",
  "search",
  "scrollTop",
  "focusAnchor",
] as const;
export const PLUGIN_LIBRARY_MANAGE_SNAPSHOT_KEYS = [
  "initialTab",
  "search",
  "scrollTop",
  "focusAnchor",
] as const;
export const PLUGIN_LIBRARY_SEARCH_SNAPSHOT_KEYS = ["plugins", "mcp", "skills"] as const;
export const PLUGIN_LIBRARY_FOCUS_ANCHOR_KEYS = ["kind", "value"] as const;

export type PluginLibraryFocusAnchor =
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "id"; readonly value: string };

/** Codex Settings › Plugins tabs: Plugins, Apps, MCP, Skills, Marketplaces. */
export type PluginLibraryManageTab = "plugins" | "apps" | "mcps" | "skills" | "marketplaces";

export interface PluginLibrarySearchSnapshot {
  readonly plugins: string;
  readonly mcp: string;
  readonly skills: string;
}

export interface PluginLibraryEntrySnapshot {
  readonly sourcePath: string;
  readonly initialHostId: ProviderKind;
  readonly initialTab: LibraryTab;
  readonly activeBucket: LibraryBucket;
  readonly selectedSectionId: string | null;
  readonly search: PluginLibrarySearchSnapshot;
  readonly scrollTop: number;
  readonly focusAnchor: PluginLibraryFocusAnchor | null;
}

export interface PluginLibraryManageSnapshot {
  readonly initialTab: PluginLibraryManageTab;
  readonly search: string;
  readonly scrollTop: number;
  readonly focusAnchor: PluginLibraryFocusAnchor | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasExactKeys(record: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function readString(value: unknown, maximumLength = 10_000): string | null {
  return typeof value === "string" && value.length <= maximumLength ? value : null;
}

function readScrollTop(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readFocusAnchor(value: unknown): PluginLibraryFocusAnchor | null | undefined {
  if (value === null) return null;
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, PLUGIN_LIBRARY_FOCUS_ANCHOR_KEYS) ||
    (record.kind !== "key" && record.kind !== "id")
  ) {
    return undefined;
  }
  const anchorValue = readString(record.value, 1_024);
  return anchorValue && anchorValue.trim().length > 0
    ? { kind: record.kind, value: anchorValue }
    : undefined;
}

function isLibraryTab(value: unknown): value is LibraryTab {
  return value === "plugins" || value === "mcp" || value === "skills";
}

function isLibraryBucket(value: unknown): value is LibraryBucket {
  return value === "moss" || value === "workspace" || value === "personal";
}

function isManageTab(value: unknown): value is PluginLibraryManageTab {
  return (
    value === "plugins" ||
    value === "apps" ||
    value === "mcps" ||
    value === "skills" ||
    value === "marketplaces"
  );
}

export function readPluginLibraryFocusAnchor(state: unknown): PluginLibraryFocusAnchor | null {
  return readFocusAnchor(asRecord(state)?.pluginLibraryFocusAnchor) ?? null;
}

export function readPluginLibraryEntrySnapshot(state: unknown): PluginLibraryEntrySnapshot | null {
  const snapshot = asRecord(asRecord(state)?.pluginLibraryEntrySnapshot);
  const search = asRecord(snapshot?.search);
  if (
    !snapshot ||
    !hasExactKeys(snapshot, PLUGIN_LIBRARY_ENTRY_SNAPSHOT_KEYS) ||
    !search ||
    !hasExactKeys(search, PLUGIN_LIBRARY_SEARCH_SNAPSHOT_KEYS) ||
    typeof snapshot.initialHostId !== "string" ||
    !isProviderKind(snapshot.initialHostId) ||
    !isLibraryTab(snapshot.initialTab) ||
    !isLibraryBucket(snapshot.activeBucket)
  ) {
    return null;
  }
  const sourcePath = readString(snapshot.sourcePath, 2_048);
  const plugins = readString(search.plugins);
  const mcp = readString(search.mcp);
  const skills = readString(search.skills);
  const scrollTop = readScrollTop(snapshot.scrollTop);
  const selectedSectionId =
    snapshot.selectedSectionId === null ? null : readString(snapshot.selectedSectionId, 1_024);
  const focusAnchor = readFocusAnchor(snapshot.focusAnchor);
  if (
    !sourcePath ||
    !isCanonicalPluginLibraryPath(sourcePath) ||
    plugins === null ||
    mcp === null ||
    skills === null ||
    scrollTop === null ||
    (selectedSectionId === null && snapshot.selectedSectionId !== null) ||
    focusAnchor === undefined
  ) {
    return null;
  }
  return {
    sourcePath,
    initialHostId: snapshot.initialHostId,
    initialTab: snapshot.initialTab,
    activeBucket: snapshot.activeBucket,
    selectedSectionId,
    search: { plugins, mcp, skills },
    scrollTop,
    focusAnchor,
  };
}

export function readPluginLibraryManageSnapshot(
  state: unknown,
): PluginLibraryManageSnapshot | null {
  const snapshot = asRecord(asRecord(state)?.pluginLibraryManageSnapshot);
  if (
    !snapshot ||
    !hasExactKeys(snapshot, PLUGIN_LIBRARY_MANAGE_SNAPSHOT_KEYS) ||
    !isManageTab(snapshot.initialTab)
  ) {
    return null;
  }
  const search = readString(snapshot.search);
  const scrollTop = readScrollTop(snapshot.scrollTop);
  const focusAnchor = readFocusAnchor(snapshot.focusAnchor);
  if (search === null || scrollTop === null || focusAnchor === undefined) return null;
  return {
    initialTab: snapshot.initialTab,
    search,
    scrollTop,
    focusAnchor,
  };
}

export function shouldReturnToPreviousPluginLibraryHistoryEntry(state: unknown): boolean {
  return (
    asRecord(state)?.pluginLibraryReturnToPreviousHistoryEntry === true &&
    readPluginLibraryEntrySnapshot(state) !== null
  );
}
