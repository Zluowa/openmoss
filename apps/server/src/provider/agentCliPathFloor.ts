// FILE: agentCliPathFloor.ts
// Purpose: Finds the agent CLIs a person already installed in the usual places (npm's global
//          folder, Claude's native installer, Cursor's installer, bun, pnpm, Volta, Scoop,
//          Homebrew…) even when Moss started with a short PATH, and appends those folders to
//          the server PATH so every probe and every chat finds the same CLI.
// Layer: Provider runtime discovery (server).
//
// A desktop app does not get the PATH a terminal has: Windows hands GUI processes a stale
// environment block, macOS hands them launchd's. The desktop already merges the persisted
// PATH (Windows registry) or the login shell's PATH (macOS); this is the floor under that.
// Folders are only added when they hold an agent CLI, and always after the person's own
// PATH entries, so nothing a person chose is shadowed.

import { readdir, readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { envPathKeyFor, executableNameCandidates, isExecutableFile } from "@moss/shared/executable";
import { resetLocalAgentPathLookupCache } from "@moss/shared/localAgentExecutable";

import { packageManagerBinaryDirectories } from "./providerBinaryResolution.ts";
import { type AgentDesktopInstall, refreshAgentDesktopInstalls } from "./agentDesktopInstalls.ts";
// Not from providerInstall.ts: that module builds its agent tables from the ACP specs at load,
// and serverSettings -> initialProviderSettings -> this module would close a load-time cycle.
import { appendManagedAgentBinDirectoryToPath } from "./managedAgentPaths.ts";

/** The commands of every agent Moss runs; a folder joins PATH only when it holds one. */
export const AGENT_CLI_COMMANDS = [
  "codex",
  "claude",
  "gemini",
  "opencode",
  "cursor-agent",
  "grok",
  "devin",
  "agy",
  "hermes",
  "omp",
  "pi",
  "kimi",
  "mcode",
  "zcode-acp-server",
] as const;

export interface AgentCliPathFloorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Test seams. */
  readonly listDirectory?: (
    directory: string,
  ) => Promise<ReadonlyArray<string> | null> | ReadonlyArray<string> | null;
  readonly readTextFile?: (filePath: string) => Promise<string | null> | string | null;
  readonly isExecutable?: (filePath: string) => boolean;
}

function homeDirectoryOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  return (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || undefined;
}

async function defaultListDirectory(directory: string): Promise<ReadonlyArray<string> | null> {
  try {
    // A missing folder or a file in its place both answer null.
    return await readdir(directory);
  } catch {
    return null;
  }
}

async function defaultReadTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Expands `${VAR}` and a leading `~` the way npm does in `.npmrc` values. */
function expandNpmrcValue(
  value: string,
  env: NodeJS.ProcessEnv,
  home: string | undefined,
): string | undefined {
  let expanded = value.trim().replace(/^["']|["']$/gu, "");
  expanded = expanded.replace(/\$\{([^}]+)\}/gu, (_whole, name: string) => env[name] ?? "");
  if (home && (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\"))) {
    expanded = `${home}${expanded.slice(1)}`;
  }
  return expanded.length > 0 ? expanded : undefined;
}

/**
 * The `prefix=` the person set in their npm user config, if any. This is where
 * `npm install -g` puts CLIs when they moved npm's global folder (common on machines
 * where the default folder needs admin rights).
 */
export async function readNpmrcGlobalPrefix(
  options: AgentCliPathFloorOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = homeDirectoryOf(env, platform);
  const join = platform === "win32" ? win32.join : posix.join;
  const userConfig =
    (env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG)?.trim() ||
    (home ? join(home, ".npmrc") : undefined);
  if (!userConfig) return undefined;
  const text = await (options.readTextFile ?? defaultReadTextFile)(userConfig);
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*prefix\s*=\s*(.+?)\s*$/u.exec(line);
    if (match?.[1]) return expandNpmrcValue(match[1], env, home);
  }
  return undefined;
}

/** Where npm puts the command shims for a global prefix. */
export function npmGlobalBinDirectory(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? prefix : posix.join(prefix, "bin");
}

/**
 * Reads `npm config get prefix` output: one absolute path, or nothing usable. A
 * relative or multi-line answer (warnings, a broken npm) is ignored.
 */
export function parseNpmPrefixOutput(
  output: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines.at(-1);
  if (!candidate) return undefined;
  const isAbsolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  return isAbsolute(candidate) ? candidate : undefined;
}

/**
 * Folders agent CLIs are installed into on this platform, the agents' own installers
 * first (Claude's native installer, Cursor's, Devin's, OpenCode's), then npm's global
 * folder (environment, `.npmrc`, default), then every other package manager's.
 */
export async function agentCliInstallDirectories(
  options: AgentCliPathFloorOptions = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = homeDirectoryOf(env, platform);
  const directories: string[] = [];
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA?.trim() || (home ? win32.join(home, "AppData", "Local") : undefined);
    if (home) {
      directories.push(
        // Claude's native installer (claude.exe) and uv-installed agents (kimi, hermes).
        win32.join(home, ".local", "bin"),
        win32.join(home, ".opencode", "bin"),
        // Grok Code's Windows installer keeps its CLI here and does not add
        // the folder to the environment inherited by GUI applications.
        win32.join(home, ".grok", "bin"),
      );
    }
    if (localAppData) {
      directories.push(
        win32.join(localAppData, "cursor-agent"),
        win32.join(localAppData, "devin", "cli", "bin"),
        win32.join(localAppData, "Programs", "opencode"),
      );
    }
  } else if (home) {
    directories.push(
      posix.join(home, ".local", "bin"),
      // Claude Code's older per-user install.
      posix.join(home, ".claude", "local"),
      posix.join(home, ".opencode", "bin"),
    );
  }
  const npmrcPrefix = await readNpmrcGlobalPrefix(options);
  if (npmrcPrefix) directories.push(npmGlobalBinDirectory(npmrcPrefix, platform));
  directories.push(...packageManagerBinaryDirectories({ env, platform }));
  return directories;
}

