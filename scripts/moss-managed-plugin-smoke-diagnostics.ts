import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const MAX_ROOTS = 16;
const MAX_ENTRIES = 64;
type ProcessIdentity = { pid: number; startedAt: string };
type KnownProcessReader = (pids: readonly number[]) => Promise<readonly ProcessIdentity[]>;

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return [
    "EBUSY",
    "EPERM",
    "ENOTEMPTY",
    "ENOENT",
    "EACCES",
    "ENOTDIR",
    "ELOOP",
    "EMFILE",
    "ENFILE",
    "EIO",
    "EINVAL",
    "ENAMETOOLONG",
  ].includes(code ?? "")
    ? code!
    : "UNKNOWN";
}

/** No process-table/argv query: inspect only numeric PIDs from our own spawn handles. */
async function readKnownWindowsProcesses(
  pids: readonly number[],
): Promise<readonly ProcessIdentity[]> {
  if (pids.length === 0 || process.platform !== "win32") return [];
  const script = `$ErrorActionPreference='Stop'
$rows=@(foreach ($ownedId in @(${pids.join(",")})) {
  $owned=$null
  try {
    $owned=[Diagnostics.Process]::GetProcessById($ownedId)
    [PSCustomObject]@{pid=$ownedId;startedAt=$owned.StartTime.ToUniversalTime().ToString('o')}
  } catch [ArgumentException] {} catch [InvalidOperationException] {} finally {
    if ($owned) { $owned.Dispose() }
  }
})
ConvertTo-Json -InputObject $rows -Compress`;
  const result = await promisify(execFile)(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 2_000, maxBuffer: 16_384 },
  );
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length > pids.length) throw new Error("Invalid identity result");
  return rows.map((row: Record<string, unknown>) => {
    if (
      !Number.isSafeInteger(row.pid) ||
      !pids.includes(row.pid as number) ||
      typeof row.startedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(row.startedAt)
    )
      throw new Error("Invalid identity row");
    return { pid: row.pid as number, startedAt: row.startedAt };
  });
}

/** Passive events on success; filesystem/native identity diagnostics run only after cleanup fails. */
export async function createManagedPluginSmokeDiagnostics(
  root: string,
  readProcesses: KnownProcessReader = readKnownWindowsProcesses,
) {
  const initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink())
    throw new Error("Smoke root must be a plain directory");
  const canonical = await realpath(root);
  const children: Array<{
    child: ChildProcess;
    pid: number;
    spawnedAt: string;
    exitObserved: boolean;
    closeObserved: boolean;
  }> = [];
  let rootsTruncated = false;
  const sameRoot = async () => {
    const current = await lstat(root);
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === initial.dev &&
      current.ino === initial.ino &&
      (await realpath(root)) === canonical
    );
  };
  return {
    observeChild(child: ChildProcess): void {
      if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 1 || child.pid === process.pid)
        return;
      if (children.length === MAX_ROOTS) {
        rootsTruncated = true;
        return;
      }
      const entry = {
        child,
        pid: child.pid!,
        spawnedAt: new Date().toISOString(),
        exitObserved: child.exitCode !== null || child.signalCode !== null,
        closeObserved: false,
      };
      children.push(entry);
      child.once("exit", () => {
        entry.exitObserved = true;
      });
      child.once("close", () => {
        entry.closeObserved = true;
      });
    },
    async collect(cause: unknown): Promise<Readonly<Record<string, unknown>>> {
      let workspace: Readonly<Record<string, unknown>>;
      try {
        if (!(await sameRoot())) {
          workspace = { status: "identity-changed-no-enumeration" };
        } else {
          // One level only: lstat never follows a child symlink/junction; no file content is read.
          const entries = await readdir(root);
          const metadata = await Promise.all(
            entries.slice(0, MAX_ENTRIES).map(async (name) => {
              try {
                const stat = await lstat(path.join(root, name));
                return {
                  name,
                  kind: stat.isSymbolicLink()
                    ? "link-not-followed"
                    : stat.isDirectory()
                      ? "directory"
                      : stat.isFile()
                        ? "file"
                        : "other",
                  size: stat.size,
                  modifiedAtMs: stat.mtimeMs,
                };
              } catch (error) {
                return { name, errorCode: errorCode(error) };
              }
            }),
          );
          workspace = (await sameRoot())
            ? {
                status: "same-task-root",
                entries: metadata,
                truncated: entries.length > MAX_ENTRIES,
              }
            : { status: "identity-changed-metadata-discarded" };
        }
      } catch (error) {
        workspace = { status: "unavailable", errorCode: errorCode(error) };
      }
      let currentIdentities: readonly ProcessIdentity[] = [];
      let identityQuery = process.platform === "win32" ? "observed" : "not-applicable";
      try {
        currentIdentities = await readProcesses(children.map((entry) => entry.pid));
      } catch {
        identityQuery = "unavailable";
      }
      return {
        cleanupErrorCode: errorCode(cause),
        workspace,
        identityQuery,
        rootsTruncated,
        knownRoots: children.map((entry) => ({
          pid: entry.pid,
          spawnedAt: entry.spawnedAt,
          exitObserved: entry.exitObserved,
          closeObserved: entry.closeObserved,
          exitCode: entry.child.exitCode,
          signalCode: entry.child.signalCode,
          stdinDestroyed: entry.child.stdin?.destroyed,
          stdoutDestroyed: entry.child.stdout?.destroyed,
          stderrDestroyed: entry.child.stderr?.destroyed,
          currentNumericPidIdentity:
            currentIdentities.find((identity) => identity.pid === entry.pid) ?? null,
          identityCaveat:
            "Current numeric PID may be reused; no ownership or liveness conclusion and no signal authorized",
        })),
        descendants: "not-recorded; no late parentage reconstruction or foreign-process scan",
      };
    },
  };
}
