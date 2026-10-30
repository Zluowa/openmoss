import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDirectoryAlias, createRejectedFileAlias } from "../fixtures/filesystem-links.ts";
import { MOSS_BUNDLED_CODEX_VERSION } from "@synara/shared/codexRuntime";

import {
  BUNDLED_CODEX_EXTRA_RESOURCE,
  BUNDLED_CODEX_PACKAGE_NAME,
  BUNDLED_CODEX_RUNTIME_DIR,
  BUNDLED_CODEX_VERSION,
  pruneBundledCodexBuildPackages,
  resolveBundledCodexInstallTarget,
  resolveBundledCodexRuntime,
  resolveBundledCodexStageOptionalDependencies,
  resolveBundledCodexTargets,
  validateBuiltBundledCodexRuntime,
  validatePackagedBundledCodexRuntime,
  validateStagedBundledCodexRuntime,
} from "./bundled-codex-runtime";

const tempDirs = new Set<string>();
type BundledCodexTarget = ReturnType<typeof resolveBundledCodexTargets>[number];

function writeRuntimeManifest(
  sourceDir: string,
  target: BundledCodexTarget,
  overrides: Partial<{
    readonly layoutVersion: number;
    readonly version: string;
    readonly target: string;
    readonly entrypoint: string;
    readonly variant: string;
    readonly resourcesDir: string;
    readonly pathDir: string;
  }> = {},
): void {
  FS.writeFileSync(
    Path.join(sourceDir, "codex-package.json"),
    JSON.stringify({
      layoutVersion: 1,
      version: BUNDLED_CODEX_VERSION,
      target: target.targetTriple,
      entrypoint: `bin/${target.executable}`,
      variant: "codex",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
      ...overrides,
    }),
  );
}

function fakeRuntime(target: BundledCodexTarget): string {
  const stageAppDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-runtime-test-"));
  tempDirs.add(stageAppDir);
  const sourceDir = Path.join(
    stageAppDir,
    "node_modules",
    "@openai",
    target.packageFolder,
    "vendor",
    target.targetTriple,
  );
  FS.mkdirSync(Path.join(sourceDir, "bin"), { recursive: true });
  FS.mkdirSync(Path.join(sourceDir, "codex-path"), { recursive: true });
  FS.mkdirSync(Path.join(sourceDir, "codex-resources"), { recursive: true });
  FS.writeFileSync(Path.join(sourceDir, "bin", target.executable), "runtime");
  FS.writeFileSync(Path.join(sourceDir, "bin", target.codeModeHost), "sidecar");
  FS.writeFileSync(Path.join(sourceDir, "codex-path", target.ripgrep), "rg");
  writeRuntimeManifest(sourceDir, target);
  return stageAppDir;
}

