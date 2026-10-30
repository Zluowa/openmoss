import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION,
  canonicalFilesystemHelperBuildFingerprint,
  canonicalFilesystemHelperTargetsForArch,
} from "./build-canonical-filesystem-helper.mjs";

describe("canonical filesystem helper build", () => {
  it("supports only the explicit macOS architectures", () => {
    expect(canonicalFilesystemHelperTargetsForArch("arm64")).toEqual([
      { arch: "arm64", target: "arm64-apple-macos12.3" },
    ]);
    expect(canonicalFilesystemHelperTargetsForArch("x64")).toEqual([
      { arch: "x64", target: "x86_64-apple-macos12.3" },
    ]);
    expect(canonicalFilesystemHelperTargetsForArch("universal")).toEqual([
      { arch: "arm64", target: "arm64-apple-macos12.3" },
      { arch: "x64", target: "x86_64-apple-macos12.3" },
    ]);
    expect(() => canonicalFilesystemHelperTargetsForArch("linux")).toThrow(
      "Unsupported canonical filesystem helper architecture",
    );
  });

  it("binds the protocol version, architecture, and source bytes into the build fingerprint", () => {
    const first = canonicalFilesystemHelperBuildFingerprint({
      arch: "arm64",
      sourceBytes: Buffer.from("source-a"),
      buildScriptBytes: Buffer.from("script-a"),
    });
    const same = canonicalFilesystemHelperBuildFingerprint({
      arch: "arm64",
      sourceBytes: Buffer.from("source-a"),
      buildScriptBytes: Buffer.from("script-a"),
    });
    const changed = canonicalFilesystemHelperBuildFingerprint({
      arch: "x64",
      sourceBytes: Buffer.from("source-a"),
      buildScriptBytes: Buffer.from("script-a"),
    });

    expect(CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION).toBe(2);
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  it("keeps the helper in the unsigned and signed macOS packaging path", () => {
    const config = readFileSync(
      new URL("../../../scripts/lib/desktop-platform-build-config.ts", import.meta.url),
      "utf8",
    );
    const desktopMain = readFileSync(new URL("../../desktop/src/main.ts", import.meta.url), "utf8");
    const desktopRuntime = readFileSync(
      new URL("../../desktop/src/canonicalFilesystemHelperRuntime.ts", import.meta.url),
      "utf8",
    );
    const devLauncher = readFileSync(
      new URL("../../desktop/scripts/dev-electron.mjs", import.meta.url),
      "utf8",
    );

    expect(config).toContain("MAC_CANONICAL_FILESYSTEM_HELPER_STAGE_PATH");
    expect(config).toContain("MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_STAGE_PATH");
    expect(config).toContain('"Contents/Resources/moss-canonical-filesystem-helper.build.json"');
    expect(config).toContain('to: "Helpers/moss-canonical-filesystem-helper"');
    expect(config).toContain("to: MAC_CANONICAL_FILESYSTEM_HELPER_METADATA_EXTRA_FILE_PATH");
    expect(config).not.toContain('to: "Helpers/moss-canonical-filesystem-helper.build.json"');
    expect(desktopMain).toContain("canonicalFilesystemHelperBackendEnv");
    expect(desktopRuntime).toContain("MOSS_CANONICAL_FILESYSTEM_HELPER_PATH");
    expect(desktopRuntime).toContain("MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH");
    expect(devLauncher).toContain("buildCanonicalFilesystemHelper");
  });
});