function pathEntries(value: string | undefined, platform: NodeJS.Platform): string[] {
  return (value ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function pathEntryKey(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.toLowerCase().replace(/[\\/]+$/u, "") : entry;
}

/** Whether `directory` holds at least one agent CLI, judged from one directory listing. */
async function directoryHoldsAgentCli(
  directory: string,
  options: AgentCliPathFloorOptions & {
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
  },
): Promise<boolean> {
  const names = await (options.listDirectory ?? defaultListDirectory)(directory);
  if (!names || names.length === 0) return false;
  const windows = options.platform === "win32";
  const present = new Set(names.map((name) => (windows ? name.toLowerCase() : name)));
  const join = windows ? win32.join : posix.join;
  const isExecutable =
    options.isExecutable ??
    ((filePath: string) =>
      isExecutableFile(filePath, { env: options.env, platform: options.platform }));
  for (const command of AGENT_CLI_COMMANDS) {
    for (const candidate of executableNameCandidates(command, options.platform, options.env)) {
      if (!present.has(windows ? candidate.toLowerCase() : candidate)) continue;
      if (isExecutable(join(directory, candidate))) return true;
    }
  }
  return false;
}

/**
 * Appends every folder from `directories` that holds an agent CLI and is not on PATH yet,
 * after the person's own entries and before the `keepLast` entries (the folder Moss
 * installs agents into, so the person's own copy wins). Mutates `env`; returns the
 * folders it added.
 */
export async function appendAgentCliDirectoriesToPath(
  directories: ReadonlyArray<string>,
  options: AgentCliPathFloorOptions & { readonly keepLast?: ReadonlyArray<string> } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathKey = envPathKeyFor(env, platform);
  const onPath = new Set(
    pathEntries(env[pathKey], platform).map((entry) => pathEntryKey(entry, platform)),
  );
  const candidates: string[] = [];
  const candidateKeys = new Set<string>();
  for (const directory of directories) {
    const key = pathEntryKey(directory, platform);
    if (directory.trim().length === 0 || onPath.has(key) || candidateKeys.has(key)) continue;
    candidateKeys.add(key);
    candidates.push(directory);
  }
  const holds = await Promise.all(
    candidates.map((directory) => directoryHoldsAgentCli(directory, { ...options, env, platform })),
  );
  // PATH is read again after the listings: another check may have changed it meanwhile.
  const existing = pathEntries(env[pathKey], platform);
  const seen = new Set(existing.map((entry) => pathEntryKey(entry, platform)));
  const added = candidates.filter(
    (directory, index) => holds[index] === true && !seen.has(pathEntryKey(directory, platform)),
  );
  if (added.length === 0) return added;
  const keepLastKeys = new Set(
    (options.keepLast ?? []).map((entry) => pathEntryKey(entry, platform)),
  );
  const head = existing.filter((entry) => !keepLastKeys.has(pathEntryKey(entry, platform)));
  const tail = existing.filter((entry) => keepLastKeys.has(pathEntryKey(entry, platform)));
  env[pathKey] = [...head, ...added, ...tail].join(platform === "win32" ? ";" : ":");
  return added;
}

/**
 * The PATH floor: every usual install folder that holds an agent CLI joins PATH. Cheap
 * enough to rerun on each provider refresh (one listing per existing folder), so an
 * agent installed while Moss runs is found on the next check.
 */
export async function applyAgentCliPathFloor(
  options: AgentCliPathFloorOptions & { readonly keepLast?: ReadonlyArray<string> } = {},
): Promise<string[]> {
  return appendAgentCliDirectoriesToPath(await agentCliInstallDirectories(options), options);
}

const PATH_FLOOR_RECHECK_MS = 15_000;

interface AgentCliPathRefreshOptions {
  readonly force?: boolean;
  readonly now?: number;
}

/** Share an in-flight scan: a health probe must never overtake PATH discovery. */
export function makeAgentCliPathMaintainer(
  scan: (mossHomeDir: string, options: AgentCliPathRefreshOptions) => Promise<string[]>,
): (mossHomeDir: string, options?: AgentCliPathRefreshOptions) => Promise<string[]> {
  const states = new Map<
    string,
    { checkedAt?: number; pending?: Promise<string[]>; forced?: boolean; forceAfterScan?: boolean }
  >();
  return async (mossHomeDir, options = {}) => {
    const state = states.get(mossHomeDir) ?? {};
    states.set(mossHomeDir, state);
    if (state.pending) {
      // A background scan may already have taken a stale directory snapshot (or
      // reused the desktop-install cache). Re-detect must force a fresh pass.
      if (options.force && !state.forced) state.forceAfterScan = true;
      return state.pending;
    }
    const now = options.now ?? Date.now();
    if (
      !options.force &&
      state.checkedAt !== undefined &&
      now - state.checkedAt < PATH_FLOOR_RECHECK_MS
    ) {
      return [];
    }
    state.forced = options.force === true;
    const pending = Promise.resolve().then(async () => {
      const added: string[] = [];
      let force = options.force === true;
      do {
        force ||= state.forceAfterScan === true;
        state.forceAfterScan = false;
        state.forced = force;
        added.push(...(await scan(mossHomeDir, { ...options, force })));
      } while (state.forceAfterScan);
      return [...new Set(added)];
    });
    state.pending = pending;
    try {
      const added = await pending;
      state.checkedAt = options.now ?? Date.now();
      return added;
    } finally {
      // A failed scan is immediately retryable, including on first launch.
      delete state.pending;
    }
  };
}

const maintainAgentCliPath = makeAgentCliPathMaintainer(async (mossHomeDir, options) => {
  const managedBinDirectory = appendManagedAgentBinDirectoryToPath(mossHomeDir);
  const [installDirectories, desktopInstalls] = await Promise.all([
    agentCliInstallDirectories(),
    refreshAgentDesktopInstalls(options.force ? { force: true } : {}),
  ]);
  const added = await appendAgentCliDirectoriesToPath(
    [...installDirectories, ...desktopAppCliDirectories(desktopInstalls)],
    { keepLast: [managedBinDirectory] },
  );
  // Installing a CLI into a folder already on PATH must also invalidate misses.
  resetLocalAgentPathLookupCache();
  return added;
});

/**
 * The server PATH for agents: the person's own entries, then the usual install folders
 * that hold an agent CLI, then the CLIs desktop apps ship (Devin's), then the folder Moss
 * installs agents into. Rechecked at most every few seconds; `force` rechecks now (startup,
 * a person pressing Re-detect).
 */
export function ensureAgentCliPath(
  mossHomeDir: string,
  options: AgentCliPathRefreshOptions = {},
): Promise<string[]> {
  return maintainAgentCliPath(mossHomeDir, options);
}

/** The agent CLI folders desktop apps ship; installers the person ran themselves come first. */
export function desktopAppCliDirectories(
  installs: ReadonlyArray<Pick<AgentDesktopInstall, "cliDirectory">>,
): string[] {
  return installs.flatMap((install) => (install.cliDirectory ? [install.cliDirectory] : []));
}
