// FILE: workspaceImport.ts
// Purpose: Schema-only contract for the user-facing external-agent import
//          flow (Codex-style source selection, resources, settings and chats).
// Layer: Shared contracts
// Exports: probe/apply payloads and the 30-day chat window constant.

import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const WORKSPACE_IMPORT_CHAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Source ids intentionally include the original `claude` spelling for wire
 * compatibility with the first Moss import implementation.  New callers may
 * use the more descriptive `claude-code` id; the server normalizes both to the
 * same adapter.  Keeping aliases in the contract lets an older renderer and a
 * newer server negotiate without silently dropping an import source.
 */
export const WorkspaceImportSourceKind = Schema.Literals([
  "claude",
  "claude-code",
  "cursor",
  "codex",
  "grok",
  "opencode",
]);
export type WorkspaceImportSourceKind = typeof WorkspaceImportSourceKind.Type;

export const WORKSPACE_IMPORT_CANONICAL_SOURCES = [
  "claude",
  "cursor",
  "codex",
  "grok",
  "opencode",
] as const;
export type WorkspaceImportCanonicalSourceKind =
  (typeof WORKSPACE_IMPORT_CANONICAL_SOURCES)[number];

export function normalizeWorkspaceImportSource(
  source: WorkspaceImportSourceKind,
): WorkspaceImportCanonicalSourceKind {
  return source === "claude-code" ? "claude" : source;
}

export const WorkspaceImportCategoryKind = Schema.Literals([
  "settings",
  "skills",
  "agents",
  "commands",
  "hooks",
  "mcp",
  "plugins",
  "memory",
  "projects",
  "chats",
]);
export type WorkspaceImportCategoryKind = typeof WorkspaceImportCategoryKind.Type;

export const WORKSPACE_IMPORT_DEFAULT_CATEGORIES = [
  "settings",
  "skills",
  "agents",
  "projects",
  "chats",
] as const satisfies readonly WorkspaceImportCategoryKind[];

export const WorkspaceImportCategoryCounts = Schema.Struct({
  settings: NonNegativeInt,
  skills: NonNegativeInt,
  agents: NonNegativeInt,
  commands: NonNegativeInt,
  hooks: NonNegativeInt,
  mcp: NonNegativeInt,
  plugins: NonNegativeInt,
  memory: NonNegativeInt,
  projects: NonNegativeInt,
  chats: NonNegativeInt,
});
export type WorkspaceImportCategoryCounts = typeof WorkspaceImportCategoryCounts.Type;

export const WorkspaceImportSyncPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(WorkspaceImportCategoryKind),
  sources: Schema.Array(WorkspaceImportSourceKind),
  updatedAt: IsoDateTime,
});
export type WorkspaceImportSyncPreferences = typeof WorkspaceImportSyncPreferences.Type;

export const WorkspaceImportHistoryStatus = Schema.Literals(["success", "partial", "failed"]);
export type WorkspaceImportHistoryStatus = typeof WorkspaceImportHistoryStatus.Type;

export const WorkspaceImportHistoryEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  sources: Schema.Array(WorkspaceImportSourceKind),
  importedAt: IsoDateTime,
  status: WorkspaceImportHistoryStatus,
  importedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  warningCount: NonNegativeInt,
  categories: WorkspaceImportCategoryCounts,
});
export type WorkspaceImportHistoryEntry = typeof WorkspaceImportHistoryEntry.Type;

export const WorkspaceImportThemePreference = Schema.Literals(["light", "dark", "system"]);
export type WorkspaceImportThemePreference = typeof WorkspaceImportThemePreference.Type;

export const WorkspaceImportLocalePreference = Schema.Literals(["en", "zh-CN"]);
export type WorkspaceImportLocalePreference = typeof WorkspaceImportLocalePreference.Type;

export const WorkspaceImportProbeInput = Schema.Struct({
  now: Schema.optionalKey(IsoDateTime),
});
export type WorkspaceImportProbeInput = typeof WorkspaceImportProbeInput.Type;

export const WorkspaceImportSyncInput = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(WorkspaceImportCategoryKind).check(Schema.isMaxLength(10)),
  sources: Schema.Array(WorkspaceImportSourceKind).check(Schema.isMaxLength(5)),
  now: Schema.optionalKey(IsoDateTime),
});
export type WorkspaceImportSyncInput = typeof WorkspaceImportSyncInput.Type;

export const WorkspaceImportSyncResult = WorkspaceImportSyncPreferences;
export type WorkspaceImportSyncResult = typeof WorkspaceImportSyncResult.Type;

