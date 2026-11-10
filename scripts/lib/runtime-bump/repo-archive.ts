// FILE: repo-archive.ts
// Purpose: Indexes the Cargo manifests and license texts inside a source archive (.crate or GitHub tarball).
// Layer: Release/build helper (agent runtime bumps)

import * as Path from "node:path";
import {
  isLicenseFileName,
  readCargoManifestLicense,
  readWorkspacePackageLicense,
} from "./cargo.ts";
import { readTarFile } from "./tar.ts";

/** Directories whose license-looking files are fixtures or docs, not shipped code. */
const NON_SHIPPED_DIRECTORY =
  /^(?:tests?|testdata|test-data|test_data|examples?|benches|fuzz|docs?|\.github|ci)$/iu;

export interface RepoArchiveIndex {
  /** Original checked archive, for bounded second-pass notice extraction. */
  readonly archivePath?: string;
  /** Common top-level directory of every entry (`serde-1.0.228`, `codex-<sha>`), no trailing slash. */
  readonly root: string;
  /** Cargo.toml text by directory relative to the root ("" for the root itself). */
  readonly manifests: ReadonlyMap<string, string>;
  /** License-like file bytes by path relative to the root. */
  readonly licenseFiles: ReadonlyMap<string, Buffer>;
  /** Extra files requested by exact relative path. */
  readonly extras: ReadonlyMap<string, Buffer>;
}

export async function indexRepoArchive(
  filePath: string,
  options: { readonly extraPaths?: readonly string[]; readonly label: string },
): Promise<RepoArchiveIndex> {
  const manifests = new Map<string, string>();
  const licenseFiles = new Map<string, Buffer>();
  const extras = new Map<string, Buffer>();
  const extraPaths = new Set([".cargo_vcs_info.json", ...(options.extraPaths ?? [])]);
  let root: string | null = null;
  await readTarFile(filePath, {
    entry: (header) => {
      const slash = header.path.indexOf("/");
      const top = slash === -1 ? header.path : header.path.slice(0, slash);
      if (top === "pax_global_header" || header.type === "other") return null;
      if (root === null) root = top;
      else if (root !== top) {
        throw new Error(`${options.label}: archive has more than one top-level directory.`);
      }
      if (header.type !== "file" || slash === -1) return null;
      const relative = header.path.slice(slash + 1);
      const baseName = Path.posix.basename(relative);
      const isManifest = baseName === "Cargo.toml";
      // REUSE names its license texts by SPDX identifier, e.g. LICENSES/MIT.txt.
      const isLicense =
        isLicenseFileName(baseName) || /(?:^|\/)LICENSES\/[^/]+\.txt$/iu.test(relative);
      // Some projects (notably r-efi) put both their grant and copyright notices
      // in AUTHORS. A plain contributor list is not a substitute for a license.
      const isAuthors = /^AUTHORS(?:\.(?:md|txt|rst))?$/iu.test(baseName);
      const isExtra = extraPaths.has(relative);
      if (!isManifest && !isLicense && !isExtra && !isAuthors) return null;
      if (header.size > 16 * 1024 * 1024)
        throw new Error(`${options.label}: archive metadata is too large: ${relative}.`);
      const parts: Buffer[] = [];
      return {
        chunk: (bytes) => parts.push(Buffer.from(bytes)),
        end: () => {
          const bytes = Buffer.concat(parts);
          if (isManifest)
            manifests.set(
              Path.posix.dirname(relative).replace(/^\.$/u, ""),
              bytes.toString("utf8"),
            );
          const authorsGrant =
            isAuthors &&
            /\bcopyright\b/iu.test(bytes.toString("utf8")) &&
            /permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/iu.test(
              bytes.toString("utf8"),
            );
          if (isLicense || authorsGrant) licenseFiles.set(relative, bytes);
          if (isExtra) extras.set(relative, bytes);
        },
      };
    },
  });
  if (root === null) throw new Error(`${options.label}: archive is empty.`);
  // Cargo permits any relative filename in license-file. The first pass finds
  // manifests; the second reads precisely those declarations, regardless of name.
  const declaredPaths = new Set<string>();
  for (const [directory, text] of manifests) {
    for (const declared of [
      readCargoManifestLicense(text).licenseFile,
      readWorkspacePackageLicense(text).licenseFile,
    ]) {
      if (!declared) continue;
      const relative = normalizeWithin(directory, declared);
      if (relative && !licenseFiles.has(relative) && !extras.has(relative))
        declaredPaths.add(relative);
    }
  }
  if (declaredPaths.size > 0) {
    await readTarFile(filePath, {
      entry: (header) => {
        if (header.type !== "file" || !header.path.startsWith(`${root}/`)) return null;
        const relative = header.path.slice(root!.length + 1);
        if (!declaredPaths.has(relative)) return null;
        if (header.size > 16 * 1024 * 1024)
          throw new Error(`${options.label}: declared license file is too large: ${relative}.`);
        const parts: Buffer[] = [];
        return {
          chunk: (bytes) => parts.push(Buffer.from(bytes)),
          end: () => extras.set(relative, Buffer.concat(parts)),
        };
      },
    });
  }
  return { root, manifests, licenseFiles, extras, archivePath: filePath };
}

