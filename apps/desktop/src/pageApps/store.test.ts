import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPermissionStorageKey,
  DesktopPageAppStore,
  parsePermissionStorageKey,
  resolveIconSlotPath,
} from "./store";
import type { InstalledDesktopPageApp } from "./types";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-page-apps-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DesktopPageAppStore", () => {
  it("builds and parses canonical permission keys (lowercased)", () => {
    const key = buildPermissionStorageKey("Acc-1", "Org-2", "App-3", "full-access");
    expect(key).toBe("acc-1|org-2|app-3|full-access");
    expect(parsePermissionStorageKey(key)).toEqual({
      accountId: "acc-1",
      orgId: "org-2",
      appId: "app-3",
      permission: "full-access",
    });
    expect(parsePermissionStorageKey("invalid")).toBeNull();
  });

  it("persists installed apps, permissions, and window styles", () => {
    const root = createTempDir();
    const store = new DesktopPageAppStore(root);
    const installId = "0123456789abcdef0123456789abcdef";

    const entry: InstalledDesktopPageApp = {
      installId,
      appId: "app-demo" as InstalledDesktopPageApp["appId"],
      name: "Demo App",
      revision: 3,
      contentHash: "hash-v3",
      places: ["start-menu", "desktop"],
      iconPath: resolveIconSlotPath(root, installId, 0),
      iconSlot: 0,
      shortcutPaths: [Path.join(root, "Demo App.lnk")],
      installedAt: "2026-11-26T00:00:00.000Z",
    };

    store.upsertInstalled(entry);
    expect(store.findInstalledByAppId("app-demo")?.installId).toBe(installId);
    expect(store.findInstalledByInstallId(installId)?.name).toBe("Demo App");

    store.setPermission("acc", "org", "app-demo", "notifications", {
      answer: "granted",
      revision: 3,
      contentHash: "hash-v3",
      updatedAt: "2026-11-26T00:00:00.000Z",
    });
    store.setPermission("acc", "org", "app-demo", "overlay", {
      answer: "denied",
      revision: 3,
      contentHash: "hash-v3",
      updatedAt: "2026-11-26T00:00:00.000Z",
    });
    expect(store.getPermission("ACC", "ORG", "App-Demo", "notifications")?.answer).toBe("granted");

    store.setWindowStyle(installId, {
      bounds: { x: 100, y: 120, width: 640, height: 480 },
      alwaysOnTop: true,
      updatedAt: "2026-11-26T00:00:00.000Z",
    });
    expect(store.getWindowStyle(installId)?.alwaysOnTop).toBe(true);

    if (process.platform !== "win32") {
      const mode = FS.statSync(store.installedAppsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Uninstall cleanup clears granted rows while retaining explicit denials.
    store.removePermissionsForApp("App-Demo");
    expect(store.getPermission("acc", "org", "app-demo", "notifications")).toBeNull();
    expect(store.getPermission("acc", "org", "app-demo", "overlay")?.answer).toBe("denied");
    expect(store.removeInstalledByInstallId(installId)?.appId).toBe("app-demo");
    expect(store.listInstalled()).toEqual([]);
  });

  it("rotates icons across 8 slots and removes stale slots", () => {
    const root = createTempDir();
    const store = new DesktopPageAppStore(root);
    const installId = "abcdef0123456789abcdef0123456789";

    const first = store.writeRotatedIcon(installId, Buffer.from("ico-0"), undefined);
    expect(first.iconSlot).toBe(0);
    expect(Path.basename(first.iconPath)).toBe(`${installId}.ico`);
    expect(FS.existsSync(first.iconPath)).toBe(true);

    const second = store.writeRotatedIcon(installId, Buffer.from("ico-1"), first.iconSlot);
    expect(second.iconSlot).toBe(1);
    expect(Path.basename(second.iconPath)).toBe(`${installId}-1.ico`);
    expect(FS.existsSync(first.iconPath)).toBe(false);
    expect(FS.existsSync(second.iconPath)).toBe(true);

    const wrapped = store.writeRotatedIcon(installId, Buffer.from("ico-wrap"), 7);
    expect(wrapped.iconSlot).toBe(0);
    expect(FS.existsSync(second.iconPath)).toBe(false);
    expect(FS.existsSync(wrapped.iconPath)).toBe(true);

    store.removeAllIconSlots(installId);
    expect(FS.existsSync(wrapped.iconPath)).toBe(false);
  });
});
