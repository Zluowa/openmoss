import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isDesktopDevelopmentRuntime,
  migrateRetiredBrowserPartitions,
  repairBrowserProfileFromBridgeManifest,
  resolveDesktopAppDataBase,
  resolveDesktopBackendHomePath,
  resolveDesktopUserDataPath,
} from "./desktopUserDataProfile";

const tempDirs = new Set<string>();
const fixtureHome = Path.resolve("/Users/tester");
const fixtureAppDataBase = Path.join(fixtureHome, "Library", "Application Support");

function makeTempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-profile-test-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("desktopUserDataProfile", () => {
  it("isolates the packaged Moss profile from the Moss development profile", () => {
    const appDataBase = fixtureAppDataBase;
    expect(resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "moss-dev" })).toBe(
      Path.join(appDataBase, "moss-dev"),
    );
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      Path.join(appDataBase, "Moss"),
    );
    expect(resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "moss" })).toBe(
      Path.join(appDataBase, "moss"),
    );
    expect(resolveDesktopUserDataPath({ appDataBase, userDataDirectoryName: "moss-canary" })).toBe(
      Path.join(appDataBase, "moss-canary"),
    );
  });

  it("isolates the packaged Moss backend home and preserves explicit overrides", () => {
    expect(resolveDesktopBackendHomePath({ homeDir: fixtureHome, isDevelopment: false })).toBe(
      Path.join(fixtureHome, ".moss"),
    );
    expect(resolveDesktopBackendHomePath({ homeDir: fixtureHome, isDevelopment: true })).toBe(
      Path.join(fixtureHome, ".moss"),
    );
    expect(
      resolveDesktopBackendHomePath({
        homeDir: fixtureHome,
        isDevelopment: false,
        mossHome: " /tmp/moss-home ",
      }),
    ).toBe(Path.resolve("/tmp/moss-home"));
    expect(
      resolveDesktopBackendHomePath({
        homeDir: fixtureHome,
        isDevelopment: false,
        mossHome: " /tmp/isolated-legacy-override ",
      }),
    ).toBe(Path.resolve("/tmp/isolated-legacy-override"));
    expect(
      resolveDesktopBackendHomePath({
        homeDir: fixtureHome,
        isDevelopment: true,
        mossHome: " /tmp/isolated-legacy-override ",
      }),
    ).toBe(Path.resolve("/tmp/isolated-legacy-override"));
  });

  it("never treats a packaged app as development because of an inherited Vite URL", () => {
    expect(
      isDesktopDevelopmentRuntime({
        isPackaged: true,
        viteDevServerUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(false);
    expect(
      isDesktopDevelopmentRuntime({
        isPackaged: false,
        viteDevServerUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(true);
    expect(isDesktopDevelopmentRuntime({ isPackaged: false, viteDevServerUrl: "  " })).toBe(false);
  });

  it("uses an absolute isolated profile override and ignores relative overrides", () => {
    const appDataBase = fixtureAppDataBase;
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        overridePath: " /tmp/moss-auth-e2e/profile ",
      }),
    ).toBe(Path.resolve("/tmp/moss-auth-e2e/profile"));
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        overridePath: "relative/profile",
      }),
    ).toBe(Path.join(appDataBase, "moss-dev"));
  });

  it("reuses the registered Dev callback profile without overriding an explicit environment", () => {
    const appDataBase = fixtureAppDataBase;
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: false,
        commandLineOverridePath: " /tmp/moss-auth-callback/profile ",
      }),
    ).toBe(Path.resolve("/tmp/moss-auth-callback/profile"));
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        overridePath: "/tmp/moss-auth-primary/profile",
        commandLineOverridePath: "/tmp/moss-auth-callback/profile",
      }),
    ).toBe(Path.resolve("/tmp/moss-auth-primary/profile"));
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        commandLineOverridePath: "relative/profile",
      }),
    ).toBe(Path.join(appDataBase, "moss-dev"));
  });

  it("uses an absolute isolated profile override and ignores relative overrides", () => {
    const appDataBase = fixtureAppDataBase;
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        overridePath: " /tmp/moss-auth-e2e/profile ",
      }),
    ).toBe(Path.resolve("/tmp/moss-auth-e2e/profile"));
    expect(
      resolveDesktopUserDataPath({
        appDataBase,
        isDevelopment: true,
        overridePath: "relative/profile",
      }),
    ).toBe(Path.join(appDataBase, "moss-dev"));
  });

  it("uses an explicit smoke profile instead of the development profile", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataBase: fixtureAppDataBase,
        userDataDirectoryName: "moss-dev",
        testOverridePath: "/tmp/moss-desktop-smoke/electron-user-data",
      }),
    ).toBe(Path.resolve("/tmp/moss-desktop-smoke/electron-user-data"));
  });

  it("uses XDG_CONFIG_HOME on Linux when available", () => {
    expect(
      resolveDesktopAppDataBase({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        homeDir: "/home/tester",
      }),
    ).toBe("/tmp/xdg");
  });

  it("repairs missing browser data from the profile recorded by the bridge", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "moss-browser");
    FS.mkdirSync(Path.join(sourcePartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Local Storage", "state"), "bridge-state");
    FS.mkdirSync(Path.join(targetPartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(targetPartitionPath, "Local Storage", "state"), "current-state");
    FS.writeFileSync(
      Path.join(targetPath, "moss-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    const result = repairBrowserProfileFromBridgeManifest(targetPath);

    expect(result).toMatchObject({
      status: "repaired",
      sourcePath,
      targetPath,
      copiedEntries: ["Cookies", "Cookies-journal"],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "bridge-cookie",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "utf8")).toBe(
      "bridge-journal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Local Storage", "state"), "utf8")).toBe(
      "current-state",
    );
  });

  it("rejects bridge manifests that point outside the Moss profile parent", () => {
    const appDataBase = makeTempDir();
    const unrelatedBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(
      Path.join(targetPath, "moss-profile-seed.json"),
      JSON.stringify({ sourcePath: Path.join(unrelatedBase, "previous-profile") }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "bridge-unavailable",
      sourcePath: null,
      copiedEntries: [],
    });
  });

  it("never adds a foreign SQLite sidecar beside an existing Moss database", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "moss-browser");
    FS.mkdirSync(sourcePartitionPath, { recursive: true });
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies"), "current-cookie");
    FS.writeFileSync(
      Path.join(targetPath, "moss-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "not-needed",
      copiedEntries: [],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "current-cookie",
    );
    expect(FS.existsSync(Path.join(targetPartitionPath, "Cookies-journal"))).toBe(false);
  });

  it("replaces an orphaned target sidecar with one from the repaired database generation", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const sourcePartitionPath = Path.join(sourcePath, "Partitions", "previous-browser");
    const targetPartitionPath = Path.join(targetPath, "Partitions", "moss-browser");
    FS.mkdirSync(sourcePartitionPath, { recursive: true });
    FS.mkdirSync(targetPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies"), "bridge-cookie");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-journal"), "bridge-journal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-wal"), "bridge-wal");
    FS.writeFileSync(Path.join(sourcePartitionPath, "Cookies-shm"), "bridge-shm");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "orphaned-journal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-wal"), "orphaned-wal");
    FS.writeFileSync(Path.join(targetPartitionPath, "Cookies-shm"), "orphaned-shm");
    FS.writeFileSync(
      Path.join(targetPath, "moss-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "repaired",
      copiedEntries: ["Cookies", "Cookies-journal", "Cookies-wal", "Cookies-shm"],
    });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe(
      "bridge-cookie",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-journal"), "utf8")).toBe(
      "bridge-journal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-wal"), "utf8")).toBe(
      "bridge-wal",
    );
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies-shm"), "utf8")).toBe(
      "bridge-shm",
    );
    expect(
      FS.readdirSync(targetPartitionPath).some((entryName) =>
        entryName.startsWith(".moss-bridge-"),
      ),
    ).toBe(false);
  });

  it("copies from only the newest browser partition recorded under the bridge profile", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    const sourcePath = Path.join(appDataBase, "previous-profile");
    const olderPartitionPath = Path.join(sourcePath, "Partitions", "older-browser");
    const newerPartitionPath = Path.join(sourcePath, "Partitions", "newer-browser");
    FS.mkdirSync(Path.join(olderPartitionPath, "Local Storage"), { recursive: true });
    FS.mkdirSync(newerPartitionPath, { recursive: true });
    FS.writeFileSync(Path.join(olderPartitionPath, "Cookies"), "older-cookie");
    FS.writeFileSync(Path.join(olderPartitionPath, "Local Storage", "state"), "older-state");
    FS.writeFileSync(Path.join(newerPartitionPath, "Cookies"), "newer-cookie");
    FS.utimesSync(olderPartitionPath, new Date(1_000), new Date(1_000));
    FS.utimesSync(newerPartitionPath, new Date(2_000), new Date(2_000));
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(
      Path.join(targetPath, "moss-profile-seed.json"),
      JSON.stringify({ sourcePath }),
    );

    const result = repairBrowserProfileFromBridgeManifest(targetPath);
    const targetPartitionPath = Path.join(targetPath, "Partitions", "moss-browser");

    expect(result).toMatchObject({ status: "repaired", copiedEntries: ["Cookies"] });
    expect(FS.readFileSync(Path.join(targetPartitionPath, "Cookies"), "utf8")).toBe("newer-cookie");
    expect(FS.existsSync(Path.join(targetPartitionPath, "Local Storage"))).toBe(false);
  });

  it("ignores a malformed bridge manifest without attempting a repair", () => {
    const appDataBase = makeTempDir();
    const targetPath = Path.join(appDataBase, "moss");
    FS.mkdirSync(targetPath, { recursive: true });
    FS.writeFileSync(Path.join(targetPath, "moss-profile-seed.json"), "{");

    expect(repairBrowserProfileFromBridgeManifest(targetPath)).toMatchObject({
      status: "bridge-unavailable",
      sourcePath: null,
      copiedEntries: [],
    });
  });

  it("copies missing data and retires predecessor browser partitions without deleting them", () => {
    const targetPath = Path.join(makeTempDir(), "moss");
    const partitionsPath = Path.join(targetPath, "Partitions");
    const predecessorPartitionPath = Path.join(partitionsPath, "previous-browser");
    const canonicalPartitionPath = Path.join(partitionsPath, "moss-browser");
    FS.mkdirSync(Path.join(predecessorPartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(predecessorPartitionPath, "Cookies"), "previous-cookie");
    FS.writeFileSync(
      Path.join(predecessorPartitionPath, "Local Storage", "state"),
      "previous-state",
    );

    const result = migrateRetiredBrowserPartitions(targetPath);

    expect(result).toMatchObject({
      status: "migrated",
      targetPath,
      copiedEntries: ["Cookies", "Local Storage"],
      retiredPartitionCount: 1,
    });
    expect(FS.existsSync(predecessorPartitionPath)).toBe(false);
    expect(FS.readFileSync(Path.join(canonicalPartitionPath, "Cookies"), "utf8")).toBe(
      "previous-cookie",
    );
    expect(
      FS.readFileSync(Path.join(canonicalPartitionPath, "Local Storage", "state"), "utf8"),
    ).toBe("previous-state");
    const retiredPartitionNames = FS.readdirSync(partitionsPath).filter((entryName) =>
      entryName.startsWith(".moss-retired-partition-"),
    );
    expect(retiredPartitionNames).toEqual([".moss-retired-partition-1"]);
    expect(
      FS.readFileSync(Path.join(partitionsPath, retiredPartitionNames[0]!, "Cookies"), "utf8"),
    ).toBe("previous-cookie");
  });

  it("preserves canonical Moss browser data while retiring more than one predecessor", () => {
    const targetPath = Path.join(makeTempDir(), "moss");
    const partitionsPath = Path.join(targetPath, "Partitions");
    const canonicalPartitionPath = Path.join(partitionsPath, "moss-browser");
    const olderPartitionPath = Path.join(partitionsPath, "older-browser");
    const newerPartitionPath = Path.join(partitionsPath, "newer-browser");
    FS.mkdirSync(canonicalPartitionPath, { recursive: true });
    FS.mkdirSync(olderPartitionPath, { recursive: true });
    FS.mkdirSync(Path.join(newerPartitionPath, "Local Storage"), { recursive: true });
    FS.writeFileSync(Path.join(canonicalPartitionPath, "Cookies"), "moss-cookie");
    FS.writeFileSync(Path.join(olderPartitionPath, "Cookies"), "older-cookie");
    FS.writeFileSync(Path.join(newerPartitionPath, "Cookies"), "newer-cookie");
    FS.writeFileSync(Path.join(newerPartitionPath, "Local Storage", "state"), "newer-state");
    FS.utimesSync(olderPartitionPath, new Date(1_000), new Date(1_000));
    FS.utimesSync(newerPartitionPath, new Date(2_000), new Date(2_000));

    const result = migrateRetiredBrowserPartitions(targetPath);

    expect(result).toMatchObject({
      status: "migrated",
      copiedEntries: ["Local Storage"],
      retiredPartitionCount: 2,
    });
    expect(FS.readFileSync(Path.join(canonicalPartitionPath, "Cookies"), "utf8")).toBe(
      "moss-cookie",
    );
    expect(
      FS.readFileSync(Path.join(canonicalPartitionPath, "Local Storage", "state"), "utf8"),
    ).toBe("newer-state");
    expect(
      FS.readdirSync(partitionsPath)
        .filter((entryName) => entryName.startsWith(".moss-retired-partition-"))
        .sort(),
    ).toEqual([".moss-retired-partition-1", ".moss-retired-partition-2"]);
    expect(migrateRetiredBrowserPartitions(targetPath)).toMatchObject({
      status: "not-needed",
      copiedEntries: [],
      retiredPartitionCount: 0,
    });
  });
});
