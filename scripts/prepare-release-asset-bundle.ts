// FILE: prepare-release-asset-bundle.ts
// Purpose: Validates the complete desktop release asset set, refreshes updater
// metadata from the actual bytes, and emits release checksums/provenance.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const CHECKSUM_FILE_NAME = "SHA256SUMS";
const PROVENANCE_FILE_NAME = "release-provenance.json";

export interface ReleaseAssetDigest {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly sha512: string;
}

interface UpdateManifestFile {
  readonly url: string;
  sha512: string;
  size: number;
  readonly [key: string]: unknown;
}

interface UpdateManifest {
  version: string;
  files: UpdateManifestFile[];
  path?: string;
  sha512?: string;
  readonly [key: string]: unknown;
}

export interface ReleaseSourceProvenance {
  readonly repository: string;
  readonly commit: string;
  readonly lockfileSha256: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: string;
  readonly event: string;
  readonly ref: string;
}

export interface PrepareReleaseAssetBundleInput {
  readonly assetDirectory: string;
  readonly indexPath: string;
  readonly version: string;
  readonly channel: string;
  readonly source: ReleaseSourceProvenance;
  readonly generatedAt?: string;
}

export interface PreparedReleaseAssetBundle {
  readonly assets: readonly ReleaseAssetDigest[];
  readonly checksumFile: ReleaseAssetDigest;
  readonly indexFile: ReleaseAssetDigest;
  readonly indexPath: string;
  readonly outputNames: readonly string[];
  readonly provenancePath: string;
}

export interface ReleaseAssetIndex {
  readonly schemaVersion: 1;
  readonly product: "Moss";
  readonly version: string;
  readonly updateChannel: string;
  readonly source: ReleaseSourceProvenance;
  readonly assets: readonly ReleaseAssetDigest[];
}

function assertSafeToken(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertDirectRegularFile(directory: string, name: string): string {
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error(`Release asset must be a direct child filename: ${name}`);
  }
  const path = join(directory, name);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release asset must be a regular non-symlink file: ${name}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`Release asset must not be hard-linked: ${name}`);
  }
  if (metadata.size <= 0) {
    throw new Error(`Release asset must not be empty: ${name}`);
  }
  const realDirectory = realpathSync(directory);
  const realPath = realpathSync(path);
  const childPath = relative(realDirectory, realPath);
  if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`)) {
    throw new Error(`Release asset escapes its directory: ${name}`);
  }
  return path;
}

function assertStableAssetIdentity(expected: BigIntStats, actual: BigIntStats, name: string): void {
  for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Release asset changed identity while hashing: ${name}`);
    }
  }
}

function digestFile(path: string): ReleaseAssetDigest {
  const name = basename(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`Release asset must remain a regular single-link file while hashing: ${name}`);
  }
  if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Release asset has an invalid size while hashing: ${name}`);
  }
  const realPathBefore = realpathSync(path);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  let size = 0;
  try {
    assertStableAssetIdentity(before, fstatSync(descriptor, { bigint: true }), name);
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      sha512.update(chunk);
      size += bytesRead;
    }
    assertStableAssetIdentity(before, fstatSync(descriptor, { bigint: true }), name);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path, { bigint: true });
  assertStableAssetIdentity(before, after, name);
  if (realpathSync(path) !== realPathBefore || BigInt(size) !== before.size) {
    throw new Error(`Release asset changed path or size while hashing: ${name}`);
  }
  return {
    name,
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

function expectedInputNames(version: string, channel: string): readonly string[] {
  return [
    `Moss-${version}-arm64.dmg`,
    `Moss-${version}-arm64.dmg.blockmap`,
    `Moss-${version}-arm64.zip`,
    `Moss-${version}-x64.AppImage`,
    `Moss-${version}-x64.AppImage.blockmap`,
    `Moss-${version}-x64.dmg`,
    `Moss-${version}-x64.dmg.blockmap`,
    `Moss-${version}-x64.exe`,
    `Moss-${version}-x64.exe.blockmap`,
    `Moss-${version}-x64.zip`,
    `${channel}-linux.yml`,
    `${channel}-mac.yml`,
    `${channel}.yml`,
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ].toSorted();
}

function assertExactDirectoryEntries(directory: string, expected: readonly string[]): void {
  const actual = readdirSync(directory).toSorted();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release asset set mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}].`,
    );
  }
}

