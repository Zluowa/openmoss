// FILE: platformEnvironment.ts
// Purpose: Resolves platform-owned executable locations from an already hydrated environment.
// Layer: Shared platform runtime

import * as Path from "node:path";

function trimNonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Layout of a locally installed app. Its caller validates any environment overrides. */
export function resolveApplicationDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly kind: "desktop-config" | "cli-data";
  readonly name: string;
  readonly xdgName?: string;
  readonly roamingAppData?: string | null | undefined;
  readonly xdgHome?: string | null | undefined;
}): string {
  if (input.platform === "win32") {
    const roaming = input.roamingAppData ?? Path.join(input.homeDir, "AppData", "Roaming");
    return Path.join(roaming, input.name);
  }
  if (input.platform === "darwin" && input.kind === "desktop-config") {
    return Path.join(input.homeDir, "Library", "Application Support", input.name);
  }
  const root =
    input.xdgHome ??
    (input.kind === "desktop-config"
      ? Path.join(input.homeDir, ".config")
      : Path.join(input.homeDir, ".local", "share"));
  return Path.join(root, input.xdgName ?? input.name);
}

export function resolveWindowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmpty(env.SystemRoot) ?? trimNonEmpty(env.SYSTEMROOT) ?? "C:\\Windows";
}

export function resolveWindowsSystemExecutable(
  relativeSegments: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return Path.win32.join(resolveWindowsSystemRoot(env), ...relativeSegments);
}

export function resolveWindowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  return (
    trimNonEmpty(env.ComSpec) ??
    trimNonEmpty(env.COMSPEC) ??
    resolveWindowsSystemExecutable(["System32", "cmd.exe"], env)
  );
}

export function resolveWindowsWslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(["System32", "wsl.exe"], env);
}

export function resolveWindowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    env,
  );
}

/** Terminal capability name used by the embedded renderer and provider login PTYs. */
export function embeddedTerminalName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "xterm-color" : "xterm-256color";
}

/** Keep Windows PowerShell's built-in modules ahead of a parent PowerShell 7 path. */
export function withWindowsPowerShellModules(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const systemModules = resolveWindowsSystemExecutable(
    ["System32", "WindowsPowerShell", "v1.0", "Modules"],
    env,
  );
  const inherited =
    env.PSModulePath?.split(";").filter(
      (entry) => entry.toLowerCase() !== systemModules.toLowerCase(),
    ) ?? [];
  return { ...env, PSModulePath: [systemModules, ...inherited].join(";") };
}

/** Snapshot the configured environment using the operating system's key comparison. */
export function normalizeEnvironmentKeys(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return platform === "win32"
    ? Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]),
      )
    : { ...environment };
}
/** Resolve only a configured home; never fall back to the owner's real profile. */
export function configuredHomeDirectory(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return (
    environment.HOME?.trim() || (platform === "win32" ? environment.USERPROFILE?.trim() : undefined)
  );
}
