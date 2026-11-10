import * as RealFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Windows app execution aliases answer `stat` with EACCES although they exist.
const ALIAS = "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
const fakeFs = vi.hoisted(() => ({ refused: new Map<string, string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((path: RealFS.PathLike, options?: RealFS.StatSyncOptions) => {
      const code = fakeFs.refused.get(String(path));
      if (code) throw Object.assign(new Error(`${code}: ${String(path)}`), { code });
      return actual.statSync(path, options);
    }) as typeof actual.statSync,
  };
});

const { isExecutableFile, resolveExecutable } = await import("./executable");
const windows = {
  platform: "win32" as const,
  env: { PATH: "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps", PATHEXT: ".COM;.EXE" },
};

afterEach(() => {
  fakeFs.refused.clear();
});

describe("Windows app execution aliases", () => {
  it("counts an alias in WindowsApps as launchable, by full path and through PATH", () => {
    fakeFs.refused.set(ALIAS, "EACCES");
    expect(isExecutableFile(ALIAS, windows)).toBe(true);
    expect(resolveExecutable("winget", windows)).toBe(ALIAS);
  });

  it("still treats other unreadable or missing files as missing", () => {
    const elsewhere = "C:\\Tools\\winget.exe";
    const script = "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps\\setup.cmd";
    for (const path of [elsewhere, script]) {
      fakeFs.refused.set(path, "EACCES");
      expect(isExecutableFile(path, windows)).toBe(false);
    }
    // Gone, not refused: a missing or dangling alias is not launchable.
    fakeFs.refused.set(ALIAS, "ENOENT");
    expect(isExecutableFile(ALIAS, windows)).toBe(false);
  });

  it("leaves POSIX lookups alone", () => {
    fakeFs.refused.set(ALIAS, "EACCES");
    expect(isExecutableFile(ALIAS, { platform: "linux", env: {} })).toBe(false);
  });
});

const realAlias = process.env.LOCALAPPDATA
  ? `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\winget.exe`
  : "";
const hasRealAlias =
  process.platform === "win32" &&
  realAlias !== "" &&
  (() => {
    try {
      RealFS.lstatSync(realAlias);
      return true;
    } catch {
      return false;
    }
  })();

// Only where App Installer is installed (as on the computer this was found on).
it.runIf(hasRealAlias)("finds the real winget alias on this computer", () => {
  expect(isExecutableFile(realAlias)).toBe(true);
});
