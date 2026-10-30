// FILE: bottomPanelLauncher.logic.ts
// Purpose: Stable Codex-style action contract for the bottom-panel "+" launcher.
// Layer: Pure terminal drawer UI model.

export const BOTTOM_PANEL_LAUNCHER_ACTION_KINDS = [
  "explorer",
  "sidechat",
  "browser",
  "review",
  "terminal",
] as const;

export type BottomPanelLauncherActionKind = (typeof BOTTOM_PANEL_LAUNCHER_ACTION_KINDS)[number];

export interface BottomPanelLauncherAction {
  kind: BottomPanelLauncherActionKind;
  label: string;
  shortcut: string | null;
}

export const BOTTOM_PANEL_LAUNCHER_ACTIONS: readonly BottomPanelLauncherAction[] = [
  { kind: "explorer", label: "Files", shortcut: "⌘P" },
  { kind: "sidechat", label: "Side task", shortcut: "⌘⌥S" },
  { kind: "browser", label: "Browser", shortcut: "⌘T" },
  { kind: "review", label: "Review", shortcut: "Ctrl+Shift+G" },
  { kind: "terminal", label: "Terminal", shortcut: null },
];

const BOTTOM_PANEL_LAUNCHER_ACTION_KIND_SET: ReadonlySet<string> = new Set(
  BOTTOM_PANEL_LAUNCHER_ACTION_KINDS,
);

export function isBottomPanelLauncherActionKind(
  value: unknown,
): value is BottomPanelLauncherActionKind {
  return typeof value === "string" && BOTTOM_PANEL_LAUNCHER_ACTION_KIND_SET.has(value);
}
