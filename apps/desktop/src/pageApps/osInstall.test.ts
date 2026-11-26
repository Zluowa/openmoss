import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPageAppAumid,
  buildPageAppLaunchArg,
  extractPageAppInstallIdFromArgv,
  findStaleInstalledApps,
  installOsArtifacts,
  PAGE_APP_SHORTCUT_DIR_ENV,
  removeOsArtifacts,
  resolvePageAppShortcutDirectories,
  sanitizePageAppInstallName,
  stripWorkingDirFromLnkBuffer,
  verifyLnkArgumentsUtf16Le,
} from "./osInstall";
import type { InstalledDesktopPageApp } from "./types";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-page-apps-os-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

function encodeShllinkUtf16Str(text: string): Buffer {
  const body = Buffer.from(text, "utf16le");
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(text.length, 0);
  return Buffer.concat([lenBuf, body]);
}

/** Synthesizes a minimal MS-SHLLINK buffer with optional WorkingDir and Unicode Arguments. */
function buildSyntheticShllink(options: {
  readonly workingDir?: string;
  readonly argumentsText?: string;
}): Buffer {
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0); // HeaderSize
  let flags = 0x80; // IsUnicode
  const segments: Buffer[] = [];

  if (options.workingDir !== undefined) {
    flags |= 0x10; // HasWorkingDir
    segments.push(encodeShllinkUtf16Str(options.workingDir));
  }
  if (options.argumentsText !== undefined) {
    flags |= 0x20; // HasArguments
    segments.push(encodeShllinkUtf16Str(options.argumentsText));
  }
  header.writeUInt32LE(flags, 0x14);
  const trailer = Buffer.alloc(4); // ExtraData terminal 0
  return Buffer.concat([header, ...segments, trailer]);
}

