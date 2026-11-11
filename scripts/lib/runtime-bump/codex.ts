// FILE: codex.ts
// Purpose: Regenerates the bundled Codex CLI pins, payload locks and license bundle for one version.
// Layer: Release/build helper (agent runtime bumps)

import { spawnSync } from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import {
  CRATES_IO_SOURCE,
  parseCargoLock,
  parseGitSource,
  type CargoLockPackage,
} from "./cargo.ts";
import {
  downloadToCache,
  fetchJson,
  fetchTextOrNull,
  mapWithConcurrency,
  sha256Hex,
} from "./download.ts";
import { downloadNpmTarball, fetchVersionDocument, NPM_CANONICAL_REGISTRY } from "./npm.ts";
import {
  findCrateDirectory,
  indexRepoArchive,
  resolveCrateLicense,
  type RepoArchiveIndex,
} from "./repo-archive.ts";
import {
  APPROVED_CRATE_LICENSES,
  APPROVED_LICENSE_EXCEPTIONS,
  selectPermissiveLicense,
} from "./spdx.ts";
import { readTarFile } from "./tar.ts";
import { readCrateSourceProvenance } from "./crate-source.ts";
import { readCrateSourceHeaderNotices } from "./source-notices.ts";
import {
  readReviewedCrateNotices,
  selectReviewedCrateLicense,
  type ReviewedBinaryDistribution,
} from "./reviewed-notices.ts";
import {
  addChangelogLine,
  compareBytes,
  replaceVersionLiterals,
  prepareBunLockRewrites,
  updateWindowsNativeManifest,
  writeTextFile,
  type BumpContext,
} from "./shared.ts";

export const CODEX_PACKAGE = "@openai/codex";
export const CODEX_ARCHIVE_IDS = [
  "launcher",
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CodexArchiveId = (typeof CODEX_ARCHIVE_IDS)[number];

const TARGET_TRIPLES: Record<Exclude<CodexArchiveId, "launcher">, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** Files that hold the bundled Codex version as a literal and are rewritten on every bump. */
export const CODEX_VERSION_LITERAL_FILES = [
  "apps/desktop/package.json",
  "packages/shared/src/codexRuntime.ts",
  "packages/shared/src/codexRuntime.test.ts",
  "scripts/desktop-stage-lock/package.json",
  "scripts/lib/bundled-codex-final-release-set.test.ts",
  "scripts/lib/bundled-codex-release-compliance.test.ts",
  "scripts/lib/bundled-codex-runtime.test.ts",
  "scripts/lib/windows-native-payload-audit.test.mjs",
] as const;

export const CODEX_BUNDLE_PARENT = Path.join("third_party", "openai-codex");
export const CODEX_PINS_FILE = Path.join("scripts", "lib", "bundled-codex-pins.ts");

export const SPDX_LICENSE_LIST_TAG = "v3.27.0";
function supplementalSpdxText(id: string): Buffer {
  if (!/^[A-Za-z0-9.+-]+$/u.test(id))
    throw new Error(`Unsupported supplemental SPDX identifier: ${id}.`);
  return FS.readFileSync(Path.join(import.meta.dirname, "spdx-texts", `${id}.txt`));
}

interface PayloadFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface PayloadArchiveRecord {
  readonly id: CodexArchiveId;
  readonly npmPackage: typeof CODEX_PACKAGE;
  readonly npmVersion: string;
  readonly archive: string;
  readonly npmIntegrity: string;
  readonly size: number;
  readonly sha256: string;
  readonly files: readonly PayloadFileRecord[];
}

interface CrateRecord {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly integrity: string;
  readonly usedBy: readonly string[];
  readonly declaredLicense: string;
  readonly selectedLicense: string;
  readonly licenseFiles: readonly { readonly path: string; readonly text: string }[];
}

interface NativeRecord {
  readonly name: string;
  readonly version: string;
  readonly declaredLicense: string;
  readonly selectedLicense: string;
  readonly platforms: readonly string[];
  readonly shippedAs: string;
  readonly origin: string;
  readonly licenseFiles: readonly string[];
  readonly source?: string;
}

const VOICE_FILE =
  /^vendor\/[^/]+\/codex-resources\/voice\/(NOTICE\.md|sources\.json|manifest\.json|licenses\/[^/]+)$/u;

async function hashNpmArchive(filePath: string): Promise<{
  files: PayloadFileRecord[];
  voice: Map<string, Buffer>;
}> {
  const files: PayloadFileRecord[] = [];
  const voice = new Map<string, Buffer>();
  await readTarFile(filePath, {
    entry: (header) => {
      if (header.type === "directory") return null;
      if (header.type !== "file") {
        throw new Error(`${filePath}: unexpected ${header.type} entry ${header.path}.`);
      }
      if (!header.path.startsWith("package/")) {
        throw new Error(`${filePath}: entry outside package/: ${header.path}.`);
      }
      const path = header.path.slice("package/".length);
      const hash = Crypto.createHash("sha256");
      const voiceMatch = VOICE_FILE.exec(path);
      const parts: Buffer[] = [];
      let size = 0;
      return {
        chunk: (bytes) => {
          hash.update(bytes);
          size += bytes.length;
          if (voiceMatch) parts.push(Buffer.from(bytes));
        },
        end: () => {
          files.push({ path, size, sha256: hash.digest("hex") });
          if (voiceMatch) voice.set(voiceMatch[1]!, Buffer.concat(parts));
        },
      };
    },
  });
  files.sort((left, right) => compareBytes(left.path, right.path));
  return { files, voice };
}

function resolveTagCommit(version: string): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "ls-remote",
      "https://github.com/openai/codex",
      `refs/tags/rust-v${version}`,
      `refs/tags/rust-v${version}^{}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-remote for rust-v${version} failed: ${result.stderr || result.error}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith("^{}")) ?? lines[0];
  const commit = peeled?.split(/\s+/u)[0];
  if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`openai/codex has no tag rust-v${version}.`);
  }
  return commit;
}

function crateIndexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

async function crateIndexChecksum(
  context: BumpContext,
  name: string,
  version: string,
): Promise<string | null> {
  const text = await fetchTextOrNull(
    `${context.cratesIndexUrl}/${crateIndexPath(name)}`,
    `crates.io index ${name}`,
  );
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { vers?: string; cksum?: string };
    if (record.vers === version && record.cksum) return record.cksum;
  }
  return null;
}

async function downloadCrate(
  context: BumpContext,
  name: string,
  version: string,
  checksum: string,
): Promise<string> {
  const url = context.cratesUrlTemplate.replaceAll("{name}", name).replaceAll("{version}", version);
  const file = await downloadToCache({
    url,
    cacheDir: context.cacheDir,
    cacheKey: Path.join("crates", name, `${name}-${version}.crate`),
    expected: { sha256: checksum },
    label: `crate ${name}@${version}`,
  });
  return file.path;
}

async function downloadGitHubSnapshot(
  context: BumpContext,
  owner: string,
  repo: string,
  commit: string,
  expectedSha256?: string,
): Promise<string> {
  const file = await downloadToCache({
    url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`,
    cacheDir: context.cacheDir,
    cacheKey: Path.join("github", `${owner}-${repo}-${commit}.tar.gz`),
    expected: expectedSha256 ? { sha256: expectedSha256 } : {},
    label: `github ${owner}/${repo}@${commit.slice(0, 12)}`,
  });
  return file.path;
}

