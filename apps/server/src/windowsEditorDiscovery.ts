// FILE: windowsEditorDiscovery.ts
// Purpose: Finds the editors and IDEs installed on Windows the way the system knows them,
//          not only through PATH: their uninstall entries, the URL protocols they register
//          (`vscode://`, `cursor://`), App Paths, and their standard install folders.
// Layer: Server runtime utility
// Exports: discovery for open.ts (availability, launch) and editorAppIcons.ts (icons).
//
// PATH is the weakest signal on Windows: an editor installed per user puts its CLI folder
// in the *user* PATH, which a Moss started from a shortcut, an updater or a test window may
// not have, and many IDEs never touch PATH. The registry is read once in the background
// (one PowerShell run, a few hundred ms) and cached; the install-folder check is synchronous
// and cheap, so an editor is found even before that read finishes.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import pathWin32 from "node:path/win32";

import type { EditorId } from "@moss/contracts";

export interface WindowsEditorApp {
  /** Uninstall entries whose DisplayName matches belong to this editor. */
  readonly displayNames: readonly RegExp[];
  /** The program inside the install folder (relative to it), first existing one wins. */
  readonly exeNames: readonly string[];
  /** Its command-line shim inside the install folder, preferred for launching when present. */
  readonly cliShims?: readonly string[];
  /** Standard install folders (`%LOCALAPPDATA%`, `%ProgramFiles%` are expanded). */
  readonly installDirs?: readonly string[];
  /**
   * Folders whose children are versioned installs of this editor (JetBrains IDEs install
   * to `JetBrains\IntelliJ IDEA 2024.1`); children starting with a prefix are checked.
   */
  readonly installParents?: readonly {
    readonly parent: string;
    readonly prefixes: readonly string[];
  }[];
  /** URL protocol the editor registers, whose open command names its program. */
  readonly uriScheme?: string;
  /** `App Paths` entries naming its program. */
  readonly appPathNames?: readonly string[];
}

const JETBRAINS_PARENTS = (prefixes: readonly string[]) => [
  { parent: "%ProgramFiles%\\JetBrains", prefixes },
  { parent: "%ProgramFiles(x86)%\\JetBrains", prefixes },
  // JetBrains Toolbox 2.x installs here.
  { parent: "%LOCALAPPDATA%\\Programs", prefixes },
  { parent: "%LOCALAPPDATA%\\JetBrains\\Toolbox\\apps", prefixes },
];

const jetbrains = (
  displayName: RegExp,
  exe: string,
  folderPrefixes: readonly string[],
): WindowsEditorApp => ({
  displayNames: [displayName],
  exeNames: [`bin\\${exe}64.exe`, `bin\\${exe}.exe`],
  installParents: JETBRAINS_PARENTS(folderPrefixes),
});

