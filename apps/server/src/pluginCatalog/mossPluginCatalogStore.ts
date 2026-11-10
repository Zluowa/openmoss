// FILE: mossPluginCatalogStore.ts
// Purpose: The Moss plugin catalog on disk: a native local marketplace
//          ("moss-catalog") that always lists every catalog plugin, so the CLI's
//          own listing, install and uninstall work for a Moss account with no
//          ChatGPT sign-in and no GitHub access. A plugin's files are fetched
//          from Moss's domestic mirror the first time it is opened or installed,
//          checked against the hash pinned in the app, and unpacked in place.
// Layer: Server plugin catalog (promise-based, Node filesystem)
// Exports: catalog root/marketplace helpers, ensureMossPluginCatalogPlugin,
//          prefetchMossPluginCatalog, MossPluginCatalogDownloadError

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_MARKETPLACE_DISPLAY_NAME,
  MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME,
  MOSS_PLUGIN_CATALOG_URL_ENV,
  type MossPluginCatalogEntry,
  mossPluginCatalogPackageUrl,
  normalizeMossPluginCatalogBaseUrl,
} from "@moss/shared/mossPluginCatalog";
import { decodeMossPluginPackage } from "@moss/shared/mossPluginPackage";

const CATALOG_DIRECTORY_NAME = "moss-plugin-catalog-v1";
const MARKETPLACE_MANIFEST = path.join(".agents", "plugins", "marketplace.json");
/** Written last inside an unpacked plugin: which pinned package it holds. */
const PACKAGE_RECEIPT = ".moss-package.json";
const DOWNLOAD_ATTEMPTS = 2;
const DOWNLOAD_TIMEOUT_MS = 45_000;

/** A download failure, worded for the person installing. */
export class MossPluginCatalogDownloadError extends Error {
  override readonly name = "MossPluginCatalogDownloadError";
  constructor(cause?: unknown) {
    super("Moss couldn't download this plugin. Check your connection and try again.", { cause });
  }
}

export function mossPluginCatalogRoot(stateDir: string): string {
  return path.join(stateDir, CATALOG_DIRECTORY_NAME);
}

export function mossPluginCatalogMarketplacePath(root: string): string {
  return path.join(root, MARKETPLACE_MANIFEST);
}

/** Whether a `plugin/install` or `plugin/read` selector names the catalog marketplace. */
export function isMossPluginCatalogMarketplacePath(
  root: string | undefined,
  marketplacePath: string | null | undefined,
): root is string {
  if (!root || !marketplacePath) return false;
  const left = path.resolve(marketplacePath);
  const right = path.resolve(mossPluginCatalogMarketplacePath(root));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function marketplaceManifest(entries: readonly MossPluginCatalogEntry[]): string {
  return `${JSON.stringify(
    {
      name: MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME,
      interface: { displayName: MOSS_PLUGIN_CATALOG_MARKETPLACE_DISPLAY_NAME },
      plugins: entries.map((entry) => ({
        name: entry.name,
        source: { source: "local", path: `./plugins/${entry.name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: entry.category,
      })),
    },
    null,
    2,
  )}\n`;
}

async function assertRealDirectory(candidate: string): Promise<void> {
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${candidate} must be a real directory.`);
  }
}

async function ensureDirectory(candidate: string): Promise<void> {
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await assertRealDirectory(candidate);
}

async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const current = await readFile(filePath, "utf8").catch(() => null);
  if (current === contents) return;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Writes the catalog marketplace (every plugin, files or not) and returns its
 * root for the managed CLI config. Idempotent; plugin folders are untouched.
 */
export async function materializeMossPluginCatalogMarketplace(
  root: string,
  catalog: readonly MossPluginCatalogEntry[] = MOSS_PLUGIN_CATALOG,
): Promise<string> {
  await ensureDirectory(root);
  await ensureDirectory(path.join(root, "plugins"));
  await ensureDirectory(path.join(root, ".agents", "plugins"));
  await writeFileAtomically(mossPluginCatalogMarketplacePath(root), marketplaceManifest(catalog));
  return root;
}

