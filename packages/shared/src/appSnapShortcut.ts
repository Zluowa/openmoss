// FILE: appSnapShortcut.ts
// Purpose: Normalize AppSnap's portable global shortcut model for desktop and web clients.

import type {
  DesktopAppSnapKeyChord,
  DesktopAppSnapPlatform,
  DesktopAppSnapShortcut,
  DesktopAppSnapShortcutModifier,
} from "@moss/contracts";

export const DEFAULT_APP_SNAP_SHORTCUT = {
  kind: "both-option-keys",
} as const satisfies DesktopAppSnapShortcut;

/**
 * Reliable Windows default: Alt+Shift+S avoids Win32 Alt+letter menu mnemonics,
 * Windows OS shortcuts (Win+Shift+S), WeChat/QQ defaults (Alt+A / Ctrl+Alt+A),
 * and every default Moss renderer keybinding.
 */
export const DEFAULT_WINDOWS_APP_SNAP_SHORTCUT = {
  kind: "key-chord",
  modifier: "option",
  extraModifiers: ["shift"],
  key: "KeyS",
} as const satisfies DesktopAppSnapKeyChord;

export const APP_SNAP_SHORTCUT_MODIFIERS = [
  "command",
  "control",
  "option",
  "shift",
] as const satisfies ReadonlyArray<DesktopAppSnapShortcutModifier>;

const WINDOWS_MODIFIER_ORDER = [
  "control",
  "option",
  "shift",
  "command",
] as const satisfies ReadonlyArray<DesktopAppSnapShortcutModifier>;

export const APP_SNAP_SHORTCUT_KEYS = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

const APP_SNAP_SHORTCUT_KEY_SET = new Set<string>(APP_SNAP_SHORTCUT_KEYS);

const MODIFIER_BY_EVENT_CODE: Readonly<Record<string, DesktopAppSnapShortcutModifier>> = {
  MetaLeft: "command",
  MetaRight: "command",
  ControlLeft: "control",
  ControlRight: "control",
  AltLeft: "option",
  AltRight: "option",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

const MAC_MODIFIER_LABELS: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "⌘ Command",
  control: "⌃ Control",
  option: "⌥ Option",
  shift: "⇧ Shift",
};

const NON_MAC_MODIFIER_LABELS: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "Win",
  control: "Ctrl",
  option: "Alt",
  shift: "Shift",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

// Chords Electron's globalShortcut probe reports as free even though reserving
// them would hijack typing or a universal action in every foreground app.
const SYSTEM_CONTROL_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyC: "interrupts the running program",
  KeyD: "ends input",
  KeyZ: "suspends the running program",
};

const SYSTEM_COMMAND_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyA: "Select All",
  KeyC: "Copy",
  KeyF: "Find",
  KeyH: "Hide",
  KeyM: "Minimize",
  KeyN: "New",
  KeyO: "Open",
  KeyP: "Print",
  KeyQ: "Quit",
  KeyS: "Save",
  KeyT: "New Tab",
  KeyV: "Paste",
  KeyW: "Close Window",
  KeyX: "Cut",
  KeyZ: "Undo",
  Space: "Spotlight",
  Tab: "app switching",
};

const WINDOWS_SYSTEM_CONTROL_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyA: "Select All",
  KeyC: "Copy",
  KeyF: "Find",
  KeyH: "Replace",
  KeyN: "New",
  KeyO: "Open",
  KeyP: "Print",
  KeyS: "Save",
  KeyT: "New Tab",
  KeyV: "Paste",
  KeyW: "Close Window",
  KeyX: "Cut",
  KeyY: "Redo",
  KeyZ: "Undo",
  Tab: "tab switching",
  Escape: "Start menu",
};

const ELECTRON_MODIFIER_NAMES: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "Command",
  control: "Control",
  option: "Alt",
  shift: "Shift",
};

function isNonMacPlatform(platform?: DesktopAppSnapPlatform): boolean {
  return platform === "windows" || platform === "linux";
}

export function defaultAppSnapShortcut(platform?: DesktopAppSnapPlatform): DesktopAppSnapShortcut {
  return platform === "windows" ? DEFAULT_WINDOWS_APP_SNAP_SHORTCUT : DEFAULT_APP_SNAP_SHORTCUT;
}

