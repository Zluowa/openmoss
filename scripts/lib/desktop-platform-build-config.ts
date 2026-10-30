// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import { MOSS_CONNECTOR_OAUTH_SCHEME, MOSS_DESKTOP_SCHEME } from "@synara/shared/desktopIdentity";
import { fileURLToPath } from "node:url";

import { BUNDLED_CLAUDE_RUNTIME_DIR } from "./bundled-claude-runtime.ts";
import { BUNDLED_CODEX_RUNTIME_DIR } from "./bundled-codex-runtime.ts";

export const MICROPHONE_USAGE_DESCRIPTION =
  "Moss needs microphone access for voice notes, transcription, and real-time voice conversations.";
// Bundle metadata uses the product version; electron-updater compares Darwin releases.
export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";
export const MAC_MINIMUM_DARWIN_VERSION = "22.0.0";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/moss-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = "Contents/Helpers/moss-appsnap-helper";
export const MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH =
  "apps/server/native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper";
export const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH = `${MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH}.build.json`;
export const MAC_CANONICAL_FILESYSTEM_HELPER_ASAR_EXCLUSION =
  "!apps/server/native/moss-canonical-filesystem-helper/build/**";
export const MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH =
  "Contents/Helpers/moss-canonical-filesystem-helper";
export const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_BUNDLE_PATH =
  "Contents/Resources/moss-canonical-filesystem-helper.build.json";
export const MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH =
  "Resources/moss-canonical-filesystem-helper.build.json";
export const MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH = fileURLToPath(
  new URL("../mac-canonical-filesystem-helper-sign.mjs", import.meta.url),
);
export const MAC_CODEX_COMPLIANCE_AFTER_PACK_MODULE_PATH = fileURLToPath(
  new URL("../mac-codex-compliance-after-pack.mjs", import.meta.url),
);
export const MAC_DEVICE_HELPER_STAGE_PATH = "apps/server/dist/device-helper";
export const MAC_DEVICE_HELPER_RESOURCE_PATH = "Resources/device-helper";
export const WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
export const WINDOWS_ESIGNER_SIGN_MODULE_PATH = fileURLToPath(
  new URL("../windows-esigner-sign.mjs", import.meta.url),
);
export const WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH = fileURLToPath(
  new URL("../windows-native-payload-after-pack.mjs", import.meta.url),
);
export const WINDOWS_NATIVE_AUDIT_AFTER_SIGN_MODULE_PATH = fileURLToPath(
  new URL("../windows-native-payload-after-sign.mjs", import.meta.url),
);
export const WINDOWS_AUTHENTICODE_SIGN_EXTENSIONS = [".exe", ".dll"] as const;
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;
export const BUNDLED_RUNTIME_ASAR_EXCLUSIONS = [
  `!${BUNDLED_CODEX_RUNTIME_DIR}/**`,
  `!${BUNDLED_CLAUDE_RUNTIME_DIR}/**`,
] as const;
export const CONNECTOR_OAUTH_PROTOCOL_CONFIG = {
  name: "Moss connector OAuth callback",
  schemes: [MOSS_CONNECTOR_OAUTH_SCHEME],
} as const;
export const AUTH_CALLBACK_PROTOCOL_CONFIG = {
  name: "Moss authentication callback",
  schemes: [MOSS_DESKTOP_SCHEME],
} as const;

