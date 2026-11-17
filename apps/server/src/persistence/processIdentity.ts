// FILE: processIdentity.ts
// Purpose: Reads who really holds a process id: its executable name and the time
//          the operating system started it.
// Layer: Server persistence
// Why: a pid alone does not identify a process. Windows reuses pids quickly, so a
//      lock owner that died uncleanly can look "live" because an unrelated program
//      now has its pid (2026-11-17: conhost.exe kept Moss from starting).

import { execProcessFile } from "@moss/shared/processRuntime";
import { resolveWindowsPowerShellExecutable } from "@moss/shared/platformEnvironment";

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export type ObservedProcessIdentity =
  | { readonly state: "dead" }
  | {
      readonly state: "live";
      /** Executable name without directory, e.g. `Moss.exe`; absent when unreadable. */
      readonly executable?: string;
      /** When the operating system started the process, in epoch ms; absent when unreadable. */
      readonly startedAtMs?: number;
    }
  | { readonly state: "unknown" };

export type ProcessIdentityProbe = (pid: number) => Promise<ObservedProcessIdentity>;

function runProbe(
  command: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execProcessFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: PROBE_TIMEOUT_MS,
          maxBuffer: PROBE_MAX_OUTPUT_BYTES,
          ...(env ? { env } : {}),
        },
        (error, stdout) => {
          // `ps -p <dead pid>` exits 1 with empty output; that is an answer, not a failure.
          if (error && (typeof stdout !== "string" || stdout.length > 0 || error.killed)) {
            resolve(null);
            return;
          }
          resolve(typeof stdout === "string" ? stdout : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function windowsProbeScript(pid: number): string {
  // ProcessName comes from the image file and cannot be renamed by the process.
  // StartTime can be denied for protected processes; the name still answers.
  return `
$ErrorActionPreference = 'Stop'
$p = $null
try { $p = [Diagnostics.Process]::GetProcessById(${pid}) } catch [ArgumentException] { [Console]::Out.WriteLine('@dead'); exit 0 }
try {
  $name = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.ProcessName))
  $started = ''
  try { $started = [string][long]($p.StartTime.ToUniversalTime() - [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalMilliseconds } catch { $started = '' }
  $exited = $false
  try { $exited = $p.HasExited } catch { $exited = $false }
  if ($exited) { [Console]::Out.WriteLine('@dead'); exit 0 }
  [Console]::Out.WriteLine('@live ' + $name + ' ' + $started)
} finally { $p.Dispose() }
`.trim();
}

export function parseWindowsProbeOutput(output: string): ObservedProcessIdentity {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("@"));
  if (line === "@dead") return { state: "dead" };
  const match = line?.match(/^@live ([A-Za-z0-9+/=]*) ?(\d*)$/u);
  if (!match) return { state: "unknown" };
  const name = Buffer.from(match[1] ?? "", "base64")
    .toString("utf8")
    .trim();
  const startedAtMs = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;
  return {
    state: "live",
    ...(name.length > 0
      ? { executable: name.toLowerCase().endsWith(".exe") ? name : `${name}.exe` }
      : {}),
    ...(Number.isSafeInteger(startedAtMs) && startedAtMs > 0 ? { startedAtMs } : {}),
  };
}

export function parsePosixProbeOutput(output: string): ObservedProcessIdentity {
  const line = output.trim();
  if (line.length === 0) return { state: "dead" };
  // `lstart` is a fixed-width ctime string such as "Mon Nov 17 19:13:04 2026".
  const startedAtMs = Date.parse(line);
  return Number.isFinite(startedAtMs) ? { state: "live", startedAtMs } : { state: "unknown" };
}

async function probeWindows(pid: number): Promise<ObservedProcessIdentity> {
  const encoded = Buffer.from(windowsProbeScript(pid), "utf16le").toString("base64");
  const output = await runProbe(resolveWindowsPowerShellExecutable(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ]);
  return output === null ? { state: "unknown" } : parseWindowsProbeOutput(output);
}

async function probePosix(pid: number): Promise<ObservedProcessIdentity> {
  // LC_ALL=C keeps lstart in the English ctime format Date.parse reads. The
  // executable name is not used on POSIX: a process can rename its own comm.
  const output = await runProbe("ps", ["-p", String(pid), "-o", "lstart="], {
    ...process.env,
    LC_ALL: "C",
  });
  return output === null ? { state: "unknown" } : parsePosixProbeOutput(output);
}

/** Reads the identity of whatever process currently has `pid`. Never throws. */
export const probeProcessIdentity: ProcessIdentityProbe = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  try {
    return process.platform === "win32" ? await probeWindows(pid) : await probePosix(pid);
  } catch {
    return { state: "unknown" };
  }
};
