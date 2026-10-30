// FILE: index.ts
// Purpose: Public server entry for the clean-room workspace import flow.
// Layer: Server import helper

export {
  persistWorkspaceImportHistory,
  persistWorkspaceImportLedger,
  persistWorkspaceImportSyncPreferences,
  prepareWorkspaceImportApply,
} from "./apply";
export type { WorkspaceImportApplyContext, WorkspaceImportPreparedApply } from "./apply";
export { planChatSync } from "./chatSync";
export { probeWorkspaceImport } from "./probe";
export type { WorkspaceImportProbeContext } from "./probe";
export { absorbHonorAbleSettings, sanitizeImportSettingsPatch } from "./settingsAbsorb";
export { workspaceImportLedgerKey } from "./ledger";
export {
  WORKSPACE_IMPORT_PROVIDERS,
  canonicalWorkspaceImportSources,
  workspaceImportProviderForSource,
} from "./providers";
export {
  countImportProjects,
  discoverImportProjectRoots,
  discoverImportResources,
  copyImportResources,
} from "./resources";
