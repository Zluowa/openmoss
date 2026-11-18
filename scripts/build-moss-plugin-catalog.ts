// FILE: build-moss-plugin-catalog.ts
// Purpose: Builds the Moss plugin catalog's packages from a pinned commit of the
//          upstream open-source plugin repository, pins their hashes in
//          `packages/shared/src/mossPluginCatalogPackages.ts`, and publishes them
//          to every download source's store (Cloudflare R2 and Tencent COS), where the
//          desktop app downloads a plugin's files the first time someone installs it.
//          Files are read from git objects, not the working tree, so a checkout's
//          line-ending settings cannot change a hash.
// Usage:
//   bun run scripts/build-moss-plugin-catalog.ts build --source <plugins checkout> --out <dir> [--commit <sha>] [--write-index]
//   bun run scripts/build-moss-plugin-catalog.ts upload --out <dir>
//   bun run scripts/build-moss-plugin-catalog.ts verify [--base-url <url>]
//   Upload reads the update mirror's storage settings (docs/ops/moss-cn-update-mirror.md) from the
//   environment or ~/.moss-release, or one folder per store listed in MOSS_UPDATE_MIRROR_SETTINGS_DIRS
//   (the environment, or a line in ~/.moss-release),
//   and writes under MOSS_PLUGIN_CATALOG_S3_PREFIX (default `plugin-catalog/v1/`) in each store.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_SELECTION,
  MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL,
  MOSS_PLUGIN_CATALOG_SOURCE,
  MOSS_PLUGIN_CATALOG_URL_ENV,
  type MossPluginCatalogPackage,
  mossPluginCatalogIconUrl,
  mossPluginCatalogPackageUrl,
  normalizeMossPluginCatalogBaseUrl,
} from "@moss/shared/mossPluginCatalog";
import {
  decodeMossPluginPackage,
  encodeMossPluginPackage,
  type MossPluginPackageFile,
} from "@moss/shared/mossPluginPackage";
import { parse } from "yaml";

import {
  describeUpdateMirrorStoreList,
  readUpdateMirrorS3ClientOptions,
  resolveUpdateMirrorStores,
  type UpdateMirrorStoreSettings,
} from "./sync-update-mirror.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const INDEX_PATH = join(REPO_ROOT, "packages/shared/src/mossPluginCatalogPackages.ts");
const DEFAULT_S3_PREFIX = "plugin-catalog/v1/";
const SKILL_DESCRIPTION_LIMIT = 280;
const SERVED_FILE_ATTEMPTS = Number(process.env.MOSS_PLUGIN_CATALOG_VERIFY_ATTEMPTS ?? 6);
const SERVED_FILE_RETRY_DELAY_MS = 15_000;
const ICON_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

interface GitEntry {
  readonly mode: string;
  readonly sha: string;
  readonly path: string;
}

function git(source: string, args: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync("git", ["-C", source, ...args], {
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}

function listTree(source: string, commit: string, folder: string): GitEntry[] {
  return git(source, ["ls-tree", "-r", "-z", commit, "--", `${folder}/`])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/u.exec(line);
      if (!match?.[1] || !match[3] || !match[4])
        throw new Error(`Unexpected ls-tree line: ${line}`);
      return { mode: match[1], sha: match[3], path: match[4] };
    });
}

