import { describe, expect, it } from "vitest";

import { computerSessionHotkey } from "./computerSessionHotkeys";

describe("computerSessionHotkey", () => {
  it("refuses the macOS lock, log out and power chords in any spelling or order", () => {
    expect(computerSessionHotkey(["ctrl", "meta", "q"], "macos")).toEqual({
      chord: "cmd+ctrl+q",
      action: "lock the screen",
    });
    expect(computerSessionHotkey(["Command+Control+Q"], "macos")?.action).toBe("lock the screen");
    expect(computerSessionHotkey(["meta", "shift", "q"], "macos")?.action).toBe("log out");
    expect(computerSessionHotkey(["option", "cmd", "shift", "q"], "macos")?.action).toBe("log out");
    expect(computerSessionHotkey(["alt", "meta", "power"], "macos")?.action).toBe(
      "put the computer to sleep",
    );
    expect(computerSessionHotkey(["ctrl", "ctrl", "cmd", "q"], "macos")?.chord).toBe("cmd+ctrl+q");
  });

  it("leaves ordinary macOS shortcuts alone, including Command-L and Command-Q", () => {
    expect(computerSessionHotkey(["meta", "l"], "macos")).toBeUndefined();
    expect(computerSessionHotkey(["meta", "q"], "macos")).toBeUndefined();
    expect(computerSessionHotkey(["meta", "shift", "z"], "macos")).toBeUndefined();
    expect(computerSessionHotkey(["enter"], "macos")).toBeUndefined();
    expect(computerSessionHotkey(["ctrl", "alt", "f2"], "macos")).toBeUndefined();
  });

  it("refuses Linux lock, log out, display-server kill and virtual terminal switches", () => {
    expect(computerSessionHotkey(["meta", "l"], "linux")?.action).toBe("lock the screen");
    expect(computerSessionHotkey(["super_l+l"], "linux")?.action).toBe("lock the screen");
    expect(computerSessionHotkey(["ctrl", "alt", "l"], "linux")?.action).toBe("lock the screen");
    expect(computerSessionHotkey(["ctrl", "alt", "del"], "linux")?.action).toBe(
      "open the log out dialog",
    );
    expect(computerSessionHotkey(["ctrl", "alt", "backspace"], "linux")?.action).toBe(
      "kill the display server",
    );
    expect(computerSessionHotkey(["ctrl", "alt", "f3"], "linux")?.action).toBe(
      "switch virtual terminal",
    );
    expect(computerSessionHotkey(["ctrl", "l"], "linux")).toBeUndefined();
    expect(computerSessionHotkey(["ctrl", "shift", "q"], "linux")).toBeUndefined();
  });

  it("refuses the Windows lock and secure attention chords", () => {
    expect(computerSessionHotkey(["win", "l"], "windows")?.action).toBe("lock the screen");
    expect(computerSessionHotkey(["ctrl", "alt", "delete"], "windows")?.action).toBe(
      "open the secure attention screen",
    );
    expect(computerSessionHotkey(["ctrl", "alt", "end"], "windows")?.action).toBe(
      "open the secure attention screen",
    );
  });

  it("refuses bare power and sleep keys on every platform", () => {
    for (const platform of ["macos", "linux", "windows"] as const) {
      expect(computerSessionHotkey(["power"], platform)).toBeDefined();
      expect(computerSessionHotkey(["XF86Sleep"], platform)).toBeDefined();
      expect(computerSessionHotkey(["XF86LogOff"], platform)).toBeDefined();
    }
  });

  it("treats empty input as no chord", () => {
    expect(computerSessionHotkey([], "macos")).toBeUndefined();
    expect(computerSessionHotkey(["+"], "linux")).toBeUndefined();
  });
});
