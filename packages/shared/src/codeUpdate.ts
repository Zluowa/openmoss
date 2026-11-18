// FILE: codeUpdate.ts
// Purpose: Code updates: the signed manifest, the checks a client makes before it downloads, and the
//          apply step that turns a verified package into a store folder the boot can load.
// Layer: Shared release/runtime contract. The build script writes packages and manifests with it;
//        the desktop verifies and applies them with it (the apply step runs in a plain-Node child,
//        because Electron's own `fs` treats .asar files as folders).
//
// A code update carries only the app code (desktop main and preloads, the server bundle and the web
// client). The client splices it into a private copy of the installed archive; the installed app is
// never modified. Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

import {
  findAsarNode,
  isAsarDirectory,
  isAsarLink,
  readAsarArchive,
  spliceAsar,
  walkAsarFiles,
} from "./asarArchive";
import {
  CODE_UPDATE_ARCHIVE_FILE,
  CODE_UPDATE_INSTALLED_FILE,
  parseCodeUpdateInstalled,
  type CodeUpdateInstalled,
  type CodeUpdateState,
} from "./codeUpdateState";
import { signMossUpdateManifest, verifyMossUpdateManifest } from "./mossUpdateMirror";

/** The archive folders a code update replaces; everything else stays the installed shell's. */
export const CODE_UPDATE_DIRECTORIES = ["apps/desktop/dist-electron", "apps/server/dist"] as const;
/** Inside the code: names the code's own commit (package.json keeps naming the shell's). */
export const CODE_UPDATE_IDENTITY_PATH = "apps/desktop/dist-electron/moss-code.json";

export const CODE_UPDATE_CHANNELS = ["preview", "desktop"] as const;
export type CodeUpdateChannel = (typeof CODE_UPDATE_CHANNELS)[number];

/** Largest manifest a client reads, and largest archive it unpacks (decompression bomb guard). */
export const CODE_UPDATE_MAX_MANIFEST_BYTES = 64 * 1024;
export const CODE_UPDATE_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export const codeUpdateManifestPath = (channel: CodeUpdateChannel) => `${channel}/code/latest.json`;

export interface CodeUpdateManifest {
  readonly schema: 1;
  readonly channel: CodeUpdateChannel;
  /** Strictly increasing per channel (the commit's committer time); a lower one is a downgrade. */
  readonly sequence: number;
  readonly commit: string;
  readonly codeVersion: string;
  /** Commits of the installed shells this code may run on. */
  readonly shells: ReadonlyArray<string>;
  readonly package: {
    /** Relative to a source's root, e.g. `desktop/code/v1/moss-code-<commit12>-<sha16>.asar.zst`. */
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly archiveSize: number;
    readonly archiveSha256: string;
  };
  readonly migrations: { readonly latest: number; readonly readerFloor: number };
  /** Installed archive sha256 -> spliced archive sha256, for the shells the build had at hand. */
  readonly results: Readonly<Record<string, string>>;
}