function parseUpdateManifest(path: string): UpdateManifest {
  const parsed = parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Updater manifest must be an object: ${basename(path)}`);
  }
  const manifest = parsed as Partial<UpdateManifest>;
  if (typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
    throw new Error(`Updater manifest is missing version/files: ${basename(path)}`);
  }
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.url !== "string" ||
      typeof file.sha512 !== "string" ||
      typeof file.size !== "number"
    ) {
      throw new Error(`Updater manifest contains an invalid file entry: ${basename(path)}`);
    }
  }
  return manifest as UpdateManifest;
}

function refreshUpdateManifest(
  manifestPath: string,
  version: string,
  expectedUrls: readonly string[],
  digests: ReadonlyMap<string, ReleaseAssetDigest>,
  primaryUrl?: string,
): string {
  const manifest = parseUpdateManifest(manifestPath);
  if (manifest.version !== version) {
    throw new Error(
      `Updater manifest ${basename(manifestPath)} has version ${manifest.version}, expected ${version}.`,
    );
  }

  const actualUrls = manifest.files.map((file) => file.url);
  if (new Set(actualUrls).size !== actualUrls.length) {
    throw new Error(`Updater manifest contains duplicate file URLs: ${basename(manifestPath)}`);
  }
  const missing = expectedUrls.filter((url) => !actualUrls.includes(url));
  const unexpected = actualUrls.filter((url) => !expectedUrls.includes(url));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Updater manifest ${basename(manifestPath)} file set mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}].`,
    );
  }

  manifest.version = version;
  for (const file of manifest.files) {
    const digest = digests.get(file.url);
    if (!digest) {
      throw new Error(`Missing digest for updater asset: ${file.url}`);
    }
    file.sha512 = digest.sha512;
    file.size = digest.size;
  }

  if (primaryUrl) {
    const primary = digests.get(primaryUrl);
    if (!primary) throw new Error(`Missing primary updater asset: ${primaryUrl}`);
    manifest.path = primaryUrl;
    manifest.sha512 = primary.sha512;
  } else {
    delete manifest.path;
    delete manifest.sha512;
  }

  return stringify(manifest, { lineWidth: 0 });
}

