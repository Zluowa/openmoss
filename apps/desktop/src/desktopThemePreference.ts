// FILE: desktopThemePreference.ts
// Purpose: Restores the native window appearance before its first renderer paint.
// Layer: Desktop preference persistence
// Exports: readDesktopThemePreference, writeDesktopThemePreference

import * as fs from "node:fs";
import path from "node:path";

type DesktopTheme = "light" | "dark" | "system";
type StartupBackgrounds = { readonly light: string; readonly dark: string };

function readPreference(file: string): { mode: unknown; backgrounds?: unknown } {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value.startsWith("{")) {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        return parsed as { mode: unknown; backgrounds?: unknown };
    }
    return { mode: value };
  } catch {
    return { mode: "system" };
  }
}

export function parseDesktopStartupBackgrounds(value: unknown): StartupBackgrounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as StartupBackgrounds;
  return typeof candidate.light === "string" &&
    /^#[0-9a-f]{6}$/i.test(candidate.light) &&
    typeof candidate.dark === "string" &&
    /^#[0-9a-f]{6}$/i.test(candidate.dark)
    ? { light: candidate.light, dark: candidate.dark }
    : undefined;
}

export function readDesktopStartupBackground(file: string, dark: boolean): string {
  const backgrounds = parseDesktopStartupBackgrounds(readPreference(file).backgrounds);
  return (dark ? backgrounds?.dark : backgrounds?.light) ?? (dark ? "#181818" : "#ffffff");
}

export function readDesktopThemePreference(file: string): DesktopTheme {
  try {
    const value = readPreference(file).mode;
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export async function writeDesktopThemePreference(
  file: string,
  theme: DesktopTheme,
  backgrounds?: StartupBackgrounds,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify({ mode: theme, backgrounds })}\n`, "utf8");
}
