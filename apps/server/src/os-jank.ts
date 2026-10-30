// FILE: os-jank.ts
// Purpose: Smooths over shell/path differences between packaged app launches and login shells.
// Exports: PATH hydration (Windows: provider homes from the user environment) plus
//   base-dir helpers used by server startup.

import { execFileSync } from "node:child_process";

import { Effect } from "effect";
import {
  isShellEnvironmentHydrated,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readPathFromLoginShell,
} from "@synara/shared/shell";
import { createCachedLoginShellPathReader } from "@synara/shared/loginShellEnvironment";
import {
  expandHomePath as expandHomePathSync,
  resolveMossHomeDirectory,
} from "@synara/shared/mossHome";

function logPathHydrationWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

/**
 * Provider homes the user configures as Windows user environment variables.
 * A process started from a terminal that predates the setting (or from an
 * agent sandbox) misses them, and Moss would then import the stale default
 * home instead of the account the user's own CLI and desktop apps use.
 */
const WINDOWS_USER_ENVIRONMENT_KEYS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

function readWindowsUserEnvironment(): string {
  return execFileSync("reg.exe", ["query", "HKCU\\Environment"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
}

const WINDOWS_REG_VALUE_LINE = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/;

export function parseWindowsUserEnvironment(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = WINDOWS_REG_VALUE_LINE.exec(line);
    if (match?.[1] && match[3]?.trim()) values.set(match[1].toUpperCase(), match[3].trim());
  }
  return values;
}

function expandWindowsEnvironmentReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find(
      (candidate) => candidate.toUpperCase() === name.toUpperCase(),
    );
    return key ? (env[key] ?? whole) : whole;
  });
}

export function hydrateWindowsUserEnvironment(
  options: {
    env?: NodeJS.ProcessEnv;
    readUserEnvironment?: () => string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const env = options.env ?? process.env;
  const missing = WINDOWS_USER_ENVIRONMENT_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length === 0) return;
  let values: Map<string, string>;
  try {
    values = parseWindowsUserEnvironment(
      (options.readUserEnvironment ?? readWindowsUserEnvironment)(),
    );
  } catch (error) {
    (options.logWarning ?? logPathHydrationWarning)(
      "Failed to read the Windows user environment.",
      error,
    );
    return;
  }
  for (const key of missing) {
    const value = values.get(key);
    if (value) env[key] = expandWindowsEnvironmentReferences(value, env);
  }
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    readWindowsUserEnvironment?: () => string;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    hydrateWindowsUserEnvironment({
      ...(options.env ? { env: options.env } : {}),
      ...(options.readWindowsUserEnvironment
        ? { readUserEnvironment: options.readWindowsUserEnvironment }
        : {}),
      ...(options.logWarning ? { logWarning: options.logWarning } : {}),
    });
    return;
  }
  if (platform !== "darwin" && platform !== "linux") return;

  const env = options.env ?? process.env;

  // Startup blocks here: the server does not begin listening until the probe returns,
  // and `-ilc` sources the user's whole interactive rc (~1s). When the desktop shell
  // already ran it and handed us the resulting PATH, repeating it buys nothing and
  // doubles cold start. The marker — not merely a populated PATH — is what proves it.
  if (isShellEnvironmentHydrated(env)) return;

  const logWarning = options.logWarning ?? logPathHydrationWarning;

  try {
    // launchctl stays a last resort, never a fast path: `launchctl getenv PATH` is a
    // launchd-session value that something published once (often a login-item plist with a
    // hardcoded string), so it can be arbitrarily stale, while the login-shell probe is the
    // PATH the user actually has in their terminal. With the probe cached below, preferring
    // launchctl would trade a sub-millisecond file read for a wrong PATH — and a spawn.
    const readLaunchctlFallbackPath = (): string | undefined =>
      platform === "darwin" ? (options.readLaunchctlPath ?? readPathFromLaunchctl)() : undefined;

    // Cached by default: the probe result is persisted under the Moss home and reused
    // until the shell, the user, or any of its startup files changes.
    const readPath = options.readPath ?? createCachedLoginShellPathReader({ env, platform });

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        shellPath = readPath(shell);
      } catch (error) {
        logWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) {
        break;
      }
    }

    const mergedPath = mergePathEntries(
      shellPath || readLaunchctlFallbackPath(),
      env.PATH,
      platform,
    );
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = (input: string): Effect.Effect<string> =>
  Effect.succeed(expandHomePathSync(input));

export const resolveBaseDir = (raw: string | undefined): Effect.Effect<string> =>
  Effect.succeed(resolveMossHomeDirectory({ configuredHome: raw }));
