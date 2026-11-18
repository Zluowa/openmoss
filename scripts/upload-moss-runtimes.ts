// FILE: upload-moss-runtimes.ts
// Purpose: Publishes the agent runtime archives a build packed (for runtimes fetched after
//          install) to every download source's store, and proves each one is served. Objects are
//          immutable and their names carry the first 16 hex digits of their sha256, so an object
//          already stored at the same size is skipped, and one stored at another size is a broken
//          build: the run fails and nothing is written into that store. Every object is then read back
//          through each store's public URL with a full GET (never HEAD: the COS source answers HEAD
//          with 403) and its size and sha256 compared with the list.
// Usage:   bun run scripts/upload-moss-runtimes.ts --out <build output>/runtimes
//          The folder holds `runtime-archives.json` (`{ "schemaVersion": 1, "objects": [...] }`)
//          and the `runtimes/v1/**` objects it lists.
//          Store settings as for scripts/sync-update-mirror.ts: one folder, or one folder per
//          store listed in MOSS_UPDATE_MIRROR_SETTINGS_DIRS (the environment, or a line in the
//          default settings folder); see docs/ops/moss-cn-update-mirror.md.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { assertRuntimeObjectPath, runtimeSourceBaseUrl } from "./lib/runtime-archive-check.ts";
import {
  describeUpdateMirrorStoreList,
  readUpdateMirrorS3ClientOptions,
  resolveUpdateMirrorStores,
  type UpdateMirrorStore,
} from "./sync-update-mirror.ts";

// Kept here too, where the upload tests and earlier callers import them from.
export { assertRuntimeObjectPath, runtimeSourceBaseUrl };

export const RUNTIME_ARCHIVES_FILE_NAME = "runtime-archives.json";
const SERVED_ATTEMPTS = 6;
const SERVED_RETRY_DELAY_MS = 15_000;
const UPLOAD_RETRIES = 3;

export interface RuntimeArchive {
  /** `runtimes/v1/<name>/<version>/<name>-<version>-<platform>-<arch>-<sha16>.tar.zst` */
  readonly path: string;
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The only list format this tool understands; a newer builder must not be half-read. */
export const RUNTIME_ARCHIVES_SCHEMA_VERSION = 1;

/**
 * Reads `runtime-archives.json` as the builder writes it:
 * `{ "schemaVersion": 1, "objects": [{ "path", "size", "sha256" }] }`.
 */
export function parseRuntimeArchiveList(text: string): ReadonlyArray<RuntimeArchive> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(
      `${RUNTIME_ARCHIVES_FILE_NAME} must be an object with schemaVersion and objects.`,
    );
  }
  if (parsed.schemaVersion !== RUNTIME_ARCHIVES_SCHEMA_VERSION) {
    throw new Error(
      `${RUNTIME_ARCHIVES_FILE_NAME} has schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this tool reads only schemaVersion ${RUNTIME_ARCHIVES_SCHEMA_VERSION}. Update the upload tool before publishing this build.`,
    );
  }
  const entries = parsed.objects;
  if (!Array.isArray(entries)) {
    throw new Error(`${RUNTIME_ARCHIVES_FILE_NAME} has no "objects" list.`);
  }
  const seen = new Set<string>();
  return entries.map((entry: unknown): RuntimeArchive => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(
        `${RUNTIME_ARCHIVES_FILE_NAME} has an invalid entry: ${JSON.stringify(entry)}`,
      );
    }
    assertRuntimeObjectPath(entry.path, entry.sha256);
    if (seen.has(entry.path)) {
      throw new Error(`${RUNTIME_ARCHIVES_FILE_NAME} lists ${entry.path} twice.`);
    }
    seen.add(entry.path);
    return { path: entry.path, size: entry.size, sha256: entry.sha256 };
  });
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Every listed object must be in the folder with exactly the listed size and sha256. */
export async function readLocalRuntimeArchives(
  outDirectory: string,
): Promise<ReadonlyArray<RuntimeArchive & { readonly localPath: string }>> {
  const archives = parseRuntimeArchiveList(
    await readFile(join(outDirectory, RUNTIME_ARCHIVES_FILE_NAME), "utf8"),
  );
  if (archives.length === 0) throw new Error(`${RUNTIME_ARCHIVES_FILE_NAME} lists nothing.`);
  const problems: string[] = [];
  const local: Array<RuntimeArchive & { readonly localPath: string }> = [];
  for (const archive of archives) {
    const localPath = join(outDirectory, ...archive.path.split("/"));
    const size = await stat(localPath).then(
      (info) => (info.isFile() ? info.size : null),
      () => null,
    );
    if (size === null) {
      problems.push(`${archive.path}: missing from ${outDirectory}.`);
      continue;
    }
    if (size !== archive.size) {
      problems.push(`${archive.path}: ${size} bytes here, ${archive.size} in the list.`);
      continue;
    }
    if ((await sha256OfFile(localPath)) !== archive.sha256) {
      problems.push(`${archive.path}: its sha256 differs from the list.`);
      continue;
    }
    local.push({ ...archive, localPath });
  }
  if (problems.length > 0) {
    throw new Error(
      `The build output does not match its list; nothing was uploaded:\n${problems.join("\n")}`,
    );
  }
  return local;
}

