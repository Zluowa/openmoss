// FILE: agentRuntimeStore.ts
// Purpose: Installs the agent runtimes Moss fetches after install (Codex, Claude Code, the Computer
//          driver) into a machine-local store, verifying every file against pins compiled into
//          the build, and finds them again.
// Layer: Shared runtime utility (used by the desktop main process and the server).
//
// Store layout (machine-local, shared by profiles):
//   <store>/<name>/<version>-<platform>-<arch>/   the runtime; `installed.json` is written last
//   <store>/.downloads/<archive sha256>.tar.zst   archive being fetched (`.partial` while it grows)
//   <store>/.staging/<name>-<pid>-<random>/       unpacking; renamed into place when verified
//   <store>/.locks/<name>-<version>-<platform>-<arch>.lock   one fetcher at a time, across processes

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type WriteStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, posix } from "node:path";
import * as Zlib from "node:zlib";

import {
  downloadPinnedFile,
  PinnedDownloadError,
  type PinnedDownloadFetch,
  type PinnedDownloadReport,
} from "./pinnedDownload";
import { createTarParser } from "./tarArchive";

export interface AgentRuntimeFilePin {
  /** Forward-slash path inside the runtime folder. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

/** One runtime for one platform, exactly as the build verified and packed it. */
export interface AgentRuntimePin {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly archive: { readonly size: number; readonly sha256: string };
  /** The program Moss starts, relative to the runtime folder. */
  readonly executable: string;
  readonly files: ReadonlyArray<AgentRuntimeFilePin>;
}

export type AgentRuntimeFailure =
  | PinnedDownloadError["failure"]
  | "unsupported"
  | "invalid-archive"
  | "busy";

export class AgentRuntimeStoreError extends Error {
  constructor(
    readonly failure: AgentRuntimeFailure,
    message: string,
    readonly download?: PinnedDownloadReport,
  ) {
    super(message);
    this.name = "AgentRuntimeStoreError";
  }
}

export const AGENT_RUNTIME_STORE_DIR_ENV = "MOSS_RUNTIME_STORE_DIR";
const INSTALLED_MARKER = "installed.json";

/**
 * `runtimes/v1/<name>/<version>/<name>-<version>-<platform>-<arch>-<sha256 first 16>.tar.zst`,
 * the same on every source. Objects are immutable and sources may cache them for ever, so the
 * name carries the content: two builds that pack the same runtime into different bytes can never
 * replace each other's file.
 */
export function agentRuntimeObjectPath(pin: AgentRuntimePin): string {
  const file = `${pin.name}-${pin.version}-${pin.platform}-${pin.arch}-${pin.archive.sha256.slice(0, 16)}.tar.zst`;
  return `runtimes/v1/${pin.name}/${pin.version}/${file}`;
}

/** Full URLs of one runtime archive, in source order. Bases may end with or without a slash. */
export function agentRuntimeSourceUrls(
  pin: AgentRuntimePin,
  sourceBases: ReadonlyArray<string>,
): string[] {
  return sourceBases.map(
    (base) => new URL(agentRuntimeObjectPath(pin), base.endsWith("/") ? base : `${base}/`).href,
  );
}

/**
 * The machine-local store: Windows `%LOCALAPPDATA%\Moss\runtimes` (never Roaming), macOS
 * `~/Library/Application Support/Moss/runtimes`, Linux `$XDG_DATA_HOME/moss/runtimes`.
 * `MOSS_RUNTIME_STORE_DIR` wins, so isolated runs never touch a real profile.
 */
export function defaultAgentRuntimeStoreRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
}): string {
  const override = input.env[AGENT_RUNTIME_STORE_DIR_ENV]?.trim();
  if (override) return override;
  if (input.platform === "win32") {
    const local = input.env.LOCALAPPDATA?.trim() || join(input.homeDir, "AppData", "Local");
    return join(local, "Moss", "runtimes");
  }
  if (input.platform === "darwin")
    return join(input.homeDir, "Library", "Application Support", "Moss", "runtimes");
  const data = input.env.XDG_DATA_HOME?.trim() || join(input.homeDir, ".local", "share");
  return join(data, "moss", "runtimes");
}

