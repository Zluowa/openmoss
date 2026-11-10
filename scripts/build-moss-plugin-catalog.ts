// FILE: build-moss-plugin-catalog.ts
// Purpose: Builds the Moss plugin catalog's packages from a pinned commit of the
//          upstream open-source plugin repository, pins their hashes in
//          `packages/shared/src/mossPluginCatalogPackages.ts`, and publishes them
//          to Moss's domestic mirror, where the desktop app downloads a plugin's
//          files the first time someone installs it.
//          Files are read from git objects, not the working tree, so a checkout's
//          line-ending settings cannot change a hash.
// Usage:
//   bun run scripts/build-moss-plugin-catalog.ts build --source <plugins checkout> --out <dir> [--commit <sha>] [--write-index]
//   bun run scripts/build-moss-plugin-catalog.ts upload --out <dir>
//   bun run scripts/build-moss-plugin-catalog.ts verify [--base-url <url>]
//   Upload reads the update mirror's storage settings (docs/ops/moss-cn-update-mirror.md) from the
//   environment or ~/.moss-release, and writes under MOSS_PLUGIN_CATALOG_S3_PREFIX
//   (default `plugin-catalog/v1/`).

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_SELECTION,
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

import { parseSettingsFile } from "./sync-update-mirror.ts";

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

function loadLocalSettings(): void {
  const directory =
    process.env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim() || join(homedir(), ".moss-release");
  for (const fileName of ["update-mirror.env", "update-mirror-upload.env"]) {
    let settings = "";
    try {
      settings = readFileSync(join(directory, fileName), "utf8");
    } catch {
      continue;
    }
    for (const [name, value] of parseSettingsFile(settings)) process.env[name] ??= value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function upload(args: readonly string[]): Promise<void> {
  loadLocalSettings();
  const out = resolve(argument(args, "--out") ?? "");
  const prefix = process.env.MOSS_PLUGIN_CATALOG_S3_PREFIX?.trim() || DEFAULT_S3_PREFIX;
  const client = new Bun.S3Client({
    accessKeyId: requireEnv("MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY"),
    bucket: requireEnv("MOSS_UPDATE_MIRROR_S3_BUCKET"),
    endpoint: requireEnv("MOSS_UPDATE_MIRROR_S3_ENDPOINT"),
    region: requireEnv("MOSS_UPDATE_MIRROR_S3_REGION"),
    virtualHostedStyle: process.env.MOSS_UPDATE_MIRROR_S3_PATH_STYLE !== "1",
  });
  const expected = new Set(
    MOSS_PLUGIN_CATALOG.flatMap((entry) => [
      entry.package.file,
      ...(entry.icon ? [entry.icon] : []),
    ]),
  );
  for (const path of filesUnder(out)) {
    const key = relative(out, path).replaceAll("\\", "/");
    if (!expected.has(key)) continue;
    expected.delete(key);
    await client.file(`${prefix}${key}`).write(Bun.file(path), {
      type: ICON_TYPES[extname(key).toLowerCase()] ?? "application/gzip",
      retry: 3,
    });
    console.log(`Uploaded ${prefix}${key}`);
  }
  if (expected.size > 0) {
    throw new Error(`Missing from ${out}: ${[...expected].join(", ")}. Run build first.`);
  }
  await verify([]);
}

/** Reads every pinned package back through the public URL, the way the app does. */
async function verify(args: readonly string[]): Promise<void> {
  const baseUrl = normalizeMossPluginCatalogBaseUrl(
    argument(args, "--base-url") ?? process.env[MOSS_PLUGIN_CATALOG_URL_ENV],
  );
  const problems: string[] = [];
  for (const entry of MOSS_PLUGIN_CATALOG) {
    const url = mossPluginCatalogPackageUrl(baseUrl, entry);
    let lastError: unknown;
    // The CDN can remember "not found" for a short while after an upload.
    for (let attempt = 1; attempt <= SERVED_FILE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        decodeMossPluginPackage({
          gzip: new Uint8Array(await response.arrayBuffer()),
          expectedName: entry.name,
          expectedVersion: entry.version,
          expectedSha256: entry.package.sha256,
        });
        const icon = mossPluginCatalogIconUrl(baseUrl, entry);
        if (icon && !(await fetch(icon, { method: "HEAD" })).ok) throw new Error("icon missing");
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < SERVED_FILE_ATTEMPTS) await sleep(SERVED_FILE_RETRY_DELAY_MS);
      }
    }
    if (lastError === undefined) console.log(`ok ${entry.name}`);
    else {
      problems.push(
        `${entry.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }
  if (problems.length > 0) throw new Error(`Mirror check failed:\n${problems.join("\n")}`);
  console.log(`All ${MOSS_PLUGIN_CATALOG.length} catalog packages are served by ${baseUrl}`);
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
