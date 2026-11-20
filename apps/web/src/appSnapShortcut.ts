// FILE: appSnapShortcut.ts
// Purpose: Detect AppSnap shortcut overlap with Moss's renderer keybindings.

import type {
  DesktopAppSnapKeyChord,
  DesktopAppSnapPlatform,
  DesktopAppSnapShortcutModifier,
  KeybindingCommand,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingsConfig,
} from "@moss/contracts";
import { appSnapShortcutKeyLabel, appSnapShortcutModifiers } from "@moss/shared/appSnapShortcut";

import { DEFAULT_SHORTCUT_FALLBACKS } from "./keybindings";

function bindingModifiers(
  shortcut: KeybindingShortcut,
  platform?: DesktopAppSnapPlatform,
): Set<DesktopAppSnapShortcutModifier> {
  const modifiers = new Set<DesktopAppSnapShortcutModifier>();
  const modTarget: DesktopAppSnapShortcutModifier =
    platform === "windows" || platform === "linux" ? "control" : "command";
  if (shortcut.modKey) modifiers.add(modTarget);
  if (shortcut.metaKey) modifiers.add("command");
  if (shortcut.ctrlKey) modifiers.add("control");
  if (shortcut.altKey) modifiers.add("option");
  if (shortcut.shiftKey) modifiers.add("shift");
  return modifiers;
}

function bindingAppliesToPlatform(
  whenAst: KeybindingWhenNode | undefined,
  platform: DesktopAppSnapPlatform | undefined,
): boolean {
  if (!whenAst || !platform) return true;
  const isMac = platform === "macos";
  const evaluate = (node: KeybindingWhenNode): boolean | null => {
    if (node.type === "identifier") {
      return node.name === "isMac" ? isMac : null;
    }
    if (node.type === "not") {
      const inner = evaluate(node.node);
      return inner === null ? null : !inner;
    }
    if (node.type === "and") {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
      return null;
    }
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
    return null;
  };
  return evaluate(whenAst) !== false;
}

function bindingKeyLabel(shortcut: KeybindingShortcut): string {
  const key = shortcut.key.toLowerCase();
  if (key === " ") return "Space";
  if (key === "enter") return "Return";
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "↑";
  if (key === "arrowdown") return "↓";
  if (key === "arrowleft") return "←";
  if (key === "arrowright") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function appSnapShortcutConflictCommand(
  shortcut: DesktopAppSnapKeyChord,
  configuredKeybindings: ResolvedKeybindingsConfig,
  platform?: DesktopAppSnapPlatform,
): KeybindingCommand | null {
  const configuredCommands = new Set(configuredKeybindings.map((binding) => binding.command));
  const bindings = [
    ...configuredKeybindings,
    ...DEFAULT_SHORTCUT_FALLBACKS.filter((binding) => !configuredCommands.has(binding.command)),
  ];
  const shortcutKeyLabel = appSnapShortcutKeyLabel(shortcut.key).toUpperCase();
  const shortcutModifiers = appSnapShortcutModifiers(shortcut);

  for (const binding of bindings) {
    if (!bindingAppliesToPlatform(binding.whenAst, platform)) continue;
    const modifiers = bindingModifiers(binding.shortcut, platform);
    if (
      modifiers.size === shortcutModifiers.length &&
      shortcutModifiers.every((modifier) => modifiers.has(modifier)) &&
      bindingKeyLabel(binding.shortcut).toUpperCase() === shortcutKeyLabel
    ) {
      return binding.command;
    }
  }
  return null;
}
