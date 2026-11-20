import { describe, expect, it, vi } from "vitest";

import {
  bringMainWindowToFrontForAppSnap,
  type AppSnapReturnWindowLike,
} from "./appSnapWindowReturn";

function makeWindow(
  overrides: Partial<AppSnapReturnWindowLike> = {},
): AppSnapReturnWindowLike & { calls: string[] } {
  const calls: string[] = [];
  let alwaysOnTop = false;
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {
      calls.push("restore");
    },
    isVisible: () => true,
    show: () => {
      calls.push("show");
    },
    isFocused: () => false,
    focus: () => {
      calls.push("focus");
    },
    moveTop: () => {
      calls.push("moveTop");
    },
    isAlwaysOnTop: () => alwaysOnTop,
    setAlwaysOnTop: (flag, level) => {
      alwaysOnTop = flag;
      calls.push(level ? `alwaysOnTop:${flag}:${level}` : `alwaysOnTop:${flag}`);
    },
    ...overrides,
  };
}

describe("bringMainWindowToFrontForAppSnap", () => {
  it("forces reliable foreground activation on Windows and restores alwaysOnTop", () => {
    const win = makeWindow({ isMinimized: () => true, isVisible: () => false });
    bringMainWindowToFrontForAppSnap(win, { platform: "win32" });
    expect(win.calls).toEqual([
      "restore",
      "show",
      "moveTop",
      "alwaysOnTop:true:pop-up-menu",
      "show",
      "focus",
      "alwaysOnTop:false",
    ]);
    expect(win.isAlwaysOnTop?.()).toBe(false);
  });

  it("does not toggle alwaysOnTop when the Windows window is already focused or pinned", () => {
    const focused = makeWindow({ isFocused: () => true });
    bringMainWindowToFrontForAppSnap(focused, { platform: "win32" });
    expect(focused.calls).toEqual(["moveTop", "focus"]);

    const pinned = makeWindow({ isAlwaysOnTop: () => true });
    bringMainWindowToFrontForAppSnap(pinned, { platform: "win32" });
    expect(pinned.calls).toEqual(["moveTop", "focus"]);
  });

  it("always clears alwaysOnTop on Windows even if focus throws", () => {
    const win = makeWindow({
      focus: () => {
        throw new Error("focus failed");
      },
    });
    expect(() => bringMainWindowToFrontForAppSnap(win, { platform: "win32" })).toThrow(
      "focus failed",
    );
    expect(win.isAlwaysOnTop?.()).toBe(false);
  });

  it("uses app.show and app.focus({ steal: true }) on macOS", () => {
    const win = makeWindow();
    const showApp = vi.fn();
    const focusApp = vi.fn();
    bringMainWindowToFrontForAppSnap(win, { platform: "darwin", showApp, focusApp });
    expect(showApp).toHaveBeenCalledOnce();
    expect(focusApp).toHaveBeenCalledWith({ steal: true });
    expect(win.calls).toEqual(["focus"]);
  });
});
