import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SNAP_SHORTCUT,
  DEFAULT_WINDOWS_APP_SNAP_SHORTCUT,
  appSnapShortcutAccelerator,
  appSnapShortcutLabels,
  appSnapShortcutSystemConflict,
  createAppSnapKeyChord,
  defaultAppSnapShortcut,
  isAppSnapShortcut,
  isAppSnapShortcutKey,
  normalizeAppSnapShortcutForPlatform,
  sameAppSnapShortcut,
} from "./appSnapShortcut";

describe("AppSnap shortcuts", () => {
  it("accepts DOM key codes, including Enter", () => {
    expect(isAppSnapShortcutKey("KeyS")).toBe(true);
    expect(isAppSnapShortcutKey("Enter")).toBe(true);
    expect(isAppSnapShortcutKey("Return")).toBe(false);
  });

  it("formats the portable chord for Electron and the UI", () => {
    const shortcut = { kind: "key-chord", modifier: "command", key: "KeyK" } as const;
    expect(appSnapShortcutAccelerator(shortcut)).toBe("Command+K");
    expect(appSnapShortcutLabels(shortcut)).toEqual(["⌘ Command", "K"]);
    expect(
      appSnapShortcutAccelerator({ kind: "key-chord", modifier: "option", key: "Enter" }),
    ).toBe("Alt+Return");
  });

  it("provides a reliable multi-modifier Windows default and platform-specific labels", () => {
    expect(defaultAppSnapShortcut("windows")).toEqual(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT);
    expect(defaultAppSnapShortcut("macos")).toEqual(DEFAULT_APP_SNAP_SHORTCUT);
    expect(appSnapShortcutAccelerator(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT, "windows")).toBe(
      "Alt+Shift+S",
    );
    expect(appSnapShortcutLabels(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT, "windows")).toEqual([
      "Alt",
      "Shift",
      "S",
    ]);
    expect(appSnapShortcutSystemConflict(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT, "windows")).toBeNull();
    expect(normalizeAppSnapShortcutForPlatform({ kind: "both-option-keys" }, "windows")).toEqual(
      DEFAULT_WINDOWS_APP_SNAP_SHORTCUT,
    );
    expect(
      appSnapShortcutLabels({ kind: "key-chord", modifier: "control", key: "Enter" }, "windows"),
    ).toEqual(["Ctrl", "Enter"]);
  });

  it("canonicalizes multi-modifier chords regardless of press order", () => {
    const shiftFirst = createAppSnapKeyChord(["shift", "option"], "KeyS");
    const altFirst = createAppSnapKeyChord(["option", "shift"], "KeyS");
    expect(shiftFirst).toEqual(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT);
    expect(altFirst).toEqual(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT);
    expect(sameAppSnapShortcut(shiftFirst!, altFirst!)).toBe(true);
    expect(isAppSnapShortcut(shiftFirst)).toBe(true);
  });

  it("rejects unsupported persisted key codes", () => {
    expect(isAppSnapShortcut({ kind: "key-chord", modifier: "option", key: "F13" })).toBe(false);
    expect(
      isAppSnapShortcut({
        kind: "key-chord",
        modifier: "option",
        extraModifiers: ["shift", "control", "command"],
        key: "KeyS",
      }),
    ).toBe(false);
  });

  it("flags universal command chords macOS would happily hand over", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyC" }),
    ).toBe("⌘ C is Copy in almost every app.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "Space" }),
    ).toBe("macOS uses ⌘ Space for Spotlight.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "option", key: "KeyC" }),
    ).toBeNull();
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "command", key: "KeyK" }),
    ).toBeNull();
  });

  it("flags Windows OS and universal Ctrl/Alt chords while permitting multi-modifier chords", () => {
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "control", key: "KeyC" },
        "windows",
      ),
    ).toBe("Ctrl + C is Copy in almost every app.");
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "option", key: "Tab" },
        "windows",
      ),
    ).toBe("Windows uses Alt + Tab to switch apps.");
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "command", key: "KeyS" },
        "windows",
      ),
    ).toContain("Windows reserves Win shortcuts");
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "control", extraModifiers: ["shift"], key: "KeyS" },
        "windows",
      ),
    ).toBeNull();
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "option", extraModifiers: ["shift"], key: "KeyS" },
        "windows",
      ),
    ).toBeNull();
  });

  it("flags chords that would break typing or terminals", () => {
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "shift", key: "KeyS" }),
    ).toMatch(/typing and text selection/);
    expect(
      appSnapShortcutSystemConflict(
        { kind: "key-chord", modifier: "shift", key: "KeyS" },
        "windows",
      ),
    ).toMatch(/combine with Ctrl or Alt/);
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyC" }),
    ).toBe("⌃ C interrupts the running program in every terminal.");
    expect(
      appSnapShortcutSystemConflict({ kind: "key-chord", modifier: "control", key: "KeyK" }),
    ).toBeNull();
  });
});
