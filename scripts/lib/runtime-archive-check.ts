// FILE: runtime-archive-check.ts
// Purpose: Proves that every agent runtime archive a release's `runtime-pins.json` names can be
//          read from every download source. The app downloads these archives right after install,
//          so a release whose pins name an object one source does not serve breaks first launch for
//          everyone that source answers. Used by scripts/sync-update-mirror.ts (per store, before
//          anything is written to it) and scripts/publish-desktop-feed-release.ts (before anything
//          is sent to GitHub).
// Layer: Release tooling; imports nothing from the scripts that use it, so neither forms a cycle.

import { setTimeout as sleep } from "node:timers/promises";

import { type AgentRuntimePin, agentRuntimeObjectPath } from "@moss/shared/agentRuntimeStore";
import { MOSS_DOWNLOAD_SOURCES } from "@moss/shared/mossDownloadSources";

/** The agent runtime pins of one app version, beside its channel manifests in the feed folder. */
export const RUNTIME_PINS_FILE_NAME = "runtime-pins.json";

const RUNTIMES_PREFIX = "runtimes/v1/";
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** What naming and checking one archive needs from a pin; a full `AgentRuntimePin` fits. */
export type RuntimeArchivePin = Pick<
  AgentRuntimePin,
  "name" | "version" | "platform" | "arch" | "archive"
>;

/**
 * The object's path on every source, from the app's own `agentRuntimeObjectPath`, so the check
 * asks for exactly what the app will request. That function names the object from the fields
 * above only; the rest of a full pin is filled in empty.
 */
export function runtimeArchiveObjectPath(pin: RuntimeArchivePin): string {
  return agentRuntimeObjectPath({ ...pin, executable: "", files: [] });
}

/** The only `runtime-pins.json` format these tools understand. */
export const RUNTIME_PINS_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Throws unless the path is a runtime object name under `runtimes/v1/` that carries its hash. */
export function assertRuntimeObjectPath(path: string, sha256: string): void {
  if (path.startsWith("/") || path.includes("\\") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) {
    throw new Error(`${path}: must be a relative path.`);
  }
  if (path.includes("?") || path.includes("#") || path.includes("%")) {
    throw new Error(`${path}: must be a plain object path.`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${path}: must not contain empty, "." or ".." segments.`);
  }
  if (!path.startsWith(RUNTIMES_PREFIX)) {
    throw new Error(`${path}: must be under ${RUNTIMES_PREFIX}.`);
  }
  const match = /^runtimes\/v1\/([^/]+)\/([^/]+)\/([^/]+)\.tar\.zst$/u.exec(path);
  if (!match) {
    throw new Error(`${path}: must be runtimes/v1/<name>/<version>/<file>.tar.zst.`);
  }
  const [, name, version, file] = match;
  if (!file!.startsWith(`${name}-${version}-`) || !file!.endsWith(`-${sha256.slice(0, 16)}`)) {
    throw new Error(
      `${path}: the file name must be <name>-<version>-<platform>-<arch>-<first 16 of its sha256>.`,
    );
  }
}

/**
 * Reads `runtime-pins.json` (`{ "schemaVersion": 1, "appVersion", "runtimes": [pin] }`). Only what
 * names and sizes each archive is checked and returned; the app verifies the files themselves.
 * Zero runtimes is valid.
 */
export function parseRuntimePins(text: string): ReadonlyArray<RuntimeArchivePin> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("runtime-pins.json is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("runtime-pins.json must be an object with schemaVersion and runtimes.");
  }
  if (parsed.schemaVersion !== RUNTIME_PINS_SCHEMA_VERSION) {
    throw new Error(
      `runtime-pins.json has schemaVersion ${JSON.stringify(parsed.schemaVersion)}; these tools read only schemaVersion ${RUNTIME_PINS_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(parsed.runtimes)) {
    throw new Error('runtime-pins.json has no "runtimes" list.');
  }
  return parsed.runtimes.map((entry: unknown): RuntimeArchivePin => {
    const archive = isRecord(entry) ? entry.archive : null;
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.platform !== "string" ||
      typeof entry.arch !== "string" ||
      !isRecord(archive) ||
      typeof archive.size !== "number" ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0 ||
      typeof archive.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(archive.sha256)
    ) {
      throw new Error(`runtime-pins.json has an invalid runtime: ${JSON.stringify(entry)}`);
    }
    const pin: RuntimeArchivePin = {
      name: entry.name,
      version: entry.version,
      platform: entry.platform,
      arch: entry.arch,
      archive: { size: archive.size, sha256: archive.sha256 },
    };
    assertRuntimeObjectPath(runtimeArchiveObjectPath(pin), pin.archive.sha256);
    return pin;
  });
}

/** Where a store serves `runtimes/v1/…`: the origin of its feed URL; one store defaults to R2. */
export function runtimeSourceBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly severalStores: boolean },
): string {
  const feedUrl = env.MOSS_UPDATE_MIRROR_FEED_URL?.trim();
  if (feedUrl) return new URL("/", feedUrl).toString();
  if (!options.severalStores) return MOSS_DOWNLOAD_SOURCES.global[0]!;
  throw new Error("Set MOSS_UPDATE_MIRROR_FEED_URL in every settings folder.");
}

