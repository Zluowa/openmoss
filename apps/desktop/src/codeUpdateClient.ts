// FILE: codeUpdateClient.ts
// Purpose: Looks for a newer code update on the app's channel, checks the signed manifest, downloads
//          the package with the shared pinned downloader and has it applied in the background. The
//          new code starts at the next start (the boot entry decides; this module never loads code).
// Layer: Desktop main process. Transport and the apply step are injected: the desktop passes
//        Electron's net.fetch and a plain-Node child process, tests pass fetch and the shared apply.
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md §3 and §4.1.

import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  checkCodeUpdateManifest,
  CODE_UPDATE_CHANNELS,
  CODE_UPDATE_MAX_MANIFEST_BYTES,
  codeUpdateId,
  codeUpdateManifestPath,
  parseCodeUpdateManifest,
  sha256OfPath,
  type CodeUpdateApplyReport,
  type CodeUpdateChannel,
  type CodeUpdateManifest,
  type CodeUpdateRefusal,
} from "@moss/shared/codeUpdate";
import {
  isCodeUpdateEnabled,
  markCodeUpdatePending,
  parseCodeUpdateInstalled,
  readCodeUpdateStateSync,
  writeCodeUpdateStateSync,
  CODE_UPDATE_INSTALLED_FILE,
} from "@moss/shared/codeUpdateState";
import {
  MOSS_DOWNLOAD_SOURCES,
  type MossDownloadSourceOrder,
} from "@moss/shared/mossDownloadSources";
import {
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import {
  downloadPinnedFile,
  PinnedDownloadError,
  type PinnedDownloadFetch,
} from "@moss/shared/pinnedDownload";

import type { CodeUpdateBootHandle } from "./codeUpdateHealth";

export const CODE_UPDATE_FIRST_CHECK_MS = 2 * 60_000;
export const CODE_UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

export interface CodeUpdateClientConfig {
  readonly sources: ReadonlyArray<string>;
  readonly channel: CodeUpdateChannel;
  readonly publicKey: string;
  readonly firstCheckMs: number;
  readonly intervalMs: number;
  /** Test only (needs the loopback-only test key): the free bytes the disk check sees. */
  readonly testFreeBytes: number | null;
}

const isLoopbackHttp = (url: URL) =>
  url.protocol === "http:" &&
  (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");

/**
 * Null with the switch off. A test key is honoured only when every source is a loopback HTTP
 * server, so it can never make a public feed trusted.
 */
export function resolveCodeUpdateClientConfig(
  env: Readonly<Record<string, string | undefined>>,
  /** The ordered production sources (COS first in the mainland, R2 first elsewhere). */
  sourceOrder: MossDownloadSourceOrder = "global",
  platform: NodeJS.Platform = process.platform,
): CodeUpdateClientConfig | { readonly error: string } | null {
  if (!isCodeUpdateEnabled(env, platform)) return null;
  const channel = (env.MOSS_CODE_UPDATE_CHANNEL?.trim() || "preview") as CodeUpdateChannel;
  if (!CODE_UPDATE_CHANNELS.includes(channel)) return { error: `unknown channel ${channel}` };
  const rawSources = env.MOSS_CODE_UPDATE_FEED?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sources: string[] = [];
  for (const raw of rawSources?.length ? rawSources : MOSS_DOWNLOAD_SOURCES[sourceOrder]) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { error: `not a URL: ${raw}` };
    }
    if (url.username || url.password || url.search || url.hash) {
      return { error: "a source must not carry credentials, a query or a fragment" };
    }
    if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
      return { error: "a source must be HTTPS (plain HTTP only on loopback)" };
    }
    sources.push(url.href.endsWith("/") ? url.href : `${url.href}/`);
  }
  const testKey = env.MOSS_CODE_UPDATE_TEST_PUBLIC_KEY?.trim();
  if (testKey && !sources.every((source) => isLoopbackHttp(new URL(source)))) {
    return { error: "a test key is only accepted with loopback sources" };
  }
  const publicKey = testKey || MOSS_UPDATE_MANIFEST_PUBLIC_KEY;
  const number = (value: string | undefined, fallback: number) =>
    value && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  return {
    sources,
    channel,
    publicKey,
    firstCheckMs: number(env.MOSS_CODE_UPDATE_FIRST_CHECK_MS, CODE_UPDATE_FIRST_CHECK_MS),
    intervalMs: number(env.MOSS_CODE_UPDATE_INTERVAL_MS, CODE_UPDATE_CHECK_INTERVAL_MS),
    testFreeBytes:
      testKey && env.MOSS_CODE_UPDATE_TEST_FREE_BYTES?.trim()
        ? number(env.MOSS_CODE_UPDATE_TEST_FREE_BYTES, 0)
        : null,
  };
}