describe("osInstall", () => {
  it("sanitizes reserved brands, Windows reserved device names, NFKD homoglyphs, and colliding names", () => {
    const existing = new Set(["notepad", "moss"]);
    expect(sanitizePageAppInstallName("Moss", existing)).toBe("Moss (应用页)");
    expect(sanitizePageAppInstallName("Windows", existing)).toBe("Windows (应用页)");
    expect(sanitizePageAppInstallName("Apple", existing)).toBe("Apple (应用页)");
    expect(sanitizePageAppInstallName("Microsoft", existing)).toBe("Microsoft (应用页)");
    expect(sanitizePageAppInstallName("Notepad", existing)).toBe("Notepad (应用页)");
    expect(sanitizePageAppInstallName("My/App:Name*", existing)).toBe("My App Name");
    // Windows reserved device names
    expect(sanitizePageAppInstallName("CON", existing)).toBe("应用 CON");
    expect(sanitizePageAppInstallName("COM1", existing)).toBe("应用 COM1");
    expect(sanitizePageAppInstallName("com1.txt", existing)).toBe("应用 com1.txt (应用页)");
    expect(sanitizePageAppInstallName("nul", existing)).toBe("应用 nul");
    // Cyrillic / Leet homoglyph spoofing of Moss / Notepad
    expect(sanitizePageAppInstallName("М\u043ess", existing)).toContain("(应用页)");
    expect(sanitizePageAppInstallName("M055", existing)).toContain("(应用页)");
    expect(sanitizePageAppInstallName("N0tepad", existing)).toContain("(应用页)");
  });

  it("isolates shortcut directories when MOSS_APPS_SHORTCUT_DIR is set", () => {
    const override = createTempDir();
    const dirs = resolvePageAppShortcutDirectories({
      [PAGE_APP_SHORTCUT_DIR_ENV]: override,
    });
    expect(dirs.isolated).toBe(true);
    expect(dirs.startMenuAppsDir).toBe(Path.join(override, "StartMenu", "Moss Apps"));
    expect(dirs.desktopDir).toBe(Path.join(override, "Desktop"));
  });

  it("strips HasWorkingDir flag and WorkingDir bytes while keeping UTF-16LE args intact", () => {
    const installId = "0123456789abcdef0123456789abcdef";
    const launchArg = buildPageAppLaunchArg(installId);
    const rawLnk = buildSyntheticShllink({
      workingDir: "C:\\Temp\\Work",
      argumentsText: launchArg,
    });

    expect(rawLnk.readUInt32LE(0x14) & 0x10).toBe(0x10);
    const stripped = stripWorkingDirFromLnkBuffer(rawLnk);
    expect(stripped.readUInt32LE(0x14) & 0x10).toBe(0);
    expect(stripped.length).toBeLessThan(rawLnk.length);
    expect(verifyLnkArgumentsUtf16Le(stripped, launchArg)).toBe(true);
  });

  it("extracts --moss-app=<32hex> from argv and builds AUMID", () => {
    const installId = "abcdef0123456789abcdef0123456789";
    expect(buildPageAppAumid(installId)).toBe(`Moss.PageApp.${installId}`);
    expect(extractPageAppInstallIdFromArgv(["Moss.exe", `--moss-app=${installId}`])).toBe(
      installId,
    );
    expect(extractPageAppInstallIdFromArgv(["Moss.exe", "--moss-app=bad"])).toBeNull();
  });

  it("installs and cleans up isolated Windows shortcuts, verifies .lnk installId, and handles empty shortcuts as stale", () => {
    const override = createTempDir();
    const installId = "0123456789abcdef0123456789abcdef";
    const env = {
      [PAGE_APP_SHORTCUT_DIR_ENV]: override,
      MOSS_DISABLE_SHORTCUT_ICON_SYNC: "1",
    };

    const winResult = installOsArtifacts({
      installId,
      name: "Orbit",
      description: "Orbit Tracker",
      executablePath: Path.join(override, "Moss.exe"),
      iconPath: Path.join(override, "orbit.ico"),
      places: ["start-menu", "desktop"],
      platform: "win32",
      env,
      ops: {
        writeWindowsShortcut: (lnkPath, opts) => {
          FS.writeFileSync(
            lnkPath,
            buildSyntheticShllink({ workingDir: override, argumentsText: opts.args }),
          );
          return true;
        },
      },
    });
    expect(winResult.shortcutPaths).toHaveLength(2);
    for (const p of winResult.shortcutPaths) {
      expect(FS.existsSync(p)).toBe(true);
      const bytes = FS.readFileSync(p);
      expect(bytes.readUInt32LE(0x14) & 0x10).toBe(0);
      expect(verifyLnkArgumentsUtf16Le(bytes, `--moss-app=${installId}`)).toBe(true);
    }

    const installedEntry: InstalledDesktopPageApp = {
      installId,
      appId: "orbit" as InstalledDesktopPageApp["appId"],
      name: "Orbit",
      revision: 1,
      places: ["start-menu", "desktop"],
      shortcutPaths: [...winResult.shortcutPaths],
      installedAt: "2026-11-26T00:00:00.000Z",
    };
    expect(findStaleInstalledApps([installedEntry]).stale).toHaveLength(0);

    // Empty shortcutPaths + null bundlePath must be pruned as stale
    expect(
      findStaleInstalledApps([{ ...installedEntry, shortcutPaths: [], bundlePath: null }]).stale,
    ).toHaveLength(1);

    // .lnk belonging to a different installId must also be treated as stale
    for (const p of winResult.shortcutPaths) {
      FS.writeFileSync(
        p,
        buildSyntheticShllink({ argumentsText: "--moss-app=ffffffffffffffffffffffffffffffff" }),
      );
    }
    expect(findStaleInstalledApps([installedEntry]).stale).toHaveLength(1);

    removeOsArtifacts(installedEntry);
    expect(findStaleInstalledApps([installedEntry]).stale).toHaveLength(1);

    const macResult = installOsArtifacts({
      installId,
      name: "Orbit",
      description: "Orbit Tracker",
      executablePath: "/Applications/Moss.app/Contents/MacOS/Moss",
      iconPath: Path.join(override, "orbit.png"),
      png256: Buffer.from("png"),
      places: ["applications"],
      platform: "darwin",
      env,
    });
    expect(macResult.bundlePath).toBe(
      Path.join(override, "Applications", "Moss Apps", "Orbit.app"),
    );
    expect(FS.existsSync(Path.join(macResult.bundlePath!, "Contents", "Info.plist"))).toBe(true);
    expect(FS.existsSync(Path.join(macResult.bundlePath!, "Contents", "MacOS", "launcher"))).toBe(
      true,
    );
    removeOsArtifacts({ shortcutPaths: macResult.shortcutPaths, bundlePath: macResult.bundlePath });
    expect(FS.existsSync(macResult.bundlePath!)).toBe(false);
  });
});
