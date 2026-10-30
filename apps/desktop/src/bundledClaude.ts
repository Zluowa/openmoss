// FILE: bundledClaude.ts
// Purpose: Resolves the native Claude Code executable shipped with packaged Moss.
// Layer: Electron main process helper

import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { probeBundledRuntimeVersion } from "./bundledRuntimeVersion";

export const MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY = "MOSS_BUNDLED_CLAUDE_PATH";
export const MOSS_BUNDLED_CLAUDE_CODE_VERSION = "2.1.285";
const BUNDLED_CLAUDE_VERSION_ARGS = ["--version"] as const;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const verifiedStartupVersions = new Map<string, string>();

export interface BundledClaudeStartupVersionProbeInput {
  readonly sourcePath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export type BundledClaudeStartupVersionProbe = (
  input: BundledClaudeStartupVersionProbeInput,
) => string;

type BundledClaudeRuntimeInput = {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly existsSync?: (path: string) => boolean;
};
const startupVersionKey = (input: BundledClaudeStartupVersionProbeInput) =>
  JSON.stringify([input.sourcePath, input.platform, input.arch]);

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!FS.statSync(path).isFile()) return false;
    if (platform !== "win32") FS.accessSync(path, FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_TARGETS = {
  "darwin-arm64": { resourceFolder: "darwin-arm64", executable: "claude" },
  "darwin-x64": { resourceFolder: "darwin-x64", executable: "claude" },
  "linux-arm64": { resourceFolder: "linux-arm64", executable: "claude" },
  "linux-x64": { resourceFolder: "linux-x64", executable: "claude" },
  "win32-arm64": { resourceFolder: "win32-arm64", executable: "claude.exe" },
  "win32-x64": { resourceFolder: "win32-x64", executable: "claude.exe" },
} as const;

type ClaudePlatform = keyof typeof CLAUDE_TARGETS;

export function bundledClaudeRelativePath(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): string {
  const target = CLAUDE_TARGETS[`${input.platform}-${input.arch}` as ClaudePlatform];
  if (!target) {
    throw new Error(`Packaged Claude is unavailable for ${input.platform}/${input.arch}.`);
  }
  return Path.join("claude-runtime", target.resourceFolder, target.executable);
}

export function parseBundledClaudeCodeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

function probeBundledClaudeStartupVersion(input: BundledClaudeStartupVersionProbeInput): string {
  const result = spawnSync(input.sourcePath, BUNDLED_CLAUDE_VERSION_ARGS, {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  if (result.error) {
    throw new Error(
      `Packaged Claude Code ${input.platform}/${input.arch} --version failed: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Packaged Claude Code ${input.platform}/${input.arch} --version exited with ${String(result.status)}: ${output.trim()}`,
    );
  }
  return output;
}

export function assertBundledClaudeStartupVersion(input: {
  readonly sourcePath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly probeVersion?: BundledClaudeStartupVersionProbe;
}): string {
  const verified = input.probeVersion
    ? null
    : verifiedStartupVersions.get(startupVersionKey(input));
  if (verified) return verified;
  const output = (input.probeVersion ?? probeBundledClaudeStartupVersion)({
    sourcePath: input.sourcePath,
    platform: input.platform,
    arch: input.arch,
  });
  const reportedVersion = parseBundledClaudeCodeVersion(output);
  if (reportedVersion !== MOSS_BUNDLED_CLAUDE_CODE_VERSION) {
    throw new Error(
      `Packaged Claude Code ${input.platform}/${input.arch} --version reported ${reportedVersion ?? "an unparseable version"}; expected ${MOSS_BUNDLED_CLAUDE_CODE_VERSION}.`,
    );
  }
  return reportedVersion;
}

function bundledClaudeCandidate(input: BundledClaudeRuntimeInput): {
  sourcePath: string;
  platform: NodeJS.Platform;
  arch: string;
} | null {
  if (!input.isPackaged) return null;

  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const candidate = Path.join(input.resourcesPath, bundledClaudeRelativePath({ platform, arch }));
  const existsSync = input.existsSync ?? ((path: string) => isExecutableFile(path, platform));
  if (!existsSync(candidate)) {
    throw new Error(
      `Packaged Moss is missing its Claude runtime for ${platform}/${arch}; refusing to start an incomplete build.`,
    );
  }

  return { sourcePath: candidate, platform, arch };
}

/** Warm and validate a cold native runtime without blocking Electron's event loop. */
export async function prepareBundledClaudeStartupVersion(
  input: BundledClaudeRuntimeInput & {
    readonly probeVersionAsync?: (input: BundledClaudeStartupVersionProbeInput) => Promise<string>;
  },
): Promise<void> {
  const candidate = bundledClaudeCandidate(input);
  if (!candidate) return;
  const key = startupVersionKey(candidate);
  if (verifiedStartupVersions.has(key)) return;
  const output = input.probeVersionAsync
    ? await input.probeVersionAsync(candidate)
    : await probeBundledRuntimeVersion(candidate.sourcePath, BUNDLED_CLAUDE_VERSION_ARGS).then(
        (result) => {
          if (!result.ok) {
            throw new Error(
              `Packaged Claude Code ${candidate.platform}/${candidate.arch} startup version preflight failed (${result.reason})`,
            );
          }
          return result.output;
        },
      );
  // Use the same pinned-version validator; never cache a timeout or mismatch.
  const verified = assertBundledClaudeStartupVersion({ ...candidate, probeVersion: () => output });
  verifiedStartupVersions.set(key, verified);
}

export function resolveBundledClaudeBinary(
  input: BundledClaudeRuntimeInput & {
    /** Override the startup probe only for deterministic tests. */
    readonly probeVersion?: BundledClaudeStartupVersionProbe;
  },
): string | null {
  const candidate = bundledClaudeCandidate(input);
  if (!candidate) return null;
  assertBundledClaudeStartupVersion({
    ...candidate,
    ...(input.probeVersion ? { probeVersion: input.probeVersion } : {}),
  });

  return candidate.sourcePath;
}