/** How each editor Moss can open is installed on Windows. */
export const WINDOWS_EDITOR_APPS: Partial<Record<EditorId, WindowsEditorApp>> = {
  cursor: {
    displayNames: [/^Cursor(?:\s|\(|$)/i],
    exeNames: ["Cursor.exe"],
    cliShims: ["resources\\app\\bin\\cursor.cmd", "bin\\cursor.cmd"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\cursor", "%ProgramFiles%\\Cursor"],
    uriScheme: "cursor",
  },
  trae: {
    displayNames: [/^Trae(?:\s|\(|$)/i],
    exeNames: ["Trae.exe"],
    cliShims: ["bin\\trae.cmd"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\Trae"],
    uriScheme: "trae",
  },
  vscode: {
    displayNames: [/^Microsoft Visual Studio Code(?! - Insiders)(?:\s|\(|$)/i],
    exeNames: ["Code.exe"],
    cliShims: ["bin\\code.cmd"],
    installDirs: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code",
      "%ProgramFiles%\\Microsoft VS Code",
    ],
    uriScheme: "vscode",
  },
  "vscode-insiders": {
    displayNames: [/^Microsoft Visual Studio Code - Insiders/i],
    exeNames: ["Code - Insiders.exe"],
    cliShims: ["bin\\code-insiders.cmd"],
    installDirs: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders",
      "%ProgramFiles%\\Microsoft VS Code Insiders",
    ],
    uriScheme: "vscode-insiders",
  },
  vscodium: {
    displayNames: [/^VSCodium(?:\s|\(|$)/i],
    exeNames: ["VSCodium.exe"],
    cliShims: ["bin\\codium.cmd"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\VSCodium", "%ProgramFiles%\\VSCodium"],
    uriScheme: "vscodium",
  },
  zed: {
    displayNames: [/^Zed(?:\s|\(|$)/i],
    exeNames: ["Zed.exe", "zed.exe"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\Zed", "%ProgramFiles%\\Zed"],
    uriScheme: "zed",
  },
  windsurf: {
    displayNames: [/^Windsurf(?:\s|\(|$)/i],
    exeNames: ["Windsurf.exe"],
    cliShims: ["bin\\windsurf.cmd"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\Windsurf"],
    uriScheme: "windsurf",
  },
  sublime: {
    displayNames: [/^Sublime Text/i],
    exeNames: ["sublime_text.exe"],
    cliShims: ["subl.exe"],
    installDirs: [
      "%ProgramFiles%\\Sublime Text",
      "%ProgramFiles%\\Sublime Text 4",
      "%ProgramFiles%\\Sublime Text 3",
    ],
    appPathNames: ["sublime_text.exe"],
  },
  antigravity: {
    displayNames: [/^Antigravity(?:\s|\(|$)/i],
    exeNames: ["Antigravity.exe"],
    cliShims: ["bin\\antigravity.cmd"],
    installDirs: ["%LOCALAPPDATA%\\Programs\\Antigravity"],
    uriScheme: "antigravity",
  },
  idea: jetbrains(/^IntelliJ IDEA/i, "idea", ["IntelliJ IDEA"]),
  webstorm: jetbrains(/^WebStorm/i, "webstorm", ["WebStorm"]),
  pycharm: jetbrains(/^PyCharm/i, "pycharm", ["PyCharm"]),
  phpstorm: jetbrains(/^PhpStorm/i, "phpstorm", ["PhpStorm"]),
  goland: jetbrains(/^GoLand/i, "goland", ["GoLand"]),
  clion: jetbrains(/^CLion/i, "clion", ["CLion"]),
  rider: jetbrains(/^(?:JetBrains )?Rider/i, "rider", ["JetBrains Rider", "Rider"]),
  rubymine: jetbrains(/^RubyMine/i, "rubymine", ["RubyMine"]),
  datagrip: jetbrains(/^DataGrip/i, "datagrip", ["DataGrip"]),
  rustrover: jetbrains(/^RustRover/i, "rustrover", ["RustRover"]),
  "android-studio": {
    displayNames: [/^Android Studio/i],
    exeNames: ["bin\\studio64.exe", "bin\\studio.exe"],
    installDirs: [
      "%ProgramFiles%\\Android\\Android Studio",
      "%LOCALAPPDATA%\\Programs\\Android Studio",
    ],
  },
};

/** What the Windows registry says about installed programs, read in one pass. */
export interface WindowsInstalledAppsSnapshot {
  /** Uninstall entries (current user, machine, 32-bit machine). */
  readonly uninstall: readonly {
    readonly name: string;
    readonly location: string;
    readonly icon: string;
  }[];
  /** URL protocol → its `shell\open\command`. */
  readonly protocols: Readonly<Record<string, string>>;
  /** App Paths program name → its path. */
  readonly appPaths: Readonly<Record<string, string>>;
}

export interface WindowsInstalledEditor {
  /** The editor's program (`Code.exe`). */
  readonly exePath: string;
  /** What Moss runs to open something in it: its command-line shim when present, else the program. */
  readonly launchPath: string;
}

export type FileExists = (filePath: string) => boolean;
export type ListDirectory = (dirPath: string) => readonly string[];

const NO_FILES: FileExists = () => false;
const NO_ENTRIES: ListDirectory = () => [];

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  const value = key ? env[key]?.trim() : undefined;
  return value ? value : undefined;
}

// Folders Windows always defines, for a process started without them (some launchers pass
// a trimmed environment): the per-user ones follow from the profile folder.
function windowsFolderFallback(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const profile = readEnv(env, "USERPROFILE");
  switch (name.toUpperCase()) {
    case "LOCALAPPDATA":
      return profile ? pathWin32.join(profile, "AppData", "Local") : undefined;
    case "APPDATA":
      return profile ? pathWin32.join(profile, "AppData", "Roaming") : undefined;
    case "PROGRAMFILES":
      return readEnv(env, "ProgramW6432") ?? "C:\\Program Files";
    case "PROGRAMFILES(X86)":
      return "C:\\Program Files (x86)";
    default:
      return undefined;
  }
}

/** Expands `%NAME%` from `env` (names ignore case); unknown names stay as written. */
export function expandWindowsPath(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /%([^%]+)%/g,
    (whole, name: string) => readEnv(env, name) ?? windowsFolderFallback(name, env) ?? whole,
  );
}

/** The program a registry command or icon value names: `"C:\x\Code.exe" --open-url -- "%1"`. */
export function programFromRegistryCommand(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  // DisplayIcon is often `C:\x\Code.exe,0`.
  const exe = /^(.*?\.exe)\b/i.exec(trimmed)?.[1];
  return exe ?? null;
}

function hasUnexpandedReference(value: string): boolean {
  return /%[^%]+%/.test(value);
}

function installFolderCandidates(
  app: WindowsEditorApp,
  env: NodeJS.ProcessEnv,
  listDirectory: ListDirectory,
): string[] {
  const folders: string[] = [];
  for (const dir of app.installDirs ?? []) {
    const expanded = expandWindowsPath(dir, env);
    if (!hasUnexpandedReference(expanded)) folders.push(expanded);
  }
  for (const { parent, prefixes } of app.installParents ?? []) {
    const expandedParent = expandWindowsPath(parent, env);
    if (hasUnexpandedReference(expandedParent)) continue;
    for (const child of listDirectory(expandedParent)) {
      if (prefixes.some((prefix) => child.toLowerCase().startsWith(prefix.toLowerCase()))) {
        folders.push(pathWin32.join(expandedParent, child));
      }
    }
  }
  return folders;
}

function editorInFolder(
  app: WindowsEditorApp,
  folder: string,
  fileExists: FileExists,
): WindowsInstalledEditor | null {
  // Every candidate is asked about up front (the async discovery records what is asked).
  const firstPresent = (relativePaths: readonly string[]) =>
    relativePaths
      .map((relative) => pathWin32.join(folder, relative))
      .map((candidate) => (fileExists(candidate) ? candidate : null))
      .find((candidate): candidate is string => candidate !== null);
  const exePath = firstPresent(app.exeNames);
  const shim = firstPresent(app.cliShims ?? []);
  return exePath ? { exePath, launchPath: shim ?? exePath } : null;
}

function editorFromProgram(
  app: WindowsEditorApp,
  programPath: string,
  fileExists: FileExists,
): WindowsInstalledEditor | null {
  if (!fileExists(programPath)) return null;
  const programName = pathWin32.basename(programPath).toLowerCase();
  const matchingExe = app.exeNames.find(
    (exeName) => pathWin32.basename(exeName).toLowerCase() === programName,
  );
  if (!matchingExe) return null;
  // `bin\idea64.exe` → the install folder is two levels up.
  const depth = matchingExe.split("\\").length;
  let folder = programPath;
  for (let index = 0; index < depth; index += 1) folder = pathWin32.dirname(folder);
  return (
    editorInFolder(app, folder, fileExists) ?? { exePath: programPath, launchPath: programPath }
  );
}

/**
 * Where `app` is installed, from the registry snapshot (when read) and the standard install
 * folders, or null when it is not installed.
 */
export function findWindowsEditorApp(
  app: WindowsEditorApp,
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly snapshot: WindowsInstalledAppsSnapshot | null;
    readonly fileExists?: FileExists;
    readonly listDirectory?: ListDirectory;
  },
): WindowsInstalledEditor | null {
  const fileExists = input.fileExists ?? NO_FILES;
  const listDirectory = input.listDirectory ?? NO_ENTRIES;
  const snapshot = input.snapshot;
  if (snapshot) {
    for (const entry of snapshot.uninstall) {
      if (!app.displayNames.some((pattern) => pattern.test(entry.name.trim()))) continue;
      if (entry.location.trim()) {
        const found = editorInFolder(
          app,
          expandWindowsPath(entry.location.trim(), input.env),
          fileExists,
        );
        if (found) return found;
      }
      const iconProgram = programFromRegistryCommand(expandWindowsPath(entry.icon, input.env));
      if (iconProgram) {
        const found = editorFromProgram(app, iconProgram, fileExists);
        if (found) return found;
      }
    }
    if (app.uriScheme) {
      const command = snapshot.protocols[app.uriScheme];
      const program = command
        ? programFromRegistryCommand(expandWindowsPath(command, input.env))
        : null;
      if (program) {
        const found = editorFromProgram(app, program, fileExists);
        if (found) return found;
      }
    }
    for (const name of app.appPathNames ?? []) {
      const value = snapshot.appPaths[name];
      const program = value
        ? programFromRegistryCommand(expandWindowsPath(value, input.env))
        : null;
      if (program) {
        const found = editorFromProgram(app, program, fileExists);
        if (found) return found;
      }
    }
  }
  for (const folder of installFolderCandidates(app, input.env, listDirectory)) {
    const found = editorInFolder(app, folder, fileExists);
    if (found) return found;
  }
  return null;
}

// ── Registry snapshot ───────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 5 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * One Windows PowerShell 5.1 run: `ConvertTo-Json` there escapes non-ASCII as `\uXXXX`, so
 * paths under a non-ASCII user folder survive the console code page.
 */
export function windowsInstalledAppsScript(): string {
  const schemes = Object.values(WINDOWS_EDITOR_APPS)
    .map((app) => app?.uriScheme)
    .filter((scheme): scheme is string => Boolean(scheme));
  const appPathNames = Object.values(WINDOWS_EDITOR_APPS).flatMap((app) => app?.appPathNames ?? []);
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "$u=New-Object System.Collections.ArrayList;",
    "foreach($r in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){",
    "foreach($k in (Get-ChildItem -LiteralPath $r)){$p=Get-ItemProperty -LiteralPath $k.PSPath;",
    "if($p.DisplayName){[void]$u.Add([ordered]@{n=[string]$p.DisplayName;l=[string]$p.InstallLocation;i=[string]$p.DisplayIcon})}}};",
    "$s=[ordered]@{};",
    `foreach($n in @(${schemes.map(powerShellQuote).join(",")})){`,
    "$v=(Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$n+'\\shell\\open\\command')).'(default)';if($v){$s[$n]=[string]$v}};",
    "$a=[ordered]@{};",
    `foreach($n in @(${appPathNames.map(powerShellQuote).join(",")})){`,
    "foreach($h in @('HKEY_CURRENT_USER','HKEY_LOCAL_MACHINE')){",
    "$v=(Get-ItemProperty -LiteralPath ('Registry::'+$h+'\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'+$n)).'(default)';if($v){$a[$n]=[string]$v;break}}};",
    "[Console]::Out.Write((@{u=$u;s=$s;a=$a}|ConvertTo-Json -Compress -Depth 4))",
  ].join("");
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0,
    ),
  );
}

export function parseWindowsInstalledAppsOutput(
  output: string,
): WindowsInstalledAppsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { u?: unknown; s?: unknown; a?: unknown };
  // A single uninstall entry is serialized as an object, not a one-item list.
  const rawUninstall = Array.isArray(record.u) ? record.u : record.u ? [record.u] : [];
  const uninstall = rawUninstall.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as { n?: unknown; l?: unknown; i?: unknown };
    const name = textValue(item.n);
    return name ? [{ name, location: textValue(item.l), icon: textValue(item.i) }] : [];
  });
  return { uninstall, protocols: stringRecord(record.s), appPaths: stringRecord(record.a) };
}

function readWindowsInstalledApps(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<WindowsInstalledAppsSnapshot | null> {
  const systemRoot =
    Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows";
  const powershell = pathWin32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve) => {
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", windowsInstalledAppsScript()],
      {
        encoding: "utf8",
        timeout: SNAPSHOT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // The server stopping kills the read (see stopWindowsInstalledAppsDiscovery).
        signal,
      },
      (error, stdout) => resolve(error ? null : parseWindowsInstalledAppsOutput(stdout)),
    );
  });
}

