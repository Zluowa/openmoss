// FILE: themePreload.test.ts
// Purpose: Exercises the script that runs before the first splash paint.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../public/theme-preload.js", import.meta.url), "utf8");
function restore(raw: string | null, systemDark = false) {
  const toggle = vi.fn();
  const setProperty = vi.fn();
  const root = { classList: { toggle }, style: { colorScheme: "", setProperty } };
  runInNewContext(script, {
    localStorage: { getItem: () => raw },
    matchMedia: () => ({ matches: systemDark }),
    document: { documentElement: root },
  });
  return { root, toggle, setProperty };
}

describe("first-paint theme", () => {
  it("restores dark mode and the chosen surface before React", () => {
    const state = restore(
      JSON.stringify({ mode: "dark", chromeThemes: { dark: { surface: "#3B3B3D" } } }),
    );
    expect(state.toggle).toHaveBeenCalledWith("dark", true);
    expect(state.setProperty).toHaveBeenCalledWith("--moss-boot-background", "#3B3B3D");
    expect(state.root.style.colorScheme).toBe("");
  });

  it("honors light over a dark system and ignores unsafe stored CSS", () => {
    const state = restore(
      JSON.stringify({
        mode: "light",
        chromeThemes: { light: { surface: "url(https://example.com)" } },
      }),
      true,
    );
    expect(state.toggle).toHaveBeenCalledWith("dark", false);
    expect(state.setProperty).toHaveBeenCalledWith("--moss-boot-background", "#ffffff");
  });

  it("survives damaged storage and follows system appearance", () => {
    const state = restore("not-json", true);
    expect(state.toggle).toHaveBeenCalledWith("dark", true);
  });
});
