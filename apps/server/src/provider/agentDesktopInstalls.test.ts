import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processRuntime from "@moss/shared/processRuntime";

import {
  findAgentDesktopInstalls,
  parseRegUninstallOutput,
  setKnownAgentDesktopInstallsForTest,
  uninstallEntryFolders,
} from "./agentDesktopInstalls.ts";
import { deriveProviderReadiness } from "./providerReadiness.ts";
import { desktopAppCliDirectories } from "./agentCliPathFloor.ts";
import { zcodeHostEnvironment, zcodeHostRequirement } from "./acp/AcpAgentSpec.ts";

it("uses bounded native registry queries through the process runtime", async () => {
  const run = vi
    .spyOn(processRuntime, "execProcessFile")
    .mockImplementation((_command, _args, _options, done) => {
      done(null, "", "");
      return new ChildProcess();
    });
  try {
    const env = { SystemRoot: "D:\\Windows" };
    await findAgentDesktopInstalls({ platform: "win32", env, pathExists: () => false });
    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const [command, args, options] of run.mock.calls) {
      expect(command).toBe("D:\\Windows\\System32\\reg.exe");
      expect(args[0]).toBe("query");
      expect(options).toEqual({
        env,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  } finally {
    run.mockRestore();
  }
});

// Shaped like this PC's real uninstall entries (paths only).
const REG_OUTPUT = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{DADADADA-ADAD-ADAD-ADAD-ADADADADADAD}}_is1",
  "    DisplayName    REG_SZ    Cursor (User)",
  "    InstallLocation    REG_SZ    D:\\tool\\cursor\\",
  "    DisplayIcon    REG_SZ    D:\\tool\\cursor\\Cursor.exe",
  '    UninstallString    REG_SZ    "D:\\tool\\cursor\\unins000.exe"',
  "",
  "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\268ce9e6-a30b-5890-ad18-d4b3ebba5377",
  "    DisplayName    REG_SZ    ZCode 3.16.3",
  "    DisplayIcon    REG_SZ    D:\\ai\\ZCode\\uninstallerIcon.ico",
  '    UninstallString    REG_SZ    "D:\\ai\\ZCode\\Uninstall ZCode.exe" /allusers',
  "",
].join("\r\n");

const WINDOWS_FILES = new Set(
  [
    "D:\\tool\\cursor\\Cursor.exe",
    "D:\\ai\\ZCode\\ZCode.exe",
    "D:\\ai\\ZCode\\resources\\glm\\zcode.cjs",
    "C:\\Users\\p\\AppData\\Local\\Programs\\Devin\\Devin.exe",
    "C:\\Users\\p\\AppData\\Local\\Programs\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe",
  ].map((file) => file.toLowerCase()),
);

const windowsExists = (file: string) => WINDOWS_FILES.has(file.toLowerCase());

afterEach(() => setKnownAgentDesktopInstallsForTest([]));

describe("desktop agent installs", () => {
  it("reads the install folder an uninstall entry records", () => {
    const entries = parseRegUninstallOutput(REG_OUTPUT);
    expect(entries.map((entry) => entry.displayName)).toEqual(["Cursor (User)", "ZCode 3.16.3"]);
    expect(uninstallEntryFolders(entries[0]!)).toEqual(["D:\\tool\\cursor"]);
    // No InstallLocation: the icon and the uninstaller both name the folder.
    expect(uninstallEntryFolders(entries[1]!)).toEqual(["D:\\ai\\ZCode"]);
  });

  it("finds apps in custom folders and the CLIs they ship", async () => {
    const installs = await findAgentDesktopInstalls({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\p", LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local" },
      pathExists: windowsExists,
      readUninstallEntries: async () => parseRegUninstallOutput(REG_OUTPUT),
    });
    expect(installs).toEqual([
      { provider: "cursor", appPath: "D:\\tool\\cursor" },
      {
        provider: "zcode",
        appPath: "D:\\ai\\ZCode",
        cliScript: "D:\\ai\\ZCode\\resources\\glm\\zcode.cjs",
      },
      {
        provider: "devin",
        appPath: "C:\\Users\\p\\AppData\\Local\\Programs\\Devin",
        cliDirectory:
          "C:\\Users\\p\\AppData\\Local\\Programs\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin",
      },
    ]);
    // Devin's bundled CLI joins PATH; Cursor ships none.
    expect(desktopAppCliDirectories(installs)).toEqual([installs[2]!.cliDirectory]);
  });

  it("finds macOS app bundles", async () => {
    const installs = await findAgentDesktopInstalls({
      platform: "darwin",
      env: { HOME: "/Users/p" },
      pathExists: (file) =>
        file === "/Applications/Cursor.app" ||
        file === "/Users/p/Applications/Devin.app" ||
        file ===
          "/Users/p/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin",
    });
    expect(installs.map((install) => [install.provider, install.cliDirectory ?? null])).toEqual([
      ["cursor", null],
      [
        "devin",
        "/Users/p/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin",
      ],
    ]);
  });

  it("says a desktop app is installed when only its command-line part is missing", () => {
    const notInstalled = {
      provider: "cursor",
      instanceId: "cursor",
      driver: "cursor",
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt: new Date(0).toISOString(),
      readiness: { state: "notInstalled" },
    } as const;
    expect(deriveProviderReadiness(notInstalled).reason).toBeUndefined();
    setKnownAgentDesktopInstallsForTest([{ provider: "cursor", appPath: "D:\\tool\\cursor" }]);
    expect(deriveProviderReadiness(notInstalled)).toMatchObject({
      state: "notInstalled",
      reason: "desktop-app-only",
    });
    // A cached answer never outlives the app.
    setKnownAgentDesktopInstallsForTest([]);
    expect(
      deriveProviderReadiness({
        ...notInstalled,
        readiness: { state: "notInstalled", reason: "desktop-app-only" },
      }).reason,
    ).toBeUndefined();
  });

  it("points the ZCode bridge at an app installed in a custom folder", () => {
    const script = "D:\\ai\\ZCode\\resources\\glm\\zcode.cjs";
    const env = { PATH: "", LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local" };
    const exists = (file: string) => file === script;
    expect(zcodeHostRequirement(env, "win32", exists)).toBeDefined();
    setKnownAgentDesktopInstallsForTest([
      { provider: "zcode", appPath: "D:\\ai\\ZCode", cliScript: script },
    ]);
    expect(zcodeHostRequirement(env, "win32", exists)).toBeUndefined();
    expect(zcodeHostEnvironment(env, "win32", () => false)).toEqual({ ZCODE_BIN: script });
    // The person's own ZCODE_BIN wins.
    expect(
      zcodeHostEnvironment({ ...env, ZCODE_BIN: "E:\\z\\zcode.cjs" }, "win32", () => false),
    ).toEqual({});
  });
});
