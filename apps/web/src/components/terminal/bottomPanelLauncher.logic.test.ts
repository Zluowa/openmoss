import { describe, expect, it } from "vitest";

import {
  BOTTOM_PANEL_LAUNCHER_ACTIONS,
  isBottomPanelLauncherActionKind,
} from "./bottomPanelLauncher.logic";

describe("bottom panel launcher", () => {
  it("keeps the Codex action order, labels, and shortcut chips stable", () => {
    expect(BOTTOM_PANEL_LAUNCHER_ACTIONS).toEqual([
      { kind: "explorer", label: "Files", shortcut: "⌘P" },
      { kind: "sidechat", label: "Side task", shortcut: "⌘⌥S" },
      { kind: "browser", label: "Browser", shortcut: "⌘T" },
      { kind: "review", label: "Review", shortcut: "Ctrl+Shift+G" },
      { kind: "terminal", label: "Terminal", shortcut: null },
    ]);
  });

  it("accepts only launcher action kinds", () => {
    for (const action of BOTTOM_PANEL_LAUNCHER_ACTIONS) {
      expect(isBottomPanelLauncherActionKind(action.kind)).toBe(true);
    }
    expect(isBottomPanelLauncherActionKind("diff")).toBe(false);
    expect(isBottomPanelLauncherActionKind(null)).toBe(false);
  });
});
