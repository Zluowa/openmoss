import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH,
  MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
} from "./lib/desktop-platform-build-config.ts";
import { createMacBuildOnlySigningEnvironment } from "./lib/desktop-signing-environment.ts";
import { createMacBuildOnlySignCommandPlan } from "./lib/mac-build-only-signing.ts";

type BuildOnlySignInput = {
  app: string;
  version: string;
  entitlements: string;
  entitlementsInherit: string;
  binaries: string[];
};

type BuildOnlySignOptions = BuildOnlySignInput & {
  platform: string;
  type: string;
  identity: string;
  identityValidation: boolean;
  preEmbedProvisioningProfile: boolean;
  preAutoEntitlements: boolean;
  strictVerify: boolean;
  optionsForFile: (filePath: string) => {
    entitlements: string;
    hardenedRuntime: boolean;
    timestamp: string;
  };
};

// The existing helper hook is synchronously required by release callers.
const require = createRequire(import.meta.url);
const legacySigning = require("./mac-canonical-filesystem-helper-sign.mjs") as {
  default: (options: unknown) => Promise<unknown>;
};
const policy = require("./lib/mac-build-only-sign-options.mjs") as {
  parseMacBuildOnlySignArgs: (argv: string[]) => BuildOnlySignInput;
  createMacBuildOnlySignOptions: (
    input: BuildOnlySignInput,
    canonicalHelperRelativePath: string,
  ) => BuildOnlySignOptions;
};
const signing = {
  default: legacySigning.default,
  parseMacBuildOnlySignArgs: policy.parseMacBuildOnlySignArgs,
  createMacBuildOnlySignOptions: (value: BuildOnlySignInput) =>
    policy.createMacBuildOnlySignOptions(value, MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH),
};

const repoRoot = path.resolve(".");
const app = path.join(repoRoot, "fixture", "Moss.app");
const input: BuildOnlySignInput = {
  app,
  version: "43.4.1",
  entitlements: path.join(repoRoot, MAC_ENTITLEMENTS_PATH),
  entitlementsInherit: path.join(repoRoot, MAC_INHERITED_ENTITLEMENTS_PATH),
  binaries: [
    path.join(app, MAC_APPSNAP_HELPER_BUNDLE_PATH),
    path.join(app, MAC_CANONICAL_FILESYSTEM_HELPER_BUNDLE_PATH),
  ],
};