async function unpackedSha256(pluginDirectory: string): Promise<string | null> {
  try {
    const receipt: unknown = JSON.parse(
      await readFile(path.join(pluginDirectory, PACKAGE_RECEIPT), "utf8"),
    );
    return typeof receipt === "object" && receipt !== null && "sha256" in receipt
      ? String(receipt.sha256)
      : null;
  } catch {
    return null;
  }
}

async function download(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const inFlight = new Map<string, Promise<"present" | "downloaded">>();

export interface EnsureMossPluginCatalogPluginInput {
  readonly root: string;
  readonly name: string;
  /** Defaults to MOSS_PLUGIN_CATALOG_URL, then Moss's domestic mirror. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** The pinned catalog; tests pass their own. */
  readonly catalog?: readonly MossPluginCatalogEntry[];
}

/**
 * Makes sure the catalog plugin's pinned files are on disk: a no-op when they
 * are, otherwise one download (shared by concurrent callers), verified before
 * anything is written, unpacked beside the old copy and swapped in.
 */
export function ensureMossPluginCatalogPlugin(
  input: EnsureMossPluginCatalogPluginInput,
): Promise<"present" | "downloaded"> {
  const entry = (input.catalog ?? MOSS_PLUGIN_CATALOG).find(
    (candidate) => candidate.name === input.name,
  );
  if (!entry) return Promise.reject(new Error(`${input.name} is not in the Moss plugin catalog.`));
  const key = `${path.resolve(input.root)}::${entry.name}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = ensureUnpacked(input, entry).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function ensureUnpacked(
  input: EnsureMossPluginCatalogPluginInput,
  entry: MossPluginCatalogEntry,
): Promise<"present" | "downloaded"> {
  const pluginsDirectory = path.join(input.root, "plugins");
  const target = path.join(pluginsDirectory, entry.name);
  if ((await unpackedSha256(target)) === entry.package.sha256) return "present";

  let files;
  try {
    const baseUrl = normalizeMossPluginCatalogBaseUrl(
      input.baseUrl ?? process.env[MOSS_PLUGIN_CATALOG_URL_ENV],
    );
    const gzip = await download(
      mossPluginCatalogPackageUrl(baseUrl, entry),
      input.fetchImpl ?? fetch,
      input.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    );
    files = decodeMossPluginPackage({
      gzip,
      expectedName: entry.name,
      expectedVersion: entry.version,
      expectedSha256: entry.package.sha256,
    });
  } catch (error) {
    throw new MossPluginCatalogDownloadError(error);
  }

  await ensureDirectory(pluginsDirectory);
  const staging = path.join(pluginsDirectory, `.${entry.name}.${randomUUID()}.partial`);
  const retired = path.join(pluginsDirectory, `.${entry.name}.${randomUUID()}.old`);
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const file of files) {
      const destination = path.join(staging, ...file.path.split("/"));
      if (!destination.startsWith(staging + path.sep)) {
        throw new Error("The plugin package lists a file outside its folder.");
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
      if (file.executable && process.platform !== "win32") await chmod(destination, 0o700);
    }
    await writeFile(
      path.join(staging, PACKAGE_RECEIPT),
      `${JSON.stringify({ name: entry.name, version: entry.version, sha256: entry.package.sha256 })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const existing = await lstat(target).catch(() => null);
    if (existing) await rename(target, retired);
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(retired, { recursive: true, force: true });
  }
  return "downloaded";
}

const prefetches = new Map<string, Promise<void>>();

/**
 * Fetches every catalog plugin once in the background (about 2 MB from the
 * domestic mirror), so the directory shows each plugin's own icon and installs
 * finish at once, offline too. Failures are left for the next install to retry.
 */
export function prefetchMossPluginCatalog(
  root: string,
  options: Omit<EnsureMossPluginCatalogPluginInput, "root" | "name"> & {
    readonly onError?: (name: string, error: unknown) => void;
  } = {},
): Promise<void> {
  const key = path.resolve(root);
  const pending = prefetches.get(key);
  if (pending) return pending;
  const work = (async () => {
    for (const entry of options.catalog ?? MOSS_PLUGIN_CATALOG) {
      await ensureMossPluginCatalogPlugin({ ...options, root, name: entry.name }).catch(
        (error: unknown) => options.onError?.(entry.name, error),
      );
    }
  })().finally(() => prefetches.delete(key));
  prefetches.set(key, work);
  return work;
}
