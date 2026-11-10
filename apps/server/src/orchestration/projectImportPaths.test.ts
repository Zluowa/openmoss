import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalImportPath,
  findImportGitWorkspace,
  importDirectoryExists,
  importPathIdentity,
  isTemporaryImportRoot,
  normalizeWindowsImportPath,
} from "./projectImportPaths";

describe("normalizeWindowsImportPath", () => {
  it("converts extended drive and UNC paths before resolving their parents", () => {
    const drive = normalizeWindowsImportPath("\\\\?\\C:\\_Install");
    const share = normalizeWindowsImportPath("\\\\?\\UNC\\Server\\Share\\gone");

    expect(drive).toBe("C:\\_Install");
    expect(path.win32.resolve(path.win32.dirname(drive))).toBe("C:\\");
    expect(share).toBe("\\\\Server\\Share\\gone");
    expect(path.win32.resolve(path.win32.dirname(share))).toBe("\\\\Server\\Share\\");
  });

  it("keeps the separator on a drive root, with or without one recorded", () => {
    // Node reads `\\?\E:\` and `\\?\E:` as `E:` (that drive's current folder) and stat fails
    // with EISDIR, which is how two `E:\` conversations failed to import.
    expect(normalizeWindowsImportPath("\\\\?\\E:\\")).toBe("E:\\");
    expect(normalizeWindowsImportPath("\\\\?\\E:")).toBe("E:\\");
    expect(normalizeWindowsImportPath("\\\\?\\e:\\work\\app")).toBe("e:\\work\\app");
    expect(normalizeWindowsImportPath("//?/E:/work/app")).toBe("E:\\work\\app");
    expect(normalizeWindowsImportPath("\\\\.\\D:\\")).toBe("D:\\");
  });

  it("preserves ordinary drive, UNC, and other device paths", () => {
    expect(normalizeWindowsImportPath("C:\\repo")).toBe("C:\\repo");
    expect(normalizeWindowsImportPath("\\\\Server\\Share\\repo")).toBe("\\\\Server\\Share\\repo");
    expect(normalizeWindowsImportPath("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1")).toBe(
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1",
    );
  });
});

it.runIf(process.platform === "win32")(
  "uses a drive root recorded as an extended-length path as a project folder",
  async () => {
    const root = path.win32.parse(process.cwd()).root;
    const extended = `\\\\?\\${root}`;
    expect(await importDirectoryExists(extended)).toBe(true);
    expect(await importDirectoryExists(extended.slice(0, -1))).toBe(true);
    expect(await canonicalImportPath(extended)).toBe(root);
    // Walking up for a Git checkout stops at the root instead of failing on `X:`.
    await findImportGitWorkspace(extended);
  },
);

describe("isTemporaryImportRoot", () => {
  it("recognizes temp folders by their usual places and by the process's own temp dirs", () => {
    expect(isTemporaryImportRoot("C:\\Users\\me\\AppData\\Local\\Temp\\omb-acp-memory-1")).toBe(
      true,
    );
    expect(isTemporaryImportRoot("/tmp/run-1")).toBe(true);
    expect(isTemporaryImportRoot("/private/var/folders/x1/abc/T/run")).toBe(true);
    expect(isTemporaryImportRoot("D:\\scratch\\job-7", ["D:\\scratch"])).toBe(true);
    expect(isTemporaryImportRoot("D:\\scratchpad\\job-7", ["D:\\scratch"])).toBe(false);
    expect(isTemporaryImportRoot("C:\\Users\\me\\code\\template")).toBe(false);
    expect(isTemporaryImportRoot("/home/me/tmpl")).toBe(false);
  });
});

it.runIf(process.platform === "win32")(
  "canonicalizes a missing extended drive path without losing its drive root",
  async () => {
    const missing = path.win32.toNamespacedPath(
      path.win32.join(process.env.SystemDrive ?? "C:", "moss-absent-import-root-1298"),
    );
    const result = await canonicalImportPath(missing);
    expect(importPathIdentity(result)).toBe(
      importPathIdentity(
        path.win32.join(process.env.SystemDrive ?? "C:", "moss-absent-import-root-1298"),
      ),
    );
    expect(result.startsWith("\\\\?\\")).toBe(false);
  },
);
