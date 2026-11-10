/**
 * The environment a project's server starts in, and the program it runs.
 *
 * Moss itself may have been started with a thin PATH (a shortcut, an updater, a test
 * window), and a tool the person installed after Moss started is only in the PATH their
 * terminal reads now. A launch run therefore gets the PATH the person's own terminal would
 * have: on Windows the persisted user and machine `Path` from the registry, on macOS and
 * Linux the login shell's, ahead of the one Moss inherited. The program a configuration
 * names (`python`, `npx`, `bun`) is looked up there first, so a missing one is reported in
 * plain words before anything starts, never as a shell's error text.
 *
 * @module launchEnvironment
 */
import { envPathKeyFor, resolveExecutable } from "@moss/shared/executable";
export { commandProgram } from "@moss/shared/launchRunFailure";
import { createCachedLoginShellPathReader } from "@moss/shared/loginShellEnvironment";
import { listLoginShellCandidates, mergePathEntries } from "@moss/shared/shell";
import { readWindowsRegistryString } from "@moss/shared/windowsRegistry";

const PERSON_PATH_CACHE_MS = 30_000;
const WINDOWS_USER_ENVIRONMENT_KEY = "HKCU\\Environment";
const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

export interface PersonPathReaders {
  /** Windows: a `Path` value from the registry (`user` or `machine` scope), unexpanded. */
  readonly readWindowsPath?: (scope: "user" | "machine") => string | null;
  /** macOS/Linux: the login shell's PATH. */
  readonly readLoginShellPath?: (shell: string) => string | undefined;
}

/** Expands `%NAME%` references the way Windows does, from `env` (names ignore case). */
export function expandWindowsEnvironmentReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find(
      (candidate) => candidate.toUpperCase() === name.toUpperCase(),
    );
    const resolved = key ? env[key] : undefined;
    return resolved ?? whole;
  });
}

function readWindowsRegistryPath(scope: "user" | "machine"): string | null {
  return readWindowsRegistryString(
    scope === "user" ? WINDOWS_USER_ENVIRONMENT_KEY : WINDOWS_MACHINE_ENVIRONMENT_KEY,
    "Path",
    { timeoutMs: 2_000 },
  );
}

let cachedLoginShellPathReader: ((shell: string) => string | undefined) | null = null;
function readLoginShellPathCached(shell: string): string | undefined {
  cachedLoginShellPathReader ??= createCachedLoginShellPathReader();
  return cachedLoginShellPathReader(shell);
}

/**
 * The PATH the person's own terminal would start with now, or undefined when it cannot
 * be read. Windows composes it machine first, then user, as a new console does.
 */
export function readPersonPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  readers: PersonPathReaders = {},
): string | undefined {
  if (platform === "win32") {
    const read = readers.readWindowsPath ?? readWindowsRegistryPath;
    const parts = (["machine", "user"] as const)
      .map((scope) => {
        try {
          return read(scope);
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => expandWindowsEnvironmentReferences(value, env));
    return parts.length > 0 ? parts.join(";") : undefined;
  }
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const read = readers.readLoginShellPath ?? readLoginShellPathCached;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      const value = read(shell);
      if (value?.trim()) return value;
    } catch {
      // Try the next shell.
    }
  }
  return undefined;
}

let personPathCache: { readonly at: number; readonly key: string; readonly value?: string } | null =
  null;

function readPersonPathCached(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const key = `${platform}\u0000${env[envPathKeyFor(env, platform)] ?? ""}`;
  const now = Date.now();
  if (
    personPathCache &&
    personPathCache.key === key &&
    now - personPathCache.at < PERSON_PATH_CACHE_MS
  ) {
    return personPathCache.value;
  }
  const value = readPersonPath(platform, env);
  personPathCache = value === undefined ? { at: now, key } : { at: now, key, value };
  return value;
}

/** Test seam: forget the cached PATH. */
export function clearPersonPathCache(): void {
  personPathCache = null;
}

/**
 * Moss's environment with the person's PATH in front of the inherited one. The PATH stays
 * under the key the environment already uses, so Windows never sees two of them.
 */
export function launchEnvironment(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly readers?: PersonPathReaders;
  } = {},
): NodeJS.ProcessEnv {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const pathKey = envPathKeyFor(env, platform);
  const personPath = input.readers
    ? readPersonPath(platform, env, input.readers)
    : readPersonPathCached(platform, env);
  const merged = mergePathEntries(personPath, env[pathKey], platform);
  return merged ? { ...env, [pathKey]: merged } : { ...env };
}

/**
 * Where `program` runs from with `env`, or null when it is not installed there. Programs a
 * shell provides itself (`cd`, `echo`) are not files and always count as found.
 */
export function resolveLaunchProgram(
  program: string,
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly platform?: NodeJS.Platform;
  },
): string | null {
  const platform = input.platform ?? process.platform;
  if (SHELL_BUILTINS.has(program.toLowerCase())) return program;
  return resolveExecutable(program, { env: input.env, cwd: input.cwd, platform });
}

/** A launch run that could not start because its program is not installed. */
export class LaunchProgramNotFoundError extends Error {
  readonly program: string;
  constructor(program: string) {
    super(program);
    this.name = "LaunchProgramNotFoundError";
    this.program = program;
  }
}

const SHELL_BUILTINS = new Set([
  "cd",
  "echo",
  "set",
  "export",
  "source",
  ".",
  "exec",
  "start",
  "call",
]);
