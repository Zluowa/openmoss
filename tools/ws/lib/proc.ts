// Process listing (with command lines) and stopping.
import { commandLineUsesPath } from "./paths.ts";
import { runAsync, runSync } from "./run.ts";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
  /** Working set (resident memory), when the listing has it. */
  readonly memoryBytes?: number;
  /** Start time (ms since the epoch), when the listing has it. */
  readonly startedMs?: number;
}

const WINDOWS_LIST =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "Get-CimInstance Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,@{n='Started';e={[long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds}} | ConvertTo-Json -Compress";

export function parseWindowsProcessJson(text: string): ProcessInfo[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const raw = JSON.parse(trimmed) as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: String(r.Name ?? ""),
    commandLine: String(r.CommandLine ?? ""),
    ...(typeof r.WorkingSetSize === "number" ? { memoryBytes: r.WorkingSetSize } : {}),
    ...(typeof r.Started === "number" ? { startedMs: r.Started } : {}),
  }));
}

export function parsePsOutput(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m)
      out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, commandLine: m[4]!.trim() });
  }
  return out;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const r = await runAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST],
      {
        timeoutMs: 60_000,
      },
    );
    if (r.code !== 0) throw new Error(`process listing failed: ${r.stderr.trim().split("\n")[0]}`);
    return parseWindowsProcessJson(r.stdout);
  }
  const r = await runAsync("ps", ["-eo", "pid=,ppid=,comm=,args="]);
  if (r.code !== 0) throw new Error(`process listing failed: ${r.stderr.trim()}`);
  return parsePsOutput(r.stdout);
}

/** Processes whose command line refers to a path inside `dir`, excluding this process and its parents. */
export function processesUsing(processes: readonly ProcessInfo[], dir: string): ProcessInfo[] {
  const self = new Set([process.pid, process.ppid]);
  return processes.filter((p) => !self.has(p.pid) && commandLineUsesPath(p.commandLine, dir));
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `root` and the processes below it that started after `sinceMs`. A parent PID alone is not proof
 * of descent on Windows (PIDs are reused and a child keeps a dead parent's PID), so a process that
 * started before the run cannot be part of it and is never included.
 */
export function descendantsOf(
  processes: readonly ProcessInfo[],
  root: number,
  sinceMs: number,
): ProcessInfo[] {
  const found = new Map<number, ProcessInfo>();
  const self = processes.find((p) => p.pid === root);
  if (self) found.set(root, self);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of processes) {
      if (found.has(p.pid) || !found.has(p.ppid)) continue;
      if (p.startedMs === undefined || p.startedMs < sinceMs) continue;
      found.set(p.pid, p);
      grew = true;
    }
  }
  return [...found.values()];
}

/** Stops one process (never a tree). */
export function stopPid(pid: number): void {
  if (process.platform === "win32")
    runSync("taskkill.exe", ["/PID", String(pid), "/F"], undefined, 15_000);
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

const DEV_TEST_PATTERN =
  /\b(vitest|vite|turbo|playwright|tsgo|tsc|dev-runner|electron|bun\s+test)\b/i;
const RUNTIME_NAMES = /^(node|bun|electron|moss)(\.exe)?$/i;

/** Dev or test runtimes whose parent process no longer exists. */
export function orphanedDevProcesses(processes: readonly ProcessInfo[]): ProcessInfo[] {
  const pids = new Set(processes.map((p) => p.pid));
  return processes.filter(
    (p) =>
      RUNTIME_NAMES.test(p.name) &&
      DEV_TEST_PATTERN.test(p.commandLine) &&
      p.ppid > 0 &&
      !pids.has(p.ppid),
  );
}
