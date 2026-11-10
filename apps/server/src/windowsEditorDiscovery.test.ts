import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  expandWindowsPath,
  findWindowsEditorApp,
  parseWindowsInstalledAppsOutput,
  programFromRegistryCommand,
  WINDOWS_EDITOR_APPS,
  windowsInstalledAppsScript,
  type WindowsInstalledAppsSnapshot,
} from "./windowsEditorDiscovery";

// The Windows-only resolver emits Windows paths even on a Linux test host.
// Translate only at the filesystem boundary; every probe still reads a real file or directory.
const disk = vi.hoisted(() => ({ hostPath: (path: string) => path }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: (path: string) => fs.stat(disk.hostPath(path)),
    readdir: (path: string) => fs.readdir(disk.hostPath(path)),
  };
});

const ENV = {
  USERPROFILE: "C:\\Users\\ada",
  LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
} as NodeJS.ProcessEnv;

function fakeFs(files: readonly string[], dirs: Record<string, readonly string[]> = {}) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return {
    fileExists: (filePath: string) => set.has(filePath.toLowerCase()),
    listDirectory: (dirPath: string) => dirs[dirPath] ?? [],
  };
}

const EMPTY_SNAPSHOT: WindowsInstalledAppsSnapshot = { uninstall: [], protocols: {}, appPaths: {} };