class LicenseTextStore {
  readonly texts = new Map<string, Buffer>();
  add(bytes: Buffer): string {
    const sha256 = sha256Hex(bytes);
    this.texts.set(sha256, bytes);
    return `licenses/rust/${sha256}.txt`;
  }
}

function selectOrThrow(declared: string, label: string): string {
  const selected = selectPermissiveLicense(declared);
  if (!selected) {
    throw new Error(`${label}: no approved branch in license expression "${declared}".`);
  }
  return selected;
}

interface CrateJob {
  readonly lock: CargoLockPackage;
  readonly usedBy: Set<string>;
  /** Archive-relative directory hint for path members of the Codex workspace. */
  readonly workspace?: "codex";
}

function crateKey(name: string, version: string, source: string): string {
  return `${name}\0${version}\0${source}`;
}

async function resolveCrates(input: {
  readonly context: BumpContext;
  readonly codexSource: RepoArchiveIndex;
  readonly sourceCommit: string;
  readonly reviewedDistribution: ReviewedBinaryDistribution;
  readonly codexLock: readonly CargoLockPackage[];
  readonly ripgrepLock: readonly CargoLockPackage[];
  readonly store: LicenseTextStore;
}): Promise<CrateRecord[]> {
  const { context, store } = input;
  const jobs = new Map<string, CrateJob>();
  const add = (lock: CargoLockPackage, usedBy: string, workspace?: "codex") => {
    const source = lock.source ?? `workspace:${usedBy}`;
    const key = crateKey(lock.name, lock.version, source);
    const existing = jobs.get(key);
    if (existing) existing.usedBy.add(usedBy);
    else jobs.set(key, { lock, usedBy: new Set([usedBy]), ...(workspace ? { workspace } : {}) });
  };
  for (const lock of input.codexLock) add(lock, "codex", lock.source ? undefined : "codex");
  // ripgrep's own workspace members are published crates; bind them to crates.io checksums.
  for (const lock of input.ripgrepLock) {
    if (lock.source) {
      add(lock, "ripgrep");
      continue;
    }
    if (lock.name === "ripgrep") continue;
    const checksum = await crateIndexChecksum(context, lock.name, lock.version);
    if (!checksum)
      throw new Error(`ripgrep member ${lock.name}@${lock.version} is not on crates.io.`);
    add({ ...lock, source: CRATES_IO_SOURCE, checksum }, "ripgrep");
  }

  const gitSnapshots = new Map<string, Promise<RepoArchiveIndex>>();
  const gitIndex = (source: string): Promise<RepoArchiveIndex> => {
    const git = parseGitSource(source);
    const key = `${git.owner}/${git.repo}#${git.commit}`;
    let pending = gitSnapshots.get(key);
    if (!pending) {
      pending = downloadGitHubSnapshot(context, git.owner, git.repo, git.commit).then((path) =>
        indexRepoArchive(path, { label: key }),
      );
      gitSnapshots.set(key, pending);
    }
    return pending;
  };

  let done = 0;
  const recoveredSourceNotices: string[] = [];
  const all = [...jobs.values()];
  const records = await mapWithConcurrency(all, context.concurrency, async (job) => {
    const { lock } = job;
    const label = `${lock.name}@${lock.version}`;
    let index: RepoArchiveIndex;
    let crateDirectory: string;
    let integrity: string;
    let source: string;
    let includeNested: boolean;
    if (job.workspace === "codex") {
      index = input.codexSource;
      crateDirectory = findCrateDirectory(index, lock.name, lock.version);
      integrity = `git:${input.sourceCommit}`;
      source = `workspace:openai/codex/${crateDirectory}`;
      includeNested = false;
    } else if (lock.source === CRATES_IO_SOURCE) {
      if (!lock.checksum) throw new Error(`${label}: crates.io package without checksum.`);
      const path = await downloadCrate(context, lock.name, lock.version, lock.checksum);
      index = await indexRepoArchive(path, { label });
      if (index.root !== `${lock.name}-${lock.version}`) {
        throw new Error(`${label}: .crate root is ${index.root}.`);
      }
      crateDirectory = "";
      integrity = `sha256:${lock.checksum}`;
      source = CRATES_IO_SOURCE;
      includeNested = true;
    } else if (lock.source?.startsWith("git+")) {
      index = await gitIndex(lock.source);
      crateDirectory = findCrateDirectory(index, lock.name, lock.version);
      integrity = `git:${parseGitSource(lock.source).commit}`;
      source = lock.source;
      includeNested = false;
    } else {
      throw new Error(`${label}: unsupported Cargo source ${lock.source}.`);
    }
    const resolved = resolveCrateLicense(index, crateDirectory, {
      includeNested,
      fallbackToAncestors: true,
    });
    // Codex workspace crates without a license field are covered by the repository's Apache-2.0.
    const declaredLicense =
      resolved.declaredLicense ?? (job.workspace === "codex" ? "Apache-2.0" : null);
    if (!declaredLicense) throw new Error(`${label}: Cargo.toml declares no license.`);
    const selectedLicense =
      selectReviewedCrateLicense(index.root, lock.checksum, declaredLicense) ??
      selectOrThrow(declaredLicense, label);
    // Paths are relative to the source archive's root (the crate itself for crates.io).
    const licenseFiles = resolved.licenseFiles.map((path) => ({
      path,
      text: store.add(index.licenseFiles.get(path) ?? index.extras.get(path)!),
    }));
    if (licenseFiles.length === 0) {
      const provenance = readCrateSourceProvenance(index, lock.checksum);
      if (provenance) {
        const upstream = await gitIndex(provenance.source);
        const sourceCrateDirectory = findCrateDirectory(upstream, lock.name, lock.version);
        if (provenance.directory !== undefined && sourceCrateDirectory !== provenance.directory)
          throw new Error(`${label}: crate VCS directory does not match its source manifest.`);
        const notices = resolveCrateLicense(upstream, sourceCrateDirectory, {
          includeNested: false,
          fallbackToAncestors: true,
        });
        for (const path of notices.licenseFiles) {
          licenseFiles.push({
            path: `${provenance.source}:${path}`,
            text: store.add(upstream.licenseFiles.get(path) ?? upstream.extras.get(path)!),
          });
        }
      }
      if (licenseFiles.length === 0 && index.archivePath) {
        const reviewed = readReviewedCrateNotices(
          index.root,
          lock.checksum,
          input.reviewedDistribution,
        );
        if (reviewed.length > 0) {
          for (const notice of reviewed)
            licenseFiles.push({ path: notice.path, text: store.add(notice.bytes) });
          // Keep the publisher's actual outer-package declaration separately
          // from the embedded data notices. No copyright owner is inferred.
          licenseFiles.push({
            path: "package-declaration:Cargo.toml",
            text: store.add(Buffer.from(index.manifests.get(crateDirectory)!)),
          });
          licenseFiles.push({
            path: `spdx:${SPDX_LICENSE_LIST_TAG}/${selectedLicense}`,
            text: store.add(supplementalSpdxText(selectedLicense)),
          });
        }
      }
      if (licenseFiles.length === 0 && index.archivePath) {
        const headers = await readCrateSourceHeaderNotices(
          index.archivePath,
          crateDirectory,
          selectedLicense,
        );
        for (const header of headers) {
          licenseFiles.push({
            path: `source-header:${header.path}`,
            text: store.add(header.bytes),
          });
        }
        // Generic terms may supplement verified package notices, never replace them.
        if (headers.length > 0) {
          licenseFiles.push({
            path: `spdx:${SPDX_LICENSE_LIST_TAG}/${selectedLicense}`,
            text: store.add(supplementalSpdxText(selectedLicense)),
          });
        }
      }
      if (licenseFiles.length === 0)
        throw new Error(
          `${label}: no package/source notice evidence; provide reviewed source declarations. Generic SPDX templates alone do not preserve package notices.`,
        );
      recoveredSourceNotices.push(label);
    }
    done += 1;
    if (done % 200 === 0) context.log(`  crates: ${done}/${all.length}`);
    return {
      name: lock.name,
      version: lock.version,
      source,
      integrity,
      usedBy: [...job.usedBy].toSorted(),
      declaredLicense,
      selectedLicense,
      licenseFiles,
    } satisfies CrateRecord;
  });
  if (recoveredSourceNotices.length > 0) {
    context.log(
      `  ${recoveredSourceNotices.length} crate notices recovered from exact source commits or checked package headers: ${recoveredSourceNotices.toSorted(compareBytes).join(", ")}`,
    );
  }
  return records.toSorted(
    (left, right) =>
      compareBytes(left.name, right.name) ||
      compareBytes(left.version, right.version) ||
      compareBytes(left.source, right.source),
  );
}