export function agentRuntimeInstallDir(storeRoot: string, pin: AgentRuntimePin): string {
  return join(storeRoot, pin.name, `${pin.version}-${pin.platform}-${pin.arch}`);
}

function pinKey(pin: AgentRuntimePin): string {
  return `${pin.name}-${pin.version}-${pin.platform}-${pin.arch}`;
}

export type AgentRuntimeLookup =
  | { readonly state: "ready"; readonly directory: string; readonly executablePath: string }
  | { readonly state: "missing" }
  /** Installed once, but a file is gone or changed since: what antivirus quarantine looks like. */
  | { readonly state: "damaged"; readonly directory: string; readonly path: string };

/**
 * Finds an installed runtime. Cheap enough for every start: it reads the marker and stats every
 * pinned file (sizes only); the full hashes were checked when it was installed.
 */
export async function findAgentRuntime(
  roots: ReadonlyArray<string>,
  pin: AgentRuntimePin,
): Promise<AgentRuntimeLookup> {
  let damaged: AgentRuntimeLookup | null = null;
  for (const root of roots) {
    const directory = agentRuntimeInstallDir(root, pin);
    let marker: { archiveSha256?: unknown };
    try {
      marker = JSON.parse(await readFile(join(directory, INSTALLED_MARKER), "utf8"));
    } catch {
      continue;
    }
    if (marker.archiveSha256 !== pin.archive.sha256) continue;
    let broken: string | null = null;
    for (const file of pin.files) {
      const size = await stat(join(directory, ...file.path.split("/"))).then(
        (value) => (value.isFile() ? value.size : -1),
        () => -1,
      );
      if (size !== file.size) {
        broken = file.path;
        break;
      }
    }
    if (broken === null)
      return {
        state: "ready",
        directory,
        executablePath: join(directory, ...pin.executable.split("/")),
      };
    damaged ??= { state: "damaged", directory, path: broken };
  }
  return damaged ?? { state: "missing" };
}

/** Bytes needed on the store's disk: archive + unpacked files + 10%. */
export function agentRuntimeSpaceNeeded(pin: AgentRuntimePin): number {
  const unpacked = pin.files.reduce((sum, file) => sum + file.size, 0);
  return Math.ceil((pin.archive.size + unpacked) * 1.1);
}

export async function assertAgentRuntimeSpace(
  storeRoot: string,
  pin: AgentRuntimePin,
  freeBytes: (path: string) => Promise<number> = async (path) => {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
): Promise<void> {
  await mkdir(storeRoot, { recursive: true });
  const needed = agentRuntimeSpaceNeeded(pin);
  const free = await freeBytes(storeRoot);
  if (free < needed)
    throw new AgentRuntimeStoreError("disk", `${needed - free} more bytes are needed on the disk.`);
}

/**
 * Settles when the stream can take more bytes. A file can end (and its stream finish) before
 * `drain` would fire, so finish, close and error settle it too; waiting on `drain` alone hung
 * the install of the real 355 MB codex.exe.
 */
function writable(out: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      for (const event of ["drain", "finish", "close", "error"] as const) out.off(event, settle);
      resolve();
    };
    for (const event of ["drain", "finish", "close", "error"] as const) out.once(event, settle);
  });
}

function isSafeEntryPath(path: string): boolean {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false;
  if (/^[A-Za-z]:/u.test(path)) return false;
  const normalized = posix.normalize(path);
  return normalized === path.replace(/\/$/u, "") && !normalized.split("/").includes("..");
}

/**
 * Unpacks a verified archive into a staging folder, checks every file against the pin (size,
 * sha256, nothing missing, nothing extra, no links), then moves it into place in one rename and
 * writes `installed.json` last. A folder without the marker is never used.
 */