export function isAppSnapShortcutModifier(value: unknown): value is DesktopAppSnapShortcutModifier {
  return APP_SNAP_SHORTCUT_MODIFIERS.includes(value as DesktopAppSnapShortcutModifier);
}

export function isAppSnapShortcutKey(value: unknown): value is string {
  return typeof value === "string" && APP_SNAP_SHORTCUT_KEY_SET.has(value);
}

export function appSnapShortcutModifiers(
  chord: DesktopAppSnapKeyChord,
  platform?: DesktopAppSnapPlatform,
): readonly DesktopAppSnapShortcutModifier[] {
  const unique = new Set<DesktopAppSnapShortcutModifier>([chord.modifier]);
  if (Array.isArray(chord.extraModifiers)) {
    for (const extra of chord.extraModifiers) {
      if (isAppSnapShortcutModifier(extra)) unique.add(extra);
    }
  }
  const order = isNonMacPlatform(platform) ? WINDOWS_MODIFIER_ORDER : APP_SNAP_SHORTCUT_MODIFIERS;
  return order.filter((modifier) => unique.has(modifier));
}

export function createAppSnapKeyChord(
  modifiers: readonly DesktopAppSnapShortcutModifier[],
  key: string,
): DesktopAppSnapKeyChord | null {
  if (!isAppSnapShortcutKey(key)) return null;
  const unique = new Set<DesktopAppSnapShortcutModifier>();
  for (const modifier of modifiers) {
    if (isAppSnapShortcutModifier(modifier)) unique.add(modifier);
  }
  const ordered = APP_SNAP_SHORTCUT_MODIFIERS.filter((modifier) => unique.has(modifier));
  const first = ordered[0];
  if (!first || ordered.length > 3) return null;
  const extraModifiers = ordered.slice(1);
  return extraModifiers.length > 0
    ? { kind: "key-chord", modifier: first, extraModifiers, key }
    : { kind: "key-chord", modifier: first, key };
}

export function normalizeAppSnapShortcutForPlatform(
  shortcut: DesktopAppSnapShortcut,
  platform?: DesktopAppSnapPlatform,
): DesktopAppSnapShortcut {
  if (shortcut.kind === "both-option-keys") {
    return platform === "windows" ? DEFAULT_WINDOWS_APP_SNAP_SHORTCUT : DEFAULT_APP_SNAP_SHORTCUT;
  }
  return createAppSnapKeyChord(appSnapShortcutModifiers(shortcut), shortcut.key) ?? shortcut;
}

export function appSnapShortcutStorageKey(shortcut: DesktopAppSnapShortcut): string {
  if (shortcut.kind === "both-option-keys") return "both-option-keys";
  return `${appSnapShortcutModifiers(shortcut).join("+")}:${shortcut.key}`;
}

export function isAppSnapShortcut(value: unknown): value is DesktopAppSnapShortcut {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "both-option-keys") return true;
  if (
    candidate.kind !== "key-chord" ||
    !isAppSnapShortcutModifier(candidate.modifier) ||
    !isAppSnapShortcutKey(candidate.key)
  ) {
    return false;
  }
  if (candidate.extraModifiers === undefined) return true;
  return (
    Array.isArray(candidate.extraModifiers) &&
    candidate.extraModifiers.length <= 2 &&
    candidate.extraModifiers.every(isAppSnapShortcutModifier)
  );
}

export function appSnapModifierFromEventCode(code: string): DesktopAppSnapShortcutModifier | null {
  return MODIFIER_BY_EVENT_CODE[code] ?? null;
}

/**
 * Reason a chord must not be reserved globally even though the OS reports it as
 * free, e.g. ⌘C / Ctrl+C or bare Shift+S: reserving it would break typing or a
 * universal action in every foreground app.
 */