export interface CodeUpdateIdentity {
  readonly commit: string;
  readonly codeVersion: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
/**
 * Where packages live under every source, shared by both channels. Under `desktop/` because that
 * prefix is already publicly readable on the COS bucket (domains session, 2026-11-18); a
 * top-level `code/v1/` would need a bucket-policy change with the owner's yes.
 */
export const CODE_UPDATE_PACKAGE_PREFIX = "desktop/code/v1/";
const PACKAGE_PATH = /^desktop\/code\/v1\/moss-code-[0-9a-f]{12}-[0-9a-f]{16}\.asar\.zst$/u;

export const codeUpdateId = (manifest: Pick<CodeUpdateManifest, "commit" | "package">) =>
  `${manifest.commit.slice(0, 12)}-${manifest.package.sha256.slice(0, 16)}`;

export const codeUpdatePackagePath = (commit: string, sha256: string) =>
  `${CODE_UPDATE_PACKAGE_PREFIX}moss-code-${commit.slice(0, 12)}-${sha256.slice(0, 16)}.asar.zst`;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const safeInteger = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;

/** Strict: anything unexpected is refused, not ignored. */
export function parseCodeUpdateManifest(text: string): CodeUpdateManifest | null {
  let raw: Record<string, unknown> | null;
  try {
    raw = record(JSON.parse(text));
  } catch {
    return null;
  }
  const pkg = record(raw?.package);
  const migrations = record(raw?.migrations);
  const results = record(raw?.results);
  if (
    !raw ||
    raw.schema !== 1 ||
    !CODE_UPDATE_CHANNELS.includes(raw.channel as CodeUpdateChannel) ||
    !safeInteger(raw.sequence, 1) ||
    typeof raw.commit !== "string" ||
    !COMMIT.test(raw.commit) ||
    typeof raw.codeVersion !== "string" ||
    raw.codeVersion.length > 64 ||
    !Array.isArray(raw.shells) ||
    raw.shells.length === 0 ||
    !raw.shells.every((shell) => typeof shell === "string" && COMMIT.test(shell)) ||
    !pkg ||
    typeof pkg.path !== "string" ||
    !PACKAGE_PATH.test(pkg.path) ||
    !safeInteger(pkg.size, 1) ||
    typeof pkg.sha256 !== "string" ||
    !SHA256.test(pkg.sha256) ||
    !safeInteger(pkg.archiveSize, 1) ||
    (pkg.archiveSize as number) > CODE_UPDATE_MAX_ARCHIVE_BYTES ||
    typeof pkg.archiveSha256 !== "string" ||
    !SHA256.test(pkg.archiveSha256) ||
    pkg.path !== codeUpdatePackagePath(raw.commit, pkg.sha256) ||
    !migrations ||
    !safeInteger(migrations.latest) ||
    !safeInteger(migrations.readerFloor) ||
    !results ||
    !Object.entries(results).every(
      ([key, value]) => SHA256.test(key) && typeof value === "string" && SHA256.test(value),
    )
  ) {
    return null;
  }
  return raw as unknown as CodeUpdateManifest;
}

export function signCodeUpdateManifest(input: {
  readonly manifest: string;
  readonly channel: CodeUpdateChannel;
  readonly privateKey: string;
}): string {
  return signMossUpdateManifest({
    channelFile: codeUpdateManifestPath(input.channel),
    manifest: input.manifest,
    privateKey: input.privateKey,
  });
}

export type CodeUpdateRefusal =
  | "signature"
  | "schema"
  | "channel"
  | "not-newer"
  | "shell"
  | "rejected"
  | "reader-floor"
  | "current";

export type CodeUpdateCheck =
  | { readonly ok: true; readonly manifest: CodeUpdateManifest; readonly id: string }
  | { readonly ok: false; readonly refusal: CodeUpdateRefusal; readonly detail: string };

export interface CodeUpdateCheckInput {
  readonly manifestText: string;
  readonly signature: string;
  readonly channel: CodeUpdateChannel;
  readonly publicKey: string;
  /** The installed archive's commit. */
  readonly shellCommit: string | null;
  /** Sequence of the code running now (0 for the installed archive). */
  readonly runningSequence: number;
  /** Ids already running, installed or pending: nothing to download. */
  readonly knownIds: ReadonlyArray<string>;
  readonly state: CodeUpdateState;
  /** Latest migration of each code a rollback may return to (installed code excluded: §4.4). */
  readonly fallbackLatestMigrations: ReadonlyArray<number>;
}

/** Every check that can be made before a byte of the package is downloaded, in this order. */
export function checkCodeUpdateManifest(input: CodeUpdateCheckInput): CodeUpdateCheck {
  const refuse = (refusal: CodeUpdateRefusal, detail: string): CodeUpdateCheck => ({
    ok: false,
    refusal,
    detail,
  });
  if (
    !verifyMossUpdateManifest({
      channelFile: codeUpdateManifestPath(input.channel),
      manifest: input.manifestText,
      signature: input.signature,
      manifestPublicKey: input.publicKey,
    })
  ) {
    return refuse("signature", "the manifest signature does not verify with the release key");
  }
  const manifest = parseCodeUpdateManifest(input.manifestText);
  if (!manifest) return refuse("schema", "the manifest is not a valid code update manifest");
  if (manifest.channel !== input.channel) {
    return refuse(
      "channel",
      `manifest is for ${manifest.channel}, this app reads ${input.channel}`,
    );
  }
  const id = codeUpdateId(manifest);
  if (input.state.rejected[id]) {
    return refuse("rejected", `${id} was rejected: ${input.state.rejected[id]!.reason}`);
  }
  if (input.knownIds.includes(id)) return refuse("current", `${id} is already here`);
  if (manifest.sequence <= input.runningSequence) {
    return refuse("not-newer", `sequence ${manifest.sequence} <= running ${input.runningSequence}`);
  }
  if (!input.shellCommit || !manifest.shells.includes(input.shellCommit)) {
    return refuse(
      "shell",
      `built for shells ${manifest.shells.map((shell) => shell.slice(0, 12)).join(", ")}; installed ${input.shellCommit?.slice(0, 12) ?? "unknown"}`,
    );
  }
  const floorTooHigh = input.fallbackLatestMigrations.find(
    (latest) => manifest.migrations.readerFloor > latest,
  );
  if (floorTooHigh !== undefined) {
    return refuse(
      "reader-floor",
      `reader floor ${manifest.migrations.readerFloor} is above the fallback's latest migration ${floorTooHigh}`,
    );
  }
  return { ok: true, manifest, id };
}

export async function sha256OfPath(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Reads the commit from the installed archive's package.json (plain-Node `fs` only). */
export async function readArchiveCommit(archive: string): Promise<string | null> {
  const parsed = await readAsarArchive(archive);
  const node = findAsarNode(parsed.header, "package.json");
  if (!node || isAsarDirectory(node) || isAsarLink(node) || node.offset === undefined) return null;
  const handle = await open(archive, "r");
  try {
    const bytes = Buffer.alloc(node.size);
    await handle.read(bytes, 0, node.size, parsed.dataStart + Number(node.offset));
    const commit = (JSON.parse(bytes.toString("utf8")) as { mossCommitHash?: unknown })
      .mossCommitHash;
    return typeof commit === "string" && COMMIT.test(commit) ? commit : null;
  } finally {
    await handle.close();
  }
}

export class CodeUpdateApplyError extends Error {
  constructor(
    readonly reason: "archive" | "content" | "result" | "disk",
    message: string,
  ) {
    super(message);
    this.name = "CodeUpdateApplyError";
  }
}

/** Decompresses with a hard size cap and the expected hash; never trusts the stream's own length. */
async function unpackPackage(input: {
  packageFile: string;
  output: string;
  archiveSize: number;
  archiveSha256: string;
}): Promise<void> {
  const hash = createHash("sha256");
  let written = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > input.archiveSize) {
        callback(
          new CodeUpdateApplyError("archive", "the package unpacks larger than its manifest says"),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(input.packageFile),
      zlib.createZstdDecompress(),
      guard,
      createWriteStream(input.output),
    );
  } catch (error) {
    if (error instanceof CodeUpdateApplyError) throw error;
    throw new CodeUpdateApplyError(
      "archive",
      `the package does not unpack: ${(error as Error).message}`,
    );
  }
  if (written !== input.archiveSize || hash.digest("hex") !== input.archiveSha256) {
    throw new CodeUpdateApplyError("archive", "the unpacked code does not match its manifest");
  }
}

/** The code archive may hold the two code folders and nothing else. */
async function readCodeIdentity(codeArchive: string, commit: string): Promise<CodeUpdateIdentity> {
  const parsed = await readAsarArchive(codeArchive);
  const allowed = new Set<string>(CODE_UPDATE_DIRECTORIES);
  for (const { path: archivePath, entry } of walkAsarFiles(parsed.header)) {
    if (![...allowed].some((dir) => archivePath.startsWith(`${dir}/`))) {
      throw new CodeUpdateApplyError("content", `unexpected path in the code: ${archivePath}`);
    }
    if (isAsarLink(entry) || entry.unpacked) {
      throw new CodeUpdateApplyError(
        "content",
        `link or unpacked entry in the code: ${archivePath}`,
      );
    }
  }
  const node = findAsarNode(parsed.header, CODE_UPDATE_IDENTITY_PATH);
  if (!node || isAsarDirectory(node) || isAsarLink(node) || node.offset === undefined) {
    throw new CodeUpdateApplyError("content", "the code carries no identity file");
  }
  const handle = await open(codeArchive, "r");
  try {
    const bytes = Buffer.alloc(node.size);
    await handle.read(bytes, 0, node.size, parsed.dataStart + Number(node.offset));
    const identity = JSON.parse(bytes.toString("utf8")) as Partial<CodeUpdateIdentity>;
    if (identity.commit !== commit || typeof identity.codeVersion !== "string") {
      throw new CodeUpdateApplyError("content", "the code's identity file names another commit");
    }
    return { commit, codeVersion: identity.codeVersion };
  } finally {
    await handle.close();
  }
}

/** Copies the installed archive's unpacked files (native modules) beside the new archive. */
async function copyUnpacked(installedArchive: string, targetArchive: string): Promise<number> {
  const parsed = await readAsarArchive(installedArchive);
  let copied = 0;
  for (const { path: archivePath, entry } of walkAsarFiles(parsed.header)) {
    if (isAsarLink(entry) || !entry.unpacked) continue;
    const from = path.join(`${installedArchive}.unpacked`, ...archivePath.split("/"));
    const to = path.join(`${targetArchive}.unpacked`, ...archivePath.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    if (entry.integrity && (await sha256OfPath(to)) !== entry.integrity.hash) {
      throw new CodeUpdateApplyError("content", `installed unpacked file changed: ${archivePath}`);
    }
    copied += 1;
  }
  return copied;
}

export interface CodeUpdateApplyInput {
  readonly manifest: CodeUpdateManifest;
  /** The downloaded package, already verified against manifest.package.{size,sha256}. */
  readonly packageFile: string;
  readonly installedArchive: string;
  readonly shellCommit: string;
  readonly storeDir: string;
  readonly now?: () => Date;
}

export interface CodeUpdateApplyReport {
  readonly installed: CodeUpdateInstalled;
  readonly unpackMs: number;
  readonly spliceMs: number;
  readonly totalMs: number;
  readonly resultChecked: boolean;
}

/**
 * Unpacks, checks and splices a verified package into `<store>/<id>/`, writing installed.json last.
 * Plain-Node `fs` only. A folder that already has installed.json is reused as it is.
 */
export async function applyCodeUpdate(input: CodeUpdateApplyInput): Promise<CodeUpdateApplyReport> {
  const started = performance.now();
  const id = codeUpdateId(input.manifest);
  const finalDir = path.join(input.storeDir, id);
  const staging = path.join(input.storeDir, `.staging-${id}-${randomBytes(4).toString("hex")}`);
  await mkdir(staging, { recursive: true });
  try {
    const codeArchive = path.join(staging, "code.asar");
    await unpackPackage({
      packageFile: input.packageFile,
      output: codeArchive,
      archiveSize: input.manifest.package.archiveSize,
      archiveSha256: input.manifest.package.archiveSha256,
    });
    const unpackMs = performance.now() - started;
    const identity = await readCodeIdentity(codeArchive, input.manifest.commit);
    const target = path.join(staging, CODE_UPDATE_ARCHIVE_FILE);
    const spliceStarted = performance.now();
    try {
      await spliceAsar({
        base: input.installedArchive,
        output: target,
        replaceFromArchive: { archive: codeArchive, directories: CODE_UPDATE_DIRECTORIES },
      });
    } catch (error) {
      throw new CodeUpdateApplyError("content", (error as Error).message);
    }
    await copyUnpacked(input.installedArchive, target);
    const spliceMs = performance.now() - spliceStarted;
    await rm(codeArchive, { force: true });

    const archiveSha256 = await sha256OfPath(target);
    let resultChecked = false;
    if (Object.keys(input.manifest.results).length > 0) {
      const expected = input.manifest.results[await sha256OfPath(input.installedArchive)];
      if (expected !== undefined) {
        if (expected !== archiveSha256) {
          throw new CodeUpdateApplyError("result", "the spliced archive differs from the build's");
        }
        resultChecked = true;
      }
    }
    const installed: CodeUpdateInstalled = {
      schema: 1,
      id,
      commit: identity.commit,
      codeVersion: identity.codeVersion,
      channel: input.manifest.channel,
      sequence: input.manifest.sequence,
      shellCommit: input.shellCommit,
      archiveSize: (await stat(target)).size,
      archiveSha256,
      migrations: input.manifest.migrations,
      installedAt: (input.now?.() ?? new Date()).toISOString(),
    };
    await writeFile(
      path.join(staging, CODE_UPDATE_INSTALLED_FILE),
      `${JSON.stringify(installed, null, 2)}\n`,
    );
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
    return {
      installed,
      unpackMs,
      spliceMs,
      totalMs: performance.now() - started,
      resultChecked,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads `<store>/<id>/installed.json` with plain `fs/promises` (tests and the apply child). */
export async function readInstalledCodeUpdate(
  storeDir: string,
  id: string,
): Promise<CodeUpdateInstalled | null> {
  try {
    return parseCodeUpdateInstalled(
      await readFile(path.join(storeDir, id, CODE_UPDATE_INSTALLED_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}
