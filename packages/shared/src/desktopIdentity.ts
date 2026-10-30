// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.
//
// 品牌说明：上游把标识重命名为 Moss；Moss 产品身份（scheme、bundle id、
// 数据目录、更新渠道）必须保持 Moss 值，否则已安装用户的深链、数据与更新
// 源全部断裂。导出名沿用上游（MOSS_*），值全部 Moss。

export const MOSS_DESKTOP_SCHEME = "moss";
/** Dedicated OS deep-link handler; never used to serve renderer content. */
export const MOSS_CONNECTOR_OAUTH_SCHEME = "moss-connectors";
export const MOSS_AUTH_PROTOCOL_REGISTRATION_DISABLED_ENV =
  "MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION";
export const MOSS_DESKTOP_ORIGIN = `${MOSS_DESKTOP_SCHEME}://app`;
export const MOSS_DESKTOP_ENTRY_URL = `${MOSS_DESKTOP_ORIGIN}/index.html`;
export const MOSS_DESKTOP_UPDATE_CHANNEL = "moss";
export const MOSS_PRODUCTION_BUNDLE_ID = "com.moss.desktop";
export const MOSS_DEVELOPMENT_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.dev`;
export const MOSS_CANARY_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.canary`;
/** Display/setup identity of the GUI host; this value does not confer native authority. */
export const MOSS_DESKTOP_BUNDLE_ID_ENV = "MOSS_DESKTOP_BUNDLE_ID";
export const MOSS_CANARY_DESKTOP_SCHEME = "moss-canary";
export const MOSS_CANARY_DESKTOP_ORIGIN = `${MOSS_CANARY_DESKTOP_SCHEME}://app`;
export const MOSS_CANARY_DESKTOP_ENTRY_URL = `${MOSS_CANARY_DESKTOP_ORIGIN}/index.html`;
export const MOSS_CUA_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.cua`;
export const MOSS_CUA_DESKTOP_SCHEME = "moss-cua";
export const MOSS_CUA_DESKTOP_ORIGIN = `${MOSS_CUA_DESKTOP_SCHEME}://app`;
export const MOSS_CUA_DESKTOP_ENTRY_URL = `${MOSS_CUA_DESKTOP_ORIGIN}/index.html`;
export const MOSS_BETA_BUNDLE_ID = `${MOSS_PRODUCTION_BUNDLE_ID}.beta`;
export const MOSS_BETA_DESKTOP_SCHEME = "moss-beta";
export const MOSS_BETA_DESKTOP_ORIGIN = `${MOSS_BETA_DESKTOP_SCHEME}://app`;
export const MOSS_BETA_DESKTOP_ENTRY_URL = `${MOSS_BETA_DESKTOP_ORIGIN}/index.html`;
export const MOSS_SOURCE_DESKTOP_BUILD_MARKER = "moss-source-desktop-build-v2";
export const MOSS_DESKTOP_SMOKE_USER_DATA_ENV = "MOSS_DESKTOP_SMOKE_USER_DATA";
/**
 * Public GitHub repository that hosts desktop installers and the
 * `moss-*.yml` / `latest-*.yml` electron-updater manifests.
 */
export const MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY = "Zluowa/moss-releases";
/** Setting `MOSS_DESKTOP_UPDATE_REPOSITORY` to this value packages a build without any update feed. */
export const MOSS_DESKTOP_UPDATE_REPOSITORY_DISABLED = "none";

export type MossDesktopFlavor = "production" | "development" | "canary" | "cua" | "beta";
export const MOSS_PACKAGED_DESKTOP_FLAVORS = ["production", "canary", "cua", "beta"] as const;
export type MossPackagedDesktopFlavor = (typeof MOSS_PACKAGED_DESKTOP_FLAVORS)[number];

/**
 * electron-updater matches the update channel against the release tag's
 * prerelease identifier, so the beta flavor must use the `beta` channel to see
 * `vX.Y.Z-beta.N` releases. Every other flavor keeps the `moss` channel.
 */