export function appSnapShortcutSystemConflict(
  chord: DesktopAppSnapKeyChord,
  platform?: DesktopAppSnapPlatform,
): string | null {
  const modifiers = appSnapShortcutModifiers(chord);
  if (modifiers.length === 1 && modifiers[0] === "shift") {
    return platform === "windows"
      ? "Shift-only combinations are used for typing and text selection — combine with Ctrl or Alt instead."
      : "⇧ combinations are used for typing and text selection — combine with ⌘, ⌃ or ⌥ instead.";
  }

  if (platform === "windows") {
    if (modifiers.includes("command")) {
      return "Windows reserves Win shortcuts for system actions — use Ctrl or Alt instead.";
    }
    if (modifiers.length === 1 && modifiers[0] === "control") {
      const action = WINDOWS_SYSTEM_CONTROL_CHORD_ACTIONS[chord.key];
      if (!action) return null;
      if (chord.key === "Escape") return "Windows uses Ctrl + Esc to open Start.";
      if (chord.key === "Tab") return "Ctrl + Tab is used for tab switching in almost every app.";
      return `Ctrl + ${appSnapShortcutKeyLabel(chord.key, platform)} is ${action} in almost every app.`;
    }
    if (modifiers.length === 1 && modifiers[0] === "option") {
      if (chord.key === "Tab") return "Windows uses Alt + Tab to switch apps.";
      if (chord.key === "Escape") return "Windows uses Alt + Esc to cycle windows.";
      if (chord.key === "Space") return "Windows uses Alt + Space for the window menu.";
      if (chord.key === "Enter") {
        return "Alt + Enter is used for properties or fullscreen in many apps.";
      }
    }
    return null;
  }

  if (modifiers.length === 1 && modifiers[0] === "control") {
    const action = SYSTEM_CONTROL_CHORD_ACTIONS[chord.key];
    return action ? `⌃ ${appSnapShortcutKeyLabel(chord.key)} ${action} in every terminal.` : null;
  }
  if (modifiers.length !== 1 || modifiers[0] !== "command") return null;
  const action = SYSTEM_COMMAND_CHORD_ACTIONS[chord.key];
  if (!action) return null;
  if (chord.key === "Space") return "macOS uses ⌘ Space for Spotlight.";
  if (chord.key === "Tab") return "macOS uses ⌘ Tab to switch apps.";
  return `⌘ ${appSnapShortcutKeyLabel(chord.key)} is ${action} in almost every app.`;
}

export function appSnapShortcutLabels(
  shortcut: DesktopAppSnapShortcut,
  platform?: DesktopAppSnapPlatform,
): readonly string[] {
  if (shortcut.kind === "both-option-keys") {
    return isNonMacPlatform(platform) ? ["Left Alt", "Right Alt"] : ["⌥ left", "⌥ right"];
  }
  return [
    ...appSnapShortcutModifiers(shortcut, platform).map((modifier) =>
      appSnapShortcutModifierLabel(modifier, platform),
    ),
    appSnapShortcutKeyLabel(shortcut.key, platform),
  ];
}

export function appSnapShortcutModifierLabel(
  modifier: DesktopAppSnapShortcutModifier,
  platform?: DesktopAppSnapPlatform,
): string {
  return isNonMacPlatform(platform)
    ? NON_MAC_MODIFIER_LABELS[modifier]
    : MAC_MODIFIER_LABELS[modifier];
}

export function appSnapShortcutKeyLabel(code: string, platform?: DesktopAppSnapPlatform): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code === "Enter" && isNonMacPlatform(platform)) return "Enter";
  return KEY_LABELS[code] ?? code;
}

export function appSnapShortcutAccelerator(
  shortcut: DesktopAppSnapKeyChord,
  platform?: DesktopAppSnapPlatform,
): string {
  const key = shortcut.key.startsWith("Key")
    ? shortcut.key.slice(3)
    : shortcut.key.startsWith("Digit")
      ? shortcut.key.slice(5)
      : (ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key);
  const modifierNames = appSnapShortcutModifiers(shortcut, platform).map((modifier) =>
    modifier === "command" && isNonMacPlatform(platform)
      ? "Super"
      : ELECTRON_MODIFIER_NAMES[modifier],
  );
  return `${modifierNames.join("+")}+${key}`;
}

export function sameAppSnapShortcut(
  left: DesktopAppSnapShortcut,
  right: DesktopAppSnapShortcut,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "both-option-keys" || right.kind === "both-option-keys") return true;
  if (left.key !== right.key) return false;
  const leftModifiers = appSnapShortcutModifiers(left);
  const rightModifiers = appSnapShortcutModifiers(right);
  return (
    leftModifiers.length === rightModifiers.length &&
    leftModifiers.every((modifier, index) => modifier === rightModifiers[index])
  );
}
