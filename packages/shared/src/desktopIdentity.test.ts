import { describe, expect, it } from "vitest";

import {
  MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV,
  MOSS_CANARY_BUNDLE_ID,
  MOSS_CANARY_DESKTOP_ENTRY_URL,
  MOSS_CANARY_DESKTOP_ORIGIN,
  MOSS_CANARY_DESKTOP_SCHEME,
  MOSS_DESKTOP_ENTRY_URL,
  MOSS_DESKTOP_ORIGIN,
  MOSS_DESKTOP_SCHEME,
  MOSS_DESKTOP_UPDATE_CHANNEL,
  MOSS_DEVELOPMENT_BUNDLE_ID,
  MOSS_PRODUCTION_BUNDLE_ID,
  mossBundleId,
  mossDesktopIdentity,
  resolveMossDesktopFlavor,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(MOSS_PRODUCTION_BUNDLE_ID).toBe("com.moss.desktop");
    expect(MOSS_DEVELOPMENT_BUNDLE_ID).toBe("com.moss.desktop.dev");
    expect(mossBundleId(false)).toBe(MOSS_PRODUCTION_BUNDLE_ID);
    expect(mossBundleId(true)).toBe(MOSS_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(MOSS_DESKTOP_SCHEME).toBe("moss");
    expect(MOSS_DESKTOP_ORIGIN).toBe("moss://app");
    expect(MOSS_DESKTOP_ENTRY_URL).toBe("moss://app/index.html");
    expect(MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV).toBe(
      "MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION",
    );
  });

  it("keeps Stable and Dev profiles distinct without changing the reviewed Moss origin", () => {
    expect(mossDesktopIdentity("production")).toEqual({
      flavor: "production",
      displayName: "Moss",
      bundleId: MOSS_PRODUCTION_BUNDLE_ID,
      scheme: MOSS_DESKTOP_SCHEME,
      origin: MOSS_DESKTOP_ORIGIN,
      entryUrl: MOSS_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss",
      defaultHomeDirectoryName: ".moss",
      usesScriptedUpdates: false,
    });
    expect(mossDesktopIdentity("development")).toEqual({
      flavor: "development",
      displayName: "Moss (Dev)",
      bundleId: MOSS_DEVELOPMENT_BUNDLE_ID,
      scheme: MOSS_DESKTOP_SCHEME,
      origin: MOSS_DESKTOP_ORIGIN,
      entryUrl: MOSS_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-dev",
      defaultHomeDirectoryName: ".moss",
      usesScriptedUpdates: false,
    });
  });

  it("uses the isolated Moss desktop update channel", () => {
    expect(MOSS_DESKTOP_UPDATE_CHANNEL).toBe("moss");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(MOSS_CANARY_BUNDLE_ID).toBe("com.moss.desktop.canary");
    expect(MOSS_CANARY_DESKTOP_SCHEME).toBe("moss-canary");
    expect(MOSS_CANARY_DESKTOP_ORIGIN).toBe("moss-canary://app");
    expect(MOSS_CANARY_DESKTOP_ENTRY_URL).toBe("moss-canary://app/index.html");
    expect(MOSS_CANARY_DESKTOP_ORIGIN).not.toBe(MOSS_DESKTOP_ORIGIN);
    expect(mossDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Moss Canary",
      bundleId: MOSS_CANARY_BUNDLE_ID,
      scheme: "moss-canary",
      origin: MOSS_CANARY_DESKTOP_ORIGIN,
      entryUrl: MOSS_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-canary",
      defaultHomeDirectoryName: ".moss-canary",
      usesScriptedUpdates: true,
    });
  });

  it("selects Canary explicitly without changing normal dev and production defaults", () => {
    expect(resolveMossDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveMossDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(resolveMossDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveMossDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
  });
});
