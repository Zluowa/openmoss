import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DesktopPageAppInstallInput,
  DesktopPageAppInstallState,
  DesktopPageAppNotificationInput,
  DesktopPageAppPermissionState,
  DesktopPageAppTrayOptions,
  DesktopPageAppWindowOptions,
  DesktopPageAppWindowPlaceInput,
  DesktopPageAppWindowSetOptionsResult,
  InstalledDesktopPageApp,
  PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL,
  PAGE_APP_DESKTOP_PERMISSIONS,
  PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL,
  filterDeclaredDesktopPermissions,
  getPageAppDesktopMethodTier,
  getPageAppDesktopPermissionTier,
  makeDesktopPageAppPermissionKey,
  resolveDesktopPermissionState,
  sanitizeDesktopScreenDisplay,
  type PageAppDesktopPermission,
} from "./pageAppDesktop";
import { PAGE_APP_BUILTIN_CAPABILITIES } from "./pageApps";

describe("pageAppDesktop contracts", () => {
  it("defines the 5-item desktop permission whitelist, method tiers, and registers desktop capability", () => {
    expect(PAGE_APP_DESKTOP_PERMISSIONS).toEqual([
      "notifications",
      "shortcuts",
      "overlay",
      "menu-bar",
      "full-access",
    ]);
    expect(PAGE_APP_BUILTIN_CAPABILITIES).toContain("desktop");
    expect(getPageAppDesktopPermissionTier("notifications")).toBe(2);
    expect(getPageAppDesktopPermissionTier("shortcuts")).toBe(2);
    expect(getPageAppDesktopPermissionTier("overlay")).toBe(2);
    expect(getPageAppDesktopPermissionTier("menu-bar")).toBe(2);
    expect(getPageAppDesktopPermissionTier("full-access")).toBe(3);

    // screen moved to Tier 2 (overlay); os split into Tier 1 (platform/arch) and Tier 3 (info)
    expect(getPageAppDesktopMethodTier("screen", "getAllDisplays")).toEqual({
      tier: 2,
      permission: "overlay",
    });
    expect(getPageAppDesktopMethodTier("screen", "getCursorScreenPoint")).toEqual({
      tier: 2,
      permission: "overlay",
    });
    expect(getPageAppDesktopMethodTier("os", "platform")).toEqual({ tier: 1 });
    expect(getPageAppDesktopMethodTier("os", "arch")).toEqual({ tier: 1 });
    expect(getPageAppDesktopMethodTier("os", "info")).toEqual({
      tier: 3,
      permission: "full-access",
    });
    expect(getPageAppDesktopMethodTier("permissions", "declare")).toEqual({ tier: 1 });
    expect(PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL).toBe("moss-app:drag-regions");
    expect(PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL).toBe("moss-app:permissions-declare");
  });

  it("filters declared permissions by count, length, and whitelist", () => {
    const validAndNoise = [
      "notifications",
      "unknown-perm",
      "notifications",
      "shortcuts",
      "overlay",
      `notifications${"x".repeat(60)}`, // > 64 chars
      123,
      "menu-bar",
    ];
    expect(filterDeclaredDesktopPermissions(validAndNoise)).toEqual([
      "notifications",
      "shortcuts",
      "overlay",
      "menu-bar",
    ]);

    const overCap = [...Array.from({ length: 32 }, (_, i) => `invalid-${i}`), "full-access"];
    expect(filterDeclaredDesktopPermissions(overCap)).toEqual([]);
  });

  it("resolves 3-tier permission states with version/hash invalidation and cascade", () => {
    const declared = new Set<PageAppDesktopPermission>([
      "notifications",
      "shortcuts",
      "overlay",
      "full-access",
    ]);
    const policy = { enabled: true, permissionsEnabled: true, fullAccessEnabled: true };

    expect(
      resolveDesktopPermissionState({
        permission: "menu-bar",
        declared,
        currentRevision: 2,
        currentContentHash: "hash-v2",
        records: {},
        policy,
      }),
    ).toBe("unavailable");

    expect(
      resolveDesktopPermissionState({
        permission: "notifications",
        declared,
        currentRevision: 2,
        currentContentHash: "hash-v2",
        records: {
          notifications: { answer: "granted", revision: 2, contentHash: "hash-v2" },
        },
        policy,
      }),
    ).toBe("granted");

    expect(
      resolveDesktopPermissionState({
        permission: "notifications",
        declared,
        currentRevision: 3,
        currentContentHash: "hash-v2",
        records: {
          notifications: { answer: "granted", revision: 2, contentHash: "hash-v2" },
        },
        policy,
      }),
    ).toBe("prompt");

    expect(
      resolveDesktopPermissionState({
        permission: "shortcuts",
        declared,
        currentRevision: 5,
        currentContentHash: "hash-v5",
        records: {
          shortcuts: { answer: "denied", revision: 1, contentHash: "hash-v1" },
          "full-access": {
            answer: "granted",
            revision: 5,
            contentHash: "hash-v5",
            coversTier2: true,
          },
        },
        policy,
      }),
    ).toBe("denied");

    expect(
      resolveDesktopPermissionState({
        permission: "overlay",
        declared,
        currentRevision: 5,
        currentContentHash: "hash-v5",
        records: {
          "full-access": {
            answer: "granted",
            revision: 5,
            contentHash: "hash-v5",
            coversTier2: true,
          },
        },
        policy,
      }),
    ).toBe("granted");

    // Full-access cascade must not apply if full-access itself wasn't declared
    const withoutFullAccess = new Set<PageAppDesktopPermission>(["overlay"]);
    expect(
      resolveDesktopPermissionState({
        permission: "overlay",
        declared: withoutFullAccess,
        currentRevision: 5,
        currentContentHash: "hash-v5",
        records: {
          "full-access": {
            answer: "granted",
            revision: 5,
            contentHash: "hash-v5",
            coversTier2: true,
          },
        },
        policy,
      }),
    ).toBe("prompt");
  });

  it("validates schemas, lowercases permission keys, and sanitizes screen displays", () => {
    expect(
      makeDesktopPageAppPermissionKey({
        accountId: "Acc1",
        orgId: "Org1",
        appId: "App1",
        permission: "notifications",
      }),
    ).toBe("acc1|org1|app1|notifications");

    const installed = Schema.decodeUnknownSync(InstalledDesktopPageApp)({
      installId: "0123456789abcdef0123456789abcdef",
      appId: "app-1",
      name: "Moss Timer",
      revision: 1,
      contentHash: "sha256:abc",
      declaredPermissions: ["notifications", "overlay"],
      places: ["start-menu", "desktop"],
      iconSlot: 0,
      installedAt: "2026-11-26T00:00:00.000Z",
    });
    expect(installed.declaredPermissions).toEqual(["notifications", "overlay"]);

    const installState = Schema.decodeUnknownSync(DesktopPageAppInstallState)({
      installed: true,
      available: true,
      installId: installed.installId,
      name: installed.name,
      places: ["start-menu"],
      app: installed,
    });
    expect(installState.installed).toBe(true);

    const setOptsResult = Schema.decodeUnknownSync(DesktopPageAppWindowSetOptionsResult)({
      applied: "now",
      reloading: true,
      options: {
        frame: false,
        transparent: true,
        hasShadow: false,
        roundedCorners: false,
        movable: true,
        fullscreenable: false,
        dragHeight: 24,
      },
    });
    expect(setOptsResult.applied).toBe("now");
    expect(setOptsResult.options.dragHeight).toBe(24);

    const placeInput = Schema.decodeUnknownSync(DesktopPageAppWindowPlaceInput)({
      anchor: "bottom_right",
      margin: 24,
      width: 320,
      height: 240,
    });
    expect(placeInput.anchor).toBe("bottom_right");

    const permState = Schema.decodeUnknownSync(DesktopPageAppPermissionState)({
      permission: "full-access",
      tier: 3,
      state: "granted",
      answer: "granted",
      revision: 2,
      contentHash: "sha256:def",
      coversTier2: true,
      runsOn: ["win32", "darwin"],
      held: true,
    });
    expect(permState.coversTier2).toBe(true);

    expect(() =>
      Schema.decodeUnknownSync(DesktopPageAppWindowOptions)({ width: 100, height: 100 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DesktopPageAppNotificationInput)({ body: "x".repeat(2001) }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(DesktopPageAppTrayOptions)({
        title: "Moss",
        iconIsTemplate: true,
      }).iconIsTemplate,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(DesktopPageAppInstallInput)({
        appId: "app-1",
        title: "Timer",
        sourceTrust: "owner",
      }).sourceTrust,
    ).toBe("owner");

    const sanitizedDisplay = sanitizeDesktopScreenDisplay({
      id: 1,
      label: "Built-in",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      size: { width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 },
      scaleFactor: 1.5,
      rotation: 0,
      internal: true,
    });
    expect(Object.keys(sanitizedDisplay)).toEqual([
      "id",
      "label",
      "bounds",
      "workArea",
      "size",
      "workAreaSize",
      "scaleFactor",
      "rotation",
      "internal",
    ]);
  });
});