/** Blob contents by sha, read in one `git cat-file --batch` pass. */
function readBlobs(source: string, shas: readonly string[]): Map<string, Buffer> {
  const output = git(source, ["cat-file", "--batch"], Buffer.from(`${shas.join("\n")}\n`));
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [sha, type, size] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (!sha || type !== "blob" || size === undefined) {
      throw new Error(`Unexpected cat-file header at ${offset}.`);
    }
    const start = headerEnd + 1;
    const end = start + Number(size);
    blobs.set(sha, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
  if (!match?.[1]) return {};
  const parsed: unknown = parse(match[1]);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function clip(value: string, limit: number): string {
  const single = value.replaceAll(/\s+/gu, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1).trimEnd()}…`;
}

interface BuiltPlugin {
  readonly entry: MossPluginCatalogPackage;
  readonly gzip: Uint8Array;
  readonly iconBytes: Uint8Array | null;
}

function buildPlugin(source: string, commit: string, name: string): BuiltPlugin {
  const folder = `plugins/${name}`;
  const tree = listTree(source, commit, folder);
  if (tree.length === 0) throw new Error(`${folder} is missing at ${commit}.`);
  const unsupported = tree.find((entry) => entry.mode !== "100644" && entry.mode !== "100755");
  if (unsupported) throw new Error(`${unsupported.path} is not a regular file.`);
  const blobs = readBlobs(
    source,
    tree.map((entry) => entry.sha),
  );
  const files: MossPluginPackageFile[] = tree
    .map((entry) => ({
      path: entry.path.slice(folder.length + 1),
      executable: entry.mode === "100755",
      bytes: blobs.get(entry.sha) ?? Buffer.alloc(0),
    }))
    .filter((file) => basename(file.path) !== ".DS_Store");
  const read = (path: string) => files.find((file) => file.path === path)?.bytes;
  const manifestBytes = read(".codex-plugin/plugin.json");
  if (!manifestBytes) throw new Error(`${folder} has no plugin manifest.`);
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as Record<
    string,
    unknown
  >;
  const iface = (manifest.interface ?? {}) as Record<string, unknown>;
  const version = text(manifest.version);
  if (text(manifest.name) !== name || !version) {
    throw new Error(`${folder} has an unexpected name or no version.`);
  }
  const license = text(manifest.license);
  if (license !== "MIT" && license !== "Apache-2.0") {
    throw new Error(
      `${name} is licensed ${license || "without a license"}; only MIT and Apache-2.0 ship.`,
    );
  }
  const iconPath = (text(iface.logo) || text(iface.composerIcon)).replace(/^\.\//u, "");
  const iconBytes = iconPath ? (read(iconPath) ?? null) : null;
  const iconExtension = extname(iconPath).toLowerCase();
  const skills = files
    .filter((file) => /^skills\/[^/]+\/SKILL\.md$/u.test(file.path))
    .map((file) => {
      const meta = frontmatter(Buffer.from(file.bytes).toString("utf8"));
      return {
        name: text(meta.name) || file.path.split("/")[1] || "",
        description: clip(text(meta.description), SKILL_DESCRIPTION_LIMIT),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const mcpBytes = read(".mcp.json");
  const mcpServers = mcpBytes
    ? Object.keys(
        (JSON.parse(Buffer.from(mcpBytes).toString("utf8")) as { mcpServers?: object })
          .mcpServers ?? {},
      ).toSorted()
    : [];
  const encoded = encodeMossPluginPackage({ name, version, files });
  return {
    entry: {
      name,
      version,
      displayName: text(iface.displayName) || name,
      developerName:
        text(iface.developerName) || text((manifest.author as { name?: string })?.name),
      license,
      description: clip(text(iface.shortDescription) || text(manifest.description), 200),
      websiteUrl: text(iface.websiteURL) || text(manifest.homepage) || null,
      icon: iconBytes && ICON_TYPES[iconExtension] ? `icons/${name}${iconExtension}` : null,
      skills,
      mcpServers,
      package: {
        file: `packages/${name}-${version}.json.gz`,
        sha256: encoded.sha256,
        bytes: encoded.json.byteLength,
      },
    },
    gzip: encoded.gzip,
    iconBytes,
  };
}

function writeIndex(commit: string, entries: readonly MossPluginCatalogPackage[]): void {
  const header = readFileSync(INDEX_PATH, "utf8").split(
    "export const MOSS_PLUGIN_CATALOG_SOURCE",
  )[0];
  writeFileSync(
    INDEX_PATH,
    `${header}export const MOSS_PLUGIN_CATALOG_SOURCE = ${JSON.stringify({
      repository: MOSS_PLUGIN_CATALOG_SOURCE.repository,
      commit,
    })} as const;\n\nexport const MOSS_PLUGIN_CATALOG_PACKAGES: readonly MossPluginCatalogPackage[] = ${JSON.stringify(
      entries,
      null,
      2,
    )};\n`,
  );
}

function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function build(args: readonly string[]): void {
  const source = resolve(argument(args, "--source") ?? "");
  const out = resolve(argument(args, "--out") ?? "");
  const commit =
    argument(args, "--commit") ||
    MOSS_PLUGIN_CATALOG_SOURCE.commit ||
    git(source, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const built = MOSS_PLUGIN_CATALOG_SELECTION.map((name) => buildPlugin(source, commit, name));
  for (const plugin of built) {
    const packagePath = join(out, plugin.entry.package.file);
    mkdirSync(dirname(packagePath), { recursive: true });
    writeFileSync(packagePath, plugin.gzip);
    if (plugin.entry.icon && plugin.iconBytes) {
      const iconPath = join(out, plugin.entry.icon);
      mkdirSync(dirname(iconPath), { recursive: true });
      writeFileSync(iconPath, plugin.iconBytes);
    }
    console.log(
      `${plugin.entry.name} ${plugin.entry.version}: ${plugin.gzip.byteLength} bytes, sha256 ${plugin.entry.package.sha256}`,
    );
  }
  if (args.includes("--write-index")) {
    writeIndex(
      commit,
      built.map((plugin) => plugin.entry),
    );
    console.log(`Wrote ${relative(REPO_ROOT, INDEX_PATH)} for ${commit}.`);
    return;
  }
  const drift = built.filter((plugin) => {
    const pinned = MOSS_PLUGIN_CATALOG.find((entry) => entry.name === plugin.entry.name);
    return pinned?.package.sha256 !== plugin.entry.package.sha256;
  });
  if (drift.length > 0) {
    throw new Error(
      `Built packages differ from the pinned catalog: ${drift.map((plugin) => plugin.entry.name).join(", ")}. Rerun with --write-index to pin them.`,
    );
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

type StoreEnv = Readonly<Record<string, string | undefined>>;

/** Writes one object into one store. */
export type CatalogObjectWriter = (key: string, localPath: string, type: string) => Promise<void>;

function createS3CatalogWriter(env: StoreEnv): CatalogObjectWriter {
  const client = new Bun.S3Client(readUpdateMirrorS3ClientOptions(env));
  return async (key, localPath, type) => {
    await client.file(key).write(Bun.file(localPath), { type, retry: 3 });
  };
}

/**
 * Where a store serves the catalog. One store: MOSS_PLUGIN_CATALOG_URL, else the R2 copy (as
 * before). Several stores: the folder's MOSS_PLUGIN_CATALOG_URL, else the catalog prefix on the
 * origin of the folder's MOSS_UPDATE_MIRROR_FEED_URL (each source serves objects at their keys).
 */
export function catalogPublicBaseUrl(
  env: StoreEnv,
  options: { readonly severalStores: boolean; readonly prefix: string },
): string {
  const explicit = env[MOSS_PLUGIN_CATALOG_URL_ENV]?.trim();
  if (explicit) return normalizeMossPluginCatalogBaseUrl(explicit);
  if (!options.severalStores) return MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL;
  const feedUrl = env.MOSS_UPDATE_MIRROR_FEED_URL?.trim();
  if (!feedUrl) {
    throw new Error(
      `Set ${MOSS_PLUGIN_CATALOG_URL_ENV} or MOSS_UPDATE_MIRROR_FEED_URL in every settings folder.`,
    );
  }
  return normalizeMossPluginCatalogBaseUrl(new URL(`/${options.prefix}`, feedUrl).toString());
}

/**
 * Uploads the built catalog to every store, then reads it back through that store's public URL.
 * Every store is attempted; the run fails afterwards if any store failed.
 */
export async function uploadCatalogToStores(input: {
  readonly out: string;
  readonly stores: ReadonlyArray<UpdateMirrorStoreSettings>;
  readonly severalStores: boolean;
  readonly createWriter?: (env: StoreEnv) => CatalogObjectWriter;
  readonly verifyStore?: (baseUrl: string) => Promise<void>;
  readonly catalog?: readonly MossPluginCatalogPackage[];
  readonly log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? ((message: string) => console.log(message));
  const catalog = input.catalog ?? MOSS_PLUGIN_CATALOG;
  const wanted = new Set(
    catalog.flatMap((entry) => [entry.package.file, ...(entry.icon ? [entry.icon] : [])]),
  );
  const files = filesUnder(input.out).flatMap((path) => {
    const key = relative(input.out, path).replaceAll("\\", "/");
    return wanted.has(key) ? [{ key, path }] : [];
  });
  const missing = [...wanted].filter((key) => !files.some((file) => file.key === key));
  if (missing.length > 0) {
    throw new Error(`Missing from ${input.out}: ${missing.join(", ")}. Run build first.`);
  }

  const failures: string[] = [];
  for (const store of input.stores) {
    try {
      const prefix = store.env.MOSS_PLUGIN_CATALOG_S3_PREFIX?.trim() || DEFAULT_S3_PREFIX;
      const baseUrl = catalogPublicBaseUrl(store.env, {
        severalStores: input.severalStores,
        prefix,
      });
      const write = (input.createWriter ?? createS3CatalogWriter)(store.env);
      for (const file of files) {
        await write(
          `${prefix}${file.key}`,
          file.path,
          ICON_TYPES[extname(file.key).toLowerCase()] ?? "application/gzip",
        );
        log(`Uploaded ${prefix}${file.key} (${store.label})`);
      }
      await (input.verifyStore ?? ((url) => verifyServedCatalog({ baseUrl: url, log })))(baseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Store ${store.label} failed: ${message}`);
      failures.push(`${store.label}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${input.stores.length} catalog store(s) failed:\n${failures.join("\n")}`,
    );
  }
}

