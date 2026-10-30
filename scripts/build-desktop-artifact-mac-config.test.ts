import { assert, describe, it } from "@effect/vitest";

import {
  BUNDLED_RUNTIME_ASAR_EXCLUSIONS,
  CONNECTOR_OAUTH_PROTOCOL_CONFIG,
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_ASAR_EXCLUSION,
  MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH,
  MAC_CODEX_COMPLIANCE_AFTER_PACK_MODULE_PATH,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  MAC_DEVICE_HELPER_STAGE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MICROPHONE_USAGE_DESCRIPTION,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  resolveDesktopBuilderCliTargets,
  validateDesktopNativeBuildHost,
  WINDOWS_AUTHENTICODE_SIGN_EXTENSIONS,
  WINDOWS_ESIGNER_SIGN_MODULE_PATH,
  WINDOWS_INSTALLER_GUID,
  WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH,
  WINDOWS_NATIVE_AUDIT_AFTER_SIGN_MODULE_PATH,
} from "./lib/desktop-platform-build-config.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

describe("createDesktopPlatformBuildConfig", () => {
  const expectedDesktopProtocols = [
    {
      name: "Moss authentication callback",
      schemes: ["moss"],
    },
    CONNECTOR_OAUTH_PROTOCOL_CONFIG,
  ];

  it("keeps the macOS update zip target when forwarding a DMG build to electron-builder", () => {
    assert.deepStrictEqual(resolveDesktopBuilderCliTargets({ platform: "mac", target: "dmg" }), [
      "dmg",
      "zip",
    ]);
    assert.deepStrictEqual(resolveDesktopBuilderCliTargets({ platform: "mac", target: "zip" }), [
      "zip",
    ]);
    assert.deepStrictEqual(resolveDesktopBuilderCliTargets({ platform: "win", target: "nsis" }), [
      "nsis",
    ]);
  });

  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.equal(mac.identity, undefined);
    assert.equal(mac.minimumSystemVersion, "13.0");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.protocols, expectedDesktopProtocols);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, true);
    assert.equal(mac.sign, MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH);
    assert.equal(config.afterPack, MAC_CODEX_COMPLIANCE_AFTER_PACK_MODULE_PATH);
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Helpers/moss-appsnap-helper");
    assert.deepStrictEqual(mac.binaries, [
      MAC_APPSNAP_HELPER_BUNDLE_PATH,
      MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH,
    ]);
    assert.equal(mac.x64ArchFiles, "Contents/Helpers/moss-appsnap-helper");
    assert.equal(
      MAC_APPSNAP_HELPER_STAGE_PATH,
      "apps/desktop/native/appsnap/build/moss-appsnap-helper",
    );
    assert.equal(MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/appsnap/build/**");
    assert.deepStrictEqual(config.files, [
      "**/*",
      ...BUNDLED_RUNTIME_ASAR_EXCLUSIONS,
      MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
      MAC_CANONICAL_FILESYSTEM_HELPER_ASAR_EXCLUSION,
    ]);
    assert.deepStrictEqual(config.extraFiles, [
      {
        from: "apps/desktop/native/appsnap/build/moss-appsnap-helper",
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
    ]);
    assert.equal(
      MICROPHONE_USAGE_DESCRIPTION,
      "Moss needs microphone access for voice notes, transcription, and real-time voice conversations.",
    );
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, undefined);
  });

  it("ad-hoc signs the app but leaves the DMG container unsigned for build-only macOS artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.deepStrictEqual(config.dmg, { sign: false, writeUpdateInfo: false });
    assert.equal((config.mac as Record<string, unknown>).identity, "-");
    assert.equal((config.mac as Record<string, unknown>).minimumSystemVersion, "13.0");
    assert.equal(
      (config.mac as Record<string, unknown>).sign,
      MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
    );
    assert.equal(config.afterPack, MAC_CODEX_COMPLIANCE_AFTER_PACK_MODULE_PATH);
  });

  it("keeps canonical helper provenance outside the macOS nested-code directory", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.equal(
      MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_BUNDLE_PATH,
      "Contents/Resources/moss-canonical-filesystem-helper.build.json",
    );
    assert.equal(
      MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH,
      "Resources/moss-canonical-filesystem-helper.build.json",
    );
    assert.equal(
      config.extraFiles?.some(
        (entry) => entry.to === "Helpers/moss-canonical-filesystem-helper.build.json",
      ),
      false,
    );
    assert.deepStrictEqual(
      config.extraFiles?.filter(
        (entry) =>
          entry.to === "Helpers/moss-canonical-filesystem-helper" ||
          entry.to === MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH,
      ),
      [
        {
          from: MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH,
          to: "Helpers/moss-canonical-filesystem-helper",
        },
        {
          from: MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH,
          to: MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH,
        },
      ],
    );
    assert.ok(config.files?.includes(MAC_CANONICAL_FILESYSTEM_HELPER_ASAR_EXCLUSION));
    const macBinaries = (config.mac as Record<string, unknown>).binaries;
    assert.ok(
      Array.isArray(macBinaries) &&
        macBinaries.includes(MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH),
    );
  });

  it("excludes the copied Codex staging tree from every platform ASAR", () => {
    const linux = createDesktopPlatformBuildConfig({
      hostPlatform: "linux",
      platform: "linux",
      target: "AppImage",
    });
    const win = createDesktopPlatformBuildConfig({
      hostPlatform: "win32",
      platform: "win",
      target: "nsis",
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.extraFiles, undefined);
    assert.equal(linux.npmRebuild, false);
    assert.deepStrictEqual(linux.files, ["**/*", ...BUNDLED_RUNTIME_ASAR_EXCLUSIONS]);
    assert.deepStrictEqual(linux.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(linux.protocols, expectedDesktopProtocols);
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "moss",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "moss",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.equal(win.extraFiles, undefined);
    assert.deepStrictEqual(win.files, ["**/*", ...BUNDLED_RUNTIME_ASAR_EXCLUSIONS]);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(win.afterPack, WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH);
    assert.equal(win.afterSign, undefined);
    assert.deepStrictEqual(win.protocols, expectedDesktopProtocols);
    assert.equal(WINDOWS_INSTALLER_GUID, "368107a8-afe6-5db5-ab3b-d4f331684868");
    assert.deepStrictEqual(win.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      signExecutable: false,
    });
  });

  it("routes SSL.com eSigner through electron-builder so inner binaries and NSIS are signed", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "win32",
      platform: "win",
      target: "nsis",
      windowsSslComSignOptions: { publisherName: "Moss Publisher" },
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
      signtoolOptions: {
        sign: WINDOWS_ESIGNER_SIGN_MODULE_PATH,
        signingHashAlgorithms: ["sha256"],
        publisherName: "Moss Publisher",
      },
      forceCodeSigning: true,
      signExts: [...WINDOWS_AUTHENTICODE_SIGN_EXTENSIONS],
      verifyUpdateCodeSignature: true,
    });
    assert.equal(config.afterPack, WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH);
    assert.equal(config.afterSign, WINDOWS_NATIVE_AUDIT_AFTER_SIGN_MODULE_PATH);
  });

  it("rejects Azure signing options even when passed directly to the build config", () => {
    assert.throws(
      () =>
        createDesktopPlatformBuildConfig({
          hostPlatform: "win32",
          platform: "win",
          target: "nsis",
          windowsAzureSignOptions: { publisherName: "Azure Publisher" },
        }),
      /Azure Trusted Signing is disabled.*vendor payload bytes.*SSL\.com eSigner/,
    );
    assert.throws(
      () =>
        createDesktopPlatformBuildConfig({
          hostPlatform: "win32",
          platform: "win",
          target: "nsis",
          windowsAzureSignOptions: { publisherName: "Azure Publisher" },
          windowsSslComSignOptions: { publisherName: "SSL.com Publisher" },
        }),
      /Azure Trusted Signing is disabled/,
    );
  });

  it("keeps Windows signing optional", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "win32",
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
      signExecutable: false,
    });
    assert.equal(config.afterPack, WINDOWS_NATIVE_AUDIT_AFTER_PACK_MODULE_PATH);
    assert.equal(config.afterSign, undefined);
  });

  it("uses an assisted Windows installer with a user-selectable installation directory", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "win32",
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    });
  });

  it("does not mutate frozen Windows native dependencies with electron-builder rebuilds", () => {
    const crossHostWindows = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "win",
      target: "nsis",
    });
    const nativeWindows = createDesktopPlatformBuildConfig({
      hostPlatform: "win32",
      platform: "win",
      target: "nsis",
    });
    const nativeMac = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "mac",
      target: "dmg",
    });

    assert.equal(crossHostWindows.npmRebuild, false);
    assert.equal(nativeWindows.npmRebuild, false);
    assert.equal(nativeMac.npmRebuild, undefined);
    assert.equal(
      createDesktopPlatformBuildConfig({
        hostPlatform: "linux",
        platform: "linux",
        target: "AppImage",
      }).npmRebuild,
      false,
    );
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "linux",
      platform: "linux",
      target: "AppImage",
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [...NODE_PTY_ASAR_UNPACK_GLOBS]);
  });

  it("copies bundled runtimes only through extraResources, never inside app.asar", () => {
    assert.deepStrictEqual(
      [...BUNDLED_RUNTIME_ASAR_EXCLUSIONS],
      ["!apps/desktop/codex-runtime/**", "!apps/desktop/claude-runtime/**"],
    );

    for (const [platform, target] of [
      ["mac", "dmg"],
      ["linux", "AppImage"],
      ["win", "nsis"],
    ] as const) {
      const config = createDesktopPlatformBuildConfig({
        hostPlatform: platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux",
        platform,
        target,
      });

      assert.deepStrictEqual(config.files?.slice(0, 3), [
        "**/*",
        ...BUNDLED_RUNTIME_ASAR_EXCLUSIONS,
      ]);
    }
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });

  it("requires a macOS host for the native Swift AppSnap helper", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "mac",
        arch: "universal",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      null,
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "linux",
      hostArch: "arm64",
    });
    assert.ok(issue?.includes("Build mac/arm64 on macOS"));
  });

  it("uses the reviewed white-backed Moss icon for every macOS icon path", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "apps/desktop/resources/icon.png");
    assert.equal(BRAND_ASSET_PATHS.productionMacLegacyIconPng, "apps/desktop/resources/icon.png");
  });
});
