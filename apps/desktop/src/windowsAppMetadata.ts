// FILE: windowsAppMetadata.ts
// Purpose: Resolves human-readable app display names and native system icons for Windows AppSnap
//          windows using PE version metadata, cua-driver list_apps paths, curated names, and
//          Electron file icon extraction with bounded caching.
// Layer: Desktop main-process service

import * as ChildProcess from "node:child_process";
import * as Path from "node:path";
import type { Readable } from "node:stream";

export interface WindowsAppWindowTarget {
  readonly pid: number;
  readonly appName: string | null;
  readonly bundleIdentifier: string | null;
  readonly windowTitle: string | null;
}

export interface WindowsResolvedAppMetadata {
  readonly displayName: string | null;
  readonly iconDataUrl: string | null;
  readonly executablePath?: string | null;
}

export interface WindowsListAppEntry {
  readonly pid: number;
  readonly name?: string | null;
  readonly launchPath?: string | null;
}

export interface WindowsProcessMetadata {
  readonly executablePath: string | null;
  readonly fileDescription: string | null;
  readonly productName: string | null;
}

export interface CreateWindowsAppMetadataResolverOptions {
  readonly listApps?: () => Promise<ReadonlyArray<WindowsListAppEntry>>;
  readonly queryProcessMetadata?: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, WindowsProcessMetadata>>;
  readonly getFileIcon: (executablePath: string) => Promise<string | null>;
  readonly now?: () => number;
}

const LIST_APPS_CACHE_TTL_MS = 15_000;
const PID_CACHE_TTL_MS = 30_000;
const PID_CACHE_LIMIT = 256;
const EXE_CACHE_LIMIT = 128;
const PROCESS_QUERY_TIMEOUT_MS = 2_500;

const GENERIC_VERSION_INFO_NOISE = new Set([
  "microsoft® windows® operating system",
  "microsoft windows operating system",
  "electron",
  "chromium",
  "application frame host",
  "windows command processor",
  "console window host",
  "host process for windows services",
  "host process for windows tasks",
]);

const CURATED_WINDOWS_APP_NAMES: Readonly<Record<string, string>> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  code: "Visual Studio Code",
  "code - insiders": "Visual Studio Code - Insiders",
  antigravity: "Antigravity",
  moss: "Moss",
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  windsurf: "Windsurf",
  windowsterminal: "Windows Terminal",
  wt: "Windows Terminal",
  explorer: "File Explorer",
  notepad: "Notepad",
  wechat: "微信",
  weixin: "微信",
  wechatappex: "微信",
  feishu: "飞书",
  lark: "Lark",
  dingtalk: "钉钉",
  qq: "QQ",
  obsidian: "Obsidian",
  notion: "Notion",
  figma: "Figma",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  spotify: "Spotify",
  pwsh: "PowerShell",
  powershell: "PowerShell",
  cmd: "Command Prompt",
  winword: "Word",
  excel: "Excel",
  powerpnt: "PowerPoint",
  wps: "WPS Office",
  mumuplayer: "MuMu Player",
  mumunxmain: "MuMu Player",
  snippingtool: "Snipping Tool",
  taskmgr: "Task Manager",
  mstsc: "Remote Desktop",
};

