// FILE: desktop-asar-cache.ts
// Purpose: Opt-in content-verified prepacked app.asar cache using spliceAsar so warm builds
//          skip re-packing 22,000+ unchanged node_modules files while preserving exact bytes.
// Layer: Release/build helper

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as Path from "node:path";

import { spliceAsar } from "@moss/shared/asarArchive";

import { copyTreeFast, linkOrCopyFile } from "./fast-stage-copy.ts";

export const DESKTOP_ASAR_CACHE_ENV = "MOSS_DESKTOP_ASAR_CACHE";
const CACHE_FORMAT_VERSION = "moss-desktop-asar-cache-v1";
const CACHE_ENTRY_NAME = /^[0-9a-f]{64}$/u;

const EXCLUDED_STAGE_SUBTREES = new Set([
  "app.asar",
  "dist",
  "node_modules",
  "package.json",
  "prepacked-app",
  "apps/desktop/dist-electron",
  "apps/server/dist",
  "apps/desktop/codex-runtime",
  "apps/desktop/claude-runtime",
  "apps/desktop/cua-driver-runtime",
  "apps/desktop/canvas-bundle",
  "apps/desktop/ssh-runtime.tar.gz",
  "apps/desktop/moss-job-launch",
  "apps/desktop/third-party-licenses",
]);

const IGNORED_MAIN_PACKAGE_PROPERTIES = new Set([
  "dist",
  "gitHead",
  "build",
  "jspm",
  "ava",
  "xo",
  "nyc",
  "eslintConfig",
  "contributors",
  "bundleDependencies",
  "tags",
  "scripts",
  "keywords",
  "devDependencies",
]);

interface AsarCacheReceipt {
  readonly formatVersion: string;
  readonly cacheKey: string;
  readonly asarSha256: string;
  readonly hasUnpackedDir: boolean;
  readonly savedAt: string;
}

export interface DesktopAsarCacheKeyInput {
  readonly stageAppDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly electronVersion: string;
  readonly agentRuntimes: string;
  readonly stageDepsCacheKey: string;
  readonly filesPatterns: ReadonlyArray<string>;
  readonly asarUnpackPatterns: ReadonlyArray<string>;
}

export interface PreparePrepackedAsarResult {
  readonly hit: boolean;
  readonly keptFiles: number;
  readonly newFiles: number;
  readonly outputBytes: number;
  readonly durationMs: number;
}

function sha256Buffer(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function copyFileAndSha256(sourcePath: string, targetPath: string): Promise<string> {
  const hash = createHash("sha256");
  const reader = createReadStream(sourcePath, { highWaterMark: 4 * 1024 * 1024 });
  const writer = createWriteStream(targetPath, { highWaterMark: 4 * 1024 * 1024 });
  await new Promise<void>((resolveDone, rejectDone) => {
    reader.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    reader.on("error", rejectDone);
    writer.on("error", rejectDone);
    writer.on("finish", resolveDone);
    reader.pipe(writer);
  });
  return hash.digest("hex");
}

export function resolveDesktopAsarCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env[DESKTOP_ASAR_CACHE_ENV]?.trim();
  return raw ? Path.resolve(raw) : undefined;
}

/**
 * Mirrors electron-builder's main package.json cleanup (`fileTransformer.js` `cleanupPackageJson`)
 * so the package.json spliced into a prepacked app.asar matches a full build's metadata.
 */
export function createAsarMainPackageJsonBuffer(
  stagePackageJson: Readonly<Record<string, unknown>>,
): Buffer {
  const cleaned: Record<string, unknown> = {};
  const deps = stagePackageJson.dependencies;
  const isRemoveBabel =
    deps !== null &&
    typeof deps === "object" &&
    !Object.getOwnPropertyNames(deps).some((name) => name.startsWith("babel"));
  for (const prop of Object.getOwnPropertyNames(stagePackageJson)) {
    if (
      prop.startsWith("_") ||
      IGNORED_MAIN_PACKAGE_PROPERTIES.has(prop) ||
      (isRemoveBabel && prop === "babel")
    ) {
      continue;
    }
    cleaned[prop] = stagePackageJson[prop];
  }
  return Buffer.from(JSON.stringify(cleaned, null, 2), "utf8");
}

