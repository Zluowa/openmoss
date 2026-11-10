// FILE: agentDesktopInstalls.ts
// Purpose: Finds agents a person installed as desktop apps (Cursor, ZCode, Devin), wherever
//          they installed them, and the command-line part each app ships, if any.
// Layer: Provider runtime discovery (server).
//
// The session importer finds these agents by their data folders; their apps can live anywhere
// (Cursor in D:\tool\cursor, ZCode in D:\ai\ZCode). Like Codex desktop, look in the usual
// install roots (%LOCALAPPDATA%\Programs, Program Files, /Applications); unlike it, also read
// the Windows uninstall entries, which record a custom install folder. Only paths are read.
//
// What each app ships:
// - Devin: the Devin CLI (`resources/app/extensions/windsurf/devin/bin/devin[.exe]`), which
//   joins PATH through the agent CLI floor and reads the app's existing sign-in.
// - ZCode: its GLM CLI (`resources/glm/zcode.cjs`), which the `zcode-acp-server` bridge drives;
//   Moss points the bridge at it with ZCODE_BIN. The bridge itself is a separate npm package.
// - Cursor: no `cursor-agent`; the app's agent runs inside the editor only.

import { execProcessFile } from "@moss/shared/processRuntime";
import { resolveWindowsSystemExecutable } from "@moss/shared/platformEnvironment";
import { access } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { ProviderKind } from "@moss/contracts";

export type DesktopAgentKind = Extract<ProviderKind, "cursor" | "zcode" | "devin">;

export interface AgentDesktopInstall {
  readonly provider: DesktopAgentKind;
  /** The app's install folder (Windows) or `.app` bundle (macOS). */
  readonly appPath: string;
  /** Folder holding the agent CLI the app ships, when it ships one. */
  readonly cliDirectory?: string;
  /** A script the agent's bridge runs (ZCode's `zcode.cjs`). */
  readonly cliScript?: string;
}

interface DesktopAgentDescriptor {
  readonly provider: DesktopAgentKind;
  /** Matches the uninstall entry's DisplayName ("Cursor (User)", "ZCode 3.16.3"). */
  readonly displayName: RegExp;
  readonly windowsExe: string;
  /** Folder names under %LOCALAPPDATA%\Programs and Program Files. */
  readonly windowsFolders: ReadonlyArray<string>;
  readonly macBundles: ReadonlyArray<string>;
  readonly linuxFolders: ReadonlyArray<string>;
  /** Relative to the app's resources folder. */
  readonly cliDirectory?: ReadonlyArray<string>;
  readonly cliExecutable?: string;
  readonly cliScript?: ReadonlyArray<string>;
}

const DESKTOP_AGENTS: ReadonlyArray<DesktopAgentDescriptor> = [
  {
    provider: "cursor",
    displayName: /^cursor\b/iu,
    windowsExe: "Cursor.exe",
    windowsFolders: ["cursor", "Cursor"],
    macBundles: ["Cursor.app"],
    linuxFolders: ["/opt/Cursor", "/usr/share/cursor"],
  },
  {
    provider: "zcode",
    displayName: /^zcode\b/iu,
    windowsExe: "ZCode.exe",
    windowsFolders: ["ZCode"],
    macBundles: ["ZCode.app"],
    linuxFolders: ["/opt/ZCode", "/usr/share/zcode"],
    cliScript: ["glm", "zcode.cjs"],
  },
  {
    provider: "devin",
    displayName: /^devin\b/iu,
    windowsExe: "Devin.exe",
    windowsFolders: ["Devin"],
    macBundles: ["Devin.app"],
    linuxFolders: ["/opt/Devin", "/usr/share/devin"],
    cliDirectory: ["app", "extensions", "windsurf", "devin", "bin"],
    cliExecutable: "devin",
  },
];

/** One entry under a Windows `...\CurrentVersion\Uninstall` key. */
export interface WindowsUninstallEntry {
  readonly displayName?: string;
  readonly installLocation?: string;
  readonly displayIcon?: string;
  readonly uninstallString?: string;
}

const UNINSTALL_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