export type CodeUpdateCheckOutcome =
  | { readonly outcome: "pending"; readonly id: string; readonly report: CodeUpdateApplyReport }
  | { readonly outcome: "none"; readonly refusal: CodeUpdateRefusal; readonly detail: string }
  | { readonly outcome: "unreachable"; readonly detail: string }
  | { readonly outcome: "disk"; readonly id: string; readonly detail: string }
  | { readonly outcome: "download-failed"; readonly id: string; readonly detail: string }
  | { readonly outcome: "apply-failed"; readonly id: string; readonly detail: string };

export interface CodeUpdateApplyRequest {
  readonly manifest: CodeUpdateManifest;
  readonly packageFile: string;
  readonly installedArchive: string;
  readonly shellCommit: string;
  readonly storeDir: string;
}

/** What a problem is reported as (the desktop maps it onto its fixed diagnostics events). */
export interface CodeUpdateProblem {
  readonly stage: "download" | "install";
  readonly message: string;
}

export interface CodeUpdateClientDeps {
  readonly config: CodeUpdateClientConfig;
  readonly boot: Pick<
    CodeUpdateBootHandle,
    "id" | "sequence" | "storeDir" | "installedArchive" | "shellCommit"
  >;
  readonly fetch: PinnedDownloadFetch;
  readonly apply: (request: CodeUpdateApplyRequest) => Promise<CodeUpdateApplyReport>;
  readonly log: (line: string) => void;
  /** Size of the installed archive (the desktop reads it with original-fs). */
  readonly installedArchiveBytes: number;
  /** Free bytes on the store's drive, or null when unknown. */
  readonly freeBytes?: (dir: string) => Promise<number | null>;
  /** A new archive was written: the desktop prepares its static snapshot in the background. */
  readonly afterApply?: (id: string, archive: string) => void;
  readonly onProblem?: (problem: CodeUpdateProblem) => void;
  readonly signal?: AbortSignal;
  /** Test seam for the downloader's waits. */
  readonly downloadRetryDelaysMs?: ReadonlyArray<number>;
}

export const CODE_UPDATE_PACKAGES_DIR = "packages";
const packageFiles = (storeDir: string, id: string) => {
  const base = Path.join(storeDir, CODE_UPDATE_PACKAGES_DIR, id);
  return {
    package: `${base}.asar.zst`,
    manifest: `${base}.manifest.json`,
    signature: `${base}.manifest.json.sig`,
  };
};

/**
 * Bytes an apply needs on the store's drive: the new archive (installed archive less the old
 * code plus the new) and the unpacked code archive while it is spliced, plus 10 %.
 */