async function hashRemainingStageFiles(
  stageAppDir: string,
): Promise<
  ReadonlyArray<{ readonly path: string; readonly size: number; readonly sha256: string }>
> {
  const results: Array<{ readonly path: string; readonly size: number; readonly sha256: string }> =
    [];

  const walk = async (dirPath: string, relPrefix: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (EXCLUDED_STAGE_SUBTREES.has(rel)) continue;
      const abs = Path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(abs);
        results.push({
          path: rel,
          size: bytes.byteLength,
          sha256: sha256Buffer(bytes),
        });
      }
    }
  };

  await walk(stageAppDir, "");
  results.sort((left, right) => left.path.localeCompare(right.path));
  return results;
}

export async function computeDesktopAsarBaseCacheKey(
  input: DesktopAsarCacheKeyInput,
): Promise<string> {
  const staticStageFiles = await hashRemainingStageFiles(input.stageAppDir);
  return sha256Buffer(
    JSON.stringify({
      formatVersion: CACHE_FORMAT_VERSION,
      platform: input.platform,
      arch: input.arch,
      electronVersion: input.electronVersion,
      agentRuntimes: input.agentRuntimes,
      stageDepsCacheKey: input.stageDepsCacheKey,
      filesPatterns: [...input.filesPatterns],
      asarUnpackPatterns: [...input.asarUnpackPatterns],
      staticStageFiles,
    }),
  );
}

async function readValidReceipt(
  entryDir: string,
  expectedKey: string,
): Promise<AsarCacheReceipt | null> {
  try {
    const receipt = JSON.parse(
      await readFile(Path.join(entryDir, "complete.json"), "utf8"),
    ) as Partial<AsarCacheReceipt>;
    if (
      receipt.formatVersion !== CACHE_FORMAT_VERSION ||
      receipt.cacheKey !== expectedKey ||
      typeof receipt.asarSha256 !== "string" ||
      typeof receipt.hasUnpackedDir !== "boolean"
    ) {
      return null;
    }
    const baseAsar = Path.join(entryDir, "app.asar");
    const actualSha = await sha256File(baseAsar);
    if (actualSha !== receipt.asarSha256) return null;
    if (receipt.hasUnpackedDir) {
      const unpackedStat = await stat(Path.join(entryDir, "app.asar.unpacked"));
      if (!unpackedStat.isDirectory()) return null;
    }
    return receipt as AsarCacheReceipt;
  } catch {
    return null;
  }
}

