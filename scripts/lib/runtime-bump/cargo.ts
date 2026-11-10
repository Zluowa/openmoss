// FILE: cargo.ts
// Purpose: Reads Cargo.lock packages and the license fields of Cargo.toml files without cargo.
// Layer: Release/build helper (agent runtime bumps)

export interface CargoLockPackage {
  readonly name: string;
  readonly version: string;
  /** Absent for workspace (path) members. */
  readonly source?: string;
  /** crates.io `.crate` SHA-256, present for registry packages. */
  readonly checksum?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

/** Parses the `[[package]]` tables of a Cargo.lock (format version 3 or 4). */
export function parseCargoLock(text: string): CargoLockPackage[] {
  const packages: CargoLockPackage[] = [];
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (!current) return;
    if (!current.name || !current.version)
      throw new Error("Cargo.lock package without name/version");
    packages.push({
      name: current.name,
      version: current.version,
      ...(current.source ? { source: current.source } : {}),
      ...(current.checksum ? { checksum: current.checksum } : {}),
    });
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      flush();
      current = {};
      continue;
    }
    if (line.startsWith("[")) {
      flush();
      continue;
    }
    if (!current) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(".*")$/u.exec(line);
    if (match) current[match[1]!] = unquote(match[2]!);
  }
  flush();
  return packages;
}

/**
 * Yields the manifest's lines with TOML multi-line strings (`"""`/`'''`) blanked, so a
 * `description = """...license = "x"..."""` can never be read as a field.
 */
function manifestLines(text: string): string[] {
  const lines: string[] = [];
  let closing: string | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    if (closing) {
      if (rawLine.includes(closing)) closing = null;
      lines.push("");
      continue;
    }
    const opening = /=\s*("""|''')/u.exec(rawLine);
    if (opening) {
      const rest = rawLine.slice(opening.index + opening[0].length);
      if (!rest.includes(opening[1]!)) closing = opening[1]!;
      lines.push("");
      continue;
    }
    lines.push(rawLine);
  }
  return lines;
}

export interface CargoManifestLicense {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly homepage?: string;
  readonly licenseFile?: string;
  readonly licenseFromWorkspace: boolean;
  readonly licenseFileFromWorkspace: boolean;
}

/**
 * Reads `[package]` name/version/license/license-file, recognising `license.workspace = true`
 * and `license = { workspace = true }`. Only the simple string forms Cargo emits are supported.
 */
export function readCargoManifestLicense(text: string): CargoManifestLicense {
  let section = "";
  const fields: Record<string, string> = {};
  let licenseFromWorkspace = false;
  let licenseFileFromWorkspace = false;
  for (const rawLine of manifestLines(text)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    // `[[bin]]`/`[[test]]` array tables end `[package]` just like `[dependencies]`.
    const header = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section === "package.license" && /^workspace\s*=\s*true$/u.test(line)) {
      licenseFromWorkspace = true;
      continue;
    }
    if (section !== "package") continue;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (/^\{\s*workspace\s*=\s*true\s*\}$/u.test(value) || key.endsWith(".workspace")) {
      const base = key.replace(/\.workspace$/u, "");
      if (base === "license" && /true/u.test(value)) licenseFromWorkspace = true;
      if (base === "license-file" && /true/u.test(value)) licenseFileFromWorkspace = true;
      continue;
    }
    if (value.startsWith('"') || value.startsWith("'")) fields[key] = unquote(value);
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.version ? { version: fields.version } : {}),
    ...(fields.license ? { license: fields.license } : {}),
    ...(fields.repository ? { repository: fields.repository } : {}),
    ...(fields.homepage ? { homepage: fields.homepage } : {}),
    ...(fields["license-file"] ? { licenseFile: fields["license-file"] } : {}),
    licenseFromWorkspace,
    licenseFileFromWorkspace,
  };
}

/** Reads `[workspace.package] license` (and license-file) from a workspace root manifest. */
export function readWorkspacePackageLicense(text: string): {
  readonly license?: string;
  readonly licenseFile?: string;
} {
  let section = "";
  const fields: Record<string, string> = {};
  for (const rawLine of manifestLines(text)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    // `[[bin]]`/`[[test]]` array tables end `[package]` just like `[dependencies]`.
    const header = /^\[\[?([^\]]+)\]\]?$/u.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== "workspace.package") continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(["'].*["'])$/u.exec(line);
    if (match) fields[match[1]!] = unquote(match[2]!);
  }
  return {
    ...(fields.license ? { license: fields.license } : {}),
    ...(fields["license-file"] ? { licenseFile: fields["license-file"] } : {}),
  };
}

const LICENSE_FILE_NAME =
  /^(?:(?:un)?licen[cs]e|copying|copyright|notice)(?:[-_.][a-z0-9._-]*)?$|^[a-z0-9]+[-_]licen[cs]e(?:[-_.][a-z0-9._-]*)?$/iu;

/** True for license-like file names a crate ships at its root (LICENSE-MIT, COPYING, NOTICE...). */
export function isLicenseFileName(fileName: string): boolean {
  return LICENSE_FILE_NAME.test(fileName) && !SOURCE_CODE_EXTENSION.test(fileName);
}

/** `license.rs`, `notice.py` and friends are code, not license texts. */
const SOURCE_CODE_EXTENSION =
  /\.(?:rs|c|h|cc|cpp|hpp|py|js|mjs|ts|go|java|toml|json|ya?ml|sh|ps1|bat|in|am|ac|cmake|bzl|bazel|s|asm|pl|rb|sql|lock|png|svg)$/iu;

export interface GitSource {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
}

/** Parses `git+https://github.com/<owner>/<repo>[.git][?...]#<commit>` lock sources. */
export function parseGitSource(source: string): GitSource {
  const match =
    /^git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\?[^#]*)?#([0-9a-f]{40})$/u.exec(
      source,
    );
  if (!match)
    throw new Error(`Unsupported Cargo git source (only GitHub commits are supported): ${source}`);
  return { owner: match[1]!, repo: match[2]!, commit: match[3]! };
}

export const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