function atomicWrite(path: string, contents: string): void {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".moss-release-asset-"));
  const temporaryPath = join(temporaryDirectory, basename(path));
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertFreshIndexPath(indexPath: string, assetDirectory: string): string {
  const resolvedIndexPath = resolve(indexPath);
  const relativeToAssets = relative(realpathSync(assetDirectory), resolvedIndexPath);
  if (
    !relativeToAssets ||
    (!relativeToAssets.startsWith(`..${sep}`) && relativeToAssets !== "..")
  ) {
    throw new Error("Release asset index must be outside the mutable asset directory.");
  }

  const indexDirectory = dirname(resolvedIndexPath);
  const directoryMetadata = lstatSync(indexDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Release asset index parent is not a direct directory: ${indexDirectory}`);
  }
  const realIndexPath = join(realpathSync(indexDirectory), basename(resolvedIndexPath));
  const realRelativeToAssets = relative(realpathSync(assetDirectory), realIndexPath);
  if (
    !realRelativeToAssets ||
    (!realRelativeToAssets.startsWith(`..${sep}`) && realRelativeToAssets !== "..")
  ) {
    throw new Error("Release asset index must be outside the mutable asset directory.");
  }
  if (existsSync(resolvedIndexPath)) {
    throw new Error(`Release asset index already exists: ${resolvedIndexPath}`);
  }
  return resolvedIndexPath;
}

function writeImmutableIndex(
  indexPath: string,
  assetDirectory: string,
  index: ReleaseAssetIndex,
): ReleaseAssetDigest {
  const resolvedIndexPath = assertFreshIndexPath(indexPath, assetDirectory);

  writeFileSync(resolvedIndexPath, `${JSON.stringify(index, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o400,
    flag: "wx",
  });
  return digestFile(resolvedIndexPath);
}

function assertAliasesMatch(directory: string, channel: string): void {
  const pairs = [
    ["latest-mac.yml", `${channel}-mac.yml`],
    ["latest.yml", `${channel}.yml`],
    ["latest-linux.yml", `${channel}-linux.yml`],
  ] as const;
  for (const [sourceName, aliasName] of pairs) {
    const source = readFileSync(join(directory, sourceName));
    const alias = readFileSync(join(directory, aliasName));
    if (!source.equals(alias)) {
      throw new Error(`Dedicated updater alias ${aliasName} differs from ${sourceName}.`);
    }
  }
}

function validateSource(source: ReleaseSourceProvenance): void {
  assertSafeToken(source.repository, REPOSITORY_PATTERN, "source repository");
  assertSafeToken(source.commit, COMMIT_PATTERN, "source commit");
  assertSafeToken(source.lockfileSha256, SHA256_PATTERN, "source lockfile SHA-256");
  assertSafeToken(source.workflowRunId, POSITIVE_INTEGER_PATTERN, "workflow run ID");
  assertSafeToken(source.workflowRunAttempt, POSITIVE_INTEGER_PATTERN, "workflow run attempt");
  if (!source.event.trim() || /[\r\n]/.test(source.event)) {
    throw new Error(`Invalid source event: ${source.event}`);
  }
  if (!source.ref.startsWith("refs/") || /[\r\n]/.test(source.ref)) {
    throw new Error(`Invalid source ref: ${source.ref}`);
  }
}

export function prepareReleaseAssetBundle(
  input: PrepareReleaseAssetBundleInput,
): PreparedReleaseAssetBundle {
  assertSafeToken(input.version, VERSION_PATTERN, "release version");
  assertSafeToken(input.channel, CHANNEL_PATTERN, "update channel");
  if (input.channel === "latest") {
    throw new Error("Dedicated update channel must not be latest.");
  }
  validateSource(input.source);

  const assetDirectory = resolve(input.assetDirectory);
  const directoryMetadata = lstatSync(assetDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Release asset path is not a directory: ${assetDirectory}`);
  }
  // Fail before modifying any release asset if the immutable index destination
  // is unsafe or occupied. Exclusive creation repeats this check at write time.
  assertFreshIndexPath(input.indexPath, assetDirectory);

  const expectedNames = expectedInputNames(input.version, input.channel);
  assertExactDirectoryEntries(assetDirectory, expectedNames);
  for (const name of expectedNames) assertDirectRegularFile(assetDirectory, name);
  assertAliasesMatch(assetDirectory, input.channel);

  const binaryNames = expectedNames.filter((name) => !name.endsWith(".yml"));
  const binaryDigests = new Map(
    binaryNames.map((name) => {
      const digest = digestFile(join(assetDirectory, name));
      return [name, digest] as const;
    }),
  );

  const macUrls = [
    `Moss-${input.version}-arm64.zip`,
    `Moss-${input.version}-arm64.dmg`,
    `Moss-${input.version}-x64.zip`,
    `Moss-${input.version}-x64.dmg`,
  ];
  const windowsUrl = `Moss-${input.version}-x64.exe`;
  const linuxUrl = `Moss-${input.version}-x64.AppImage`;
  const refreshedManifests = new Map<string, string>([
    [
      "latest-mac.yml",
      refreshUpdateManifest(
        join(assetDirectory, "latest-mac.yml"),
        input.version,
        macUrls,
        binaryDigests,
      ),
    ],
    [
      "latest.yml",
      refreshUpdateManifest(
        join(assetDirectory, "latest.yml"),
        input.version,
        [windowsUrl],
        binaryDigests,
        windowsUrl,
      ),
    ],
    [
      "latest-linux.yml",
      refreshUpdateManifest(
        join(assetDirectory, "latest-linux.yml"),
        input.version,
        [linuxUrl],
        binaryDigests,
        linuxUrl,
      ),
    ],
  ]);

  const aliasMappings = new Map<string, string>([
    [`${input.channel}-mac.yml`, "latest-mac.yml"],
    [`${input.channel}.yml`, "latest.yml"],
    [`${input.channel}-linux.yml`, "latest-linux.yml"],
  ]);
  for (const [name, contents] of refreshedManifests) {
    atomicWrite(join(assetDirectory, name), contents);
  }
  for (const [aliasName, sourceName] of aliasMappings) {
    const contents = refreshedManifests.get(sourceName);
    if (!contents) throw new Error(`Missing refreshed updater manifest: ${sourceName}`);
    atomicWrite(join(assetDirectory, aliasName), contents);
  }

  const assets = expectedNames.map((name) => digestFile(join(assetDirectory, name)));
  const checksumContents = `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`;
  const checksumPath = join(assetDirectory, CHECKSUM_FILE_NAME);
  atomicWrite(checksumPath, checksumContents);
  const checksumFile = digestFile(checksumPath);

  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`Invalid provenance timestamp: ${generatedAt}`);
  }
  const provenance = {
    schemaVersion: 1,
    product: "Moss",
    version: input.version,
    updateChannel: input.channel,
    generatedAt,
    source: {
      ...input.source,
      workflow: ".github/workflows/release.yml",
      workflowUrl: `https://github.com/${input.source.repository}/actions/runs/${input.source.workflowRunId}/attempts/${input.source.workflowRunAttempt}`,
    },
    assets,
    checksumManifest: checksumFile,
  };
  const provenancePath = join(assetDirectory, PROVENANCE_FILE_NAME);
  atomicWrite(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  assertDirectRegularFile(assetDirectory, CHECKSUM_FILE_NAME);
  assertDirectRegularFile(assetDirectory, PROVENANCE_FILE_NAME);
  const provenanceFile = digestFile(provenancePath);

  const outputNames = [...expectedNames, CHECKSUM_FILE_NAME, PROVENANCE_FILE_NAME].toSorted();
  assertExactDirectoryEntries(assetDirectory, outputNames);
  const indexedAssets = [...assets, checksumFile, provenanceFile].toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const indexPath = resolve(input.indexPath);
  const indexFile = writeImmutableIndex(indexPath, assetDirectory, {
    schemaVersion: 1,
    product: "Moss",
    version: input.version,
    updateChannel: input.channel,
    source: input.source,
    assets: indexedAssets,
  });
  return { assets, checksumFile, indexFile, indexPath, outputNames, provenancePath };
}

function readFlag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required argument ${name}.`);
  }
  return value;
}

function main(args: readonly string[]): void {
  const knownFlags = new Set([
    "--asset-directory",
    "--index-path",
    "--version",
    "--channel",
    "--source-repository",
    "--source-commit",
    "--lockfile-sha256",
    "--workflow-run-id",
    "--workflow-run-attempt",
    "--event",
    "--ref",
  ]);
  if (args.length !== knownFlags.size * 2) {
    throw new Error(`Expected exactly ${knownFlags.size} named release asset arguments.`);
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag || !knownFlags.has(flag)) throw new Error(`Unknown release asset argument: ${flag}`);
  }

  const prepared = prepareReleaseAssetBundle({
    assetDirectory: readFlag(args, "--asset-directory"),
    indexPath: readFlag(args, "--index-path"),
    version: readFlag(args, "--version"),
    channel: readFlag(args, "--channel"),
    source: {
      repository: readFlag(args, "--source-repository"),
      commit: readFlag(args, "--source-commit"),
      lockfileSha256: readFlag(args, "--lockfile-sha256").toLowerCase(),
      workflowRunId: readFlag(args, "--workflow-run-id"),
      workflowRunAttempt: readFlag(args, "--workflow-run-attempt"),
      event: readFlag(args, "--event"),
      ref: readFlag(args, "--ref"),
    },
  });
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `asset_index_sha256=${prepared.indexFile.sha256}\n`, "utf8");
  }
  console.log(`Prepared ${prepared.outputNames.length} immutable release assets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
