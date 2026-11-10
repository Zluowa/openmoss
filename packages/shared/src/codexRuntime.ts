// FILE: codexRuntime.ts
// Purpose: Defines the pinned public Codex runtime targets, version parsing and the
//          damaged-runtime error. Which executable to run lives in codexExecutable.ts.
// Layer: Shared provider runtime policy
//
// Keep this module free of imports. scripts/build-desktop-artifact.ts loads it under plain
// Node, which strips types but cannot resolve the extensionless relative imports the rest of
// this package uses; one such import here breaks every installer build
// (guarded by scripts/lib/plain-node-imports.test.ts).

export const MOSS_BUNDLED_CODEX_VERSION = "0.166.0";
export const MOSS_BUNDLED_CODEX_PATH_ENV_KEY = "MOSS_BUNDLED_CODEX_PATH";
export const MOSS_BUNDLED_CODEX_ERROR_ENV_KEY = "MOSS_BUNDLED_CODEX_ERROR";
/** The reserved Codex account id of Moss's own (managed) Codex. */
export const MOSS_MANAGED_CODEX_ACCOUNT_ID = "moss";

const CODEX_EXECUTABLE_VERSION_PATTERN =
  /(?:^|[^0-9A-Za-z.+-])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.+-])/m;

export function parseCodexExecutableVersion(output: string): string | null {
  return CODEX_EXECUTABLE_VERSION_PATTERN.exec(output)?.[1] ?? null;
}

export function formatBundledCodexExecutableVersionMismatch(reportedVersion: string): string {
  return `Bundled Codex executable version mismatch: Moss expected v${MOSS_BUNDLED_CODEX_VERSION} but the executable reported v${reportedVersion}. Reinstall Moss before using this runtime.`;
}

export interface CodexRuntimeTarget {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packageName: string;
  readonly npmAliasSpecifier: string;
  readonly targetTriple: string;
  readonly executableName: string;
}

const CODEX_RUNTIME_TARGETS = new Map<string, CodexRuntimeTarget>([
  [
    "darwin/arm64",
    {
      platform: "darwin",
      arch: "arm64",
      packageName: "@openai/codex-darwin-arm64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-darwin-arm64`,
      targetTriple: "aarch64-apple-darwin",
      executableName: "codex",
    },
  ],
  [
    "darwin/x64",
    {
      platform: "darwin",
      arch: "x64",
      packageName: "@openai/codex-darwin-x64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-darwin-x64`,
      targetTriple: "x86_64-apple-darwin",
      executableName: "codex",
    },
  ],
  [
    "linux/arm64",
    {
      platform: "linux",
      arch: "arm64",
      packageName: "@openai/codex-linux-arm64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-linux-arm64`,
      targetTriple: "aarch64-unknown-linux-musl",
      executableName: "codex",
    },
  ],
  [
    "linux/x64",
    {
      platform: "linux",
      arch: "x64",
      packageName: "@openai/codex-linux-x64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-linux-x64`,
      targetTriple: "x86_64-unknown-linux-musl",
      executableName: "codex",
    },
  ],
  [
    "win32/arm64",
    {
      platform: "win32",
      arch: "arm64",
      packageName: "@openai/codex-win32-arm64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-win32-arm64`,
      targetTriple: "aarch64-pc-windows-msvc",
      executableName: "codex.exe",
    },
  ],
  [
    "win32/x64",
    {
      platform: "win32",
      arch: "x64",
      packageName: "@openai/codex-win32-x64",
      npmAliasSpecifier: `npm:@openai/codex@${MOSS_BUNDLED_CODEX_VERSION}-win32-x64`,
      targetTriple: "x86_64-pc-windows-msvc",
      executableName: "codex.exe",
    },
  ],
]);

export function resolveCodexRuntimeTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): CodexRuntimeTarget | null {
  return CODEX_RUNTIME_TARGETS.get(`${input.platform}/${input.arch}`) ?? null;
}

export class BundledCodexRuntimeUnavailableError extends Error {
  readonly code = "bundled-codex-runtime-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "BundledCodexRuntimeUnavailableError";
  }
}
