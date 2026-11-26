import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopPageAppPermissionEngine,
  DesktopPageAppPolicyWatcher,
  MOSS_POLICY_PAGE_APPS_ENABLED_ENV,
  MOSS_POLICY_PAGE_APPS_FULL_ACCESS_ENV,
  MOSS_POLICY_PAGE_APPS_PERMISSIONS_ENV,
  readDesktopPageAppPolicyState,
} from "./permissions";
import { DesktopPageAppStore } from "./store";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-page-apps-perm-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DesktopPageAppPermissionEngine", () => {
  it("invalidates granted permissions on revision or contentHash change while retaining denials", () => {
    const store = new DesktopPageAppStore(createTempDir());
    const engine = new DesktopPageAppPermissionEngine(store, () => ({
      enabled: true,
      permissionsEnabled: true,
      fullAccessEnabled: true,
    }));

    engine.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "app1",
      permission: "notifications",
      answer: "granted",
      revision: 1,
      contentHash: "hash-1",
    });
    engine.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "app1",
      permission: "shortcuts",
      answer: "denied",
      revision: 1,
      contentHash: "hash-1",
    });

    const rev1 = engine.evaluateAll({
      accountId: "acc",
      orgId: "org",
      appId: "app1",
      declaredPermissions: ["notifications", "shortcuts"],
      currentRevision: 1,
      currentContentHash: "hash-1",
    });
    expect(rev1.notifications.state).toBe("granted");
    expect(rev1.shortcuts.state).toBe("denied");
    expect(rev1.overlay.state).toBe("unavailable");

    const rev2 = engine.evaluateAll({
      accountId: "acc",
      orgId: "org",
      appId: "app1",
      declaredPermissions: ["notifications", "shortcuts"],
      currentRevision: 2,
      currentContentHash: "hash-2",
    });
    expect(rev2.notifications.state).toBe("prompt");
    expect(rev2.notifications.isReapproval).toBe(true);
    expect(rev2.shortcuts.state).toBe("denied");
  });

  it("cascades full-access to non-denied Tier 2 permissions and revokes held grants cleanly", () => {
    const store = new DesktopPageAppStore(createTempDir());
    const engine = new DesktopPageAppPermissionEngine(store, () => ({
      enabled: true,
      permissionsEnabled: true,
      fullAccessEnabled: true,
    }));

    engine.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      permission: "overlay",
      answer: "denied",
      revision: 1,
      contentHash: "h1",
    });

    engine.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      permission: "full-access",
      answer: "granted",
      revision: 1,
      contentHash: "h1",
      declaredPermissions: ["notifications", "shortcuts", "overlay", "menu-bar", "full-access"],
    });

    const afterGrant = engine.evaluateAll({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      declaredPermissions: ["notifications", "shortcuts", "overlay", "menu-bar", "full-access"],
      currentRevision: 1,
      currentContentHash: "h1",
    });
    expect(afterGrant["full-access"].state).toBe("granted");
    expect(afterGrant.notifications.state).toBe("granted");
    expect(afterGrant.notifications.reason).toBe("cascade_full_access");
    expect(afterGrant.shortcuts.state).toBe("granted");
    expect(afterGrant["menu-bar"].state).toBe("granted");
    // Explicit denial must not be overridden by full-access cascade.
    expect(afterGrant.overlay.state).toBe("denied");
    // No synthetic Tier 2 held rows are persisted on disk.
    expect(store.getPermission("acc", "org", "app2", "notifications")).toBeNull();

    // If manifest drops full-access from declaredPermissions, dynamic cascade stops.
    const withoutFullAccess = engine.evaluateAll({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      declaredPermissions: ["notifications", "overlay"],
      currentRevision: 1,
      currentContentHash: "h1",
    });
    expect(withoutFullAccess.notifications.state).toBe("prompt");
    expect(withoutFullAccess.overlay.state).toBe("denied");

    engine.setPermission({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      permission: "full-access",
      answer: null,
      revision: 1,
      contentHash: "h1",
    });
    const afterRevoke = engine.evaluateAll({
      accountId: "acc",
      orgId: "org",
      appId: "app2",
      declaredPermissions: ["notifications", "shortcuts", "overlay", "menu-bar", "full-access"],
      currentRevision: 1,
      currentContentHash: "h1",
    });
    expect(afterRevoke["full-access"].state).toBe("prompt");
    expect(afterRevoke.notifications.state).toBe("prompt");
    expect(afterRevoke.overlay.state).toBe("denied");
  });

  it("enforces untrusted lock and 3-tier enterprise policy flags", () => {
    const store = new DesktopPageAppStore(createTempDir());
    let envState: NodeJS.ProcessEnv = {
      [MOSS_POLICY_PAGE_APPS_ENABLED_ENV]: "1",
      [MOSS_POLICY_PAGE_APPS_PERMISSIONS_ENV]: "1",
      [MOSS_POLICY_PAGE_APPS_FULL_ACCESS_ENV]: "0",
    };
    const watcher = new DesktopPageAppPolicyWatcher(() => readDesktopPageAppPolicyState(envState));
    const engine = new DesktopPageAppPermissionEngine(store, () => watcher.current());

    expect(
      engine.evaluate({
        accountId: "acc",
        orgId: "org",
        appId: "app3",
        permission: "full-access",
        declaredPermissions: ["full-access"],
        currentRevision: 1,
        currentContentHash: "h1",
      }).state,
    ).toBe("unavailable");

    envState = {
      [MOSS_POLICY_PAGE_APPS_ENABLED_ENV]: "0",
    };
    const transition = watcher.poll();
    expect(transition?.appFeatureDisabled).toBe(true);
    expect(transition?.permissionsDisabled).toBe(true);
  });
});
