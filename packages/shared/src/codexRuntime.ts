// FILE: codexRuntime.ts
// Purpose: Defines the pinned public Codex runtime targets and executable precedence.
// Layer: Shared provider runtime policy

export const MOSS_BUNDLED_CODEX_VERSION = "0.163.0";
export const MOSS_BUNDLED_CODEX_PATH_ENV_KEY = "MOSS_BUNDLED_CODEX_PATH";
export const MOSS_BUNDLED_CODEX_ERROR_ENV_KEY = "MOSS_BUNDLED_CODEX_ERROR";

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

export interface CodexExecutableResolution {
  readonly binaryPath: string;
  readonly source: "configured" | "bundled" | "path";
}

export class BundledCodexRuntimeUnavailableError extends Error {
  readonly code = "bundled-codex-runtime-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "BundledCodexRuntimeUnavailableError";
  }
}

/**
 * Resolves the executable without mutating persisted provider settings.
 *
 * A non-default configured path is user intent and always wins. The literal
 * `codex` (the settings schema default) means "use Moss's best available Codex",
 * so packaged builds can prefer their verified runtime and development/server
 * launches retain the historical PATH fallback.
 */
export function resolveCodexExecutable(input: {
  readonly configuredBinaryPath?: string | null | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): CodexExecutableResolution {
  const configured = input.configuredBinaryPath?.trim() ?? "";
  const bundled = input.env?.[MOSS_BUNDLED_CODEX_PATH_ENV_KEY]?.trim() ?? "";
  if (configured && configured !== "codex" && configured !== bundled) {
    return { binaryPath: configured, source: "configured" };
  }

  if (bundled) {
    return { binaryPath: bundled, source: "bundled" };
  }

  const bundledError = input.env?.[MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]?.trim() ?? "";
  if (bundledError) {
    // A packaged build must never hide a damaged/missing bundled runtime by
    // accidentally discovering some unrelated global Codex on PATH.
    throw new BundledCodexRuntimeUnavailableError(bundledError);
  }

  return { binaryPath: configured || "codex", source: "path" };
}