export interface RuntimeStoreTarget {
  readonly label: string;
  readonly store: UpdateMirrorStore;
  /** The source's public base URL; an object is served at `<base><path>`. */
  readonly publicBaseUrl: string;
}

type ServedCheck = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/** A full GET with a streamed sha256. Not served yet gets a few more tries; wrong bytes do not. */
async function checkServed(input: {
  readonly url: string;
  readonly archive: RuntimeArchive;
  readonly fetchImpl: typeof fetch;
  readonly attempts: number;
  readonly retryDelayMs: number;
}): Promise<ServedCheck> {
  let lastProblem = "not checked";
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    if (attempt > 0) await sleep(input.retryDelayMs);
    const response = await input.fetchImpl(input.url, { method: "GET" }).catch((error: unknown) => {
      lastProblem = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (!response) continue;
    if (response.status !== 200 || !response.body) {
      lastProblem = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== input.archive.size) {
      return { ok: false, problem: `served ${size} bytes, listed ${input.archive.size}` };
    }
    if (hash.digest("hex") !== input.archive.sha256) {
      return { ok: false, problem: "served bytes differ from the listed sha256" };
    }
    return { ok: true };
  }
  return { ok: false, problem: `not served (${lastProblem})` };
}

export interface RuntimeUploadLine {
  readonly store: string;
  readonly path: string;
  readonly action: "uploaded" | "already stored" | "conflict" | "not uploaded";
  readonly served: boolean;
  readonly problem: string | null;
}

/**
 * Uploads every listed archive to every store and reads each back through the store's public URL.
 * One line per object per store; throws at the end if any store lacks or mismatches any object.
 */
export async function uploadRuntimeArchives(input: {
  readonly outDirectory: string;
  readonly stores: ReadonlyArray<RuntimeStoreTarget>;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly log?: (message: string) => void;
}): Promise<ReadonlyArray<RuntimeUploadLine>> {
  const log = input.log ?? ((message: string) => console.log(message));
  const archives = await readLocalRuntimeArchives(input.outDirectory);
  const lines: RuntimeUploadLine[] = [];
  for (const target of input.stores) {
    const actions = new Map<string, RuntimeUploadLine["action"]>();
    const problems = new Map<string, string>();
    try {
      // Look at everything first: an object of another size means this build reuses a name for
      // other bytes, and nothing may be written over it.
      for (const archive of archives) {
        const stored = await target.store.sizeOf(archive.path);
        if (stored === null) actions.set(archive.path, "uploaded");
        else if (stored === archive.size) actions.set(archive.path, "already stored");
        else {
          actions.set(archive.path, "conflict");
          problems.set(
            archive.path,
            `already stored with ${stored} bytes, listed ${archive.size}; not overwritten`,
          );
        }
      }
      // A conflict means the list or the store is not what this build expects: write nothing.
      const conflicted = [...actions.values()].includes("conflict");
      for (const archive of archives) {
        if (actions.get(archive.path) !== "uploaded") continue;
        if (conflicted) {
          actions.set(archive.path, "not uploaded");
          problems.set(archive.path, "held back: another object conflicts in this store");
          continue;
        }
        try {
          await target.store.upload(archive.path, archive.localPath);
        } catch (error) {
          actions.set(archive.path, "not uploaded");
          problems.set(
            archive.path,
            `upload failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const archive of archives) {
        if (!problems.has(archive.path)) {
          actions.set(archive.path, actions.get(archive.path) ?? "not uploaded");
          problems.set(archive.path, `store unavailable: ${message}`);
        }
      }
    }
    for (const archive of archives) {
      const served = await checkServed({
        url: new URL(archive.path, target.publicBaseUrl).toString(),
        archive,
        fetchImpl: input.fetchImpl ?? fetch,
        attempts: input.attempts ?? SERVED_ATTEMPTS,
        retryDelayMs: input.retryDelayMs ?? SERVED_RETRY_DELAY_MS,
      });
      const problem = [problems.get(archive.path), served.ok ? null : served.problem]
        .filter((value): value is string => Boolean(value))
        .join("; ");
      const line: RuntimeUploadLine = {
        store: target.label,
        path: archive.path,
        action: actions.get(archive.path) ?? "not uploaded",
        served: served.ok,
        problem: problem || null,
      };
      lines.push(line);
      log(
        `${line.problem ? "FAIL" : "ok  "} ${line.store} ${line.path} (${line.action}${line.served ? ", served" : ""})${line.problem ? `: ${line.problem}` : ""}`,
      );
    }
  }
  const failed = lines.filter((line) => line.problem !== null);
  if (failed.length > 0) {
    const stores = [...new Set(failed.map((line) => line.store))];
    throw Object.assign(
      new Error(
        `${failed.length} runtime object(s) are missing or wrong in ${stores.length} store(s): ${stores.join(", ")}`,
      ),
      { lines },
    );
  }
  return lines;
}

function createS3RuntimeStore(
  env: Readonly<Record<string, string | undefined>>,
): UpdateMirrorStore {
  const client = new Bun.S3Client(readUpdateMirrorS3ClientOptions(env));
  return {
    upload: async (key, localPath) => {
      await client.file(key).write(Bun.file(localPath), {
        type: "application/zstd",
        retry: UPLOAD_RETRIES,
      });
    },
    sizeOf: async (key) => {
      try {
        return (await client.file(key).stat()).size;
      } catch {
        return null;
      }
    },
  };
}

/** Resolves the stores from the settings folders, then uploads to and checks every one. */
export async function runRuntimeUpload(input: {
  readonly outDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly createStore?: (env: Readonly<Record<string, string | undefined>>) => UpdateMirrorStore;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly log?: (message: string) => void;
}): Promise<ReadonlyArray<RuntimeUploadLine>> {
  const log = input.log ?? ((message: string) => console.log(message));
  const resolution = await resolveUpdateMirrorStores({
    env: input.env,
    homeDirectory: input.homeDirectory,
    files: ["update-mirror.env", "update-mirror-upload.env"],
  });
  const listNote = describeUpdateMirrorStoreList(resolution);
  if (listNote) log(listNote);
  const { severalStores } = resolution;
  return uploadRuntimeArchives({
    outDirectory: input.outDirectory,
    stores: resolution.stores.map((store) => ({
      label: store.label,
      store: (input.createStore ?? createS3RuntimeStore)(store.env),
      publicBaseUrl: runtimeSourceBaseUrl(store.env, { severalStores }),
    })),
    log,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
  });
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  const outFlag = args.indexOf("--out");
  const out = outFlag >= 0 ? args[outFlag + 1] : undefined;
  if (!out) throw new Error("Usage: upload-moss-runtimes.ts --out <build output>/runtimes");
  await runRuntimeUpload({
    outDirectory: resolve(out),
    env: process.env,
    homeDirectory: homedir(),
  });
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
