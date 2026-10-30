// FILE: workspaceImportUi.test.ts
// Purpose: Prove Import UI states and provider/category selection semantics.
// Layer: Web UI tests

import { describe, expect, it } from "vitest";

import {
  canStartWorkspaceImport,
  INITIAL_WORKSPACE_IMPORT_UI_STATE,
  reduceWorkspaceImportError,
  reduceWorkspaceImportProbe,
  toggleWorkspaceImportSource,
  toggleWorkspaceImportCategory,
  toggleWorkspaceImportTools,
  workspaceImportToolsSelectionState,
  workspaceImportSourceLabel,
} from "./workspaceImportUi";

describe("workspace import UI", () => {
  it("starts in a loading state", () => {
    expect(INITIAL_WORKSPACE_IMPORT_UI_STATE.step).toBe("loading");
  });

  it("shows an empty state when neither source has data", () => {
    const next = reduceWorkspaceImportProbe({
      requiresSourceChoice: false,
      sources: [
        {
          source: "claude",
          present: false,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 0,
          olderChatCount: 0,
        },
        {
          source: "cursor",
          present: false,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 0,
          olderChatCount: 0,
        },
      ],
    });
    expect(next.step).toBe("empty");
    expect(canStartWorkspaceImport(next)).toBe(false);
  });

  it("asks which source to use when both Claude Code and Cursor have data", () => {
    const next = reduceWorkspaceImportProbe({
      requiresSourceChoice: true,
      sources: [
        {
          source: "claude",
          present: true,
          skillCount: 1,
          honorAbleSettingCount: 1,
          chatCount: 1,
          olderChatCount: 0,
        },
        {
          source: "cursor",
          present: true,
          skillCount: 1,
          honorAbleSettingCount: 1,
          chatCount: 1,
          olderChatCount: 0,
        },
      ],
    });
    expect(next.step).toBe("pick-sources");
    expect(next.selectedSources).toEqual([]);
    expect(canStartWorkspaceImport(next)).toBe(false);
    const selected = toggleWorkspaceImportSource(next, "claude");
    expect(selected.selectedSources).toEqual(["claude"]);
    expect(canStartWorkspaceImport(selected)).toBe(true);
  });

  it("skips the picker when only one source has data", () => {
    const next = reduceWorkspaceImportProbe({
      requiresSourceChoice: false,
      sources: [
        {
          source: "claude",
          present: true,
          skillCount: 2,
          honorAbleSettingCount: 1,
          chatCount: 3,
          olderChatCount: 1,
        },
        {
          source: "cursor",
          present: false,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 0,
          olderChatCount: 0,
        },
      ],
    });
    expect(next.step).toBe("ready");
    expect(next.selectedSources).toEqual(["claude"]);
    expect(canStartWorkspaceImport(next)).toBe(true);
  });

  it("exposes a cancellable error state", () => {
    const next = reduceWorkspaceImportError("Could not read local Claude Code data.");
    expect(next.step).toBe("error");
    expect(next.error).toContain("Claude Code");
    expect(canStartWorkspaceImport(next)).toBe(false);
  });

  it("labels every supported source", () => {
    expect(workspaceImportSourceLabel("claude")).toBe("Claude Code");
    expect(workspaceImportSourceLabel("cursor")).toBe("Cursor");
    expect(workspaceImportSourceLabel("codex")).toBe("Codex");
    expect(workspaceImportSourceLabel("grok")).toBe("Grok");
    expect(workspaceImportSourceLabel("opencode")).toBe("OpenCode");
  });

  it("supports tri-state tools selection and category toggles", () => {
    const available = new Set(["settings", "skills", "agents"] as const);
    const selected = new Set(["settings"] as const);
    expect(workspaceImportToolsSelectionState(selected, available)).toBe("indeterminate");
    const all = toggleWorkspaceImportTools(selected, available);
    expect(all).toEqual(new Set(["settings", "skills", "agents"]));
    expect(toggleWorkspaceImportCategory(all, "agents")).toEqual(new Set(["settings", "skills"]));
  });
});