afterEach(() => {
  for (const directory of tempDirs) FS.rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

describe("bundled Codex release runtime", () => {
  it("maps native release targets and universal macOS", () => {
    expect(BUNDLED_CODEX_VERSION).toBe(MOSS_BUNDLED_CODEX_VERSION);
    expect(resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]?.targetTriple).toBe(
      "aarch64-apple-darwin",
    );
    expect(resolveBundledCodexTargets({ platform: "win", arch: "x64" })[0]?.targetTriple).toBe(
      "x86_64-pc-windows-msvc",
    );
    expect(resolveBundledCodexTargets({ platform: "mac", arch: "universal" })).toHaveLength(2);
    expect(() => resolveBundledCodexTargets({ platform: "win", arch: "universal" })).toThrow(
      /unsupported/,
    );
  });

  it("sets Bun optional dependency overrides for the artifact target", () => {
    expect(resolveBundledCodexInstallTarget({ platform: "mac", arch: "arm64" })).toEqual({
      os: "darwin",
      cpu: "arm64",
    });
    expect(resolveBundledCodexInstallTarget({ platform: "win", arch: "x64" })).toEqual({
      os: "win32",
      cpu: "x64",
    });
    expect(resolveBundledCodexInstallTarget({ platform: "mac", arch: "universal" }).cpu).toBe("*");
    expect(BUNDLED_CODEX_EXTRA_RESOURCE).toEqual({
      from: "apps/desktop/codex-runtime",
      to: "codex-runtime",
    });
    expect(
      resolveBundledCodexStageOptionalDependencies({ platform: "mac", arch: "arm64" }),
    ).toEqual({
      "@openai/codex-darwin-arm64": "npm:@openai/codex@0.163.0-darwin-arm64",
    });
    expect(
      resolveBundledCodexStageOptionalDependencies({ platform: "mac", arch: "universal" }),
    ).toEqual({
      "@openai/codex-darwin-arm64": "npm:@openai/codex@0.163.0-darwin-arm64",
      "@openai/codex-darwin-x64": "npm:@openai/codex@0.163.0-darwin-x64",
    });
  });

  it("accepts a complete pinned runtime", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    expect(resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir).toContain(
      target.targetTriple,
    );
    expect(
      validateStagedBundledCodexRuntime({
        nodeModulesDir: Path.join(stageAppDir, "node_modules"),
        platform: "mac",
        arch: "arm64",
      }),
    ).toMatchObject({
      version: MOSS_BUNDLED_CODEX_VERSION,
      targets: [{ packageName: "@openai/codex-darwin-arm64" }],
    });
  });

  it("rejects symlinked runtime files before packaging", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    const executable = Path.join(sourceDir, "bin", target.executable);
    const replacement = `${executable}.real`;
    FS.renameSync(executable, replacement);
    createRejectedFileAlias(replacement, executable);

    expect(() => resolveBundledCodexRuntime({ stageAppDir, target })).toThrow(/plain file/);
  });

  it("validates copied runtimes in the final packaged resources tree", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    const distRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-package-test-"));
    tempDirs.add(distRoot);
    const resourcesDir = Path.join(distRoot, "Moss.app", "Contents", "Resources");
    FS.cpSync(sourceDir, Path.join(resourcesDir, "codex-runtime", target.targetTriple), {
      recursive: true,
    });

    expect(
      validatePackagedBundledCodexRuntime({
        resourcesDir,
        platform: "mac",
        arch: "arm64",
      }),
    ).toMatchObject({ version: MOSS_BUNDLED_CODEX_VERSION });
    expect(
      validateBuiltBundledCodexRuntime({
        stageDistDir: distRoot,
        platform: "mac",
        arch: "arm64",
      }),
    ).toMatchObject({ resourcesDir, version: MOSS_BUNDLED_CODEX_VERSION });
  });

  it("rejects a symlinked copied runtime root", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    const resourcesDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-codex-resources-test-"));
    tempDirs.add(resourcesDir);
    const realRuntimeRoot = Path.join(resourcesDir, "codex-runtime-real");
    FS.cpSync(sourceDir, Path.join(realRuntimeRoot, target.targetTriple), { recursive: true });
    createDirectoryAlias(realRuntimeRoot, Path.join(resourcesDir, "codex-runtime"));

    expect(() =>
      validatePackagedBundledCodexRuntime({
        resourcesDir,
        platform: "mac",
        arch: "arm64",
      }),
    ).toThrow(/codex-runtime must be a plain directory/);
  });

  it("rejects a runtime manifest with the wrong pinned version", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    writeRuntimeManifest(sourceDir, target, { version: "0.0.0" });

    expect(() => resolveBundledCodexRuntime({ stageAppDir, target })).toThrow(/version mismatch/);
  });

  it("rejects a runtime manifest for the wrong target triple", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    writeRuntimeManifest(sourceDir, target, { target: "x86_64-apple-darwin" });

    expect(() => resolveBundledCodexRuntime({ stageAppDir, target })).toThrow(/does not match/);
  });

  it("rejects a runtime missing the code-mode-host sidecar", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    FS.rmSync(Path.join(sourceDir, "bin", target.codeModeHost));

    expect(() => resolveBundledCodexRuntime({ stageAppDir, target })).toThrow(
      /incomplete: missing/,
    );
  });

  it("rejects a runtime missing the ripgrep sidecar", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    FS.rmSync(Path.join(sourceDir, "codex-path", target.ripgrep));

    expect(() => resolveBundledCodexRuntime({ stageAppDir, target })).toThrow(
      /incomplete: missing/,
    );
  });

  it("prunes build-only wrapper and platform packages without deleting copied extraResources", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const sourceDir = resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir;
    const copiedRuntimeDir = Path.join(stageAppDir, BUNDLED_CODEX_RUNTIME_DIR, target.targetTriple);
    FS.mkdirSync(Path.dirname(copiedRuntimeDir), { recursive: true });
    FS.cpSync(sourceDir, copiedRuntimeDir, { recursive: true });

    FS.writeFileSync(
      Path.join(stageAppDir, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: {
          [BUNDLED_CODEX_PACKAGE_NAME]: BUNDLED_CODEX_VERSION,
          "other-runtime": "1.0.0",
        },
        optionalDependencies: {
          [target.packageName]: target.npmAliasSpecifier,
        },
      }),
    );
    const wrapperDir = Path.join(stageAppDir, "node_modules", "@openai", "codex");
    const bunWrapperDir = Path.join(
      stageAppDir,
      "node_modules",
      ".bun",
      `@openai+codex@${BUNDLED_CODEX_VERSION}`,
    );
    const bunPlatformDir = `${bunWrapperDir}-darwin-arm64`;
    const otherCodexVersionDir = Path.join(
      stageAppDir,
      "node_modules",
      ".bun",
      "@openai+codex@0.144.10",
    );
    const codexBin = Path.join(stageAppDir, "node_modules", ".bin", "codex");
    const otherRuntimeMarker = Path.join(
      stageAppDir,
      "node_modules",
      "other-runtime",
      "package.json",
    );
    for (const directory of [
      wrapperDir,
      bunWrapperDir,
      bunPlatformDir,
      otherCodexVersionDir,
      Path.dirname(codexBin),
    ]) {
      FS.mkdirSync(directory, { recursive: true });
    }
    FS.mkdirSync(Path.dirname(otherRuntimeMarker), { recursive: true });
    FS.writeFileSync(Path.join(wrapperDir, "package.json"), "wrapper");
    FS.writeFileSync(Path.join(bunWrapperDir, "package.json"), "bun-wrapper");
    FS.writeFileSync(Path.join(bunPlatformDir, "package.json"), "bun-platform");
    FS.writeFileSync(Path.join(otherCodexVersionDir, "package.json"), "other-codex-version");
    FS.writeFileSync(codexBin, "shim");
    FS.writeFileSync(otherRuntimeMarker, "other-runtime");

    const result = pruneBundledCodexBuildPackages({ stageAppDir });

    expect(result.removedPaths.length).toBeGreaterThanOrEqual(4);
    expect(FS.existsSync(wrapperDir)).toBe(false);
    expect(FS.existsSync(sourceDir)).toBe(false);
    expect(FS.existsSync(bunWrapperDir)).toBe(false);
    expect(FS.existsSync(bunPlatformDir)).toBe(false);
    expect(FS.existsSync(otherCodexVersionDir)).toBe(true);
    expect(FS.existsSync(codexBin)).toBe(false);
    expect(FS.readFileSync(otherRuntimeMarker, "utf8")).toBe("other-runtime");
    expect(FS.readFileSync(Path.join(copiedRuntimeDir, "bin", target.executable), "utf8")).toBe(
      "runtime",
    );

    const stagedPackage = JSON.parse(
      FS.readFileSync(Path.join(stageAppDir, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    expect(stagedPackage.dependencies).toEqual({ "other-runtime": "1.0.0" });
    expect(stagedPackage.optionalDependencies).toEqual({});
  });

  it("refuses to prune Codex packages before the extraResource copy exists", () => {
    const target = resolveBundledCodexTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    FS.writeFileSync(
      Path.join(stageAppDir, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { [BUNDLED_CODEX_PACKAGE_NAME]: BUNDLED_CODEX_VERSION },
        optionalDependencies: {
          [target.packageName]: target.npmAliasSpecifier,
        },
      }),
    );

    expect(() => pruneBundledCodexBuildPackages({ stageAppDir })).toThrow(
      /before its validated runtime has been copied/,
    );
    expect(resolveBundledCodexRuntime({ stageAppDir, target }).sourceDir).toContain(
      target.targetTriple,
    );
  });
});