export function desktopUpdateChannel(flavor: MossDesktopFlavor): string {
  return flavor === "beta" ? "beta" : MOSS_DESKTOP_UPDATE_CHANNEL;
}

export interface MossDesktopIdentity {
  readonly flavor: MossDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveMossDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): MossDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "cua") {
    return "cua";
  }
  if (requestedFlavor === "canary") {
    return "canary";
  }
  if (requestedFlavor === "beta") {
    return "beta";
  }
  if (
    requestedFlavor === "development" &&
    (input.isDevelopment || input.allowDevelopmentOverride === true)
  ) {
    return "development";
  }
  return input.isDevelopment ? "development" : "production";
}

/** Packaged identity is fixed when the artifact is staged, before it is signed. */
export function resolveMossDesktopRuntimeFlavor(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly packagedFlavor?: unknown;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): MossDesktopFlavor {
  if (input.isPackaged && input.packagedFlavor !== undefined) {
    const flavor = input.packagedFlavor;
    if (flavor === "production" || flavor === "canary" || flavor === "cua" || flavor === "beta") {
      return flavor;
    }
    throw new Error("The packaged Moss desktop flavor is invalid. Rebuild the application.");
  }
  // Source launchers also use an app bundle on macOS. Their build marker keeps
  // the existing environment-based routing, while legacy packaged apps remain
  // Stable even when a developer shell happens to export a different flavor.
  if (input.isPackaged && input.allowDevelopmentOverride !== true) {
    return "production";
  }
  return resolveMossDesktopFlavor(input);
}

export function canOverrideDesktopSmokeUserData(input: {
  readonly packagedFlavor?: unknown;
  readonly sourceBuildMarker?: string | undefined;
}): boolean {
  return (
    input.packagedFlavor === "cua" ||
    input.packagedFlavor === "beta" ||
    (input.packagedFlavor === undefined &&
      input.sourceBuildMarker === MOSS_SOURCE_DESKTOP_BUILD_MARKER)
  );
}

export function mossDesktopIdentity(flavor: MossDesktopFlavor): MossDesktopIdentity {
  if (flavor === "cua") {
    return {
      flavor,
      displayName: "Moss Cua",
      bundleId: MOSS_CUA_BUNDLE_ID,
      scheme: MOSS_CUA_DESKTOP_SCHEME,
      origin: MOSS_CUA_DESKTOP_ORIGIN,
      entryUrl: MOSS_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-cua",
      defaultHomeDirectoryName: ".moss-cua",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Moss Canary",
      bundleId: MOSS_CANARY_BUNDLE_ID,
      scheme: MOSS_CANARY_DESKTOP_SCHEME,
      origin: MOSS_CANARY_DESKTOP_ORIGIN,
      entryUrl: MOSS_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-canary",
      defaultHomeDirectoryName: ".moss-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "beta") {
    return {
      flavor,
      displayName: "Moss Beta",
      bundleId: MOSS_BETA_BUNDLE_ID,
      scheme: MOSS_BETA_DESKTOP_SCHEME,
      origin: MOSS_BETA_DESKTOP_ORIGIN,
      entryUrl: MOSS_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-beta",
      defaultHomeDirectoryName: ".moss-beta",
      usesScriptedUpdates: false,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Moss (Dev)",
      bundleId: MOSS_DEVELOPMENT_BUNDLE_ID,
      scheme: MOSS_DESKTOP_SCHEME,
      origin: MOSS_DESKTOP_ORIGIN,
      entryUrl: MOSS_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "moss-dev",
      defaultHomeDirectoryName: ".moss",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Moss",
    bundleId: MOSS_PRODUCTION_BUNDLE_ID,
    scheme: MOSS_DESKTOP_SCHEME,
    origin: MOSS_DESKTOP_ORIGIN,
    entryUrl: MOSS_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "moss",
    defaultHomeDirectoryName: ".moss",
    usesScriptedUpdates: false,
  };
}

export function mossBundleId(isDevelopment: boolean): string {
  return mossDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