describe("explicit build-only macOS signing boundary", () => {
  it("keeps the new command inside its independently guarded process boundary", () => {
    const source = readFileSync(
      new URL("./lib/mac-build-only-signing.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/ChildProcess\.make/g)).toHaveLength(1);
    expect(source).toContain("ChildProcess.make(plan.executable, plan.args, plan.options)");
    expect(source).toContain("env: createMacBuildOnlySigningEnvironment(input.env)");
    expect(source).toContain("extendEnv: false");
  });

  it("reports a direct CLI failure without exposing the underlying exception", () => {
    const result = spawnSync(
      process.execPath,
      [
        ...(process.versions.bun ? ["--no-env-file"] : []),
        MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
        "--invalid",
      ],
      {
        env: {
          ...createMacBuildOnlySigningEnvironment({ SYSTEMROOT: process.env.SYSTEMROOT }),
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "[mac-build-only-sign] Failed to create an ad-hoc application seal.",
    );
  });

  it("disables builder discovery while retaining every other unsigned ZIP setting", () => {
    const options = {
      hostPlatform: "darwin" as const,
      platform: "mac" as const,
      target: "zip",
      signed: false,
    };
    const baseline = createDesktopPlatformBuildConfig(options);
    const selected = createDesktopPlatformBuildConfig({
      ...options,
      macBuildOnlyPostPackagingSign: true,
    });
    expect(selected).toEqual({ ...baseline, mac: { ...baseline.mac, identity: null } });
    expect(baseline.mac?.identity).toBe("-");
  });

  it.each([
    { platform: "mac" as const, target: "zip", signed: true },
    { platform: "mac" as const, target: "dmg", signed: false },
    { platform: "mac" as const, target: "dir", signed: false },
    { platform: "win" as const, target: "nsis", signed: false },
    { platform: "linux" as const, target: "AppImage", signed: false },
  ])("rejects the no-discovery path outside unsigned mac/zip: %j", (options) => {
    expect(() =>
      createDesktopPlatformBuildConfig({
        hostPlatform: "darwin",
        ...options,
        macBuildOnlyPostPackagingSign: true,
      }),
    ).toThrow(/restricted to unsigned macOS ZIP/);
  });

  it("removes signing aliases and injection variables without changing the source environment", () => {
    const source = {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CSC_NAME: "fixture",
      csc_keychain: "fixture",
      CSC_INSTALLER_LINK: "fixture",
      WIN_CSC_PRIVATE_KEY: "fixture",
      APPLE_USER: "fixture",
      apple_unrecognized_future_key: "fixture",
      Debug: "fixture",
      NODE_OPTIONS: "--require=/fixture/inject.cjs",
      DYLD_INSERT_LIBRARIES: "/fixture/inject.dylib",
    };
    const snapshot = { ...source };
    expect(createMacBuildOnlySigningEnvironment(source)).toEqual({
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
    expect(source).toEqual(snapshot);
  });

  it.each([false, true])(
    "passes only fixed CLI arguments and an explicit environment (Bun=%s)",
    (isBun) => {
      const plan = createMacBuildOnlySignCommandPlan({
        executable: "/fixture/node",
        isBun,
        appBundlePath: app,
        electronVersion: input.version,
        repoRoot,
        env: { PATH: "/fixture/bin", CSC_KEYCHAIN: "fixture", APPLE_ID: "fixture" },
      });
      expect(plan.executable).toBe("/fixture/node");
      expect(plan.args).toEqual([
        ...(isBun ? ["--no-env-file"] : []),
        MAC_CANONICAL_FILESYSTEM_HELPER_SIGN_MODULE_PATH,
        "--build-only",
        app,
        input.version,
        input.entitlements,
        input.entitlementsInherit,
        ...input.binaries,
      ]);
      expect(plan.options).toEqual({
        cwd: repoRoot,
        env: { PATH: "/fixture/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" },
        extendEnv: false,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(signing.parseMacBuildOnlySignArgs(plan.args.slice(isBun ? 2 : 1))).toEqual(input);
    },
  );

  it("keeps synchronous hook imports and fixes the identity and strict verification policy", () => {
    expect(typeof signing.default).toBe("function");
    const options = signing.createMacBuildOnlySignOptions(input);
    expect(options).toMatchObject({
      app,
      platform: "darwin",
      version: input.version,
      identity: "-",
      identityValidation: false,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      strictVerify: true,
      binaries: input.binaries,
    });
    expect(options.optionsForFile(app)).toEqual({
      entitlements: input.entitlements,
      hardenedRuntime: false,
      timestamp: "none",
    });
    expect(options.optionsForFile(input.binaries[1]!)).toEqual({
      entitlements: input.entitlementsInherit,
      hardenedRuntime: false,
      timestamp: "none",
    });
  });

  it.each([
    { ...input, app: "relative.app" },
    { ...input, version: "43.4.1 --identity fixture" },
    { ...input, entitlements: "relative.plist" },
    { ...input, binaries: [path.resolve(app, "..", "outside"), input.binaries[1]!] },
    { ...input, binaries: [input.binaries[1]!, input.binaries[1]!] },
    { ...input, binaries: [input.binaries[0]!, path.join(app, "other-helper")] },
  ])("rejects invalid signing inputs before executing a signer: %j", (invalid) => {
    expect(() => signing.createMacBuildOnlySignOptions(invalid)).toThrow();
  });

  it("rejects incomplete or extended CLI argument vectors", () => {
    for (const argv of [
      [],
      ["--identity", "fixture"],
      ["--build-only", ...Array(7).fill("fixture")],
    ]) {
      expect(() => signing.parseMacBuildOnlySignArgs(argv)).toThrow(/Expected --build-only/);
    }
  });

  it("signs after packaging and before the original strict verification and ZIP finalization", () => {
    const source = readFileSync(new URL("./build-desktop-artifact.ts", import.meta.url), "utf8");
    const packageCommand = source.indexOf(
      "electronBuilderCliPath,",
      source.indexOf("const electronBuilderCliPath"),
    );
    const signingCommand = source.indexOf("createMacBuildOnlySignCommand({", packageCommand);
    const verification = source.indexOf("const packagedBundledCodexValidation", signingCommand);
    const zip = source.indexOf("finalizeMacUpdateZip({", verification);
    expect(packageCommand).toBeGreaterThan(0);
    expect(signingCommand).toBeGreaterThan(packageCommand);
    expect(verification).toBeGreaterThan(signingCommand);
    expect(zip).toBeGreaterThan(verification);
    expect(source).toMatch(
      /releaseMode === "build-only" && platform === "mac" && target === "zip" && !signed/,
    );
  });
});
