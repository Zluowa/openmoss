// FILE: window.ts
// Purpose: Keep every window of this run's Moss off the owner's screen (RULES.md has no exception for
//          kits). Electron's DevTools protocol cannot move a window and window.moveTo is ignored, so
//          this uses Win32, like the lead's launch-iso.mjs: a PowerShell mover started BEFORE the app,
//          given the app's PID, that moves every visible top-level window of that PID and its
//          descendants left of the whole virtual screen, every 0.2 s for the first minute (a new window is moved before anyone notices it), every 1.2 s
//          to ten minutes and every 5 s after,
//          for as long as the process lives (a first start shows a progress window and opens the main
//          window later). It moves without resizing, so the screenshot tool's own resize is not undone.
//          `windowsOnScreen` checks that no window of the run intersects any display.
// Layer: tools/accept (Windows only; elsewhere these are no-ops until the macOS path exists)

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN32 = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MossW {
  public delegate bool E(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
}
'@
# A process belongs to the run only if it started at or after its parent and the root: a recorded
# parent PID is not proof of descent on Windows (PIDs are reused, and a program keeps the PID of a
# parent that has exited), so a program of the owner's that names a reused PID is never moved.
function Get-RunIdsFrom($all, [int]$root) {
  $born = @{}
  foreach ($p in $all) { $born[[int]$p.ProcessId] = [datetime]$p.CreationDate }
  $ids = New-Object System.Collections.Generic.HashSet[int]
  if (-not $born.ContainsKey($root)) { return ,$ids }
  [void]$ids.Add($root)
  $rootBorn = $born[$root]
  do {
    $grew = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId; $pp = [int]$p.ParentProcessId
      if ($ids.Contains($pp) -and -not $ids.Contains($id)) {
        $at = [datetime]$p.CreationDate
        if ($at -ge $born[$pp] -and $at -ge $rootBorn) { [void]$ids.Add($id); $grew = $true }
      }
    }
  } while ($grew)
  return ,$ids
}
function Get-RunIds([int]$root) {
  return ,(Get-RunIdsFrom (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate) $root)
}
function Get-RunWindows($ids) {
  $found = New-Object System.Collections.ArrayList
  [void][MossW]::EnumWindows({ param($h, $l)
    $q = 0; [void][MossW]::GetWindowThreadProcessId($h, [ref]$q)
    if ($ids.Contains([int]$q) -and [MossW]::IsWindowVisible($h)) {
      $r = New-Object MossW+R; [void][MossW]::GetWindowRect($h, [ref]$r)
      $onScreen = $false
      foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $b = $s.Bounds
        if ($r.L -lt $b.Right -and $r.Rt -gt $b.Left -and $r.T -lt $b.Bottom -and $r.B -gt $b.Top) { $onScreen = $true }
      }
      [void]$found.Add([pscustomobject]@{ hwnd = [int64]$h; pid = [int]$q; left = $r.L; top = $r.T; right = $r.Rt; bottom = $r.B; onScreen = $onScreen })
    }
    $true }, [IntPtr]::Zero)
  return $found
}
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$parkX = $vs.Left - 4000; $parkY = $vs.Top + 80
function Move-RunWindows($ids) {
  foreach ($w in (Get-RunWindows $ids)) {
    if ($w.onScreen) {
      # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
      [void][MossW]::SetWindowPos([IntPtr]$w.hwnd, [IntPtr]::Zero, $parkX, $parkY, 0, 0, 0x0015)
      [Console]::Out.WriteLine("moved $($w.hwnd) pid $($w.pid) from $($w.left),$($w.top)")
    }
  }
}
`;

const MOVER = `param([string]$PidFile)
${WIN32}
[Console]::Out.WriteLine("ready")
while (-not (Test-Path -LiteralPath $PidFile)) { Start-Sleep -Milliseconds 50 }
$root = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
$started = Get-Date
while ($true) {
  if (-not (Get-Process -Id $root -ErrorAction SilentlyContinue)) { break }
  try { Move-RunWindows (Get-RunIds $root) } catch {}
  $age = ((Get-Date) - $started).TotalSeconds
  if ($age -lt 60) { Start-Sleep -Milliseconds 200 } elseif ($age -lt 600) { Start-Sleep -Milliseconds 1200 } else { Start-Sleep -Seconds 5 }
}
`;

/** For tests: the run's ids for a planted process list (JSON: ProcessId, ParentProcessId, CreationDate). */
const IDS = `param([int]$Root, [string]$FixtureFile)
${WIN32}
$all = Get-Content -LiteralPath $FixtureFile -Raw | ConvertFrom-Json
@(Get-RunIdsFrom $all $Root) | Sort-Object | ConvertTo-Json -Compress
`;

const CHECK = `param([int]$Root, [switch]$Park)
${WIN32}
$ids = Get-RunIds $Root
if ($Park) { Move-RunWindows $ids | Out-Null }
@(Get-RunWindows $ids) | ConvertTo-Json -Compress
`;

/** The scripts live in a folder of the kit's own, written once per process. */
function script(name: string, text: string): string {
  const dir = path.join(os.tmpdir(), "moss-accept-scripts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  // UTF-8 with a BOM, which Windows PowerShell 5.1 needs to read a script file as UTF-8.
  fs.writeFileSync(file, `\uFEFF${text}`, "utf8");
  return file;
}

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

export interface RunWindow {
  readonly hwnd: number;
  readonly pid: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly onScreen: boolean;
}

export interface WindowMover {
  /** Give the mover the app's PID; it then runs until that process exits. */
  attach(pid: number): void;
  stop(): void;
}

/** Starts the mover and resolves once its Win32 types are compiled, before the app is started. */
export async function startWindowMover(
  runDir: string,
  log: (line: string) => void,
): Promise<WindowMover> {
  if (process.platform !== "win32") return { attach: () => {}, stop: () => {} };
  const pidFile = path.join(runDir, "app.pid");
  fs.rmSync(pidFile, { force: true });
  const child: ChildProcess = spawn(
    "powershell",
    [...PS, script("mover.ps1", MOVER), "-PidFile", pidFile],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the window mover did not start in 30 s")),
      30_000,
    );
    let buffer = "";
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (line.trim()) log(`window mover: ${line.trim()}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the window mover exited with ${code} before it was ready: ${stderr.slice(0, 300)}`,
        ),
      );
    });
  });
  return {
    attach: (pid) => fs.writeFileSync(pidFile, String(pid)),
    stop: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * The visible windows of `pid` and its descendants, and whether each intersects a display.
 * With `park`, any on-screen window is moved off first and the answer shows where they are after.
 */
export function windowsOf(pid: number, park = false): RunWindow[] {
  if (process.platform !== "win32") return [];
  const r = spawnSync(
    "powershell",
    [...PS, script("check.ps1", CHECK), "-Root", String(pid), ...(park ? ["-Park"] : [])],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  const text = (r.stdout ?? "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as RunWindow | RunWindow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The run's process ids the scripts would use for a planted process list (tests; Windows only). */
export function runIdsForFixture(
  root: number,
  processes: readonly { ProcessId: number; ParentProcessId: number; CreationDate: string }[],
  dir: string,
): number[] {
  const fixture = path.join(dir, "processes.json");
  fs.writeFileSync(fixture, JSON.stringify(processes));
  const r = spawnSync(
    "powershell",
    [...PS, script("ids.ps1", IDS), "-Root", String(root), "-FixtureFile", fixture],
    { encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  const text = (r.stdout ?? "").trim();
  if (!text) throw new Error(`ids.ps1 gave no answer: ${(r.stderr ?? "").slice(0, 300)}`);
  const parsed = JSON.parse(text) as number | number[];
  return Array.isArray(parsed) ? parsed : [parsed];
}