function normalizeNonEmpty(value: string | null | undefined, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function extractExecutableStem(raw: string | null | undefined): string | null {
  const value = normalizeNonEmpty(raw);
  if (!value) return null;
  // Handle UWP AUMID such as "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"
  let segment = value;
  const bangIndex = segment.indexOf("!");
  if (bangIndex > 0) {
    segment = segment.slice(0, bangIndex);
  }
  const slashBase = Path.win32.basename(segment);
  const strippedAumid = slashBase.replace(/_[a-z0-9]{8,}$/iu, "");
  const withoutExt = strippedAumid.replace(/\.(?:exe|dll|com|bat|cmd)$/iu, "");
  const clean = withoutExt.trim();
  if (!clean) return null;
  return clean.toLowerCase();
}

export function isGenericWindowsHostExecutable(raw: string | null | undefined): boolean {
  const stem = extractExecutableStem(raw);
  return stem === "applicationframehost";
}

function cleanVersionInfoName(raw: string | null | undefined): string | null {
  const value = normalizeNonEmpty(raw);
  if (!value) return null;
  const cleaned = value
    .replace(/\.(?:exe|com)$/iu, "")
    .replace(/\s+application$/iu, "")
    .trim();
  if (!cleaned) return null;
  if (GENERIC_VERSION_INFO_NOISE.has(cleaned.toLowerCase())) return null;
  if (isGenericWindowsHostExecutable(cleaned)) return null;
  return cleaned;
}

function deriveUwpTitleAppName(windowTitle: string | null | undefined): string | null {
  const trimmed = normalizeNonEmpty(windowTitle, 256);
  if (!trimmed) return null;
  // Strip invisible bidi marks that UWP titles sometimes include around dashes.
  const withoutBidi = trimmed.replace(/[\u200e\u200f]/gu, "").trim();
  if (!withoutBidi) return null;
  const separatorMatch = /\s[-–—]\s([^-\n]+)$/u.exec(withoutBidi);
  if (separatorMatch?.[1]) {
    const trailing = separatorMatch[1].trim();
    if (trailing.length > 0 && trailing.length <= 48 && !isGenericWindowsHostExecutable(trailing)) {
      return trailing;
    }
  }
  return withoutBidi;
}

function isCleanHumanAppName(value: string): boolean {
  if (value.length === 0 || value.length > 120) return false;
  if (/\.(?:exe|dll|com|bat|cmd)$/iu.test(value)) return false;
  if (/[\\/!_]/.test(value)) return false;
  if (/^(?:com|org|net|io|dev|app|ai|cn|microsoft|windows)\.[a-z0-9.-]+$/iu.test(value)) {
    return false;
  }
  // Single lowercase process stem like "chrome" or "msedge" should still resolve to its human name.
  if (/^[a-z0-9-]+$/u.test(value)) return false;
  return true;
}

function lookupCuratedWindowsAppName(candidate: string | null | undefined): string | null {
  const stem = extractExecutableStem(candidate);
  if (!stem) return null;
  if (CURATED_WINDOWS_APP_NAMES[stem]) {
    return CURATED_WINDOWS_APP_NAMES[stem];
  }
  if (stem.includes(".")) {
    const tail = stem.split(".").pop();
    if (tail && CURATED_WINDOWS_APP_NAMES[tail]) {
      return CURATED_WINDOWS_APP_NAMES[tail];
    }
  }
  return null;
}

function splitCamelCaseAndTitle(raw: string): string {
  const spaced = raw
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!spaced) return raw;
  return spaced
    .split(" ")
    .map((word) => {
      if (!word) return word;
      if (/^[A-Z0-9]+$/u.test(word) && word.length <= 4) return word;
      return `${word.charAt(0).toLocaleUpperCase("en-US")}${word.slice(1)}`;
    })
    .join(" ");
}

function sanitizeFallbackAppName(candidate: string): string | null {
  const value = normalizeNonEmpty(candidate);
  if (!value) return null;
  let segment = value;
  const bangIndex = segment.indexOf("!");
  if (bangIndex > 0) {
    segment = segment.slice(0, bangIndex);
  }
  segment = Path.win32.basename(segment);
  segment = segment.replace(/_[a-z0-9]{8,}$/iu, "");
  segment = segment.replace(/\.(?:exe|dll|com|bat|cmd)$/iu, "");
  const dotParts = segment.split(".").filter(Boolean);
  if (dotParts.length > 1) {
    const first = dotParts[0]?.toLowerCase() ?? "";
    if (
      ["microsoft", "windows", "com", "org", "net", "io", "dev", "app", "adobe"].includes(first)
    ) {
      segment = dotParts.slice(1).join(" ");
    } else {
      segment = dotParts.at(-1) ?? segment;
    }
  }
  const formatted = splitCamelCaseAndTitle(segment);
  return formatted.length > 0 && !isGenericWindowsHostExecutable(formatted) ? formatted : null;
}

/**
 * Resolves a human-friendly Windows application name for an AppSnap window or capture,
 * never leaking raw `.exe` filenames, UWP AUMIDs, or `ApplicationFrameHost`.
 */
