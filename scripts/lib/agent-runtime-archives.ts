// FILE: agent-runtime-archives.ts
// Purpose: In a `download` build, packs the staged, already verified agent runtimes into the
//          archives Moss fetches after install, pins them, and proves the archives unpack to
//          exactly the staged bytes with the same store code the app uses.
// Layer: Release/build helper

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as Zlib from "node:zlib";

import {
  agentRuntimeObjectPath,
  type AgentRuntimePin,
  installAgentRuntimeArchive,
} from "@moss/shared/agentRuntimeStore";
import { listTarEntries, writeTarArchive } from "@moss/shared/tarArchive";

export const AGENT_RUNTIMES_MODES = ["bundled", "download"] as const;
export type AgentRuntimesMode = (typeof AGENT_RUNTIMES_MODES)[number];
export const AGENT_RUNTIMES_ENV = "MOSS_DESKTOP_AGENT_RUNTIMES";

/** Embedded in app.asar and written next to the installer (signed and published as `runtime-pins.json`). */
export const AGENT_RUNTIME_PINS_FILE = "agent-runtime-pins.json";
export const AGENT_RUNTIME_PINS_FEED_FILE = "runtime-pins.json";
/** Under the output directory: `runtimes/v1/**` plus this list, for the upload and its read-back. */
export const AGENT_RUNTIME_OUTPUT_DIR = "runtimes";
export const AGENT_RUNTIME_ARCHIVE_LIST_FILE = "runtime-archives.json";
/** A folder kept between builds; the same staged runtime then reuses its packed archive. */
export const AGENT_RUNTIME_ARCHIVE_CACHE_ENV = "MOSS_AGENT_RUNTIME_ARCHIVE_CACHE";
const ARCHIVE_FORMAT = "moss-agent-runtime-archive-v1";

/**
 * zstd level 19 with long-distance matching over a 128 MiB window (the default decoder limit, so
 * the app needs no option). Measured 2026-11-18 on the 1.0.7 runtimes: Claude 327 MB → 117.2 MB
 * in 3.4 min (level 9: 132.0 MB in 21 s). A person's first chat waits on this download, so the
 * build pays once per runtime version: archives are cached by content (see `cacheDir`).
 */
export const AGENT_RUNTIME_ZSTD_PARAMS = {
  [Zlib.constants.ZSTD_c_compressionLevel]: 19,
  [Zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
  [Zlib.constants.ZSTD_c_windowLog]: 27,
} as const;

/**
 * `download` takes the agent runtimes out of the installer. Only unsigned Windows builds take
 * it for now: macOS waits for a signed and notarized archive proven on the ops Mac, and signed
 * Windows builds verify the runtimes inside the final installer (not yet adapted).
 */
export function resolveAgentRuntimesMode(input: {
  readonly requested: string | undefined;
  readonly platform: "mac" | "linux" | "win";
  readonly signed: boolean;
}): AgentRuntimesMode {
  const requested = input.requested?.trim() || "bundled";
  if (!(AGENT_RUNTIMES_MODES as ReadonlyArray<string>).includes(requested))
    throw new Error(`${AGENT_RUNTIMES_ENV} must be bundled or download, got ${requested}.`);
  if (requested === "bundled") return "bundled";
  if (input.platform !== "win")
    throw new Error(
      "--agent-runtimes download is Windows-only until a signed and notarized runtime archive is proven on macOS.",
    );
  if (input.signed)
    throw new Error(
      "--agent-runtimes download does not support --signed yet: the signed installer checks verify the runtimes inside it.",
    );
  return "download";
}

/** One staged runtime folder, as the build verified it. */
export interface StagedAgentRuntime {
  readonly name: string;
  readonly version: string;
  /** Node platform and arch names (`win32`, `x64`), as the app reads them from `process`. */
  readonly platform: string;
  readonly arch: string;
  readonly root: string;
  /** Forward-slash path of the program inside `root`. */
  readonly executable: string;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface PackedAgentRuntime {
  readonly pin: AgentRuntimePin;
  /** Path relative to the output root, the same as on every download source. */
  readonly objectPath: string;
  readonly archivePath: string;
}

/** Packs one staged runtime deterministically (tar) into `<outputRoot>/<objectPath>` and pins it. */
export async function packAgentRuntimeArchive(input: {
  readonly runtime: StagedAgentRuntime;
  readonly outputRoot: string;
  /** Packed archives keyed by their exact input; reused when the staged runtime is the same. */
  readonly cacheDir?: string | undefined;
}): Promise<PackedAgentRuntime & { readonly fromCache: boolean }> {
  const { runtime } = input;
  const entries = await listTarEntries(runtime.root);
  if (!entries.some((entry) => entry.path === runtime.executable))
    throw new Error(`${runtime.name}: the staged runtime has no ${runtime.executable}.`);
  const files = [];
  for (const entry of entries)
    files.push({
      path: entry.path,
      size: entry.size,
      sha256: await sha256OfFile(entry.absolutePath),
      executable: (entry.mode & 0o111) !== 0 || entry.path === runtime.executable,
    });
  const temporary = Path.join(input.outputRoot, ".packing", `${runtime.name}.tar.zst`);
  await mkdir(Path.dirname(temporary), { recursive: true });
  // Everything that decides the archive's bytes: the files, the format, the codec and its version.
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        format: ARCHIVE_FORMAT,
        zstd: process.versions.zstd ?? process.versions.node,
        params: AGENT_RUNTIME_ZSTD_PARAMS,
        files,
      }),
    )
    .digest("hex");
  const cached = input.cacheDir ? Path.join(input.cacheDir, `${cacheKey}.tar.zst`) : null;
  let fromCache = false;
  if (cached && existsSync(cached) && existsSync(`${cached}.sha256`)) {
    await copyFile(cached, temporary);
    const recorded = (await readFile(`${cached}.sha256`, "utf8")).trim();
    fromCache = recorded === (await sha256OfFile(temporary));
  }
  if (!fromCache) {
    await pipeline(
      Readable.from(writeTarArchive(entries)),
      Zlib.createZstdCompress({ params: AGENT_RUNTIME_ZSTD_PARAMS }),
      createWriteStream(temporary),
    );
  }
  const pin: AgentRuntimePin = {
    name: runtime.name,
    version: runtime.version,
    platform: runtime.platform,
    arch: runtime.arch,
    archive: { size: (await stat(temporary)).size, sha256: await sha256OfFile(temporary) },
    executable: runtime.executable,
    files,
  };
  const objectPath = agentRuntimeObjectPath(pin);
  const archivePath = Path.join(input.outputRoot, ...objectPath.split("/"));
  await mkdir(Path.dirname(archivePath), { recursive: true });
  await rename(temporary, archivePath);
  await rm(Path.join(input.outputRoot, ".packing"), { recursive: true, force: true });
  if (cached && !fromCache) {
    await mkdir(Path.dirname(cached), { recursive: true });
    await copyFile(archivePath, `${cached}.tmp`);
    await rename(`${cached}.tmp`, cached);
    await writeFile(`${cached}.sha256`, `${pin.archive.sha256}\n`);
  }
  return { pin, objectPath, archivePath, fromCache };
}