function readShellAssignment(script: string, name: string): string {
  const match = new RegExp(`^${name}="([^"]+)"$`, "mu").exec(script);
  if (!match) throw new Error(`install-musl-build-tools.sh no longer sets ${name}.`);
  return match[1]!;
}

function systemTar(): string {
  if (process.platform === "win32") {
    const builtIn = Path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (FS.existsSync(builtIn)) return builtIn;
  }
  return "tar";
}

function readXzTarMember(archive: string, member: string): Buffer {
  const result = spawnSync(systemTar(), ["-xJOf", archive, member], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stdout.length === 0) {
    throw new Error(
      `Could not read ${member} from ${archive}: ${result.stderr?.toString() || result.error}`,
    );
  }
  return result.stdout;
}

function readmeText(input: {
  readonly version: string;
  readonly commit: string;
  readonly sourceArchive: { readonly path: string; readonly sha256: string };
  readonly libcap: {
    readonly version: string;
    readonly path: string;
    readonly sha256: string;
    readonly url: string;
  };
  readonly bubblewrapVersion: string;
  readonly ripgrepVersion: string;
  readonly crateCount: number;
  readonly textCount: number;
}): string {
  return `# OpenAI Codex CLI ${input.version}: licenses and sources

Moss ships the unmodified public npm build of \`@openai/codex@${input.version}\` (Apache-2.0, source
\`openai/codex\` tag \`rust-v${input.version}\`, commit \`${input.commit}\`). This folder is what
that redistribution carries with it. It is generated by \`bun run bump:codex ${input.version}\`
(\`scripts/bump-agent-runtime.ts\`); never edit it by hand. Engineering record, not legal advice.

- \`LICENSE\`, \`NOTICE\`: Codex's Apache-2.0 license and NOTICE, from the source commit.
- \`THIRD_PARTY.json\`: every Rust crate in Codex's \`codex-rs/Cargo.lock\` and ripgrep ${input.ripgrepVersion}'s
  \`Cargo.lock\` (${input.crateCount} crates), with its declared and selected license and the license
  texts its source ships (\`licenses/rust/<sha256>.txt\`, ${input.textCount} distinct texts), plus the
  native components below. The inventory is over-inclusive: it lists build and test crates too.
- \`licenses/ripgrep\`, \`licenses/pcre2\`: the bundled \`rg\` and the PCRE2 it links.
- \`licenses/voice\`: the notice, licenses and source list Codex ships for its voice libraries
  (GStreamer, GLib and friends, LGPL-2.1, dynamically linked and replaceable).
- \`licenses/bubblewrap\`, \`licenses/libcap\`, \`sources/\`: corresponding source for the Linux
  \`bwrap\` helper (bubblewrap ${input.bubblewrapVersion}, LGPL-2.0-or-later, statically linked with libcap ${input.libcap.version}).
- \`PAYLOADS.json\`: npm integrity, SHA-256 and the per-file hashes of all seven npm archives.

## Corresponding source for bwrap

- \`${input.sourceArchive.path}\` is the GitHub archive of \`openai/codex\` at \`${input.commit}\`
  (SHA-256 \`${input.sourceArchive.sha256}\`). bubblewrap is under \`codex-rs/vendor/bubblewrap\`,
  the Rust wrapper under \`codex-rs/bwrap\`, the musl toolchain and libcap build in
  \`.github/scripts/install-musl-build-tools.sh\`, the release sequence in
  \`.github/workflows/rust-release.yml\`.
- \`${input.libcap.path}\` is the libcap archive that script pins (${input.libcap.url},
  SHA-256 \`${input.libcap.sha256}\`).

Rebuild on Ubuntu 24.04 x86_64 with the toolchain in \`codex-rs/rust-toolchain.toml\` and Zig 0.14.0:

\`\`\`sh
export TARGET=x86_64-unknown-linux-musl
export GITHUB_ENV="$PWD/rebuild.env"
export RUNNER_TEMP="\${RUNNER_TEMP:-/tmp}/codex-bwrap-rebuild"
bash .github/scripts/install-musl-build-tools.sh
set -a
. "$GITHUB_ENV"
set +a
cd codex-rs
cargo build --locked --target "$TARGET" --release --bin bwrap
\`\`\`

For an offline rebuild, serve the bundled libcap archive at the script's \`libcap_download_url\`;
the script checks the same SHA-256.
`;
}

