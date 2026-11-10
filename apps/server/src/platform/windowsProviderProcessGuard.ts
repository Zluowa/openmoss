// FILE: windowsProviderProcessGuard.ts
// Purpose: Retires provider process trees when this backend dies before its finalizers finish.
// Layer: Server Windows platform runtime
//
// Teardown finalizers cover every exit the backend gets to run. They cannot cover
// TerminateProcess: the desktop's forced stop, Task Manager, or an uninstaller
// stopping everything under the install folder. libuv's kill-on-close job does not
// help either, because it sets JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: it holds direct
// children only. A `.cmd` shim's cmd.exe dies with the backend while the real CLI it
// started keeps running, along with whatever handles it inherited.
//
// So one PowerShell outside the install folder holds a handle on each owned root and
// waits on a pipe that only this backend writes to. End of input means the backend is
// gone, and the guard stops what is still registered and then exits. An open handle
// stops Windows reusing that PID, so descendants are found by parentage from a process
// known to be ours, and creation times reject anything older than its supposed parent.
// Nothing outside those trees is ever signalled.

import { type ChildProcess } from "node:child_process";
import path from "node:path";

import { resolveWindowsComSpec, resolveWindowsSystemRoot } from "@moss/shared/platformEnvironment";
import { spawnProcess } from "@moss/shared/processRuntime";

const MAX_SIGNALABLE_PID = 0x7fffffff;

// The start check allows a second: Date.now() can read later than the coarser creation
// time Windows records for a process spawned right after it. Each pass forgets a known
// PID now held by a different process, because a stopped process's PID can be reused
// between passes and that process's children are not ours.
const WINDOWS_PROVIDER_GUARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$tracked = @{}
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line -match '^\\+([1-9][0-9]*) ([0-9]+)$') {
    $id = [int]$Matches[1]
    $notBefore = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Matches[2]).UtcDateTime.AddSeconds(-1)
    $process = $null
    $started = $notBefore
    try {
      $process = [Diagnostics.Process]::GetProcessById($id)
      $null = $process.Handle
      $started = $process.StartTime.ToUniversalTime()
    } catch {
      if ($process) { $process.Dispose() }
      $process = $null
      $started = $notBefore
    }
    if ($started -lt $notBefore) {
      $process.Dispose()
      continue
    }
    $tracked[$id] = @{ Process = $process; Started = $started }
  } elseif ($line -match '^-([1-9][0-9]*)$') {
    $id = [int]$Matches[1]
    $entry = $tracked[$id]
    if ($entry) {
      if ($entry.Process) { $entry.Process.Dispose() }
      $tracked.Remove($id)
    }
  }
}
if ($tracked.Count -eq 0) { exit 0 }