export async function installAgentRuntimeArchive(input: {
  readonly archivePath: string;
  readonly pin: AgentRuntimePin;
  readonly storeRoot: string;
}): Promise<string> {
  const { pin } = input;
  if (typeof Zlib.createZstdDecompress !== "function")
    throw new AgentRuntimeStoreError("unsupported", "This build's Node has no zstd decompression.");
  const expected = new Map(pin.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of pin.files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join("/"));
  }
  const staging = join(
    input.storeRoot,
    ".staging",
    `${pin.name}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(staging, { recursive: true });
  const seen = new Set<string>();
  const invalid = (message: string) => new AgentRuntimeStoreError("invalid-archive", message);
  try {
    const state: { failure: Error | null; open: WriteStream | null } = {
      failure: null,
      open: null,
    };
    const drains: Promise<void>[] = [];
    const closed: Promise<void>[] = [];
    const parser = createTarParser({
      entry: (header) => {
        if (state.failure) return null;
        const path = header.path.replace(/^\.\//u, "").replace(/\/$/u, "");
        if (header.type === "directory" && (directories.has(path) || path === "")) return null;
        if (header.type !== "file" || !isSafeEntryPath(path)) {
          state.failure = invalid(
            `The archive holds an entry Moss does not accept: ${header.path}`,
          );
          return null;
        }
        const file = expected.get(path);
        if (!file || seen.has(path)) {
          state.failure = invalid(`The archive holds a file its pin does not list: ${path}`);
          return null;
        }
        seen.add(path);
        const out = createWriteStream(join(staging, ...path.split("/")), { flags: "wx" });
        closed.push(
          new Promise<void>((resolve, reject) => {
            out.on("close", resolve);
            out.on("error", reject);
          }),
        );
        state.open = out;
        const hash = createHash("sha256");
        let size = 0;
        return {
          chunk: (bytes) => {
            hash.update(bytes);
            size += bytes.length;
            if (!out.write(Buffer.from(bytes))) drains.push(writable(out));
          },
          end: () => {
            out.end();
            state.open = null;
            if (size !== file.size || hash.digest("hex") !== file.sha256)
              state.failure ??= invalid(`${file.path} does not match its pin.`);
          },
        };
      },
    });
    for (const path of directories)
      await mkdir(join(staging, ...path.split("/")), { recursive: true });
    const source = createReadStream(input.archivePath).pipe(Zlib.createZstdDecompress());
    try {
      for await (const chunk of source) {
        parser.write(chunk as Buffer);
        if (state.failure) break;
        if (drains.length > 0) await Promise.all(drains.splice(0));
      }
      if (!state.failure) parser.finish();
    } catch (error) {
      state.failure ??= invalid(`The archive cannot be read: ${String(error)}`);
    } finally {
      state.open?.destroy();
      source.destroy();
    }
    await Promise.allSettled(closed);
    if (state.failure) throw state.failure;
    const missing = pin.files.find((file) => !seen.has(file.path));
    if (missing) throw invalid(`The archive lacks ${missing.path}.`);
    for (const file of pin.files)
      if (file.executable && process.platform !== "win32")
        await chmod(join(staging, ...file.path.split("/")), 0o755);

    const destination = agentRuntimeInstallDir(input.storeRoot, pin);
    await mkdir(join(input.storeRoot, pin.name), { recursive: true });
    // A leftover folder (damaged, or from an install that never wrote its marker) goes aside first.
    const existing = await findAgentRuntime([input.storeRoot], pin);
    if (existing.state === "ready") {
      await rm(staging, { recursive: true, force: true });
      return destination;
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    const marker = join(destination, `${INSTALLED_MARKER}.tmp`);
    await writeFile(
      marker,
      `${JSON.stringify({ name: pin.name, version: pin.version, platform: pin.platform, arch: pin.arch, archiveSha256: pin.archive.sha256, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    await rename(marker, join(destination, INSTALLED_MARKER));
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the store's lock for one runtime. Another Moss window or profile holding it makes this
 * wait (calling `onWait` with the bytes that process has on disk so far); a lock whose process
 * is gone, or older than `staleMs`, is taken over.
 */
async function withRuntimeLock<T>(input: {
  readonly storeRoot: string;
  readonly pin: AgentRuntimePin;
  readonly onWait?: () => Promise<void>;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly signal?: AbortSignal;
  readonly work: () => Promise<T>;
}): Promise<T> {
  const locks = join(input.storeRoot, ".locks");
  await mkdir(locks, { recursive: true });
  const lockPath = join(locks, `${pinKey(input.pin)}.lock`);
  for (;;) {
    if (input.signal?.aborted) throw new AgentRuntimeStoreError("aborted", "cancelled");
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      try {
        return await input.work();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readFile(lockPath, "utf8").then(
      (text) => JSON.parse(text) as { pid?: number; at?: number },
      () => ({}) as { pid?: number; at?: number },
    );
    const stale =
      (holder.pid !== undefined && !processAlive(holder.pid)) ||
      (holder.at !== undefined && Date.now() - holder.at > input.staleMs);
    if (stale) {
      await rm(lockPath, { force: true });
      continue;
    }
    await input.onWait?.();
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
}

export type AgentRuntimeStatus =
  | { readonly phase: "checking" }
  | { readonly phase: "downloading"; readonly bytes: number; readonly total: number }
  | {
      readonly phase: "waiting";
      readonly failure: PinnedDownloadError["failure"];
      readonly retryInMs: number;
      readonly bytes: number;
      readonly total: number;
    }
  | { readonly phase: "installing" }
  | { readonly phase: "ready"; readonly executablePath: string };

/** One fetch, for diagnostics: no URL, no path. */
export interface AgentRuntimeFetchReport {
  readonly name: string;
  readonly version: string;
  readonly outcome: "ready" | "already-installed" | AgentRuntimeFailure;
  readonly durationMs: number;
  readonly installMs: number;
  readonly download: PinnedDownloadReport | null;
  /** The program was there before and is gone or changed now (antivirus, a cleaner). */
  readonly replacedDamaged: boolean;
}

/**
 * Makes one pinned runtime ready: looks in the read-only pre-seeded roots (full installer) and the
 * store, and otherwise downloads, verifies and installs it, one process at a time per runtime.
 */
export async function ensureAgentRuntime(input: {
  readonly pin: AgentRuntimePin;
  readonly storeRoot: string;
  /** Read-only roots with the same layout, searched first (the full offline installer). */
  readonly preseededRoots?: ReadonlyArray<string>;
  readonly sourceBases: ReadonlyArray<string>;
  readonly fetch: PinnedDownloadFetch;
  readonly onStatus?: (status: AgentRuntimeStatus) => void;
  readonly signal?: AbortSignal;
  readonly connectTimeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly freeBytes?: (path: string) => Promise<number>;
  readonly lockPollMs?: number;
  readonly lockStaleMs?: number;
  readonly now?: () => number;
}): Promise<{ readonly executablePath: string; readonly report: AgentRuntimeFetchReport }> {
  const now = input.now ?? Date.now;
  const started = now();
  const { pin } = input;
  const report = (
    outcome: AgentRuntimeFetchReport["outcome"],
    download: PinnedDownloadReport | null,
    installMs: number,
    replacedDamaged: boolean,
  ): AgentRuntimeFetchReport => ({
    name: pin.name,
    version: pin.version,
    outcome,
    durationMs: now() - started,
    installMs,
    download,
    replacedDamaged,
  });
  input.onStatus?.({ phase: "checking" });
  const roots = [...(input.preseededRoots ?? []), input.storeRoot];
  const first = await findAgentRuntime(roots, pin);
  if (first.state === "ready") {
    input.onStatus?.({ phase: "ready", executablePath: first.executablePath });
    return {
      executablePath: first.executablePath,
      report: report("already-installed", null, 0, false),
    };
  }
  const replacedDamaged = first.state === "damaged";
  const archivePath = join(input.storeRoot, ".downloads", `${pin.archive.sha256}.tar.zst`);
  let download: PinnedDownloadReport | null = null;
  let installMs = 0;
  try {
    return await withRuntimeLock({
      storeRoot: input.storeRoot,
      pin,
      pollMs: input.lockPollMs ?? 1_000,
      staleMs: input.lockStaleMs ?? 6 * 60 * 60 * 1_000,
      ...(input.signal ? { signal: input.signal } : {}),
      onWait: async () => {
        // Another Moss is fetching it: show that process's progress from the bytes on disk.
        const bytes = await stat(`${archivePath}.partial`).then(
          (value) => value.size,
          () => 0,
        );
        input.onStatus?.({ phase: "downloading", bytes, total: pin.archive.size });
      },
      work: async () => {
        const again = await findAgentRuntime(roots, pin);
        if (again.state === "ready") {
          input.onStatus?.({ phase: "ready", executablePath: again.executablePath });
          return {
            executablePath: again.executablePath,
            report: report("already-installed", null, 0, replacedDamaged),
          };
        }
        await assertAgentRuntimeSpace(input.storeRoot, pin, input.freeBytes);
        download = await downloadPinnedFile({
          sources: agentRuntimeSourceUrls(pin, input.sourceBases),
          size: pin.archive.size,
          sha256: pin.archive.sha256,
          destinationPath: archivePath,
          fetch: input.fetch,
          ...(input.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: input.connectTimeoutMs }),
          ...(input.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: input.stallTimeoutMs }),
          ...(input.retryDelaysMs === undefined ? {} : { retryDelaysMs: input.retryDelaysMs }),
          ...(input.signal ? { signal: input.signal } : {}),
          onProgress: ({ bytes, total }) =>
            input.onStatus?.({ phase: "downloading", bytes, total }),
          onWaiting: (waiting) => input.onStatus?.({ phase: "waiting", ...waiting }),
        });
        input.onStatus?.({ phase: "installing" });
        const installStarted = now();
        await installAgentRuntimeArchive({ archivePath, pin, storeRoot: input.storeRoot });
        installMs = now() - installStarted;
        await rm(archivePath, { force: true });
        const done = await findAgentRuntime([input.storeRoot], pin);
        if (done.state !== "ready")
          throw new AgentRuntimeStoreError(
            "invalid-archive",
            "The installed runtime cannot be found.",
          );
        input.onStatus?.({ phase: "ready", executablePath: done.executablePath });
        return {
          executablePath: done.executablePath,
          report: report("ready", download, installMs, replacedDamaged),
        };
      },
    });
  } catch (error) {
    if (error instanceof PinnedDownloadError)
      throw new AgentRuntimeStoreError(error.failure, error.message, error.report);
    if (error instanceof AgentRuntimeStoreError) {
      if (error.failure === "invalid-archive") await rm(archivePath, { force: true });
      throw new AgentRuntimeStoreError(error.failure, error.message, download ?? undefined);
    }
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOSPC" || code === "EDQUOT")
      throw new AgentRuntimeStoreError("disk", String(error), download ?? undefined);
    throw error;
  }
}

/**
 * Removes runtime versions no pin in `keep` names, and staging folders left by processes that
 * are gone. The caller passes the pins in use, after the new version has started an agent once.
 */
export async function pruneAgentRuntimeStore(input: {
  readonly storeRoot: string;
  readonly keep: ReadonlyArray<AgentRuntimePin>;
}): Promise<string[]> {
  const removed: string[] = [];
  const keepDirs = new Set(input.keep.map((pin) => agentRuntimeInstallDir(input.storeRoot, pin)));
  const names = new Set(input.keep.map((pin) => pin.name));
  for (const name of names) {
    const entries = await readdir(join(input.storeRoot, name)).catch(() => [] as string[]);
    for (const entry of entries) {
      const directory = join(input.storeRoot, name, entry);
      if (keepDirs.has(directory)) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(directory);
    }
  }
  const staging = join(input.storeRoot, ".staging");
  for (const entry of await readdir(staging).catch(() => [] as string[])) {
    const pid = Number(/-(\d+)-[0-9a-f]+$/u.exec(entry)?.[1]);
    if (processAlive(pid)) continue;
    await rm(join(staging, entry), { recursive: true, force: true });
    removed.push(join(staging, entry));
  }
  return removed;
}
