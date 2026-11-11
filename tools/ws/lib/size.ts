// Directory sizes that never follow links or junctions. On Windows the walk runs in .NET
// (file sizes come with the directory listing, no stat per file); elsewhere `du -sk`.
// A walk has a time budget: a tree not finished in time is reported as "at least" what was counted.
// Complete results are cached in the state folder, so later runs only measure what changed or is new.
import fs from "node:fs";
import path from "node:path";
import { pathKey } from "./paths.ts";
import { mapLimit, runAsync } from "./run.ts";

export interface DirSize {
  readonly bytes: number;
  readonly files: number;
  /** The walk ran out of time: the real size is at least this. */
  readonly partial?: boolean;
}

// The walk is inside a function: Windows PowerShell compiles function loops but interprets
// top-level script loops, which is several times slower.
const WINDOWS_SIZE_SCRIPT = `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
function Measure-Tree([string]$root, [System.Diagnostics.Stopwatch]$clock, [long]$budgetMs) {
  $bytes = [long]0; $files = 0; $partial = $false
  $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  try { $stack.Push([System.IO.DirectoryInfo]::new($root)) } catch {}
  while ($stack.Count) {
    if ($clock.ElapsedMilliseconds -gt $budgetMs) { $partial = $true; break }
    $d = $stack.Pop()
    try {
      foreach ($i in $d.EnumerateFileSystemInfos()) {
        if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($i -is [IO.DirectoryInfo]) { $stack.Push($i) } else { $bytes += $i.Length; $files++ }
      }
    } catch {}
  }
  return (@{ path = $root; bytes = $bytes; files = $files; partial = $partial } | ConvertTo-Json -Compress)
}
$job = [Console]::In.ReadToEnd() | ConvertFrom-Json
$clock = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($root in $job.paths) {
  if ($clock.ElapsedMilliseconds -gt $job.budgetMs) { break }
  [Console]::Out.WriteLine((Measure-Tree $root $clock $job.budgetMs))
}
`;

/** Node fallback: slow but portable. */
export async function sizeWithNode(
  dir: string,
  deadline = Number.POSITIVE_INFINITY,
): Promise<DirSize> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return { bytes, files, partial: true };
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          bytes += (await fs.promises.lstat(p)).size;
          files += 1;
        } catch {
          // vanished
        }
      }
    }
  }
  return { bytes, files };
}

async function sizeWindows(
  dirs: readonly string[],
  processes: number,
  budgetMs: number,
): Promise<Map<string, DirSize>> {
  const out = new Map<string, DirSize>();
  const chunks: string[][] = Array.from(
    { length: Math.max(1, Math.min(processes, dirs.length)) },
    () => [],
  );
  dirs.forEach((d, i) => chunks[i % chunks.length]!.push(d));
  await Promise.all(
    chunks.map(async (chunk) => {
      const r = await runAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SIZE_SCRIPT],
        {
          input: JSON.stringify({ paths: chunk, budgetMs }),
          timeoutMs: budgetMs + 60_000,
        },
      );
      for (const line of r.stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as {
            path: string;
            bytes: number;
            files: number;
            partial: boolean;
          };
          out.set(pathKey(row.path), {
            bytes: row.bytes,
            files: row.files,
            ...(row.partial ? { partial: true } : {}),
          });
        } catch {
          // ignore a partial line
        }
      }
    }),
  );
  return out;
}

async function sizePosix(dirs: readonly string[], budgetMs: number): Promise<Map<string, DirSize>> {
  const out = new Map<string, DirSize>();
  const deadline = Date.now() + budgetMs;
  await mapLimit(dirs, 2, async (d) => {
    if (Date.now() > deadline) return;
    const r = await runAsync("du", ["-sk", d], {
      timeoutMs: Math.max(1000, deadline - Date.now()),
    });
    const kb = Number(r.stdout.trim().split(/\s+/)[0]);
    if (r.code === 0 && Number.isFinite(kb)) out.set(pathKey(d), { bytes: kb * 1024, files: -1 });
  });
  return out;
}

interface CacheEntry extends DirSize {
  readonly at: number;
}

export interface SizeOptions {
  cacheFile?: string | undefined;
  /** Cached results younger than this are reused; 0 measures everything again. */
  maxAgeMs?: number | undefined;
  processes?: number | undefined;
  /** Wall-clock budget for measuring; unfinished trees come back partial or missing. */
  budgetMs?: number | undefined;
}

/** Sizes for the dirs, from the cache when fresh. A dir missing from the result was not reached in time. */
export async function sizeDirs(
  dirs: readonly string[],
  options: SizeOptions = {},
): Promise<Map<string, DirSize>> {
  const maxAge = options.maxAgeMs ?? 24 * 3600_000;
  const budgetMs = options.budgetMs ?? 30_000;
  let cache: Record<string, CacheEntry> = {};
  if (options.cacheFile) {
    try {
      cache = JSON.parse(fs.readFileSync(options.cacheFile, "utf8")) as Record<string, CacheEntry>;
    } catch {
      cache = {};
    }
  }
  const now = Date.now();
  const result = new Map<string, DirSize>();
  const todo: string[] = [];
  for (const d of dirs) {
    const hit = cache[pathKey(d)];
    if (hit && !hit.partial && now - hit.at < maxAge) result.set(pathKey(d), hit);
    else todo.push(d);
  }
  if (todo.length) {
    // Trees never measured go first; within each group, oldest measurement first.
    todo.sort((a, b) => (cache[pathKey(a)]?.at ?? 0) - (cache[pathKey(b)]?.at ?? 0));
    const fresh =
      process.platform === "win32"
        ? await sizeWindows(todo, options.processes ?? 2, budgetMs)
        : await sizePosix(todo, budgetMs);
    for (const d of todo) {
      const s = fresh.get(pathKey(d));
      const old = cache[pathKey(d)];
      if (s && !s.partial) {
        result.set(pathKey(d), s);
        cache[pathKey(d)] = { ...s, at: now };
      } else if (old && !old.partial) {
        result.set(pathKey(d), { ...old, partial: false });
      } else if (s) {
        result.set(pathKey(d), s);
      }
    }
    if (options.cacheFile) {
      try {
        fs.mkdirSync(path.dirname(options.cacheFile), { recursive: true });
        fs.writeFileSync(options.cacheFile, JSON.stringify(cache));
      } catch {
        // best effort
      }
    }
  }
  return result;
}

export function formatSize(bytes: number | undefined, partial = false): string {
  if (bytes === undefined) return "-";
  const prefix = partial ? ">" : "";
  if (bytes >= 1024 ** 3) return `${prefix}${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${prefix}${Math.round(bytes / 1024 ** 2)} MB`;
}
