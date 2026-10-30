import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_CLAUDE_AGENT_SDK_VERSION,
  BUNDLED_CLAUDE_CODE_VERSION,
  BUNDLED_CLAUDE_EXTRA_RESOURCE,
  BUNDLED_CLAUDE_RUNTIME_DIR,
  assertBundledClaudeFinalArtifactVerificationReceipt,
  assertBundledClaudeReleaseVerificationReceipt,
  createBundledClaudeReleaseVerificationReceipt,
  parseBundledClaudeCodeVersion,
  pruneBundledClaudeNativePackages,
  resolveBundledClaudeProbeExecution,
  resolveBundledClaudeRuntime,
  resolveBundledClaudeTargets,
  verifyFinalBundledClaudeMacRuntime,
  type ResolvedBundledClaudeRuntime,
} from "./bundled-claude-runtime";

const tempDirs = new Set<string>();
type BundledClaudeTarget = ReturnType<typeof resolveBundledClaudeTargets>[number];

function fakeRuntime(
  target: BundledClaudeTarget,
  overrides: Partial<{
    readonly name: string;
    readonly version: string;
    readonly claudeCodeVersion: string;
    readonly os: ReadonlyArray<string>;
    readonly cpu: ReadonlyArray<string>;
  }> = {},
): string {
  const stageAppDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-claude-runtime-test-"));
  tempDirs.add(stageAppDir);
  const packageRoot = Path.join(stageAppDir, "node_modules", ...target.npmPackageName.split("/"));
  FS.mkdirSync(packageRoot, { recursive: true });
  const mainPackageRoot = Path.join(
    stageAppDir,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
  );
  FS.mkdirSync(mainPackageRoot, { recursive: true });
  FS.writeFileSync(
    Path.join(mainPackageRoot, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk",
      version: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
      claudeCodeVersion: overrides.claudeCodeVersion ?? BUNDLED_CLAUDE_CODE_VERSION,
    }),
  );
  FS.writeFileSync(
    Path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: target.npmPackageName,
      version: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
      os: [target.os],
      cpu: [target.cpu],
      ...overrides,
    }),
  );
  const executablePath = Path.join(packageRoot, target.executable);
  FS.writeFileSync(executablePath, "runtime", { mode: 0o755 });
  return stageAppDir;
}

