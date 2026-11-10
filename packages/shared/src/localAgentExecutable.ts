// FILE: localAgentExecutable.ts
// Purpose: One precedence rule for which agent CLI Moss runs across provider accounts.
// Layer: Shared provider runtime policy
// Depends on: ./executable for PATH lookup.

import { hasPathSeparator, resolveExecutable } from "./executable";
import { posix, win32 } from "node:path";

export type LocalAgentExecutableSource = "configured" | "path" | "bundled";

export interface LocalAgentExecutableResolution {
  readonly binaryPath: string;
  readonly source: LocalAgentExecutableSource;
}

const PATH_LOOKUP_TTL_MS = 5_000;
const pathLookupCache = new Map<
  string,
  { readonly expiresAt: number; readonly path: string | null }
>();

function pathLookupKey(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const pathValue = Object.keys(env)
    .filter((key) => key.toUpperCase() === "PATH")
    .map((key) => env[key] ?? "")
    .join("\u0001");
  const pathExt = platform === "win32" ? (env.PATHEXT ?? env.PathExt ?? "") : "";
  return `${platform}\u0000${command}\u0000${pathValue}\u0000${pathExt}`;
}

/**
 * Whether `command` resolves on PATH. A lookup walks every PATH entry, so the
 * answer is cached briefly per PATH value; an install shows up within seconds.
 */
export function isCommandOnPath(
  command: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform } = {},
): boolean {
  return resolveCommandOnPath(command, options) !== null;
}

function resolveCommandOnPath(
  command: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform } = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const key = pathLookupKey(command, env, platform);
  const now = Date.now();
  const cached = pathLookupCache.get(key);
  if (cached && cached.expiresAt > now) return cached.path;
  const resolved = resolveExecutable(command, { env, platform });
  const executablePath =
    resolved === null ? null : (platform === "win32" ? win32 : posix).resolve(resolved);
  pathLookupCache.set(key, { expiresAt: now + PATH_LOOKUP_TTL_MS, path: executablePath });
  return executablePath;
}

/** Test seam: forget cached PATH lookups. */
export function resetLocalAgentPathLookupCache(): void {
  pathLookupCache.clear();
}

/**
 * Which CLI every Codex or Claude account runs:
 *
 * 1. A path the person configured wins (the bare default command means "not configured";
 *    a configured path equal to the bundled one means "the bundled one").
 * 2. Their own install on PATH wins next, so an agent already on the computer just works
 *    with its own version. Account credentials are selected separately.
 * 3. Otherwise the copy Moss ships, so a fresh computer works without installing anything.
 * 4. With neither, the bare command, which the health check reports as not installed.
 */
export function resolveLocalAgentExecutable(input: {
  readonly command: string;
  readonly configuredBinaryPath?: string | null | undefined;
  readonly bundledBinaryPath?: string | null | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Test seam for the PATH lookup. */
  readonly isOnPath?: ((command: string) => boolean) | undefined;
}): LocalAgentExecutableResolution & { readonly bundledAvailable: boolean } {
  const configured = input.configuredBinaryPath?.trim() ?? "";
  const bundled = input.bundledBinaryPath?.trim() ?? "";
  const bundledAvailable = bundled.length > 0;
  if (configured && configured !== input.command && configured !== bundled) {
    // Resolve relative paths/commands in the server environment, before an
    // account's private HOME/PATH is applied to the subprocess.
    const platform = input.platform ?? process.platform;
    const pathModule = platform === "win32" ? win32 : posix;
    const resolved = resolveExecutable(configured, {
      ...(input.env ? { env: input.env } : {}),
      platform,
    });
    const binaryPath =
      resolved !== null
        ? pathModule.resolve(resolved)
        : hasPathSeparator(configured) && !pathModule.isAbsolute(configured)
          ? pathModule.resolve(configured)
          : configured;
    return { binaryPath, source: "configured", bundledAvailable };
  }
  const explicitlyBundled = bundledAvailable && configured === bundled;
  if (!explicitlyBundled) {
    const executablePath = input.isOnPath
      ? !bundledAvailable || input.isOnPath(input.command)
        ? input.command
        : null
      : resolveCommandOnPath(input.command, {
          ...(input.env ? { env: input.env } : {}),
          ...(input.platform ? { platform: input.platform } : {}),
        });
    if (!bundledAvailable || executablePath) {
      return { binaryPath: executablePath ?? input.command, source: "path", bundledAvailable };
    }
  }
  return { binaryPath: bundled, source: "bundled", bundledAvailable };
}