describe("findWindowsEditorApp", () => {
  it("finds a per-user VS Code in its standard folder and prefers its command-line shim", () => {
    const found = findWindowsEditorApp(WINDOWS_EDITOR_APPS.vscode!, {
      env: ENV,
      snapshot: null,
      ...fakeFs([
        "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
      ]),
    });
    expect(found).toEqual({
      exePath: "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      launchPath: "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
    });
  });

  it("derives the per-user folders from the profile when LOCALAPPDATA is missing", () => {
    const found = findWindowsEditorApp(WINDOWS_EDITOR_APPS.vscode!, {
      env: { USERPROFILE: "C:\\Users\\ada" } as NodeJS.ProcessEnv,
      snapshot: null,
      ...fakeFs(["C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"]),
    });
    expect(found?.exePath).toBe(
      "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    );
  });

  it("finds an editor installed elsewhere through its uninstall entry", () => {
    const found = findWindowsEditorApp(WINDOWS_EDITOR_APPS.cursor!, {
      env: ENV,
      snapshot: {
        ...EMPTY_SNAPSHOT,
        uninstall: [{ name: "Cursor (User)", location: "D:\\tool\\cursor\\", icon: "" }],
      },
      ...fakeFs([
        "D:\\tool\\cursor\\Cursor.exe",
        "D:\\tool\\cursor\\resources\\app\\bin\\cursor.cmd",
      ]),
    });
    expect(found).toEqual({
      exePath: "D:\\tool\\cursor\\Cursor.exe",
      launchPath: "D:\\tool\\cursor\\resources\\app\\bin\\cursor.cmd",
    });
  });

  it("follows an uninstall entry's icon and a URL protocol's command to the program", () => {
    expect(
      findWindowsEditorApp(WINDOWS_EDITOR_APPS.antigravity!, {
        env: ENV,
        snapshot: {
          ...EMPTY_SNAPSHOT,
          uninstall: [
            {
              name: "Antigravity 2.25.0",
              location: "",
              icon: "E:\\Antigravity\\Antigravity.exe,0",
            },
          ],
        },
        ...fakeFs(["E:\\Antigravity\\Antigravity.exe"]),
      })?.exePath,
    ).toBe("E:\\Antigravity\\Antigravity.exe");
    expect(
      findWindowsEditorApp(WINDOWS_EDITOR_APPS.zed!, {
        env: ENV,
        snapshot: { ...EMPTY_SNAPSHOT, protocols: { zed: '"F:\\Apps\\Zed\\Zed.exe" "%1"' } },
        ...fakeFs(["F:\\Apps\\Zed\\Zed.exe"]),
      })?.exePath,
    ).toBe("F:\\Apps\\Zed\\Zed.exe");
  });

  it("ignores a protocol that another program took over", () => {
    expect(
      findWindowsEditorApp(WINDOWS_EDITOR_APPS.windsurf!, {
        env: ENV,
        snapshot: {
          ...EMPTY_SNAPSHOT,
          protocols: { windsurf: '"C:\\Apps\\Devin\\Devin.exe" --open-url -- "%1"' },
        },
        ...fakeFs(["C:\\Apps\\Devin\\Devin.exe"]),
      }),
    ).toBeNull();
  });

  it("finds versioned JetBrains installs and reports nothing when an editor is absent", () => {
    const { fileExists, listDirectory } = fakeFs(
      ["C:\\Program Files\\JetBrains\\PyCharm Community Edition 2025.2\\bin\\pycharm64.exe"],
      {
        "C:\\Program Files\\JetBrains": [
          "PyCharm Community Edition 2025.2",
          "IntelliJ IDEA 2025.1",
        ],
      },
    );
    expect(
      findWindowsEditorApp(WINDOWS_EDITOR_APPS.pycharm!, {
        env: ENV,
        snapshot: EMPTY_SNAPSHOT,
        fileExists,
        listDirectory,
      })?.exePath,
    ).toBe("C:\\Program Files\\JetBrains\\PyCharm Community Edition 2025.2\\bin\\pycharm64.exe");
    expect(
      findWindowsEditorApp(WINDOWS_EDITOR_APPS.idea!, {
        env: ENV,
        snapshot: EMPTY_SNAPSHOT,
        fileExists,
        listDirectory,
      }),
    ).toBeNull();
  });
});

describe("registry snapshot", () => {
  it("reads the PowerShell output, including a single uninstall entry", () => {
    expect(
      parseWindowsInstalledAppsOutput(
        JSON.stringify({
          u: { n: "Cursor (User)", l: "D:\\tool\\cursor\\", i: "" },
          s: { cursor: '"D:\\tool\\cursor\\Cursor.exe" --open-url -- "%1"', zed: "" },
          a: {},
        }),
      ),
    ).toEqual({
      uninstall: [{ name: "Cursor (User)", location: "D:\\tool\\cursor\\", icon: "" }],
      protocols: { cursor: '"D:\\tool\\cursor\\Cursor.exe" --open-url -- "%1"' },
      appPaths: {},
    });
    expect(parseWindowsInstalledAppsOutput("not json")).toBeNull();
  });

  it("asks only for the protocols and App Paths entries the editors use", () => {
    const script = windowsInstalledAppsScript();
    expect(script).toContain("'vscode'");
    expect(script).toContain("'sublime_text.exe'");
    expect(script).toContain("ConvertTo-Json");
  });

  it("reads programs out of registry commands and expands folders", () => {
    expect(programFromRegistryCommand('"C:\\A B\\Code.exe" --open-url -- "%1"')).toBe(
      "C:\\A B\\Code.exe",
    );
    expect(programFromRegistryCommand("C:\\Zed\\Zed.exe,0")).toBe("C:\\Zed\\Zed.exe");
    expect(expandWindowsPath("%localappdata%\\Programs", ENV)).toBe(
      "C:\\Users\\ada\\AppData\\Local\\Programs",
    );
  });
});

describe("discoverWindowsEditors", () => {
  it("probes the install folders on disk and finds the editors in them", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { discoverWindowsEditors } = await import("./windowsEditorDiscovery");
    const root = await mkdtemp(join(tmpdir(), "moss-editor-discovery-"));
    const windowsRoot = process.platform === "win32" ? root : "C:\\fixture";
    const install = win32.join(windowsRoot, "Local", "Programs", "Microsoft VS Code");
    try {
      disk.hostPath = (candidate) => {
        const relative = win32.relative(windowsRoot, candidate);
        if (relative.startsWith("..") || win32.isAbsolute(relative)) {
          throw new Error("Discovery probed outside the fixture");
        }
        return join(root, ...relative.split("\\"));
      };
      const vscodeFolder = join(root, "Local", "Programs", "Microsoft VS Code");
      await mkdir(join(vscodeFolder, "bin"), { recursive: true });
      await writeFile(join(vscodeFolder, "Code.exe"), "");
      await writeFile(join(vscodeFolder, "bin", "code.cmd"), "");
      const found = await discoverWindowsEditors(
        {
          USERPROFILE: windowsRoot,
          LOCALAPPDATA: win32.join(windowsRoot, "Local"),
          ProgramFiles: win32.join(windowsRoot, "PF"),
        },
        null,
      );
      expect(found.get("vscode")).toEqual({
        exePath: win32.join(install, "Code.exe"),
        launchPath: win32.join(install, "bin", "code.cmd"),
      });
      expect(found.has("cursor")).toBe(false);
    } finally {
      disk.hostPath = (path) => path;
      await rm(root, { recursive: true, force: true });
    }
  });
});
