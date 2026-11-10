// FILE: desktopThemePreference.test.ts
// Purpose: Checks native first-paint theme restoration across restarts.

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDesktopStartupBackgrounds,
  readDesktopStartupBackground,
  readDesktopThemePreference,
  writeDesktopThemePreference,
} from "./desktopThemePreference";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("native first-paint theme", () => {
  it("restores explicitly chosen dark mode even on a light system", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-theme-"));
    directories.push(directory);
    const file = path.join(directory, "userdata", "theme");
    expect(readDesktopThemePreference(file)).toBe("system");
    await writeDesktopThemePreference(file, "dark");
    expect(readDesktopThemePreference(file)).toBe("dark");
    await writeDesktopThemePreference(file, "light");
    expect(readDesktopThemePreference(file)).toBe("light");
    await writeDesktopThemePreference(file, "system");
    expect(readDesktopThemePreference(file)).toBe("system");
  });

  it("uses the system when the preference is damaged", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-theme-"));
    directories.push(directory);
    const file = path.join(directory, "theme");
    await fs.writeFile(file, "unexpected");
    expect(readDesktopThemePreference(file)).toBe("system");
  });

  it("preserves both palette backgrounds for native first paint and system switches", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-theme-"));
    directories.push(directory);
    const file = path.join(directory, "theme");
    await writeDesktopThemePreference(file, "system", { light: "#fafafa", dark: "#3b3b3d" });
    expect(readDesktopThemePreference(file)).toBe("system");
    expect(readDesktopStartupBackground(file, true)).toBe("#3b3b3d");
    expect(readDesktopStartupBackground(file, false)).toBe("#fafafa");
    await fs.writeFile(file, "dark\n");
    expect(readDesktopThemePreference(file)).toBe("dark");
    expect(readDesktopStartupBackground(file, true)).toBe("#181818");
    await fs.writeFile(
      file,
      JSON.stringify({ mode: "dark", backgrounds: { light: "red", dark: "url(secret)" } }),
    );
    expect(readDesktopStartupBackground(file, true)).toBe("#181818");
    expect(parseDesktopStartupBackgrounds({ dark: "#000000" })).toBeUndefined();
  });
});