function isShippedPath(relative: string): boolean {
  return Path.posix
    .dirname(relative)
    .split("/")
    .every((segment) => !NON_SHIPPED_DIRECTORY.test(segment));
}

function directLicenseFiles(index: RepoArchiveIndex, directory: string): string[] {
  const prefix = directory ? `${directory}/` : "";
  return [...index.licenseFiles.keys()].filter((path) => {
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    // Root-level files plus the REUSE `LICENSES/` folder.
    return !rest.includes("/") || /^LICENSES\/[^/]+$/u.test(rest);
  });
}

function normalizeWithin(directory: string, relative: string): string | null {
  const joined = Path.posix.normalize(Path.posix.join(directory || ".", relative));
  if (joined.startsWith("../") || joined === ".." || Path.posix.isAbsolute(joined)) return null;
  return joined;
}

export interface ResolvedCrateLicense {
  readonly declaredLicense: string | null;
  /** Paths relative to the archive root, sorted. */
  readonly licenseFiles: readonly string[];
}

/**
 * Resolves a crate's declared license and license texts inside an archive. `crateDirectory` is
 * the crate's folder relative to the root. Nested texts (vendored C code) count when
 * `includeNested` is set; tests, docs and examples never do.
 */
export function resolveCrateLicense(
  index: RepoArchiveIndex,
  crateDirectory: string,
  options: { readonly includeNested: boolean; readonly fallbackToAncestors: boolean },
): ResolvedCrateLicense {
  const manifestText = index.manifests.get(crateDirectory);
  if (manifestText === undefined) {
    throw new Error(`No Cargo.toml at ${crateDirectory || "<root>"} in ${index.root}.`);
  }
  const manifest = readCargoManifestLicense(manifestText);
  const ancestors: string[] = [];
  for (let directory = crateDirectory; directory; ) {
    directory = Path.posix.dirname(directory).replace(/^\.$/u, "");
    ancestors.push(directory);
  }
  let declaredLicense = manifest.license ?? null;
  let licenseFile = manifest.licenseFile ?? null;
  let licenseFileBase = crateDirectory;
  if (manifest.licenseFromWorkspace || manifest.licenseFileFromWorkspace) {
    for (const ancestor of ancestors) {
      const text = index.manifests.get(ancestor);
      if (text === undefined) continue;
      const workspace = readWorkspacePackageLicense(text);
      if (manifest.licenseFromWorkspace && workspace.license) declaredLicense = workspace.license;
      if (manifest.licenseFileFromWorkspace && workspace.licenseFile) {
        licenseFile = workspace.licenseFile;
        licenseFileBase = ancestor;
      }
      if (workspace.license || workspace.licenseFile) break;
    }
  }
  const selected = new Set(directLicenseFiles(index, crateDirectory));
  if (options.includeNested) {
    const prefix = crateDirectory ? `${crateDirectory}/` : "";
    for (const path of index.licenseFiles.keys()) {
      if (path.startsWith(prefix) && isShippedPath(path.slice(prefix.length))) selected.add(path);
    }
  }
  if (licenseFile) {
    const resolved = normalizeWithin(licenseFileBase, licenseFile);
    if (resolved && index.licenseFiles.has(resolved)) selected.add(resolved);
    else if (resolved && index.extras.has(resolved)) selected.add(resolved);
    else
      throw new Error(
        `${index.root}/${crateDirectory}: declared license-file ${licenseFile} is unavailable in the source archive.`,
      );
  }
  if (selected.size === 0 && options.fallbackToAncestors) {
    for (const ancestor of ancestors) {
      const found = directLicenseFiles(index, ancestor);
      if (found.length > 0) {
        for (const path of found) selected.add(path);
        break;
      }
    }
  }
  return {
    declaredLicense,
    licenseFiles: [...selected].toSorted((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  };
}

/** Finds the directory of the crate named `name` (and `version`, when its manifest states one). */
export function findCrateDirectory(index: RepoArchiveIndex, name: string, version: string): string {
  const candidates: { directory: string; versionMatches: boolean }[] = [];
  for (const [directory, text] of index.manifests) {
    const manifest = readCargoManifestLicense(text);
    if (manifest.name !== name) continue;
    candidates.push({ directory, versionMatches: manifest.version === version });
  }
  const exact = candidates.filter((candidate) => candidate.versionMatches);
  const pool = exact.length > 0 ? exact : candidates;
  if (pool.length !== 1) {
    throw new Error(
      `${index.root}: expected one Cargo.toml for ${name}@${version}, found ${pool.length} (${pool.map((c) => c.directory || "<root>").join(", ")}).`,
    );
  }
  return pool[0]!.directory;
}