/**
 * Unpacks an archive with the app's own store code into `<verifyRoot>/<layoutName>`, which checks
 * every file against the pin. The result has the layout the runtime has in resources/, so the
 * build's existing packaged-runtime checks can run on what a person will actually get.
 */
export async function unpackAgentRuntimeForVerification(input: {
  readonly packed: PackedAgentRuntime;
  readonly verifyRoot: string;
  readonly layoutName: string;
}): Promise<string> {
  const store = Path.join(input.verifyRoot, ".store");
  const installed = await installAgentRuntimeArchive({
    archivePath: input.packed.archivePath,
    pin: input.packed.pin,
    storeRoot: store,
  });
  await rm(Path.join(installed, "installed.json"), { force: true });
  const destination = Path.join(input.verifyRoot, input.layoutName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(Path.dirname(destination), { recursive: true });
  await rename(installed, destination);
  await rm(store, { recursive: true, force: true });
  return destination;
}

export interface AgentRuntimePinsDocument {
  readonly schemaVersion: 1;
  readonly appVersion: string;
  readonly runtimes: ReadonlyArray<AgentRuntimePin>;
}

export function agentRuntimePinsDocument(input: {
  readonly appVersion: string;
  readonly pins: ReadonlyArray<AgentRuntimePin>;
}): AgentRuntimePinsDocument {
  return { schemaVersion: 1, appVersion: input.appVersion, runtimes: input.pins };
}

/** What the upload writes to every source and reads back: path, size and sha256 per object. */
export function agentRuntimeArchiveList(packed: ReadonlyArray<PackedAgentRuntime>) {
  return {
    schemaVersion: 1 as const,
    objects: packed.map((entry) => ({
      path: entry.objectPath,
      size: entry.pin.archive.size,
      sha256: entry.pin.archive.sha256,
    })),
  };
}

/** The packaged app's resources folder (the one holding app.asar) under electron-builder's output. */
export function findPackagedResourcesDirectory(stageDistDir: string): string {
  const found: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (existsSync(Path.join(directory, "app.asar"))) {
      found.push(directory);
      return;
    }
    if (depth >= 4) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) visit(Path.join(directory, entry.name), depth + 1);
  };
  visit(stageDistDir, 0);
  if (found.length !== 1)
    throw new Error(`Expected one packaged resources folder, found ${found.length}.`);
  return found[0]!;
}