export interface CodexBumpResult {
  readonly version: string;
  readonly previousVersion: string;
  readonly bundleDirectory: string;
  readonly crateCount: number;
  readonly licenseTextCount: number;
  readonly hostExecutable: string | null;
}

function currentCodexVersion(repoRoot: string): string {
  const text = FS.readFileSync(Path.join(repoRoot, "packages/shared/src/codexRuntime.ts"), "utf8");
  const match = /MOSS_BUNDLED_CODEX_VERSION = "([^"]+)"/u.exec(text);
  if (!match)
    throw new Error("packages/shared/src/codexRuntime.ts has no MOSS_BUNDLED_CODEX_VERSION.");
  return match[1]!;
}

export async function bumpBundledCodex(
  context: BumpContext,
  version: string,
): Promise<CodexBumpResult> {
  const { repoRoot, log } = context;
  const previousVersion = currentCodexVersion(repoRoot);
  log(`Codex ${previousVersion} -> ${version} (registry ${context.registry})`);

  // 1. npm archives, integrity-checked.
  const documents = new Map<CodexArchiveId, Awaited<ReturnType<typeof fetchVersionDocument>>>();
  for (const id of CODEX_ARCHIVE_IDS) {
    const npmVersion = id === "launcher" ? version : `${version}-${id}`;
    const document = await fetchVersionDocument(context.registry, CODEX_PACKAGE, npmVersion);
    if (document.license !== "Apache-2.0") {
      throw new Error(`${CODEX_PACKAGE}@${npmVersion} is licensed ${String(document.license)}.`);
    }
    documents.set(id, document);
  }
  const launcher = documents.get("launcher")!;
  const expectedOptional = Object.fromEntries(
    CODEX_ARCHIVE_IDS.filter((id) => id !== "launcher").map((id) => [
      `${CODEX_PACKAGE}-${id}`,
      `npm:${CODEX_PACKAGE}@${version}-${id}`,
    ]),
  );
  if (
    JSON.stringify(Object.entries(launcher.optionalDependencies ?? {}).toSorted()) !==
    JSON.stringify(Object.entries(expectedOptional).toSorted())
  ) {
    throw new Error(
      `${CODEX_PACKAGE}@${version} optionalDependencies changed shape; review the bump.`,
    );
  }

  const archives: PayloadArchiveRecord[] = [];
  const voiceByArchive = new Map<CodexArchiveId, Map<string, Buffer>>();
  for (const id of CODEX_ARCHIVE_IDS) {
    const document = documents.get(id)!;
    log(`  npm ${document.name}@${document.version}`);
    const file = await downloadNpmTarball({ document, cacheDir: context.cacheDir });
    const { files, voice } = await hashNpmArchive(file.path);
    if (id !== "launcher") voiceByArchive.set(id, voice);
    archives.push({
      id,
      npmPackage: CODEX_PACKAGE,
      npmVersion: document.version,
      archive: `codex-${document.version}.tgz`,
      npmIntegrity: document.dist.integrity,
      size: file.size,
      sha256: file.sha256,
      files,
    });
  }

  // 2. Source commit: the release tag, cross-checked with the voice manifests' build commit.
  const commit = resolveTagCommit(version);
  for (const [id, voice] of voiceByArchive) {
    const manifest = voice.get("manifest.json");
    if (!manifest) continue;
    const buildCommit = (JSON.parse(manifest.toString("utf8")) as { buildCommit?: string })
      .buildCommit;
    if (buildCommit && buildCommit !== commit) {
      throw new Error(
        `${id} voice manifest was built from ${buildCommit}, tag rust-v${version} is ${commit}.`,
      );
    }
  }
  log(`  source openai/codex@${commit}`);

  const bundleDirectory = Path.join(repoRoot, CODEX_BUNDLE_PARENT, version);
  const sourceName = `codex-rust-v${version}-source.tar.gz`;
  // Reuse the committed archive when this version was generated before: GitHub's on-the-fly
  // archives are not guaranteed byte-stable, the committed one is.
  const committedSource = Path.join(bundleDirectory, "sources", sourceName);
  const sourcePath = FS.existsSync(committedSource)
    ? committedSource
    : await downloadGitHubSnapshot(context, "openai", "codex", commit);
  const sourceSha256 = sha256Hex(FS.readFileSync(sourcePath));
  const codexSource = await indexRepoArchive(sourcePath, {
    label: `openai/codex@${commit}`,
    extraPaths: [
      "LICENSE",
      "NOTICE",
      "codex-rs/Cargo.lock",
      ".github/scripts/install-musl-build-tools.sh",
      "codex-rs/vendor/bubblewrap/meson.build",
      "scripts/codex_package/rg",
    ],
  });
  const extra = (path: string): Buffer => {
    const bytes = codexSource.extras.get(path);
    if (!bytes) throw new Error(`openai/codex@${commit} has no ${path}.`);
    return bytes;
  };

  // 3. Native components.
  const installScript = extra(".github/scripts/install-musl-build-tools.sh").toString("utf8");
  const libcapVersion = readShellAssignment(installScript, "libcap_version");
  const libcapSha256 = readShellAssignment(installScript, "libcap_sha256");
  const libcapUrl = readShellAssignment(installScript, "libcap_download_url")
    .replaceAll("${libcap_tarball_name}", `libcap-${libcapVersion}.tar.xz`)
    .replaceAll("${libcap_version}", libcapVersion);
  const libcap = await downloadToCache({
    url: libcapUrl,
    cacheDir: context.cacheDir,
    cacheKey: Path.join("sources", `libcap-${libcapVersion}.tar.xz`),
    expected: { sha256: libcapSha256 },
    label: `libcap ${libcapVersion}`,
  });
  const libcapLicense = readXzTarMember(libcap.path, `libcap-${libcapVersion}/License`);
  const bubblewrapVersion = /version\s*:\s*'([^']+)'/u.exec(
    extra("codex-rs/vendor/bubblewrap/meson.build").toString("utf8"),
  )?.[1];
  const bubblewrapCopying = codexSource.licenseFiles.get("codex-rs/vendor/bubblewrap/COPYING");
  if (!bubblewrapVersion || !bubblewrapCopying)
    throw new Error("bubblewrap version or COPYING not found.");

  const dotslash = JSON.parse(
    extra("scripts/codex_package/rg")
      .toString("utf8")
      .replace(/^#!.*\n/u, ""),
  ) as { platforms: Record<string, { providers: { url: string }[] }> };
  const ripgrepVersions = new Set(
    Object.values(dotslash.platforms).flatMap((platform) =>
      platform.providers.map(
        (provider) => /\/releases\/download\/([^/]+)\//u.exec(provider.url)?.[1],
      ),
    ),
  );
  if (ripgrepVersions.size !== 1 || ripgrepVersions.has(undefined)) {
    throw new Error(`Could not read one ripgrep version from scripts/codex_package/rg.`);
  }
  const ripgrepVersion = [...ripgrepVersions][0]!;
  const ripgrepChecksum = await crateIndexChecksum(context, "ripgrep", ripgrepVersion);
  if (!ripgrepChecksum) throw new Error(`ripgrep ${ripgrepVersion} is not on crates.io.`);
  const ripgrepCrate = await indexRepoArchive(
    await downloadCrate(context, "ripgrep", ripgrepVersion, ripgrepChecksum),
    { label: `ripgrep ${ripgrepVersion}`, extraPaths: ["Cargo.lock"] },
  );
  const ripgrepLock = parseCargoLock(ripgrepCrate.extras.get("Cargo.lock")?.toString("utf8") ?? "");
  const ripgrepLicense = resolveCrateLicense(ripgrepCrate, "", {
    includeNested: false,
    fallbackToAncestors: false,
  });
  const pcre2Sys = ripgrepLock.find((pkg) => pkg.name === "pcre2-sys");
  if (!pcre2Sys?.checksum) throw new Error(`ripgrep ${ripgrepVersion} no longer locks pcre2-sys.`);
  const pcre2Crate = await indexRepoArchive(
    await downloadCrate(context, pcre2Sys.name, pcre2Sys.version, pcre2Sys.checksum),
    { label: `pcre2-sys ${pcre2Sys.version}`, extraPaths: ["upstream/include/pcre2.h"] },
  );
  // pcre2-sys statically builds its vendored PCRE2 C sources into rg, but its published crate
  // leaves PCRE2's LICENCE out. The licence text itself is shipped by Codex's voice payload
  // (licenses/PCRE2.md), so that copy is used; the version comes from the vendored header.
  const pcre2Header = pcre2Crate.extras.get("upstream/include/pcre2.h")?.toString("utf8") ?? "";
  const pcre2Major = /#define PCRE2_MAJOR\s+(\d+)/u.exec(pcre2Header)?.[1];
  const pcre2Minor = /#define PCRE2_MINOR\s+(\d+)/u.exec(pcre2Header)?.[1];
  if (!pcre2Major || !pcre2Minor) {
    throw new Error(`pcre2-sys ${pcre2Sys.version}: vendored PCRE2 version not found.`);
  }

  // Voice libraries: each platform payload ships its own notice, licenses and source list
  // (line endings and the Windows MSVC runtime section differ), so each set is kept.
  for (const [id, voice] of voiceByArchive) {
    if (!voice.has("NOTICE.md"))
      throw new Error(`${id} payload has no codex-resources/voice/NOTICE.md.`);
  }

  // 4. Crates.
  const codexLock = parseCargoLock(extra("codex-rs/Cargo.lock").toString("utf8"));
  log(`  crates: ${codexLock.length} in codex-rs/Cargo.lock, ${ripgrepLock.length} in ripgrep's`);
  const store = new LicenseTextStore();
  const crates = await resolveCrates({
    context,
    codexSource,
    sourceCommit: commit,
    reviewedDistribution: { sourceCommit: commit, sourceSha256, payloadArchives: archives },
    codexLock,
    ripgrepLock,
    store,
  });

  // Validate the lock rewrite before any file changes.
  const lockDocuments = new Map(
    CODEX_ARCHIVE_IDS.map((id) => [
      id === "launcher" ? CODEX_PACKAGE : `${CODEX_PACKAGE}-${id}`,
      documents.get(id)!,
    ]),
  );
  const writeBunLocks = await prepareBunLockRewrites(context, {
    packageName: CODEX_PACKAGE,
    previousVersion,
    version,
    documents: lockDocuments,
    fetchPrevious: (key) =>
      fetchVersionDocument(
        context.registry,
        CODEX_PACKAGE,
        key === CODEX_PACKAGE
          ? previousVersion
          : `${previousVersion}-${key.slice(`${CODEX_PACKAGE}-`.length)}`,
      ),
  });

  // 5. Write the bundle from scratch, then swap it in.
  const parent = Path.join(repoRoot, CODEX_BUNDLE_PARENT);
  const staging = Path.join(parent, `.${version}.staging`);
  FS.rmSync(staging, { recursive: true, force: true });
  const put = (relative: string, bytes: Buffer | string) => {
    const target = Path.join(staging, ...relative.split("/"));
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, bytes);
  };
  put("LICENSE", extra("LICENSE"));
  put("NOTICE", extra("NOTICE"));
  for (const [sha256, bytes] of store.texts) put(`licenses/rust/${sha256}.txt`, bytes);
  put("licenses/bubblewrap/COPYING", bubblewrapCopying);
  put("licenses/libcap/License", libcapLicense);
  const ripgrepFiles = ripgrepLicense.licenseFiles.map((path) => {
    put(`licenses/ripgrep/${path}`, ripgrepCrate.licenseFiles.get(path)!);
    return `licenses/ripgrep/${path}`;
  });
  // The Linux payload's copy keeps upstream's LF line endings (the Windows one is CRLF).
  const pcre2Licence = voiceByArchive.get("linux-x64")?.get("licenses/PCRE2.md");
  if (!pcre2Licence) throw new Error("Codex voice payload no longer ships licenses/PCRE2.md.");
  put("licenses/pcre2/LICENCE.md", pcre2Licence);
  const voicePaths = [...voiceByArchive].flatMap(([id, voice]) =>
    [...voice.keys()]
      .filter((name) => name !== "manifest.json")
      .toSorted(compareBytes)
      .map((name) => {
        const target = `licenses/voice/${id}/${name.replace(/^licenses\//u, "")}`;
        put(target, voice.get(name)!);
        return target;
      }),
  );
  const sourceRelative = `sources/${sourceName}`;
  const libcapRelative = `sources/libcap-${libcapVersion}.tar.xz`;
  FS.mkdirSync(Path.join(staging, "sources"), { recursive: true });
  FS.copyFileSync(sourcePath, Path.join(staging, "sources", sourceName));
  FS.copyFileSync(libcap.path, Path.join(staging, ...libcapRelative.split("/")));

  const linux = ["linux-arm64", "linux-x64"];
  const allPlatforms = CODEX_ARCHIVE_IDS.filter((id) => id !== "launcher");
  const native: NativeRecord[] = [
    {
      name: "ripgrep",
      version: ripgrepVersion,
      declaredLicense: ripgrepLicense.declaredLicense ?? "",
      selectedLicense: selectOrThrow(ripgrepLicense.declaredLicense ?? "", "ripgrep"),
      platforms: allPlatforms,
      shippedAs: "codex-path/rg",
      origin:
        "BurntSushi/ripgrep release build (scripts/codex_package/rg); its crates are in `crates`",
      licenseFiles: ripgrepFiles,
    },
    {
      name: "PCRE2",
      version: `${pcre2Major}.${pcre2Minor}`,
      declaredLicense: "BSD-3-Clause WITH PCRE2-exception",
      selectedLicense: "BSD-3-Clause WITH PCRE2-exception",
      platforms: allPlatforms,
      shippedAs: "statically linked into codex-path/rg",
      origin: `vendored by pcre2-sys ${pcre2Sys.version}; licence text from the Codex voice payload`,
      licenseFiles: ["licenses/pcre2/LICENCE.md"],
    },
    {
      name: "bubblewrap",
      version: bubblewrapVersion,
      declaredLicense: "LGPL-2.0-or-later",
      selectedLicense: "LGPL-2.0-or-later",
      platforms: linux,
      shippedAs: "codex-resources/bwrap (static)",
      origin: "openai/codex codex-rs/vendor/bubblewrap",
      licenseFiles: ["licenses/bubblewrap/COPYING"],
      source: sourceRelative,
    },
    {
      name: "libcap",
      version: libcapVersion,
      declaredLicense: "BSD-3-Clause OR GPL-2.0-only",
      selectedLicense: "BSD-3-Clause",
      platforms: linux,
      shippedAs: "statically linked into codex-resources/bwrap",
      origin: libcapUrl,
      licenseFiles: ["licenses/libcap/License"],
      source: libcapRelative,
    },
    {
      name: "codex voice libraries",
      version,
      declaredLicense: "LGPL-2.1-or-later AND BSD-3-Clause AND MIT AND Zlib AND MSVC-runtime",
      selectedLicense: "LGPL-2.1-or-later AND BSD-3-Clause AND MIT AND Zlib AND MSVC-runtime",
      platforms: allPlatforms,
      shippedAs: "codex-resources/voice (dynamic libraries)",
      origin: "Codex npm payload codex-resources/voice (NOTICE.md, licenses/, sources.json)",
      licenseFiles: voicePaths,
    },
  ];

  const payloads = {
    schemaVersion: 1,
    package: CODEX_PACKAGE,
    baseVersion: version,
    registry: NPM_CANONICAL_REGISTRY,
    archives,
  };
  put("PAYLOADS.json", `${JSON.stringify(payloads, null, 2)}\n`);
  const thirdParty = {
    schemaVersion: 1,
    codexVersion: version,
    sourceCommit: commit,
    generatedBy: `bun run bump:codex ${version}`,
    policy: {
      approvedCrateLicenses: [...APPROVED_CRATE_LICENSES],
      approvedExceptions: [...APPROVED_LICENSE_EXCEPTIONS],
    },
    crateCount: crates.length,
    licenseTextCount: store.texts.size,
    crates,
    native,
  };
  put("THIRD_PARTY.json", `${JSON.stringify(thirdParty, null, 2)}\n`);
  put(
    "README.md",
    readmeText({
      version,
      commit,
      sourceArchive: { path: sourceRelative, sha256: sourceSha256 },
      libcap: {
        version: libcapVersion,
        path: libcapRelative,
        sha256: libcapSha256,
        url: libcapUrl,
      },
      bubblewrapVersion,
      ripgrepVersion,
      crateCount: crates.length,
      textCount: store.texts.size,
    }),
  );

  for (const entry of FS.readdirSync(parent)) {
    if (entry === Path.basename(staging)) continue;
    FS.rmSync(Path.join(parent, entry), { recursive: true, force: true });
  }
  FS.renameSync(staging, bundleDirectory);

  // 6. Pins.
  const { computeBundledCodexComplianceTree } =
    await import("../bundled-codex-release-compliance.ts");
  const tree = computeBundledCodexComplianceTree(bundleDirectory);
  const fileSha = (relative: string) =>
    sha256Hex(FS.readFileSync(Path.join(bundleDirectory, relative)));
  const pins = {
    version,
    sourceTag: `rust-v${version}`,
    sourceCommit: commit,
    tree,
    files: {
      LICENSE: fileSha("LICENSE"),
      NOTICE: fileSha("NOTICE"),
      "PAYLOADS.json": fileSha("PAYLOADS.json"),
      "README.md": fileSha("README.md"),
      "THIRD_PARTY.json": fileSha("THIRD_PARTY.json"),
    },
    crateCount: crates.length,
    nativeComponentCount: native.length,
    licenseTextCount: store.texts.size,
    payloadFileCount: archives.reduce((sum, archive) => sum + archive.files.length, 0),
    sourceMaterials: {
      [`codex-rust-v${version}`]: {
        path: sourceRelative,
        size: FS.statSync(Path.join(bundleDirectory, sourceRelative)).size,
        sha256: sourceSha256,
        mediaType: "application/gzip",
      },
      [`libcap-${libcapVersion}`]: {
        path: libcapRelative,
        size: libcap.size,
        sha256: libcap.sha256,
        mediaType: "application/x-xz",
      },
    },
    archives: Object.fromEntries(
      archives.map((archive) => [
        archive.id,
        {
          npmVersion: archive.npmVersion,
          archive: archive.archive,
          size: archive.size,
          sha256: archive.sha256,
          npmIntegrity: archive.npmIntegrity,
        },
      ]),
    ),
  };
  writeTextFile(
    Path.join(repoRoot, CODEX_PINS_FILE),
    `// FILE: bundled-codex-pins.ts
// Purpose: Pins the bundled Codex CLI release, its npm archives and its license bundle.
// GENERATED by \`bun run bump:codex ${version}\` (scripts/bump-agent-runtime.ts). Do not edit by hand.

export const BUNDLED_CODEX_PINS = ${JSON.stringify(pins, null, 2)} as const;
`,
  );

  // 7. Version pins elsewhere in the repository.
  if (previousVersion !== version) {
    replaceVersionLiterals(repoRoot, CODEX_VERSION_LITERAL_FILES, previousVersion, version, log);
    addChangelogLine(
      repoRoot,
      `Updated the Codex CLI shipped with the Moss desktop app from ${previousVersion} to ${version}.`,
    );
  }
  writeBunLocks();
  const win = archives.find((archive) => archive.id === "win32-x64")!;
  updateWindowsNativeManifest(repoRoot, {
    pathPrefix: "resources/codex-runtime/",
    sourcePrefix: `${CODEX_PACKAGE}@`,
    entries: win.files
      .filter(
        (file) => file.path.startsWith("vendor/") && /\.(?:dll|exe|node|pdb)$/u.test(file.path),
      )
      .map((file) => ({
        path: file.path.replace(/^vendor\//u, "resources/codex-runtime/"),
        sha256: file.sha256,
        source: `${CODEX_PACKAGE}@${win.npmVersion}`,
      })),
  });

  // 8. Host executable for the version probe (official bytes, integrity-checked above).
  let hostExecutable: string | null = null;
  const hostId = `${process.platform}-${process.arch}` as CodexArchiveId;
  const hostArchive = archives.find((archive) => archive.id === hostId);
  if (hostArchive) {
    const triple = TARGET_TRIPLES[hostId as Exclude<CodexArchiveId, "launcher">];
    const entry = `package/vendor/${triple}/bin/codex${process.platform === "win32" ? ".exe" : ""}`;
    const target = Path.join(
      context.cacheDir,
      "extract",
      `codex-${hostArchive.npmVersion}`,
      Path.basename(entry),
    );
    if (!FS.existsSync(target)) {
      FS.mkdirSync(Path.dirname(target), { recursive: true });
      const parts: Buffer[] = [];
      await readTarFile(
        Path.join(context.cacheDir, "npm", "@openai", "codex", hostArchive.archive),
        {
          entry: (header) =>
            header.path === entry
              ? { chunk: (b) => parts.push(Buffer.from(b)), end: () => {} }
              : null,
        },
      );
      FS.writeFileSync(target, Buffer.concat(parts), { mode: 0o755 });
    }
    hostExecutable = target;
  }

  return {
    version,
    previousVersion,
    bundleDirectory,
    crateCount: crates.length,
    licenseTextCount: store.texts.size,
    hostExecutable,
  };
}

export async function resolveLatestCodexVersion(context: BumpContext): Promise<string> {
  const tags = (await fetchJson(
    `${context.registry}/-/package/${CODEX_PACKAGE.replace("/", "%2f")}/dist-tags`,
    "codex dist-tags",
  )) as Record<string, string>;
  if (!tags.latest) throw new Error("@openai/codex has no latest dist-tag.");
  return tags.latest;
}
