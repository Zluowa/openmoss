import { describe, expect, it, vi } from "vitest";

import {
  DesktopRealtimeVoiceShortcutManager,
  realtimeVoiceShortcutAccelerator,
} from "./realtimeVoiceShortcut";

describe("realtimeVoiceShortcutAccelerator", () => {
  it("maps the canonical renderer shortcut to Electron accelerators", () => {
    expect(realtimeVoiceShortcutAccelerator("meta+shift+v", "darwin")).toBe("Command+Shift+V");
    expect(realtimeVoiceShortcutAccelerator("ctrl+alt+v", "win32")).toBe("Control+Alt+V");
  });

  it("rejects bare, duplicate, and unsupported keys", () => {
    expect(realtimeVoiceShortcutAccelerator("v", "darwin")).toBeNull();
    expect(realtimeVoiceShortcutAccelerator("meta+meta+v", "darwin")).toBeNull();
    expect(realtimeVoiceShortcutAccelerator("meta+escape", "darwin")).toBeNull();
  });
});

describe("DesktopRealtimeVoiceShortcutManager", () => {
  it("registers one shortcut, invokes the toggle, and releases it", () => {
    let trigger: (() => void) | null = null;
    const unregister = vi.fn();
    const onToggle = vi.fn();
    const manager = new DesktopRealtimeVoiceShortcutManager({
      platform: "darwin",
      onToggle,
      registry: {
        register: (_accelerator, callback) => {
          trigger = callback;
          return true;
        },
        unregister,
      },
    });
    expect(manager.setShortcut("meta+shift+v").registered).toBe(true);
    (trigger as (() => void) | null)?.();
    expect(onToggle).toHaveBeenCalledOnce();
    manager.dispose();
    expect(unregister).toHaveBeenCalledWith("Command+Shift+V");
  });
});
