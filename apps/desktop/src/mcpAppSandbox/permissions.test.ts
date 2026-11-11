import { describe, expect, it } from "vitest";

import {
  decideMcpAppPermission,
  decideMcpAppPermissionCheck,
  grantableMcpAppPermissions,
  mcpAppPermissionKeysFor,
} from "./permissions";

describe("MCP App permission decisions", () => {
  it("maps Electron permissions onto the MCP Apps keys", () => {
    expect(mcpAppPermissionKeysFor("geolocation", undefined)).toEqual(["geolocation"]);
    expect(mcpAppPermissionKeysFor("clipboard-sanitized-write", undefined)).toEqual([
      "clipboardWrite",
    ]);
    expect(mcpAppPermissionKeysFor("media", ["video"])).toEqual(["camera"]);
    expect(mcpAppPermissionKeysFor("media", ["audio", "video"])).toEqual(["microphone", "camera"]);
    expect(mcpAppPermissionKeysFor("media", [])).toBe(null);
    expect(mcpAppPermissionKeysFor("media", ["screen"])).toBe(null);
    for (const never of [
      "notifications",
      "midi",
      "midiSysex",
      "clipboard-read",
      "display-capture",
      "pointerLock",
      "fullscreen",
      "openExternal",
      "hid",
      "serial",
      "usb",
      "idle-detection",
      "window-management",
    ]) {
      expect(mcpAppPermissionKeysFor(never, undefined), never).toBe(null);
    }
  });

  it("grants only declared and host-granted keys", () => {
    const context = { declared: { camera: true, geolocation: true }, granted: { camera: true } };
    expect(decideMcpAppPermission("media", ["video"], context)).toBe(true);
    expect(decideMcpAppPermission("media", ["video", "audio"], context)).toBe(false);
    expect(decideMcpAppPermission("geolocation", undefined, context)).toBe(false);
    expect(decideMcpAppPermission("clipboard-sanitized-write", undefined, context)).toBe(false);
    expect(decideMcpAppPermission("notifications", undefined, context)).toBe(false);
    expect(decideMcpAppPermission("media", ["video"], null)).toBe(false);
    // A grant without a declaration is still denied.
    expect(
      decideMcpAppPermission("geolocation", undefined, {
        declared: {},
        granted: { geolocation: true },
      }),
    ).toBe(false);
  });

  it("decides permission checks one media type at a time", () => {
    const context = { declared: { microphone: true }, granted: { microphone: true } };
    expect(decideMcpAppPermissionCheck("media", "audio", context)).toBe(true);
    expect(decideMcpAppPermissionCheck("media", "video", context)).toBe(false);
    expect(decideMcpAppPermissionCheck("media", "unknown", context)).toBe(false);
    expect(decideMcpAppPermissionCheck("media", undefined, context)).toBe(false);
  });

  it("lets the host grant only what some registration declared", () => {
    expect(
      grantableMcpAppPermissions({ camera: true, microphone: true, geolocation: false }, [
        { camera: true },
        { geolocation: true },
      ]),
    ).toEqual({ camera: true });
    expect(grantableMcpAppPermissions({ clipboardWrite: true }, [])).toEqual({});
  });
});