export interface DesktopPlatformBuildConfig {
  readonly afterPack?: string;
  readonly afterSign?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly protocols?: ReadonlyArray<{
    readonly name: string;
    readonly schemes: ReadonlyArray<string>;
  }>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly npmRebuild?: boolean;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly signed?: boolean;
  readonly macBuildOnlyPostPackagingSign?: boolean;
  readonly windowsAzureSignOptions?: Record<string, string>;
  readonly windowsSslComSignOptions?: {
    readonly publisherName: string;
    readonly signModulePath?: string;
  };
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function resolveDesktopBuilderCliTargets(
  input: Pick<CreateDesktopPlatformBuildConfigInput, "platform" | "target">,
): ReadonlyArray<string> {
  return input.platform === "mac" && input.target === "dmg"
    ? [input.target, "zip"]
    : [input.target];
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include the native Swift AppSnap helper.",
      `Build mac/${input.arch} on macOS so the helper can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  if (
    input.macBuildOnlyPostPackagingSign === true &&
    (input.platform !== "mac" || input.target !== "zip" || input.signed === true)
  ) {
    throw new Error("Post-packaging ad-hoc signing is restricted to unsigned macOS ZIP builds.");
  }
  if (input.windowsAzureSignOptions) {
    throw new Error(
      "Windows Azure Trusted Signing is disabled because it would modify reviewed vendor payload bytes before the afterPack audit. Use SSL.com eSigner instead.",
    );
  }

  const nativePackaging = {
    asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS],
    protocols: [AUTH_CALLBACK_PROTOCOL_CONFIG, CONNECTOR_OAUTH_PROTOCOL_CONFIG],
  };
  const applicationFiles = ["**/*", ...BUNDLED_RUNTIME_ASAR_EXCLUSIONS];

  if (input.platform === "mac") {
    const mac = {
      target: resolveDesktopBuilderCliTargets(input),
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      // The bundled Claude and Cua native executables require macOS 13.
      // Keep the app's launch metadata consistent with its complete payload.
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      // electron-builder 26.15 no longer falls back to ad-hoc signing when
      // certificate discovery is disabled. Build-only packages still need a
      // complete resource seal so the isolated startup smoke exercises the
      // packaged app rather than an invalid Electron template signature.
      ...(input.signed === true
        ? {}
        : { identity: input.macBuildOnlyPostPackagingSign === true ? null : "-" }),
      hardenedRuntime: input.signed === true,
      notarize: input.signed === true,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH],
      // The universal build stages the same pre-lipo'd helper in both app trees.
      // @electron/universal needs this pattern to preserve that existing fat binary.
      x64ArchFiles: MAC_APPSNAP_HELPER_BUNDLE_PATH,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
      },
    } satisfies Record<string, unknown>;

    return {
      afterPack: MAC_CODEX_COMPLIANCE_AFTER_PACK_MODULE_PATH,
      ...nativePackaging,
      dmg: {
        sign: input.signed === true,
        // The signed release flow notarizes and staples the DMG after electron-builder exits.
        // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
        // macOS auto-updates use the separately finalized ZIP artifact.
        writeUpdateInfo: false,
      },
      files: [
        ...applicationFiles,
        MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
        MAC_CANONICAL_FILESYSTEM_HELPER_ASAR_EXCLUSION,
      ],
      // electron-builder signs nested binaries before sealing the outer .app
      // bundle. Refresh the helper sidecar immediately before the outer
      // signature so the sealed Resources metadata matches the signed helper.
      mac: {
        ...mac,
        sign: MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
      },
      extraFiles: [
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
          to: "Helpers/moss-appsnap-helper",
        },
        {
          from: MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH,
          to: "Helpers/moss-canonical-filesystem-helper",
        },
        {
          from: MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH,
          to: MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH,
        },
        {
          from: MAC_DEVICE_HELPER_STAGE_PATH,
          to: MAC_DEVICE_HELPER_RESOURCE_PATH,
        },
      ],
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      files: applicationFiles,
      // The staged install performs one explicit @electron/rebuild for node-pty.
      // Do not let electron-builder broad-rebuild every native dependency again.
      npmRebuild: false,
      linux: {
        target: [input.target],
        executableName: "moss",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "moss",
          },
        },
      },
    };
  }

  const windowsSigningConfig = input.windowsSslComSignOptions
    ? {
        signtoolOptions: {
          sign: input.windowsSslComSignOptions.signModulePath ?? WINDOWS_ESIGNER_SIGN_MODULE_PATH,
          signingHashAlgorithms: ["sha256"],
          publisherName: input.windowsSslComSignOptions.publisherName,
        },
      }
    : undefined;

  return {
    afterPack: WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH,
    ...(windowsSigningConfig ? { afterSign: WINDOWS_NATIVE_AUDIT_AFTER_SIGN_MODULE_PATH } : {}),
    ...nativePackaging,
    // Bundled agent runtimes are copied once through extraResources. Keeping
    // their source directories out of app.asar prevents duplicate executable
    // payloads from escaping the closed Windows native manifest.
    files: applicationFiles,
    // The frozen stage install already selected and smoke-tested win32/<arch>
    // native payloads. A second @electron/rebuild would mutate those reviewed
    // bytes after lockfile verification (and cannot cross-compile reliably).
    npmRebuild: false,
    // Keep the installed-product registration stable so this release safely
    // upgrades existing Moss 0.5.3 installs without duplicate uninstallers.
    // Runtime data is isolated independently under the Moss namespaces.
    nsis: {
      guid: WINDOWS_INSTALLER_GUID,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      // electron-builder otherwise sends every extraResources `.exe` through
      // its default unsigned signing path. That path can rewrite existing
      // vendor signatures before afterPack verifies the byte-pinned Claude
      // and Codex payloads. Keep executable resource editing for Moss.exe,
      // while disabling only code signing for explicitly unsigned builds.
      ...(windowsSigningConfig ? {} : { signExecutable: false }),
      ...(windowsSigningConfig ?? {}),
      ...(windowsSigningConfig
        ? {
            forceCodeSigning: true,
            signExts: [...WINDOWS_AUTHENTICODE_SIGN_EXTENSIONS],
            verifyUpdateCodeSignature: true,
          }
        : {}),
    },
  };
}