interface DiscoveryState {
  snapshot: WindowsInstalledAppsSnapshot | null;
  /** Where each editor is installed, for the environment in `envKey`. */
  editors: ReadonlyMap<EditorId, WindowsInstalledEditor>;
  envKey: string | null;
  readAt: number;
  pending: Promise<void> | null;
}

let discoveryState: DiscoveryState = {
  snapshot: null,
  editors: new Map(),
  envKey: null,
  readAt: 0,
  pending: null,
};

/** Aborts the background read in flight; replaced once it is used. */
let discoveryAbort = new AbortController();

function discoveryEnvKey(env: NodeJS.ProcessEnv): string {
  return ["USERPROFILE", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"]
    .map((name) => readEnv(env, name) ?? "")
    .join("\u0000");
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function listEntries(dirPath: string): Promise<readonly string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

/**
 * Where every known editor is installed. The file checks run asynchronously: a first dry
 * pass records every path the lookup would look at, those are probed together, and a second
 * pass answers from the results.
 */
export async function discoverWindowsEditors(
  env: NodeJS.ProcessEnv,
  snapshot: WindowsInstalledAppsSnapshot | null,
): Promise<Map<EditorId, WindowsInstalledEditor>> {
  const entries = Object.entries(WINDOWS_EDITOR_APPS) as Array<[EditorId, WindowsEditorApp]>;
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const [, app] of entries) {
    findWindowsEditorApp(app, {
      env,
      snapshot,
      fileExists: (filePath) => {
        files.add(filePath);
        return false;
      },
      listDirectory: (dirPath) => {
        directories.add(dirPath);
        return [];
      },
    });
  }
  const listings = new Map(
    await Promise.all(
      [...directories].map(async (dirPath) => [dirPath, await listEntries(dirPath)] as const),
    ),
  );
  // The listed folders add candidates of their own (versioned JetBrains folders).
  for (const [, app] of entries) {
    findWindowsEditorApp(app, {
      env,
      snapshot,
      fileExists: (filePath) => {
        files.add(filePath);
        return false;
      },
      listDirectory: (dirPath) => listings.get(dirPath) ?? [],
    });
  }
  const existing = new Set(
    (
      await Promise.all(
        [...files].map(async (filePath) =>
          (await isFile(filePath)) ? filePath.toLowerCase() : null,
        ),
      )
    ).filter((filePath): filePath is string => filePath !== null),
  );
  const found = new Map<EditorId, WindowsInstalledEditor>();
  for (const [editorId, app] of entries) {
    const installed = findWindowsEditorApp(app, {
      env,
      snapshot,
      fileExists: (filePath) => existing.has(filePath.toLowerCase()),
      listDirectory: (dirPath) => listings.get(dirPath) ?? [],
    });
    if (installed) found.set(editorId, installed);
  }
  return found;
}

/**
 * Starts (or reuses) a background read of what is installed: the registry snapshot and the
 * install folders. Resolves once it is done, or once `waitMs` passes (answers then come from
 * what is cached).
 */
export function refreshWindowsInstalledApps(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly waitMs?: number;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") return Promise.resolve();
  const env = options.env ?? process.env;
  const envKey = discoveryEnvKey(env);
  const fresh =
    discoveryState.envKey === envKey && Date.now() - discoveryState.readAt < SNAPSHOT_TTL_MS;
  if (!fresh && !discoveryState.pending) {
    const signal = discoveryAbort.signal;
    const pending = (async () => {
      const snapshot = (await readWindowsInstalledApps(env, signal)) ?? discoveryState.snapshot;
      if (signal.aborted) return;
      const editors = await discoverWindowsEditors(env, snapshot).catch(
        () => new Map<EditorId, WindowsInstalledEditor>(),
      );
      if (signal.aborted) return;
      discoveryState = { snapshot, editors, envKey, readAt: Date.now(), pending: null };
    })()
      .catch(() => undefined)
      .finally(() => {
        if (discoveryState.pending === pending)
          discoveryState = { ...discoveryState, pending: null };
      });
    discoveryState = { ...discoveryState, pending };
  }
  const pending = discoveryState.pending;
  if (!pending) return Promise.resolve();
  if (options.waitMs === undefined) return pending;
  // Waiting is bounded; the timer never keeps the process alive and is gone once settled.
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, options.waitMs);
    timer.unref?.();
    void pending.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Stops background discovery: kills a registry read in flight and drops its result. The
 * server calls this when it shuts down, so nothing it started outlives it.
 */
export function stopWindowsInstalledAppsDiscovery(): void {
  discoveryAbort.abort();
  discoveryAbort = new AbortController();
  discoveryState = { ...discoveryState, pending: null };
}

/** Test seam: what discovery found. */
export function setWindowsInstalledEditorsForTest(
  editors: ReadonlyMap<EditorId, WindowsInstalledEditor>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  discoveryState = {
    snapshot: null,
    editors,
    envKey: discoveryEnvKey(env),
    readAt: Date.now(),
    pending: null,
  };
}

/** Where an editor is installed on Windows, as the last background discovery found it. */
export function findInstalledWindowsEditor(
  editorId: EditorId,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): WindowsInstalledEditor | null {
  if (platform !== "win32") return null;
  if (discoveryState.envKey !== discoveryEnvKey(env)) return null;
  return discoveryState.editors.get(editorId) ?? null;
}