afterEach(() => {
  for (const directory of tempDirs) FS.rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

describe("bundled Claude release runtime", () => {
  it("matches the Claude Agent SDK pinned by the packaged server", () => {
    const serverPackage = JSON.parse(
      FS.readFileSync(Path.resolve(import.meta.dirname, "../../apps/server/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(BUNDLED_CLAUDE_AGENT_SDK_VERSION).toBe("0.3.285");
    expect(BUNDLED_CLAUDE_CODE_VERSION).toBe("2.1.285");
    expect(serverPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBe(
      BUNDLED_CLAUDE_AGENT_SDK_VERSION,
    );
  });

  it("parses and requires the exact packaged Claude Code CLI version", () => {
    expect(parseBundledClaudeCodeVersion("2.1.285 (Claude Code)\n")).toBe(
      BUNDLED_CLAUDE_CODE_VERSION,
    );
    expect(parseBundledClaudeCodeVersion("Claude Code 2.1.230\n")).toBe("2.1.230");
    expect(parseBundledClaudeCodeVersion("Claude Code development build\n")).toBeNull();
  });

  it("maps macOS arm64, macOS x64, and Windows x64 to their pinned native packages", () => {
    expect(resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]).toMatchObject({
      npmPackageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      resourceFolder: "darwin-arm64",
      executable: "claude",
    });
    expect(resolveBundledClaudeTargets({ platform: "mac", arch: "x64" })[0]).toMatchObject({
      npmPackageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
      resourceFolder: "darwin-x64",
      executable: "claude",
    });
    expect(resolveBundledClaudeTargets({ platform: "win", arch: "x64" })[0]).toMatchObject({
      npmPackageName: "@anthropic-ai/claude-agent-sdk-win32-x64",
      resourceFolder: "win32-x64",
      executable: "claude.exe",
    });
  });

  it("stages both native runtimes for universal macOS", () => {
    expect(resolveBundledClaudeTargets({ platform: "mac", arch: "universal" })).toHaveLength(2);
    expect(() => resolveBundledClaudeTargets({ platform: "win", arch: "universal" })).toThrow(
      /unsupported/,
    );
    expect(BUNDLED_CLAUDE_EXTRA_RESOURCE).toEqual({
      from: "apps/desktop/claude-runtime",
      to: "claude-runtime",
    });
  });

  it.runIf(process.platform !== "win32")(
    "revalidates the executable and exact version from an extracted macOS app bundle",
    () => {
      const stageAppDir = fakeRuntime(
        resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]!,
      );
      const resourcesDir = Path.join(stageAppDir, "resources");
      const executablePath = Path.join(resourcesDir, "claude-runtime", "darwin-arm64", "claude");
      FS.mkdirSync(Path.dirname(executablePath), { recursive: true });
      FS.writeFileSync(executablePath, "#!/bin/sh\nprintf '2.1.285 (Claude Code)\\n'\n");
      FS.chmodSync(executablePath, 0o755);

      const verification = verifyFinalBundledClaudeMacRuntime({
        resourcesDir,
        arch: "arm64",
        hostPlatform: "darwin",
        hostArch: "arm64",
      });
      expect(verification).toMatchObject({
        schemaVersion: 1,
        kind: "moss-bundled-claude-final-artifact-verification",
        platform: "mac",
        arch: "arm64",
        targets: [
          {
            resourceFolder: "darwin-arm64",
            relativePath: "claude-runtime/darwin-arm64/claude",
            executableVerified: true,
            method: "direct-exec",
            argv: ["--version"],
            reportedVersion: "2.1.285",
          },
        ],
      });
      expect(
        assertBundledClaudeFinalArtifactVerificationReceipt({
          value: verification,
          expectedArch: "arm64",
        }),
      ).toEqual(verification);
    },
  );

  it("executes host targets directly and uses macOS Rosetta for universal x64 targets", () => {
    const armTarget = resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]!;
    const x64Target = resolveBundledClaudeTargets({ platform: "mac", arch: "x64" })[0]!;

    expect(
      resolveBundledClaudeProbeExecution({
        sourcePath: "/stage/claude-arm64",
        target: armTarget,
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toEqual({
      method: "direct-exec",
      command: "/stage/claude-arm64",
      args: ["--version"],
    });
    expect(
      resolveBundledClaudeProbeExecution({
        sourcePath: "/stage/claude-x64",
        target: x64Target,
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toEqual({
      method: "macos-arch-exec",
      command: "/usr/bin/arch",
      args: ["-x86_64", "/stage/claude-x64", "--version"],
    });
  });

  it("fails closed when a target cannot be executed by this host", () => {
    const target = resolveBundledClaudeTargets({ platform: "win", arch: "x64" })[0]!;

    expect(() =>
      resolveBundledClaudeProbeExecution({
        sourcePath: "C:\\stage\\claude.exe",
        target,
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toThrow(/native target runner evidence is required/);

    if (process.platform === "win32") {
      const macTarget = resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]!;
      expect(() =>
        resolveBundledClaudeProbeExecution({
          sourcePath: Path.join(OS.tmpdir(), "unexecutable-mac-claude"),
          target: macTarget,
          hostPlatform: process.platform,
          hostArch: process.arch,
        }),
      ).toThrow(/native target runner evidence is required/);
    }
  });

  it("accepts a complete pinned runtime for every release target", () => {
    for (const [platform, arch] of [
      ["mac", "arm64"],
      ["mac", "x64"],
      ["win", "x64"],
    ] as const) {
      const target = resolveBundledClaudeTargets({ platform, arch })[0]!;
      const stageAppDir = fakeRuntime(target);
      const runtime = resolveBundledClaudeRuntime({
        stageAppDir,
        target,
        probeExecutableVersion: () => "2.1.285 (Claude Code)",
      });
      expect(runtime.sourcePath).toBe(Path.join(runtime.packageRoot, target.executable));
    }
  });

  it("rejects a runtime with a mismatched version or target", () => {
    const target = resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]!;
    const wrongVersionStage = fakeRuntime(target, { version: "0.0.0" });
    expect(() => resolveBundledClaudeRuntime({ stageAppDir: wrongVersionStage, target })).toThrow(
      /does not match/,
    );

    const wrongCpuStage = fakeRuntime(target, { cpu: ["x64"] });
    expect(() => resolveBundledClaudeRuntime({ stageAppDir: wrongCpuStage, target })).toThrow(
      /does not match/,
    );

    const wrongClaudeCodeVersionStage = fakeRuntime(target, { claudeCodeVersion: "2.1.230" });
    expect(() =>
      resolveBundledClaudeRuntime({
        stageAppDir: wrongClaudeCodeVersionStage,
        target,
      }),
    ).toThrow(/claudeCodeVersion 2\.1\.285/);

    const wrongCliVersionStage = fakeRuntime(target);
    expect(() =>
      resolveBundledClaudeRuntime({
        stageAppDir: wrongCliVersionStage,
        target,
        probeExecutableVersion: () => "2.1.230 (Claude Code)",
      }),
    ).toThrow(/reported 2\.1\.230.*expected 2\.1\.285/);
  });

  it("rejects and then accepts an incorrect non-host CLI fixture", () => {
    const target = resolveBundledClaudeTargets({ platform: "mac", arch: "x64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const probeExecutableVersion = () => "2.1.230 (Claude Code)";

    expect(() =>
      resolveBundledClaudeRuntime({
        stageAppDir,
        target,
        probeExecutableVersion,
      }),
    ).toThrow(/reported 2\.1\.230.*expected 2\.1\.285/);

    const accepted = resolveBundledClaudeRuntime({
      stageAppDir,
      target,
      probeExecutableVersion: () => "2.1.285 (Claude Code)",
    });
    expect(accepted.verification).toEqual({
      method: "injected-test",
      reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
    });
  });

  it("creates release receipt evidence only from real execution probes", () => {
    const target = resolveBundledClaudeTargets({ platform: "mac", arch: "x64" })[0]!;
    const runtime = {
      sourcePath: "/stage/claude-x64",
      packageRoot: "/stage/package",
      target,
      verification: {
        method: "macos-arch-exec" as const,
        reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
      },
    } satisfies ResolvedBundledClaudeRuntime;

    expect(createBundledClaudeReleaseVerificationReceipt([runtime])).toEqual({
      schemaVersion: 1,
      kind: "moss-bundled-claude-runtime-verification",
      agentSdkVersion: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
      codeVersion: BUNDLED_CLAUDE_CODE_VERSION,
      runner: {
        platform: process.platform,
        arch: process.arch,
      },
      targets: [
        {
          resourceFolder: "darwin-x64",
          os: "darwin",
          cpu: "x64",
          executable: "claude",
          method: "macos-arch-exec",
          argv: ["--version"],
          reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
        },
      ],
    });

    expect(() =>
      createBundledClaudeReleaseVerificationReceipt([
        {
          ...runtime,
          verification: {
            method: "injected-test",
            reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
          },
        },
      ]),
    ).toThrow(/cannot use an injected test probe/);
  });

  it("revalidates persisted release evidence against the exact build target", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "moss-bundled-claude-runtime-verification",
      agentSdkVersion: BUNDLED_CLAUDE_AGENT_SDK_VERSION,
      codeVersion: BUNDLED_CLAUDE_CODE_VERSION,
      runner: { platform: "darwin", arch: "arm64" },
      targets: [
        {
          resourceFolder: "darwin-arm64",
          os: "darwin",
          cpu: "arm64",
          executable: "claude",
          method: "direct-exec",
          argv: ["--version"],
          reportedVersion: BUNDLED_CLAUDE_CODE_VERSION,
        },
      ],
    };
    expect(
      assertBundledClaudeReleaseVerificationReceipt({
        value: receipt,
        expectedPlatform: "mac",
        expectedArch: "arm64",
      }),
    ).toEqual(receipt);

    for (const invalid of [
      { ...receipt, codeVersion: "0.0.0" },
      { ...receipt, runner: { platform: "linux", arch: "arm64" } },
      { ...receipt, targets: [{ ...receipt.targets[0], method: "injected-test" }] },
      { ...receipt, targets: [{ ...receipt.targets[0], cpu: "x64" }] },
    ]) {
      expect(() =>
        assertBundledClaudeReleaseVerificationReceipt({
          value: invalid,
          expectedPlatform: "mac",
          expectedArch: "arm64",
        }),
      ).toThrow(/Bundled Claude release verification receipt/);
    }
  });

  it("rejects a runtime missing its native executable", () => {
    const target = resolveBundledClaudeTargets({ platform: "win", arch: "x64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    FS.rmSync(
      Path.join(
        stageAppDir,
        "node_modules",
        ...target.npmPackageName.split("/"),
        target.executable,
      ),
    );
    expect(() => resolveBundledClaudeRuntime({ stageAppDir, target })).toThrow(/missing/);
  });

  it("prunes the build-only native package without deleting copied extraResources", () => {
    const target = resolveBundledClaudeTargets({ platform: "mac", arch: "arm64" })[0]!;
    const stageAppDir = fakeRuntime(target);
    const source = resolveBundledClaudeRuntime({
      stageAppDir,
      target,
      probeExecutableVersion: () => "2.1.285 (Claude Code)",
    }).sourcePath;
    const destination = Path.join(
      stageAppDir,
      BUNDLED_CLAUDE_RUNTIME_DIR,
      target.resourceFolder,
      target.executable,
    );
    FS.mkdirSync(Path.dirname(destination), { recursive: true });
    FS.copyFileSync(source, destination);

    const result = pruneBundledClaudeNativePackages({ stageAppDir });

    expect(result.removedPaths.length).toBeGreaterThan(0);
    expect(FS.existsSync(source)).toBe(false);
    expect(FS.existsSync(destination)).toBe(true);
  });
});