/** Parses `reg query <Uninstall> /s` output into entries (value names are matched exactly). */
export function parseRegUninstallOutput(output: string): WindowsUninstallEntry[] {
  const entries: WindowsUninstallEntry[] = [];
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (!current) return;
    entries.push({
      ...(current.DisplayName ? { displayName: current.DisplayName } : {}),
      ...(current.InstallLocation ? { installLocation: current.InstallLocation } : {}),
      ...(current.DisplayIcon ? { displayIcon: current.DisplayIcon } : {}),
      ...(current.UninstallString ? { uninstallString: current.UninstallString } : {}),
    });
  };
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("HKEY_")) {
      flush();
      current = {};
      continue;
    }
    const match = /^\s+(\S.*?)\s{4}REG_(?:SZ|EXPAND_SZ)\s{4}(.*)$/u.exec(line);
    if (match && current) current[match[1]!] = match[2]!.trim();
  }
  flush();
  return entries;
}

/** The first path in a registry value: `"D:\x\Uninstall ZCode.exe" /allusers`, `D:\x\a.exe,0`. */
function leadingWindowsPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const quoted = /^"([^"]+)"/u.exec(trimmed);
  const raw = quoted ? quoted[1]! : trimmed.replace(/,\s*-?\d+$/u, "");
  return win32.isAbsolute(raw) ? raw : undefined;
}

/** Install folders an uninstall entry points at, most specific first. */
export function uninstallEntryFolders(entry: WindowsUninstallEntry): string[] {
  const folders = [
    entry.installLocation?.trim().replace(/^"|"$/gu, ""),
    leadingWindowsPath(entry.displayIcon),
    leadingWindowsPath(entry.uninstallString),
  ].flatMap((candidate) => {
    if (!candidate) return [];
    const folder = /\.(?:exe|ico)$/iu.test(candidate) ? win32.dirname(candidate) : candidate;
    return [folder.replace(/[\\/]+$/u, "")];
  });
  return [...new Set(folders)];
}

function readRegistryUninstallEntries(
  env: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<WindowsUninstallEntry[]> {
  return Promise.all(
    UNINSTALL_ROOTS.map(
      (root) =>
        new Promise<WindowsUninstallEntry[]>((resolve) => {
          execProcessFile(
            resolveWindowsSystemExecutable(["System32", "reg.exe"], env),
            ["query", root, "/s"],
            { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => resolve(error ? [] : parseRegUninstallOutput(String(stdout))),
          );
        }),
    ),
  ).then((lists) => lists.flat());
}

export interface FindAgentDesktopInstallsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly pathExists?: (path: string) => boolean | Promise<boolean>;
  readonly readUninstallEntries?: () => Promise<ReadonlyArray<WindowsUninstallEntry>>;
}

type PathExists = (path: string) => Promise<boolean>;

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate that exists, checked in order. */
async function firstExisting(
  candidates: ReadonlyArray<string>,
  pathExists: PathExists,
  probe: (candidate: string) => string = (candidate) => candidate,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(probe(candidate))) return candidate;
  }
  return undefined;
}

function windowsCandidateFolders(
  descriptor: DesktopAgentDescriptor,
  env: NodeJS.ProcessEnv,
  uninstallEntries: ReadonlyArray<WindowsUninstallEntry>,
): string[] {
  const localAppData =
    env.LOCALAPPDATA?.trim() ||
    (env.USERPROFILE?.trim() ? win32.join(env.USERPROFILE.trim(), "AppData", "Local") : undefined);
  const roots = [
    localAppData ? win32.join(localAppData, "Programs") : undefined,
    env.ProgramFiles?.trim(),
    env["ProgramFiles(x86)"]?.trim(),
  ].filter((root): root is string => Boolean(root));
  return [
    ...uninstallEntries
      .filter((entry) => descriptor.displayName.test(entry.displayName?.trim() ?? ""))
      .flatMap(uninstallEntryFolders),
    ...roots.flatMap((root) => descriptor.windowsFolders.map((name) => win32.join(root, name))),
  ];
}