export async function preparePrepackedAsarFromCache(input: {
  readonly cacheDir: string;
  readonly cacheKey: string;
  readonly stageAppDir: string;
  readonly stagePackageJson: Readonly<Record<string, unknown>>;
}): Promise<PreparePrepackedAsarResult> {
  const startedAt = performance.now();
  const entryDir = Path.join(input.cacheDir, input.cacheKey);
  const receipt = await readValidReceipt(entryDir, input.cacheKey);
  if (!receipt) {
    return { hit: false, keptFiles: 0, newFiles: 0, outputBytes: 0, durationMs: 0 };
  }

  const prepackedDir = Path.join(input.stageAppDir, "prepacked-app");
  const prepackedAsar = Path.join(prepackedDir, "app.asar");
  const rootAsarMarker = Path.join(input.stageAppDir, "app.asar");
  try {
    await rm(prepackedDir, { recursive: true, force: true });
    await rm(rootAsarMarker, { force: true });
    await mkdir(prepackedDir, { recursive: true });

    const report = await spliceAsar({
      base: Path.join(entryDir, "app.asar"),
      output: prepackedAsar,
      replaceDirectories: {
        "apps/desktop/dist-electron": Path.join(input.stageAppDir, "apps/desktop/dist-electron"),
        "apps/server/dist": Path.join(input.stageAppDir, "apps/server/dist"),
      },
      replaceFiles: {
        "package.json": createAsarMainPackageJsonBuffer(input.stagePackageJson),
      },
    });
    // app-builder-lib detects prepacked app.asar by reading `<projectDir>/app.asar` when
    // `directories.app` has no package.json, then copies `<directories.app>/**` into resources/.
    await linkOrCopyFile(prepackedAsar, rootAsarMarker, true);
    if (receipt.hasUnpackedDir) {
      await copyTreeFast(
        Path.join(entryDir, "app.asar.unpacked"),
        Path.join(prepackedDir, "app.asar.unpacked"),
        { mode: "hardlink" },
      );
    }

    return {
      hit: true,
      keptFiles: report.keptFiles,
      newFiles: report.newFiles,
      outputBytes: report.outputBytes,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    await rm(prepackedDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(rootAsarMarker, { force: true }).catch(() => undefined);
    return { hit: false, keptFiles: 0, newFiles: 0, outputBytes: 0, durationMs: 0 };
  }
}

export async function saveDesktopAsarToCache(input: {
  readonly cacheDir: string;
  readonly cacheKey: string;
  readonly packagedResourcesDir: string;
  readonly keepEntries?: number;
}): Promise<{ readonly saved: boolean; readonly pruned: number }> {
  await mkdir(input.cacheDir, { recursive: true });
  const entryDir = Path.join(input.cacheDir, input.cacheKey);
  if (await readValidReceipt(entryDir, input.cacheKey)) {
    const pruned = await pruneOldAsarCacheEntries(
      input.cacheDir,
      input.cacheKey,
      input.keepEntries ?? 2,
    );
    return { saved: false, pruned };
  }

  const sourceAsar = Path.join(input.packagedResourcesDir, "app.asar");
  const sourceUnpacked = Path.join(input.packagedResourcesDir, "app.asar.unpacked");
  let hasUnpackedDir = false;
  try {
    hasUnpackedDir = (await stat(sourceUnpacked)).isDirectory();
  } catch {
    hasUnpackedDir = false;
  }

  const tempDir = Path.join(input.cacheDir, `.tmp-${input.cacheKey.slice(0, 12)}-${process.pid}`);
  await rm(tempDir, { recursive: true, force: true });
  try {
    await mkdir(tempDir, { recursive: true });
    const asarSha256 = await copyFileAndSha256(sourceAsar, Path.join(tempDir, "app.asar"));
    if (hasUnpackedDir) {
      await copyTreeFast(sourceUnpacked, Path.join(tempDir, "app.asar.unpacked"), {
        mode: "hardlink",
      });
    }
    const receipt: AsarCacheReceipt = {
      formatVersion: CACHE_FORMAT_VERSION,
      cacheKey: input.cacheKey,
      asarSha256,
      hasUnpackedDir,
      savedAt: new Date().toISOString(),
    };
    await writeFile(Path.join(tempDir, "complete.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await rm(entryDir, { recursive: true, force: true });
    await rename(tempDir, entryDir);
    const pruned = await pruneOldAsarCacheEntries(
      input.cacheDir,
      input.cacheKey,
      input.keepEntries ?? 2,
    );
    return { saved: true, pruned };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function pruneOldAsarCacheEntries(
  cacheDir: string,
  activeKey: string,
  keepEntries: number,
): Promise<number> {
  const limit = Math.max(1, keepEntries);
  const names = await readdir(cacheDir).catch(() => [] as string[]);
  const others: Array<{ readonly name: string; readonly mtimeMs: number }> = [];
  for (const name of names) {
    if (!CACHE_ENTRY_NAME.test(name) || name === activeKey) continue;
    try {
      const info = await stat(Path.join(cacheDir, name));
      others.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore entries disappearing concurrently.
    }
  }
  others.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let pruned = 0;
  for (const stale of others.slice(limit - 1)) {
    await rm(Path.join(cacheDir, stale.name), { recursive: true, force: true }).catch(
      () => undefined,
    );
    pruned += 1;
  }
  return pruned;
}