/** Resolves the stores from the settings folders, then uploads the built catalog to every one. */
export async function runCatalogUpload(input: {
  readonly out: string;
  readonly env: StoreEnv;
  readonly homeDirectory: string;
  readonly createWriter?: (env: StoreEnv) => CatalogObjectWriter;
  readonly verifyStore?: (baseUrl: string) => Promise<void>;
  readonly catalog?: readonly MossPluginCatalogPackage[];
  readonly log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? ((message: string) => console.log(message));
  const resolution = await resolveUpdateMirrorStores({
    env: input.env,
    homeDirectory: input.homeDirectory,
    files: ["update-mirror.env", "update-mirror-upload.env"],
  });
  const listNote = describeUpdateMirrorStoreList(resolution);
  if (listNote) log(listNote);
  await uploadCatalogToStores({
    out: input.out,
    stores: resolution.stores,
    severalStores: resolution.severalStores,
    log,
    ...(input.createWriter ? { createWriter: input.createWriter } : {}),
    ...(input.verifyStore ? { verifyStore: input.verifyStore } : {}),
    ...(input.catalog ? { catalog: input.catalog } : {}),
  });
}

async function upload(args: readonly string[]): Promise<void> {
  await runCatalogUpload({
    out: resolve(argument(args, "--out") ?? ""),
    env: process.env,
    homeDirectory: homedir(),
  });
}

/**
 * Reads every pinned package back through the public URL, the way the app does: a plain GET. The
 * icon is checked with a one-byte ranged GET, since the COS source answers HEAD with 403.
 */
export async function verifyServedCatalog(input: {
  readonly baseUrl: string;
  readonly catalog?: readonly MossPluginCatalogPackage[];
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const baseUrl = normalizeMossPluginCatalogBaseUrl(input.baseUrl);
  const catalog = input.catalog ?? MOSS_PLUGIN_CATALOG;
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts = input.attempts ?? SERVED_FILE_ATTEMPTS;
  const log = input.log ?? ((message: string) => console.log(message));
  const problems: string[] = [];
  for (const entry of catalog) {
    const url = mossPluginCatalogPackageUrl(baseUrl, entry);
    let lastError: unknown;
    // The CDN can remember "not found" for a short while after an upload.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        decodeMossPluginPackage({
          gzip: new Uint8Array(await response.arrayBuffer()),
          expectedName: entry.name,
          expectedVersion: entry.version,
          expectedSha256: entry.package.sha256,
        });
        const icon = mossPluginCatalogIconUrl(baseUrl, entry);
        if (icon) {
          const iconResponse = await fetchImpl(icon, {
            method: "GET",
            headers: { range: "bytes=0-0" },
            signal: AbortSignal.timeout(60_000),
          });
          await iconResponse.body?.cancel().catch(() => undefined);
          if (iconResponse.status !== 200 && iconResponse.status !== 206) {
            throw new Error(`icon missing (HTTP ${iconResponse.status})`);
          }
        }
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(input.retryDelayMs ?? SERVED_FILE_RETRY_DELAY_MS);
      }
    }
    if (lastError === undefined) log(`ok ${entry.name}`);
    else {
      problems.push(
        `${entry.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }
  if (problems.length > 0) throw new Error(`Mirror check failed:\n${problems.join("\n")}`);
  log(`All ${catalog.length} catalog packages are served by ${baseUrl}`);
}

async function verify(args: readonly string[]): Promise<void> {
  await verifyServedCatalog({
    baseUrl: normalizeMossPluginCatalogBaseUrl(
      argument(args, "--base-url") ?? process.env[MOSS_PLUGIN_CATALOG_URL_ENV],
    ),
  });
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") build(args);
  else if (command === "upload") await upload(args);
  else if (command === "verify") await verify(args);
  else {
    console.error("Usage: build-moss-plugin-catalog.ts build|upload|verify …");
    process.exit(2);
  }
}
