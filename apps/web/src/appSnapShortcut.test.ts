import { DEFAULT_WINDOWS_APP_SNAP_SHORTCUT } from "@moss/shared/appSnapShortcut";
import { describe, expect, it } from "vitest";

import { appSnapShortcutConflictCommand } from "./appSnapShortcut";

describe("AppSnap renderer shortcut conflicts", () => {
  it("finds a default Moss shortcut", () => {
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "command", key: "KeyN" }, []),
    ).toBe("chat.new");
  });

  it("finds a configured shortcut and ignores non-matching modifier counts", () => {
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "option", key: "KeyK" }, [
        {
          command: "chat.new",
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
            modKey: false,
          },
        },
      ]),
    ).toBe("chat.new");
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "command", key: "KeyM" }, []),
    ).toBeNull();
  });

  it("checks multi-modifier Windows chords against Ctrl-mapped modKey bindings", () => {
    expect(
      appSnapShortcutConflictCommand(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT, [], "windows"),
    ).toBeNull();
    expect(
      appSnapShortcutConflictCommand(
        { kind: "key-chord", modifier: "control", extraModifiers: ["option"], key: "KeyS" },
        [],
        "windows",
      ),
    ).toBe("sidechat.toggle");
    expect(
      appSnapShortcutConflictCommand(
        { kind: "key-chord", modifier: "control", key: "KeyN" },
        [],
        "windows",
      ),
    ).toBe("chat.new");
  });
});
