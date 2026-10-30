// FILE: workspaceImportUi.ts
// Purpose: Pure UI state for the Import flow (empty / loading / error / cancel).
// Layer: Web UI helper

import type {
  WorkspaceImportApplyResult,
  WorkspaceImportCategoryKind,
  WorkspaceImportCategoryCounts,
  WorkspaceImportProbeResult,
  WorkspaceImportSourceKind,
  WorkspaceImportSourcePreview,
} from "@synara/contracts";

export type WorkspaceImportUiStep =
  | "loading"
  | "empty"
  | "error"
  | "pick-sources"
  | "ready"
  | "importing"
  | "success";

export interface WorkspaceImportUiState {
  readonly step: WorkspaceImportUiStep;
  readonly selectedSources: readonly WorkspaceImportSourceKind[];
  readonly probe: WorkspaceImportProbeResult | null;
  readonly result: WorkspaceImportApplyResult | null;
  readonly error: string | null;
}

export const INITIAL_WORKSPACE_IMPORT_UI_STATE: WorkspaceImportUiState = {
  step: "loading",
  selectedSources: [],
  probe: null,
  result: null,
  error: null,
};

export function presentWorkspaceImportSources(
  probe: WorkspaceImportProbeResult,
): WorkspaceImportSourcePreview[] {
  return probe.sources.filter((source) => source.present);
}

export function workspaceImportSourceLabel(source: WorkspaceImportSourceKind): string {
  switch (source) {
    case "claude":
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
  }
}

export const WORKSPACE_IMPORT_TOOLS_CATEGORIES = [
  "settings",
  "skills",
  "agents",
  "commands",
  "hooks",
  "mcp",
  "plugins",
  "memory",
] as const satisfies readonly WorkspaceImportCategoryKind[];

export function emptyWorkspaceImportCategoryCounts(): WorkspaceImportCategoryCounts {
  return {
    settings: 0,
    skills: 0,
    agents: 0,
    commands: 0,
    hooks: 0,
    mcp: 0,
    plugins: 0,
    memory: 0,
    projects: 0,
    chats: 0,
  };
}

export function workspaceImportCategoryCounts(
  preview: WorkspaceImportSourcePreview,
): WorkspaceImportCategoryCounts {
  if (preview.categoryCounts) return preview.categoryCounts;
  return {
    ...emptyWorkspaceImportCategoryCounts(),
    settings: preview.honorAbleSettingCount,
    skills: preview.skillCount,
    chats: preview.chatCount,
  };
}

export function workspaceImportDefaultCategories(
  preview: WorkspaceImportSourcePreview,
): WorkspaceImportCategoryKind[] {
  const counts = workspaceImportCategoryCounts(preview);
  return (Object.keys(counts) as WorkspaceImportCategoryKind[]).filter(
    (category) => counts[category] > 0,
  );
}

export function workspaceImportToolsSelectionState(
  selected: ReadonlySet<WorkspaceImportCategoryKind>,
  available: ReadonlySet<WorkspaceImportCategoryKind>,
): boolean | "indeterminate" {
  const total = [...available].filter((category) =>
    WORKSPACE_IMPORT_TOOLS_CATEGORIES.includes(
      category as (typeof WORKSPACE_IMPORT_TOOLS_CATEGORIES)[number],
    ),
  );
  const count = total.filter((category) => selected.has(category)).length;
  return count === 0 ? false : count === total.length ? true : "indeterminate";
}

export function toggleWorkspaceImportCategory(
  selected: ReadonlySet<WorkspaceImportCategoryKind>,
  category: WorkspaceImportCategoryKind,
): Set<WorkspaceImportCategoryKind> {
  const next = new Set(selected);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return next;
}

export function toggleWorkspaceImportTools(
  selected: ReadonlySet<WorkspaceImportCategoryKind>,
  available: ReadonlySet<WorkspaceImportCategoryKind>,
): Set<WorkspaceImportCategoryKind> {
  const next = new Set(selected);
  const tools = [...available].filter((category) =>
    WORKSPACE_IMPORT_TOOLS_CATEGORIES.includes(
      category as (typeof WORKSPACE_IMPORT_TOOLS_CATEGORIES)[number],
    ),
  );
  const allSelected = tools.length > 0 && tools.every((category) => next.has(category));
  for (const category of tools) {
    if (allSelected) next.delete(category);
    else next.add(category);
  }
  return next;
}

export function reduceWorkspaceImportProbe(
  probe: WorkspaceImportProbeResult,
): WorkspaceImportUiState {
  const present = presentWorkspaceImportSources(probe);
  if (present.length === 0) {
    return {
      ...INITIAL_WORKSPACE_IMPORT_UI_STATE,
      step: "empty",
      probe,
    };
  }
  if (probe.requiresSourceChoice || present.length > 1) {
    return {
      ...INITIAL_WORKSPACE_IMPORT_UI_STATE,
      step: "pick-sources",
      probe,
      selectedSources: [],
    };
  }
  return {
    ...INITIAL_WORKSPACE_IMPORT_UI_STATE,
    step: "ready",
    probe,
    selectedSources: present.map((source) => source.source),
  };
}

export function reduceWorkspaceImportError(message: string): WorkspaceImportUiState {
  return {
    ...INITIAL_WORKSPACE_IMPORT_UI_STATE,
    step: "error",
    error: message,
  };
}

export function canStartWorkspaceImport(state: WorkspaceImportUiState): boolean {
  return (
    (state.step === "ready" || state.step === "pick-sources") && state.selectedSources.length > 0
  );
}

export function toggleWorkspaceImportSource(
  state: WorkspaceImportUiState,
  source: WorkspaceImportSourceKind,
): WorkspaceImportUiState {
  const selected = new Set(state.selectedSources);
  if (selected.has(source)) {
    selected.delete(source);
  } else {
    selected.add(source);
  }
  const nextSelected = [...selected];
  return {
    ...state,
    selectedSources: nextSelected,
    step:
      nextSelected.length > 0 && state.probe && !state.probe.requiresSourceChoice
        ? "ready"
        : state.step === "ready" && nextSelected.length === 0
          ? "pick-sources"
          : state.step,
  };
}