$known = @{}
foreach ($id in $tracked.Keys) { $known[$id] = $tracked[$id].Started }
for ($pass = 0; $pass -lt 3; $pass++) {
  try {
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 30)
  } catch {
    break
  }
  foreach ($row in $rows) {
    $id = [int]$row.ProcessId
    if ($known.ContainsKey($id) -and $null -ne $row.CreationDate -and [Math]::Abs(($row.CreationDate.ToUniversalTime() - $known[$id]).TotalSeconds) -ge 1) {
      $known.Remove($id)
    }
  }
  $found = New-Object System.Collections.ArrayList
  do {
    $grew = $false
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if ($id -eq $PID -or $known.ContainsKey($id) -or -not $known.ContainsKey($parent)) { continue }
      if ($null -eq $row.CreationDate) { continue }
      $created = $row.CreationDate.ToUniversalTime()
      if ($created -lt $known[$parent]) { continue }
      $known[$id] = $created
      [void]$found.Add(@{ Id = $id; Created = $created })
      $grew = $true
    }
  } while ($grew)
  if ($found.Count -eq 0) { break }
  $found.Reverse()
  foreach ($item in $found) {
    $victim = $null
    try {
      $victim = [Diagnostics.Process]::GetProcessById($item.Id)
      if ([Math]::Abs(($victim.StartTime.ToUniversalTime() - $item.Created).TotalSeconds) -lt 1) {
        $victim.Kill()
      }
    } catch {
    } finally {
      if ($victim) { $victim.Dispose() }
    }
  }
  Start-Sleep -Milliseconds 250
}
foreach ($entry in $tracked.Values) {
  if ($entry.Process) {
    try { if (-not $entry.Process.HasExited) { $entry.Process.Kill() } } catch {}
    $entry.Process.Dispose()
  }
}
`.trim();

function powershellExecutablePath(): string {
  return path.win32.join(
    resolveWindowsSystemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * The guard has to outlive the backend, so it cannot be libuv's direct child, and
 * `detached` is no use: PowerShell started without a console exits at once, with code
 * 0, before running a line. Going through cmd.exe uses the same job rule that strands
 * the CLIs above. cmd.exe dies with the backend, and the PowerShell it started keeps
 * the hidden console and the pipe. The working directory must not be the install
 * folder an uninstaller is about to remove.
 */
export function windowsProviderProcessGuardLaunch() {
  return {
    command: resolveWindowsComSpec(),
    args: [
      "/d",
      "/c",
      powershellExecutablePath(),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_PROVIDER_GUARD_SCRIPT, "utf16le").toString("base64"),
    ],
    cwd: path.win32.join(resolveWindowsSystemRoot(), "System32"),
  };
}

function spawnPowerShellGuard(): ChildProcess {
  const { command, args, cwd } = windowsProviderProcessGuardLaunch();
  return spawnProcess(command, args, {
    cwd,
    stdio: ["pipe", "ignore", "ignore"],
    platform: "win32",
  });
}

export interface WindowsProviderProcessGuard {
  /** Registers an owned root started no earlier than `notBeforeMs`; returns its release. */
  track(pid: number, notBeforeMs: number): () => void;
}

export function createWindowsProviderProcessGuard(
  options: { readonly spawnGuard?: () => ChildProcess } = {},
): WindowsProviderProcessGuard {
  const spawnGuard = options.spawnGuard ?? spawnPowerShellGuard;
  const tracked = new Map<number, number>();
  let guard: ChildProcess | null = null;

  const send = (line: string): void => {
    guard?.stdin?.write(`${line}\n`, () => undefined);
  };

  // The guard starts with the first provider and lives as long as this backend. A guard
  // that was lost, or could not start, gets another chance with the next provider.
  const ensureGuard = (): void => {
    if (guard !== null) return;
    let started: ChildProcess;
    try {
      started = spawnGuard();
    } catch {
      return;
    }
    const forget = () => {
      if (guard === started) guard = null;
    };
    started.once("error", forget);
    started.once("exit", forget);
    started.stdin?.on("error", forget);
    // The backend's exit must not wait on the process that outlives it.
    started.unref();
    (started.stdin as { unref?: () => void } | null)?.unref?.();
    guard = started;
    for (const [pid, notBeforeMs] of tracked) send(`+${pid} ${notBeforeMs}`);
  };

  return {
    track: (pid, notBeforeMs) => {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid > MAX_SIGNALABLE_PID)
        return () => undefined;
      const hadGuard = guard !== null;
      tracked.set(pid, notBeforeMs);
      ensureGuard();
      if (hadGuard) send(`+${pid} ${notBeforeMs}`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        tracked.delete(pid);
        send(`-${pid}`);
      };
    },
  };
}

let installedGuard: WindowsProviderProcessGuard | null = null;

/**
 * Called once from the server entry point, never on import: test doubles report
 * made-up PIDs, and a guard must only ever hear about processes that really exist.
 */
export function installWindowsProviderProcessGuard(
  guard: WindowsProviderProcessGuard | null = createWindowsProviderProcessGuard(),
): void {
  installedGuard = guard;
}

/** Registers a provider root with the guard, when one is installed. */
export function trackOwnedProviderProcess(pid: number, notBeforeMs: number): () => void {
  return installedGuard?.track(pid, notBeforeMs) ?? (() => undefined);
}

/** Spawns a Node-managed provider root that stays registered until it exits. */
export function spawnGuardedProviderChild<
  TChild extends {
    readonly pid?: number | undefined;
    once(event: "exit", listener: () => void): unknown;
  },
>(spawn: () => TChild): TChild {
  const notBeforeMs = Date.now();
  const child = spawn();
  if (child.pid !== undefined) {
    child.once("exit", trackOwnedProviderProcess(child.pid, notBeforeMs));
  }
  return child;
}
