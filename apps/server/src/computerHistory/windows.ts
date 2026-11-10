// FILE: windows.ts
// Purpose: Windows foreground-app history with DPAPI-protected local encryption keys.
// Layer: Computer History operating-system adapter
// Exports: makeWindowsHistoryKeyProvider, startWindowsHistoryCollector, parseWindowsHistorySample

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerHistoryKeyProvider } from "./store.ts";

export interface WindowsHistorySample {
  readonly capturedAtMs: number;
  readonly app: { readonly bundleIdentifier: string; readonly name: string };
  readonly window: Record<string, never>;
}

// Unknown Chromium windows are excluded too. Only these desktop applications
// may use Chromium's window class without an unverifiable private-browser mode.
const DESKTOP_CHROMIUM_APPS = new Set(["moss", "codex", "claude", "code", "cursor", "windsurf"]);
const BROWSER_APPS = new Set([
  "chrome",
  "msedge",
  "firefox",
  "brave",
  "opera",
  "opera_gx",
  "vivaldi",
  "iexplore",
  "arc",
  "zen",
  "waterfox",
  "librewolf",
  "chromium",
  "browser",
  "sogouexplorer",
  "360chrome",
  "360se",
  "qqbrowser",
  "safari",
  "thorium",
  "floorp",
]);

export const WINDOWS_HISTORY_BROWSER_CAPABILITIES = [...BROWSER_APPS].map((name) => ({
  bundleIdentifier: `windows.${name}`,
  name,
  status: "unsupported" as const,
  detail: "Windows browser activity is excluded because private browsing cannot be verified.",
}));

export function parseWindowsHistorySample(value: unknown): WindowsHistorySample | null {
  if (!value || typeof value !== "object") return null;
  const sample = value as Record<string, unknown>;
  const processName =
    typeof sample.processName === "string" ? sample.processName.toLowerCase() : "";
  if (!/^[a-z0-9_. -]{1,120}$/u.test(processName) || BROWSER_APPS.has(processName)) return null;
  if (typeof sample.windowClass !== "string" || sample.windowClass.length > 256) return null;
  if (
    /chrome|mozilla|internet explorer|applicationframewindow/iu.test(sample.windowClass) &&
    !DESKTOP_CHROMIUM_APPS.has(processName)
  )
    return null;
  if (!Number.isSafeInteger(sample.capturedAtMs) || (sample.capturedAtMs as number) <= 0)
    return null;
  // No title, URL, OCR, input events or executable path leaves the collector.
  const displayName =
    typeof sample.displayName === "string" ? sample.displayName.trim().slice(0, 120) : "";
  return {
    capturedAtMs: sample.capturedAtMs as number,
    app: { bundleIdentifier: `windows.${processName}`, name: displayName || processName },
    window: {},
  };
}

function powershellScript(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error("Windows could not unlock the local history key."));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($request.data)
$entropy = [Text.Encoding]::UTF8.GetBytes('Moss Computer History v1')
if ($request.action -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

export function makeWindowsHistoryKeyProvider(rootDir: string): ComputerHistoryKeyProvider {
  const path = join(rootDir, "key.dpapi");
  let pending: Promise<Buffer> | undefined;
  const load = async (): Promise<Buffer> => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    let protectedKey: string;
    try {
      protectedKey = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      protectedKey = await powershellScript(
        DPAPI_SCRIPT,
        JSON.stringify({ action: "protect", data: key.toString("base64") }),
      );
      key.fill(0);
      try {
        await writeFile(path, protectedKey, { flag: "wx", mode: 0o600 });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        protectedKey = await readFile(path, "utf8");
      }
    }
    const key = Buffer.from(
      await powershellScript(
        DPAPI_SCRIPT,
        JSON.stringify({ action: "unprotect", data: protectedKey }),
      ),
      "base64",
    );
    if (key.length !== 32) throw new Error("Windows returned an invalid local history key.");
    return key;
  };
  return {
    getOrCreateKey() {
      pending ??= load().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    async destroyKey() {
      const existing = pending;
      pending = undefined;
      if (existing)
        await existing.then(
          (key) => key.fill(0),
          () => undefined,
        );
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

const COLLECTOR_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MossHistoryForeground {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int max);
}
'@
while ($true) {
 try { $null = Get-Process -Id ([int]$env:MOSS_HISTORY_PARENT_PID) -ErrorAction Stop } catch { break }
 try {
  $window = [MossHistoryForeground]::GetForegroundWindow()
  [uint32]$foregroundId = 0
  $null = [MossHistoryForeground]::GetWindowThreadProcessId($window, [ref]$foregroundId)
  $process = Get-Process -Id $foregroundId -ErrorAction Stop
  $class = New-Object Text.StringBuilder(256)
  $null = [MossHistoryForeground]::GetClassName($window, $class, 256)
  $name = $process.ProcessName
  $displayName = $name
  # ProductName is application metadata, never a document/window title.
  try { if ($process.MainModule.FileVersionInfo.ProductName) { $displayName = $process.MainModule.FileVersionInfo.ProductName } } catch {}
  @{processName=$name;displayName=$displayName;windowClass=$class.ToString();capturedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress | Write-Output
 } catch {}
 Start-Sleep -Milliseconds 5000
}
`;

export function startWindowsHistoryCollector(
  onSample: (sample: WindowsHistorySample) => void,
  onFailure: () => void,
): () => Promise<void> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(COLLECTOR_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, MOSS_HISTORY_PARENT_PID: String(process.pid) },
    },
  );
  let stopped = false;
  let pending = "";
  const failed = () => {
    if (!stopped) {
      stopped = true;
      child.kill();
      onFailure();
    }
  };
  child.on("error", failed);
  child.on("exit", failed);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stopped) return;
    pending += chunk;
    if (pending.length > 32_768) {
      failed();
      return;
    }
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const sample = parseWindowsHistorySample(JSON.parse(line));
        if (sample) onSample(sample);
      } catch {
        /* Ignore malformed samples without exposing raw activity. */
      }
    }
  });
  return async () => {
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    await exited;
  };
}