async function describeInstall(
  descriptor: DesktopAgentDescriptor,
  appPath: string,
  resourcesPath: string,
  platform: NodeJS.Platform,
  pathExists: PathExists,
): Promise<AgentDesktopInstall> {
  const join = platform === "win32" ? win32.join : posix.join;
  let cliDirectory: string | undefined;
  if (descriptor.cliDirectory && descriptor.cliExecutable) {
    const directory = join(resourcesPath, ...descriptor.cliDirectory);
    const executable = descriptor.cliExecutable + (platform === "win32" ? ".exe" : "");
    if (await pathExists(join(directory, executable))) cliDirectory = directory;
  }
  let cliScript: string | undefined;
  if (descriptor.cliScript) {
    const script = join(resourcesPath, ...descriptor.cliScript);
    if (await pathExists(script)) cliScript = script;
  }
  return {
    provider: descriptor.provider,
    appPath,
    ...(cliDirectory ? { cliDirectory } : {}),
    ...(cliScript ? { cliScript } : {}),
  };
}

/** Every Cursor / ZCode / Devin desktop app on this computer, with what it ships. */
export async function findAgentDesktopInstalls(
  options: FindAgentDesktopInstallsOptions = {},
): Promise<AgentDesktopInstall[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const injectedPathExists = options.pathExists;
  const pathExists: PathExists = injectedPathExists
    ? async (path) => injectedPathExists(path)
    : defaultPathExists;
  const installs: AgentDesktopInstall[] = [];
  if (platform === "win32") {
    const entries = options.readUninstallEntries
      ? await options.readUninstallEntries()
      : await readRegistryUninstallEntries(env);
    for (const descriptor of DESKTOP_AGENTS) {
      const folder = await firstExisting(
        windowsCandidateFolders(descriptor, env, entries),
        pathExists,
        (candidate) => win32.join(candidate, descriptor.windowsExe),
      );
      if (folder) {
        installs.push(
          await describeInstall(
            descriptor,
            folder,
            win32.join(folder, "resources"),
            platform,
            pathExists,
          ),
        );
      }
    }
    return installs;
  }
  if (platform === "darwin") {
    const home = env.HOME?.trim();
    for (const descriptor of DESKTOP_AGENTS) {
      const bundle = await firstExisting(
        descriptor.macBundles.flatMap((name) => [
          posix.join("/Applications", name),
          ...(home ? [posix.join(home, "Applications", name)] : []),
        ]),
        pathExists,
      );
      if (bundle) {
        installs.push(
          await describeInstall(
            descriptor,
            bundle,
            posix.join(bundle, "Contents", "Resources"),
            platform,
            pathExists,
          ),
        );
      }
    }
    return installs;
  }
  for (const descriptor of DESKTOP_AGENTS) {
    const folder = await firstExisting(descriptor.linuxFolders, pathExists, (candidate) =>
      posix.join(candidate, "resources"),
    );
    if (folder) {
      installs.push(
        await describeInstall(
          descriptor,
          folder,
          posix.join(folder, "resources"),
          platform,
          pathExists,
        ),
      );
    }
  }
  return installs;
}

const DESKTOP_RESCAN_MS = 60_000;
let lastScan: { readonly at: number; readonly installs: ReadonlyArray<AgentDesktopInstall> } = {
  at: 0,
  installs: [],
};
let pendingScan: Promise<ReadonlyArray<AgentDesktopInstall>> | null = null;

/**
 * The desktop apps on this computer, rescanned at most once a minute (an app installed while
 * Moss runs is found on a later check); `force` rescans now.
 */
export async function refreshAgentDesktopInstalls(
  options: { readonly force?: boolean; readonly now?: number } = {},
): Promise<ReadonlyArray<AgentDesktopInstall>> {
  const now = options.now ?? Date.now();
  if (!options.force && lastScan.at > 0 && now - lastScan.at < DESKTOP_RESCAN_MS) {
    return lastScan.installs;
  }
  pendingScan ??= findAgentDesktopInstalls()
    .catch(() => [] as AgentDesktopInstall[])
    .then((installs) => {
      lastScan = { at: Date.now(), installs };
      return installs;
    })
    .finally(() => {
      pendingScan = null;
    });
  return pendingScan;
}

/** The last scan's answer, for synchronous callers (readiness, the ZCode bridge env). */
export function knownAgentDesktopInstall(provider: DesktopAgentKind): AgentDesktopInstall | null {
  return lastScan.installs.find((install) => install.provider === provider) ?? null;
}

/** Test seam: replaces the remembered scan. */
export function setKnownAgentDesktopInstallsForTest(
  installs: ReadonlyArray<AgentDesktopInstall>,
): void {
  lastScan = { at: installs.length > 0 ? Date.now() : 0, installs };
}