export function formatWindowsAppDisplayName(input: {
  readonly rawAppName?: string | null;
  readonly fileDescription?: string | null;
  readonly productName?: string | null;
  readonly executablePath?: string | null;
  readonly windowTitle?: string | null;
  readonly bundleIdentifier?: string | null;
}): string | null {
  if (
    isGenericWindowsHostExecutable(input.rawAppName) ||
    isGenericWindowsHostExecutable(input.executablePath) ||
    isGenericWindowsHostExecutable(input.bundleIdentifier)
  ) {
    return deriveUwpTitleAppName(input.windowTitle);
  }

  const cleanedFileDescription = cleanVersionInfoName(input.fileDescription);
  if (cleanedFileDescription) return cleanedFileDescription;
  const cleanedProductName = cleanVersionInfoName(input.productName);
  if (cleanedProductName) return cleanedProductName;

  const trimmedRaw = normalizeNonEmpty(input.rawAppName);
  if (trimmedRaw && isCleanHumanAppName(trimmedRaw)) {
    return trimmedRaw;
  }

  for (const candidate of [input.executablePath, input.rawAppName, input.bundleIdentifier]) {
    const mapped = lookupCuratedWindowsAppName(candidate);
    if (mapped) return mapped;
  }

  if (trimmedRaw) {
    const sanitized = sanitizeFallbackAppName(trimmedRaw);
    if (sanitized) return sanitized;
  }
  for (const candidate of [input.executablePath, input.bundleIdentifier]) {
    const value = normalizeNonEmpty(candidate);
    if (!value) continue;
    const sanitized = sanitizeFallbackAppName(value);
    if (sanitized) return sanitized;
  }

  return null;
}

function isAbsoluteWindowsExePath(raw: string | null | undefined): raw is string {
  const trimmed = normalizeNonEmpty(raw, 4_096);
  if (!trimmed) return false;
  return Path.win32.isAbsolute(trimmed) && /\.exe$/iu.test(trimmed);
}

function defaultWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return Path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildProcessMetadataPowerShellScript(pids: readonly number[]): string {
  const idList = pids.join(",");
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
foreach ($id in @(${idList})) {
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$id)
    $exe = ''
    $desc = ''
    $prod = ''
    try {
      $m = $p.MainModule
      if ($m) {
        if ($m.FileName) { $exe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$m.FileName)) }
        $vi = $m.FileVersionInfo
        if ($vi) {
          if ($vi.FileDescription) { $desc = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$vi.FileDescription)) }
          if ($vi.ProductName) { $prod = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$vi.ProductName)) }
        }
      }
    } catch {}
    [Console]::Out.WriteLine(("{0}\`t{1}\`t{2}\`t{3}" -f $id, $exe, $desc, $prod))
  } catch {}
}
`.trim();
}

function decodeBase64Utf8Field(raw: string | undefined, maxLength: number): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return null;
  }
  try {
    return normalizeNonEmpty(Buffer.from(trimmed, "base64").toString("utf8"), maxLength);
  } catch {
    return null;
  }
}

export async function defaultQueryWindowsProcessMetadata(
  pids: readonly number[],
): Promise<ReadonlyMap<number, WindowsProcessMetadata>> {
  const validPids = [
    ...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fff_ffff)),
  ].slice(0, 48);
  const out = new Map<number, WindowsProcessMetadata>();
  if (validPids.length === 0 || process.platform !== "win32") return out;

  const encoded = Buffer.from(buildProcessMetadataPowerShellScript(validPids), "utf16le").toString(
    "base64",
  );
  const rawOutput = await new Promise<string | null>((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcess.ChildProcessByStdio<null, Readable, null> | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Best-effort cleanup on bounded timeout.
      }
      finish(null);
    }, PROCESS_QUERY_TIMEOUT_MS);
    timer.unref?.();

    try {
      child = ChildProcess.spawn(
        defaultWindowsPowerShellPath(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 256 * 1024) {
          stdout += chunk;
        }
      });
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code === 0 ? stdout : null));
    } catch {
      finish(null);
    }
  });

  if (!rawOutput) return out;
  for (const line of rawOutput.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidRaw, exeB64, descB64, prodB64] = trimmed.split("\t");
    const pid = Number(pidRaw);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    out.set(pid, {
      executablePath: decodeBase64Utf8Field(exeB64, 4_096),
      fileDescription: decodeBase64Utf8Field(descB64, 512),
      productName: decodeBase64Utf8Field(prodB64, 512),
    });
  }
  return out;
}

interface CachedPidRecord {
  readonly rawAppName: string | null;
  readonly executablePath: string | null;
  readonly fileDescription: string | null;
  readonly productName: string | null;
  readonly updatedAt: number;
}

interface CachedExeRecord {
  readonly fileDescription: string | null;
  readonly productName: string | null;
  readonly iconDataUrl: string | null;
}

export function createWindowsAppMetadataResolver(
  options: CreateWindowsAppMetadataResolverOptions,
): (
  targets: readonly WindowsAppWindowTarget[],
) => Promise<ReadonlyMap<number, WindowsResolvedAppMetadata>> {
  const now = options.now ?? Date.now;
  const queryProcessMetadata = options.queryProcessMetadata ?? defaultQueryWindowsProcessMetadata;

  let cachedListApps: {
    readonly byPid: ReadonlyMap<number, { name: string | null; launchPath: string | null }>;
    readonly updatedAt: number;
  } | null = null;
  let inFlightListApps: Promise<
    ReadonlyMap<number, { name: string | null; launchPath: string | null }>
  > | null = null;

  const pidCache = new Map<number, CachedPidRecord>();
  const exeCache = new Map<string, CachedExeRecord>();

  const rememberPid = (pid: number, entry: CachedPidRecord) => {
    if (pidCache.has(pid)) pidCache.delete(pid);
    pidCache.set(pid, entry);
    while (pidCache.size > PID_CACHE_LIMIT) {
      const oldest = pidCache.keys().next().value;
      if (oldest === undefined) break;
      pidCache.delete(oldest);
    }
  };

  const rememberExe = (exeKey: string, entry: CachedExeRecord) => {
    if (exeCache.has(exeKey)) exeCache.delete(exeKey);
    exeCache.set(exeKey, entry);
    while (exeCache.size > EXE_CACHE_LIMIT) {
      const oldest = exeCache.keys().next().value;
      if (oldest === undefined) break;
      exeCache.delete(oldest);
    }
  };

  const readCachedExe = (exeKey: string): CachedExeRecord | undefined => {
    const hit = exeCache.get(exeKey);
    if (!hit) return undefined;
    // Refresh LRU order on read.
    exeCache.delete(exeKey);
    exeCache.set(exeKey, hit);
    return hit;
  };

  const getListAppsMap = async (): Promise<
    ReadonlyMap<number, { name: string | null; launchPath: string | null }>
  > => {
    if (!options.listApps) return new Map();
    const currentMs = now();
    if (cachedListApps && currentMs - cachedListApps.updatedAt < LIST_APPS_CACHE_TTL_MS) {
      return cachedListApps.byPid;
    }
    if (inFlightListApps) return inFlightListApps;
    inFlightListApps = (async () => {
      try {
        const entries = await options.listApps!();
        const byPid = new Map<number, { name: string | null; launchPath: string | null }>();
        for (const entry of entries) {
          if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) continue;
          byPid.set(entry.pid, {
            name: normalizeNonEmpty(entry.name),
            launchPath: normalizeNonEmpty(entry.launchPath, 4_096),
          });
        }
        cachedListApps = { byPid, updatedAt: now() };
        return byPid;
      } catch {
        return cachedListApps?.byPid ?? new Map();
      } finally {
        inFlightListApps = null;
      }
    })();
    return inFlightListApps;
  };

  return async (targets) => {
    const result = new Map<number, WindowsResolvedAppMetadata>();
    if (targets.length === 0) return result;

    const currentMs = now();
    const uniqueTargets = new Map<number, WindowsAppWindowTarget>();
    for (const target of targets) {
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0) continue;
      if (!uniqueTargets.has(target.pid)) {
        uniqueTargets.set(target.pid, target);
      }
    }

    const uncachedTargets: WindowsAppWindowTarget[] = [];
    for (const [pid, target] of uniqueTargets) {
      const cached = pidCache.get(pid);
      const rawName = normalizeNonEmpty(target.appName);
      if (
        cached &&
        currentMs - cached.updatedAt < PID_CACHE_TTL_MS &&
        cached.rawAppName === rawName
      ) {
        continue;
      }
      uncachedTargets.push(target);
    }

    if (uncachedTargets.length > 0) {
      const nonHostPids = uncachedTargets
        .filter(
          (target) =>
            !isGenericWindowsHostExecutable(target.appName) &&
            !isGenericWindowsHostExecutable(target.bundleIdentifier),
        )
        .map((target) => target.pid);

      const [listAppsMap, processMetaMap] = await Promise.all([
        nonHostPids.length > 0 ? getListAppsMap() : Promise.resolve(new Map()),
        nonHostPids.length > 0
          ? queryProcessMetadata(nonHostPids).catch(() => new Map())
          : Promise.resolve(new Map()),
      ]);

      const exeIconRequests = new Map<string, string>();
      const pendingPidInfo = new Map<
        number,
        {
          readonly rawAppName: string | null;
          readonly exePath: string | null;
          readonly fileDescription: string | null;
          readonly productName: string | null;
        }
      >();

      for (const target of uncachedTargets) {
        const procMeta = processMetaMap.get(target.pid);
        const listApp = listAppsMap.get(target.pid);
        const candidatePath =
          procMeta?.executablePath ??
          (isAbsoluteWindowsExePath(listApp?.launchPath) ? listApp.launchPath : null) ??
          (isAbsoluteWindowsExePath(target.bundleIdentifier) ? target.bundleIdentifier : null);
        const exePath =
          candidatePath && !isGenericWindowsHostExecutable(candidatePath) ? candidatePath : null;
        const fileDescription = procMeta?.fileDescription ?? null;
        const productName = procMeta?.productName ?? cleanVersionInfoName(listApp?.name);
        pendingPidInfo.set(target.pid, {
          rawAppName: normalizeNonEmpty(target.appName),
          exePath,
          fileDescription,
          productName,
        });

        if (exePath && isAbsoluteWindowsExePath(exePath)) {
          const exeKey = exePath.toLowerCase();
          if (!readCachedExe(exeKey) && !exeIconRequests.has(exeKey)) {
            exeIconRequests.set(exeKey, exePath);
          }
        }
      }

      if (exeIconRequests.size > 0) {
        await Promise.all(
          [...exeIconRequests.entries()].map(async ([exeKey, exePath]) => {
            let iconDataUrl: string | null = null;
            try {
              iconDataUrl = await options.getFileIcon(exePath);
            } catch {
              iconDataUrl = null;
            }
            const matchingPidInfo = [...pendingPidInfo.values()].find(
              (entry) => entry.exePath?.toLowerCase() === exeKey,
            );
            rememberExe(exeKey, {
              fileDescription: matchingPidInfo?.fileDescription ?? null,
              productName: matchingPidInfo?.productName ?? null,
              iconDataUrl,
            });
          }),
        );
      }

      const settledAt = now();
      for (const [pid, info] of pendingPidInfo) {
        const exeEntry = info.exePath ? readCachedExe(info.exePath.toLowerCase()) : undefined;
        const fileDescription = info.fileDescription ?? exeEntry?.fileDescription ?? null;
        const productName = info.productName ?? exeEntry?.productName ?? null;
        rememberPid(pid, {
          rawAppName: info.rawAppName,
          executablePath: info.exePath,
          fileDescription,
          productName,
          updatedAt: settledAt,
        });
      }
    }

    for (const [pid, target] of uniqueTargets) {
      const pidRecord = pidCache.get(pid);
      const exePath = pidRecord?.executablePath ?? null;
      const exeRecord = exePath ? readCachedExe(exePath.toLowerCase()) : undefined;
      const isHost =
        isGenericWindowsHostExecutable(target.appName) ||
        isGenericWindowsHostExecutable(exePath) ||
        isGenericWindowsHostExecutable(target.bundleIdentifier);
      const displayName = formatWindowsAppDisplayName({
        rawAppName: target.appName,
        fileDescription: pidRecord?.fileDescription ?? exeRecord?.fileDescription ?? null,
        productName: pidRecord?.productName ?? exeRecord?.productName ?? null,
        executablePath: exePath,
        windowTitle: target.windowTitle,
        bundleIdentifier: target.bundleIdentifier,
      });
      result.set(pid, {
        displayName,
        iconDataUrl: isHost ? null : (exeRecord?.iconDataUrl ?? null),
        ...(exePath ? { executablePath: exePath } : {}),
      });
    }

    return result;
  };
}
