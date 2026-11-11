// Process listing (with command lines) and stopping.
import { commandLineUsesPath } from "./paths.ts";
import { runAsync, runSync } from "./run.ts";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
}

const WINDOWS_LIST =
  "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "Get-CimInstance Win32_Process | " +
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";

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

/** Stops a process and its children. Returns an error message, or undefined on success. */
export function stopProcessTree(pid: number): string | undefined {
  if (process.platform === "win32") {
    const r = runSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], undefined, 30_000);
    return r.code === 0 || !isAlive(pid) ? undefined : r.stderr.trim() || r.stdout.trim();
  }
  try {
    process.kill(pid, "SIGTERM");
    return undefined;
  } catch (error) {
    return String(error);
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