export interface RuntimeArchiveSource {
  /** The settings folder, for messages. */
  readonly label: string;
  /** The source's public base URL; an object is served at `<base><object path>`. */
  readonly baseUrl: string;
}

export interface RuntimeArchiveServedLine {
  readonly store: string;
  readonly url: string;
  readonly ok: boolean;
  readonly problem: string | null;
}

type Probe =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly problem: string }
  | { readonly kind: "retry"; readonly problem: string };

/**
 * One anonymous one-byte GET. COS refuses HEAD, so this never sends one. R2 sometimes ignores the
 * range and answers 200 with the whole body; its length then proves the size, and the body is
 * cancelled unread.
 */
async function probeArchive(input: {
  readonly url: string;
  readonly size: number;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}): Promise<Probe> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: { range: "bytes=0-0" },
      credentials: "omit",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    return { kind: "retry", problem: error instanceof Error ? error.message : String(error) };
  }
  await response.body?.cancel().catch(() => undefined);
  // 408 and 429 say "ask again", not "no such object".
  if (response.status === 408 || response.status === 429) {
    return { kind: "retry", problem: `HTTP ${response.status}` };
  }
  if (response.status >= 400 && response.status < 500) {
    return { kind: "failed", problem: `not served (HTTP ${response.status})` };
  }
  let served: number | null = null;
  if (response.status === 206) {
    const total = /\/(\d+)\s*$/u.exec(response.headers.get("content-range") ?? "")?.[1];
    served = total === undefined ? null : Number(total);
  } else if (response.status === 200) {
    const length = response.headers.get("content-length")?.trim();
    served = length && /^\d+$/u.test(length) ? Number(length) : null;
  } else {
    return { kind: "retry", problem: `HTTP ${response.status}` };
  }
  if (served === null) {
    return { kind: "retry", problem: `HTTP ${response.status} without a usable length` };
  }
  if (served !== input.size) {
    return { kind: "failed", problem: `served ${served} bytes, pinned ${input.size}` };
  }
  return { kind: "ok" };
}

/**
 * Asks every store for every pinned archive and returns one line per store per object; a missing
 * object is a line, never a throw, so the caller decides. A 4xx (other than 408 and 429) or a wrong
 * size is final at once; a network error, timeout, 5xx or a reply without a usable length is tried
 * again a few times,
 * since a mainland line drops about one request in ten. This does not hash the bytes: the upload
 * tool reads every object back in full with its sha256, and the object name carries that hash.
 */
export async function checkRuntimeArchivesServed(input: {
  readonly pins: ReadonlyArray<RuntimeArchivePin>;
  readonly stores: ReadonlyArray<RuntimeArchiveSource>;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<RuntimeArchiveServedLine>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts = Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS);
  const lines: RuntimeArchiveServedLine[] = [];
  for (const store of input.stores) {
    for (const pin of input.pins) {
      const url = new URL(runtimeArchiveObjectPath(pin), store.baseUrl).toString();
      let probe: Probe = { kind: "retry", problem: "not checked" };
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        probe = await probeArchive({
          url,
          size: pin.archive.size,
          fetchImpl,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (probe.kind !== "retry") break;
      }
      lines.push({
        store: store.label,
        url,
        ok: probe.kind === "ok",
        problem:
          probe.kind === "ok"
            ? null
            : probe.kind === "failed"
              ? probe.problem
              : `not served after ${attempts} tries (${probe.problem})`,
      });
    }
  }
  return lines;
}

export function formatRuntimeArchiveLine(line: RuntimeArchiveServedLine): string {
  return `${line.ok ? "ok  " : "FAIL"} ${line.store} ${line.url}${line.problem ? `: ${line.problem}` : ""}`;
}

/** What to tell the operator when a store lacks pinned archives. */
export function runtimeArchivesMissingMessage(
  failed: ReadonlyArray<RuntimeArchiveServedLine>,
): string {
  return [
    `${failed.length} runtime archive(s) named in runtime-pins.json are not served:`,
    ...failed.map((line) => `  ${line.url} (${line.store}): ${line.problem}`),
    "Run `bun run scripts/upload-moss-runtimes.ts --out <build output>/runtimes`, then publish again. A fresh 404 on the Cloudflare host can stay cached at its edge for a few minutes after the upload.",
  ].join("\n");
}