export const WorkspaceImportSourcePreview = Schema.Struct({
  source: WorkspaceImportSourceKind,
  present: Schema.Boolean,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  detectedPath: Schema.optionalKey(TrimmedNonEmptyString),
  skillCount: NonNegativeInt,
  honorAbleSettingCount: NonNegativeInt,
  chatCount: NonNegativeInt,
  olderChatCount: NonNegativeInt,
  projectCount: Schema.optionalKey(NonNegativeInt),
  categoryCounts: Schema.optionalKey(WorkspaceImportCategoryCounts),
});
export type WorkspaceImportSourcePreview = typeof WorkspaceImportSourcePreview.Type;

export const WorkspaceImportProbeResult = Schema.Struct({
  sources: Schema.Array(WorkspaceImportSourcePreview),
  requiresSourceChoice: Schema.Boolean,
  sync: Schema.optionalKey(WorkspaceImportSyncPreferences),
  history: Schema.optionalKey(Schema.Array(WorkspaceImportHistoryEntry)),
});
export type WorkspaceImportProbeResult = typeof WorkspaceImportProbeResult.Type;

export const WorkspaceImportApplyInput = Schema.Struct({
  sources: Schema.Array(WorkspaceImportSourceKind).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  categories: Schema.optionalKey(
    Schema.Array(WorkspaceImportCategoryKind).check(Schema.isMaxLength(10)),
  ),
  keepInSync: Schema.optionalKey(Schema.Boolean),
  now: Schema.optionalKey(IsoDateTime),
});
export type WorkspaceImportApplyInput = typeof WorkspaceImportApplyInput.Type;

export const WorkspaceImportSkillCopy = Schema.Struct({
  name: TrimmedNonEmptyString,
  source: WorkspaceImportSourceKind,
  action: Schema.Literals(["copied", "updated", "unchanged", "skipped"]),
  /** The destination name can be namespaced when a Moss skill already exists. */
  destinationName: Schema.optionalKey(TrimmedNonEmptyString),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkspaceImportSkillCopy = typeof WorkspaceImportSkillCopy.Type;

export const WorkspaceImportSettingChange = Schema.Struct({
  key: TrimmedNonEmptyString,
  action: Schema.Literals(["applied", "skipped"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkspaceImportSettingChange = typeof WorkspaceImportSettingChange.Type;

export const WorkspaceImportClientPreferences = Schema.Struct({
  theme: Schema.optionalKey(WorkspaceImportThemePreference),
  locale: Schema.optionalKey(WorkspaceImportLocalePreference),
});
export type WorkspaceImportClientPreferences = typeof WorkspaceImportClientPreferences.Type;

export const WorkspaceImportChatResult = Schema.Struct({
  source: WorkspaceImportSourceKind,
  sourceId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  workingDirectory: TrimmedNonEmptyString,
  action: Schema.Literals(["created", "updated", "unchanged"]),
  connectors: Schema.Array(TrimmedNonEmptyString),
});
export type WorkspaceImportChatResult = typeof WorkspaceImportChatResult.Type;

export const WorkspaceImportResourceCopy = Schema.Struct({
  name: TrimmedNonEmptyString,
  source: WorkspaceImportSourceKind,
  category: WorkspaceImportCategoryKind,
  action: Schema.Literals(["copied", "updated", "unchanged", "skipped"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  /** Imported resources are staged as inert data until an explicit review/apply flow. */
  reviewRequired: Schema.optionalKey(Schema.Boolean),
  quarantined: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceImportResourceCopy = typeof WorkspaceImportResourceCopy.Type;

export const WorkspaceImportProjectCopy = Schema.Struct({
  path: TrimmedNonEmptyString,
  action: Schema.Literals(["created", "existing", "skipped"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkspaceImportProjectCopy = typeof WorkspaceImportProjectCopy.Type;

export const WorkspaceImportApplyResult = Schema.Struct({
  skills: Schema.Array(WorkspaceImportSkillCopy),
  settings: Schema.Array(WorkspaceImportSettingChange),
  clientPreferences: WorkspaceImportClientPreferences,
  chats: Schema.Array(WorkspaceImportChatResult),
  connectors: Schema.Array(TrimmedNonEmptyString),
  skippedOlderChatCount: NonNegativeInt,
  resources: Schema.optionalKey(Schema.Array(WorkspaceImportResourceCopy)),
  projects: Schema.optionalKey(Schema.Array(WorkspaceImportProjectCopy)),
  categories: Schema.optionalKey(WorkspaceImportCategoryCounts),
  historyEntry: Schema.optionalKey(WorkspaceImportHistoryEntry),
  warnings: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type WorkspaceImportApplyResult = typeof WorkspaceImportApplyResult.Type;
