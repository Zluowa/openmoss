// FILE: providerBinaryResolution.ts
// Purpose: Resolves provider CLI binaries from PATH and vendor-owned install folders.
// Layer: Server provider runtime

import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";

import {
  envPathKeyFor,
  executableCandidates,
  executableNameCandidates,
  isExecutableFile,
} from "@moss/shared/executable";

import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";

export interface ProviderBinaryResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (path: string) => boolean;
  readonly isExecutable?: (path: string) => boolean;
}

interface ResolvedProviderBinaryResolutionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pathExists: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
}

function resolveOptions(
  options: ProviderBinaryResolutionOptions,
): ResolvedProviderBinaryResolutionOptions {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    pathExists: options.pathExists ?? existsSync,
    isExecutable:
      options.isExecutable ??
      ((path) => isExecutableFile(path, { env: options.env, platform: options.platform })),
  };
}

export function commandExistsOnPath(
  command: string,
  options: ProviderBinaryResolutionOptions = {},
): boolean {
  const resolved = resolveOptions(options);
  // PATH presence alone does not prove that a CLI can be spawned: directories
  // and POSIX files without execute permission must not pass discovery.
  // Preserve the existing pathExists seam for callers with synthetic test FS.
  const canExecute =
    options.isExecutable ?? (options.pathExists ? resolved.pathExists : resolved.isExecutable);
  for (const candidate of executableCandidates(command, resolved)) {
    if (canExecute(candidate.path)) return true;
  }
  return false;
}

/** First of `paths` that exists, for a CLI's own files that are not executables on this host. */
export function firstExistingPath(
  paths: ReadonlyArray<string>,
  options: ProviderBinaryResolutionOptions = {},
): string | undefined {
  const { pathExists } = resolveOptions(options);
  return paths.find((path) => pathExists(path));
}

export function resolveWindowsLocalAppDataBinary(
  relativeCandidates: ReadonlyArray<ReadonlyArray<string>>,
  options: ProviderBinaryResolutionOptions = {},
): string | undefined {
  const resolved = resolveOptions(options);
  if (resolved.platform !== "win32") return undefined;

  const localAppData =
    resolved.env.LOCALAPPDATA?.trim() ||
    (resolved.env.USERPROFILE?.trim()
      ? win32.join(resolved.env.USERPROFILE.trim(), "AppData", "Local")
      : undefined);
  if (!localAppData) return undefined;

  const canExecute =
    options.isExecutable ?? (options.pathExists ? resolved.pathExists : resolved.isExecutable);
  for (const relativePath of relativeCandidates) {
    const candidate = win32.join(localAppData, ...relativePath);
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
}

function posixPackageManagerBinaryDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = env.HOME?.trim();
  const directories: string[] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/local/bin",
  ];
  if (home) {
    directories.push(
      posix.join(home, ".bun", "bin"),
      posix.join(home, ".local", "bin"),
      posix.join(home, "bin"),
      posix.join(home, ".npm-global", "bin"),
      posix.join(home, ".volta", "bin"),
      posix.join(home, ".asdf", "shims"),
      posix.join(home, ".local", "share", "mise", "shims"),
      posix.join(home, ".proto", "shims"),
      posix.join(home, ".deno", "bin"),
      // pnpm's default global bin differs per OS; nonexistence filters out.
      posix.join(home, ".local", "share", "pnpm"),
      posix.join(home, "Library", "pnpm"),
      posix.join(home, ".yarn", "bin"),
    );
    try {
      for (const versionDir of readdirSync(posix.join(home, ".nvm", "versions", "node"), {
        withFileTypes: true,
      })) {
        if (versionDir.isDirectory()) {
          directories.push(posix.join(home, ".nvm", "versions", "node", versionDir.name, "bin"));
        }
      }
    } catch {
      // nvm not installed; nothing to add.
    }
    for (const fnmRoot of [
      posix.join(home, "Library", "Application Support", "fnm", "node-versions"),
      posix.join(home, ".local", "share", "fnm", "node-versions"),
    ]) {
      try {
        for (const versionDir of readdirSync(fnmRoot, { withFileTypes: true })) {
          if (versionDir.isDirectory()) {
            directories.push(posix.join(fnmRoot, versionDir.name, "installation", "bin"));
          }
        }
      } catch {
        // fnm not installed; nothing to add.
      }
    }
  }
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) directories.push(pnpmHome);
  const npmPrefix = (env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX)?.trim();
  if (npmPrefix) directories.push(posix.join(npmPrefix, "bin"));
  const bunInstall = env.BUN_INSTALL?.trim();
  if (bunInstall) directories.push(posix.join(bunInstall, "bin"));
  const voltaHome = env.VOLTA_HOME?.trim();
  if (voltaHome) directories.push(posix.join(voltaHome, "bin"));
  return directories;
}

function windowsPackageManagerBinaryDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const userProfile = env.USERPROFILE?.trim();
  const localAppData =
    env.LOCALAPPDATA?.trim() ||
    (userProfile ? win32.join(userProfile, "AppData", "Local") : undefined);
  const roamingAppData =
    env.APPDATA?.trim() ||
    (userProfile ? win32.join(userProfile, "AppData", "Roaming") : undefined);
  const directories: string[] = [];
  if (userProfile) {
    directories.push(
      win32.join(userProfile, ".bun", "bin"),
      win32.join(userProfile, "scoop", "shims"),
      win32.join(userProfile, ".local", "bin"),
      win32.join(userProfile, ".volta", "bin"),
    );
  }
  if (localAppData) {
    directories.push(
      win32.join(localAppData, "pnpm"),
      win32.join(localAppData, "mise", "shims"),
      win32.join(localAppData, "Yarn", "bin"),
    );
  }
  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) directories.push(pnpmHome);
  if (roamingAppData) {
    directories.push(win32.join(roamingAppData, "npm"));
  }
  const chocolateyInstall = env.ChocolateyInstall?.trim();
  if (chocolateyInstall) {
    directories.push(win32.join(chocolateyInstall, "bin"));
  } else {
    directories.push(win32.join("C:\\", "ProgramData", "chocolatey", "bin"));
  }
  // A custom npm global prefix is its own bin folder on Windows.
  const npmPrefix = (env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX)?.trim();
  if (npmPrefix) directories.push(npmPrefix);
  const bunInstall = env.BUN_INSTALL?.trim();
  if (bunInstall) directories.push(win32.join(bunInstall, "bin"));
  const voltaHome = env.VOLTA_HOME?.trim();
  if (voltaHome) directories.push(win32.join(voltaHome, "bin"));
  if (localAppData) directories.push(win32.join(localAppData, "Volta", "bin"));
  const scoop = env.SCOOP?.trim();
  if (scoop) directories.push(win32.join(scoop, "shims"));
  // nvm-windows keeps the active Node, and the CLIs installed with it, behind this link.
  const nvmSymlink = env.NVM_SYMLINK?.trim();
  if (nvmSymlink) directories.push(nvmSymlink);
  return directories;
}

/**
 * Every package manager's global bin folder for this platform (npm, pnpm, bun, Volta,
 * Scoop, Homebrew, version managers). Most will not exist; callers filter.
 */
export function packageManagerBinaryDirectories(
  options: ProviderBinaryResolutionOptions = {},
): ReadonlyArray<string> {
  const resolved = resolveOptions(options);
  return resolved.platform === "win32"
    ? windowsPackageManagerBinaryDirectories(resolved.env)
    : posixPackageManagerBinaryDirectories(resolved.env);
}

/**
 * Directories the `opencode` CLI can be installed into: the installer's own
 * `~/.opencode/bin`-style location first, then every package-manager global
 * bin dir. GUI-launched processes often inherit a minimal PATH that misses
 * all of them even though the CLI is installed.
 */
export function openCodeBinarySearchDirectories(
  options: ProviderBinaryResolutionOptions = {},
): ReadonlyArray<string> {
  const resolved = resolveOptions(options);
  const env = resolved.env;
  // Version-manager directories can appear after installation without an
  // environment change. Refresh them so health checks and launches see new CLIs.
  const installerDirs: string[] = [];
  if (resolved.platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    const localAppData =
      env.LOCALAPPDATA?.trim() ||
      (userProfile ? win32.join(userProfile, "AppData", "Local") : undefined);
    if (userProfile) installerDirs.push(win32.join(userProfile, ".opencode", "bin"));
    if (localAppData) installerDirs.push(win32.join(localAppData, "Programs", "opencode"));
    installerDirs.push(...windowsPackageManagerBinaryDirectories(env));
  } else {
    const home = env.HOME?.trim();
    if (home) installerDirs.push(posix.join(home, ".opencode", "bin"));
    installerDirs.push(...posixPackageManagerBinaryDirectories(env));
  }
  return installerDirs;
}

export function buildOpenCodeServerProcessEnv(input: {
  readonly experimentalWebSockets?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly inheritedMossKeys?: ReadonlyArray<string>;
}): NodeJS.ProcessEnv {
  const env = buildProviderChildEnvironment({
    provider: "opencode",
    baseEnv: input.baseEnv ?? process.env,
    ...(input.inheritedMossKeys ? { inheritedMossKeys: input.inheritedMossKeys } : {}),
    overrides: input.experimentalWebSockets ? { OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true" } : {},
  });
  // Keep PATH lean: only dirs that actually contain the CLI binary qualify as
  // fallbacks, so unrelated package-manager bins never shadow tools.
  const searchDirectories = directoriesContainingCommand(
    "opencode",
    openCodeBinarySearchDirectories({ env }),
    { env },
  );
  return appendDirectoriesToPathEnv(env, searchDirectories, { env });
}

/**
 * Filters `directories` down to those containing a `command` executable, using
 * the platform's executable name candidates (`.exe`/`.cmd` on Windows).
 */
export function directoriesContainingCommand(
  command: string,
  directories: ReadonlyArray<string>,
  options: ProviderBinaryResolutionOptions = {},
): string[] {
  const resolved = resolveOptions(options);
  const joinPath = resolved.platform === "win32" ? win32.join : posix.join;
  return directories.filter((directory) =>
    executableNameCandidates(command, resolved.platform, resolved.env).some((name) =>
      resolved.isExecutable(joinPath(directory, name)),
    ),
  );
}

/**
 * Returns `env` with each existing directory appended to PATH (deduplicated,
 * preserving the user's own PATH precedence order). Nonexistent entries are
 * dropped so PATH stays clean.
 */
export function appendDirectoriesToPathEnv(
  env: NodeJS.ProcessEnv,
  directories: ReadonlyArray<string>,
  options: ProviderBinaryResolutionOptions = {},
): NodeJS.ProcessEnv {
  const resolved = resolveOptions({ ...options, env });
  const platform = resolved.platform;
  const separator = platform === "win32" ? ";" : ":";
  const pathKey = envPathKeyFor(resolved.env, platform);
  const existing = (resolved.env[pathKey] ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set(
    existing.map((entry) => (platform === "win32" ? entry.toLowerCase() : entry)),
  );
  const appended = directories.filter((directory) => {
    if (directory.trim().length === 0) return false;
    const key = platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key) || !resolved.pathExists(directory)) return false;
    seen.add(key);
    return true;
  });
  if (appended.length === 0) return resolved.env;
  return { ...resolved.env, [pathKey]: [...existing, ...appended].join(separator) };
}