export function codeUpdateBytesNeeded(installedArchiveBytes: number, manifest: CodeUpdateManifest) {
  return Math.ceil((installedArchiveBytes + manifest.package.archiveSize) * 1.1);
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    await mkdir(dir, { recursive: true });
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function fetchSmallText(
  fetch: PinnedDownloadFetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  try {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > CODE_UPDATE_MAX_MANIFEST_BYTES) throw new Error("too large");
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** The checks, the apply and the record shared by a new update and a rebuild. */
async function applyAndRecord(
  deps: CodeUpdateClientDeps,
  input: {
    id: string;
    manifest: CodeUpdateManifest;
    manifestText: string;
    signature: string;
    packageFile: string;
  },
): Promise<CodeUpdateCheckOutcome> {
  const { boot, log } = deps;
  const storeDir = boot.storeDir!;
  const { id, manifest } = input;
  try {
    const report = await deps.apply({
      manifest,
      packageFile: input.packageFile,
      installedArchive: boot.installedArchive,
      shellCommit: boot.shellCommit!,
      storeDir,
    });
    // Keep the package and its signed manifest: an archive that goes missing is rebuilt from them.
    const kept = packageFiles(storeDir, id);
    await mkdir(Path.dirname(kept.package), { recursive: true });
    if (Path.resolve(input.packageFile) !== Path.resolve(kept.package)) {
      await rename(input.packageFile, kept.package);
    }
    await writeFile(kept.manifest, input.manifestText);
    await writeFile(kept.signature, input.signature);
    writeCodeUpdateStateSync(
      FS,
      storeDir,
      markCodeUpdatePending(readCodeUpdateStateSync(FS, storeDir), id),
    );
    log(
      `code-update ready id=${id} applied in ${Math.round(report.totalMs)} ms (unpack ${Math.round(report.unpackMs)}, splice ${Math.round(report.spliceMs)}) resultChecked=${report.resultChecked}; starts at the next launch`,
    );
    deps.afterApply?.(id, Path.join(storeDir, id, "app.asar"));
    return { outcome: "pending", id, report };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`code-update apply failed id=${id} ${detail}`);
    deps.onProblem?.({ stage: "install", message: `code update apply failed: ${detail}` });
    // A package that fails its checks is not kept: the next check downloads it again only if it
    // is still the newest, which a fixed build replaces.
    await rm(input.packageFile, { force: true }).catch(() => undefined);
    return { outcome: "apply-failed", id, detail };
  }
}

async function hasRoomFor(
  deps: CodeUpdateClientDeps,
  id: string,
  manifest: CodeUpdateManifest,
): Promise<CodeUpdateCheckOutcome | null> {
  const storeDir = deps.boot.storeDir!;
  const needed =
    codeUpdateBytesNeeded(deps.installedArchiveBytes, manifest) + manifest.package.size;
  const free = await (deps.freeBytes ?? defaultFreeBytes)(storeDir);
  if (free !== null && free < needed) {
    const detail = `needs ${needed} bytes on the store's drive, ${free} free`;
    deps.log(`code-update skipped id=${id}: not enough disk space (${detail})`);
    deps.onProblem?.({ stage: "download", message: `code update skipped: not enough disk space` });
    return { outcome: "disk", id, detail };
  }
  return null;
}

/** Rebuilds a healthy code's missing archive from its kept package; null when there is none. */
async function rebuildFromKeptPackage(
  deps: CodeUpdateClientDeps,
): Promise<CodeUpdateCheckOutcome | null> {
  const storeDir = deps.boot.storeDir!;
  const state = readCodeUpdateStateSync(FS, storeDir);
  const id = state.rebuild;
  if (!id) return null;
  const kept = packageFiles(storeDir, id);
  const drop = (detail: string): CodeUpdateCheckOutcome => {
    deps.log(`code-update rebuild dropped id=${id}: ${detail}`);
    const current = readCodeUpdateStateSync(FS, storeDir);
    writeCodeUpdateStateSync(FS, storeDir, {
      ...current,
      rebuild: null,
      packages: current.packages.filter((kept) => kept !== id),
    });
    return { outcome: "apply-failed", id, detail };
  };
  let manifestText: string;
  let signature: string;
  try {
    manifestText = await readFile(kept.manifest, "utf8");
    signature = await readFile(kept.signature, "utf8");
  } catch {
    return drop("its kept package is gone");
  }
  // The same signature check as a download; sequence and "already here" do not apply.
  if (
    !verifyMossUpdateManifest({
      channelFile: codeUpdateManifestPath(deps.config.channel),
      manifest: manifestText,
      signature,
      manifestPublicKey: deps.config.publicKey,
    })
  ) {
    return drop("its kept manifest no longer verifies");
  }
  const manifest = parseCodeUpdateManifest(manifestText);
  if (!manifest || codeUpdateId(manifest) !== id) return drop("its kept manifest is not for it");
  if (!deps.boot.shellCommit || !manifest.shells.includes(deps.boot.shellCommit)) {
    return drop("built for another shell");
  }
  try {
    if (
      (await stat(kept.package)).size !== manifest.package.size ||
      (await sha256OfPath(kept.package)) !== manifest.package.sha256
    ) {
      return drop("its kept package changed");
    }
  } catch {
    return drop("its kept package is gone");
  }
  const room = await hasRoomFor(deps, id, manifest);
  if (room) return room;
  deps.log(`code-update rebuilding id=${id} from its kept package`);
  return applyAndRecord(deps, { id, manifest, manifestText, signature, packageFile: kept.package });
}

/** One check: rebuild if needed, else manifest, checks, room, download, apply. Never throws. */
export async function runCodeUpdateCheck(
  deps: CodeUpdateClientDeps,
): Promise<CodeUpdateCheckOutcome> {
  const { config, boot, log } = deps;
  const storeDir = boot.storeDir;
  if (!storeDir) return { outcome: "none", refusal: "current", detail: "no store" };
  const rebuilt = await rebuildFromKeptPackage(deps);
  if (rebuilt) return rebuilt;
  const manifestPath = codeUpdateManifestPath(config.channel);

  let manifestText: string | null = null;
  let signature: string | null = null;
  let lastError = "no source";
  // A request header does not make the Cloudflare edge bypass an object it cached; a query does
  // (the updater does the same with `?noCache=`). Packages are immutable and fetched without one.
  const noCache = `?noCache=${Date.now()}`;
  for (const [index, source] of config.sources.entries()) {
    try {
      manifestText = await fetchSmallText(
        deps.fetch,
        `${source}${manifestPath}${noCache}`,
        deps.signal,
      );
      signature = await fetchSmallText(
        deps.fetch,
        `${source}${manifestPath}.sig${noCache}`,
        deps.signal,
      );
      break;
    } catch (error) {
      lastError = `source ${index}: ${error instanceof Error ? error.message : String(error)}`;
      manifestText = null;
    }
  }
  if (manifestText === null || signature === null) {
    log(`code-update check unreachable ${lastError}`);
    return { outcome: "unreachable", detail: lastError };
  }

  const state = readCodeUpdateStateSync(FS, storeDir);
  const fallbackLatestMigrations: number[] = [];
  if (boot.id) {
    try {
      const running = parseCodeUpdateInstalled(
        FS.readFileSync(Path.join(storeDir, boot.id, CODE_UPDATE_INSTALLED_FILE), "utf8"),
      );
      if (running) fallbackLatestMigrations.push(running.migrations.latest);
    } catch {
      // The running code's record is gone: nothing to compare against but the shell (build time).
    }
  }
  const check = checkCodeUpdateManifest({
    manifestText,
    signature,
    channel: config.channel,
    publicKey: config.publicKey,
    shellCommit: boot.shellCommit,
    runningSequence: boot.sequence,
    knownIds: [boot.id, state.active, state.pending, state.trial?.id].filter(
      (id): id is string => typeof id === "string",
    ),
    state,
    fallbackLatestMigrations,
  });
  if (!check.ok) {
    log(`code-update check refused=${check.refusal} detail=${check.detail}`);
    return { outcome: "none", refusal: check.refusal, detail: check.detail };
  }
  const { manifest, id } = check;
  log(
    `code-update found id=${id} commit=${manifest.commit.slice(0, 12)} size=${manifest.package.size}`,
  );
  const room = await hasRoomFor(deps, id, manifest);
  if (room) return room;

  const packageFile = Path.join(storeDir, "downloads", `${manifest.package.sha256}.asar.zst`);
  try {
    const report = await downloadPinnedFile({
      sources: config.sources.map((source) => `${source}${manifest.package.path}`),
      size: manifest.package.size,
      sha256: manifest.package.sha256,
      destinationPath: packageFile,
      fetch: deps.fetch,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.downloadRetryDelaysMs ? { retryDelaysMs: deps.downloadRetryDelaysMs } : {}),
    });
    log(
      `code-update downloaded id=${id} in ${report.durationMs} ms resumedFrom=${report.resumedFromBytes} source=${report.sourceIndex} switches=${report.switches}`,
    );
  } catch (error) {
    const detail =
      error instanceof PinnedDownloadError
        ? `${error.failure}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    log(`code-update download failed id=${id} ${detail}`);
    deps.onProblem?.({ stage: "download", message: `code update download failed: ${detail}` });
    return { outcome: "download-failed", id, detail };
  }
  return applyAndRecord(deps, { id, manifest, manifestText, signature, packageFile });
}
