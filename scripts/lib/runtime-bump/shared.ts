// FILE: shared.ts
// Purpose: Repository rewrites shared by the Codex and Claude runtime bumps.
// Layer: Release/build helper (agent runtime bumps)

import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import {
  bunLockPackageEntry,
  findBunLockPackageEntry,
  replaceBunLockPackageEntry,
  replaceBunLockWorkspaceSpec,
  type NpmVersionDocument,
} from "./bun-lock.ts";

export interface BumpContext {
  readonly repoRoot: string;
  readonly registry: string;
  readonly cacheDir: string;
  readonly cratesUrlTemplate: string;
  readonly cratesIndexUrl: string;
  readonly concurrency: number;
  readonly log: (message: string) => void;
}

export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Writes text with LF endings (the repository is LF; Windows tools may not be). */
export function writeTextFile(filePath: string, text: string): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, text.replace(/\r\n/gu, "\n"));
}

export function writeJsonFile(filePath: string, value: unknown): void {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Replaces the exact version `from` (also in its regex-escaped `1\.2\.3` spelling) in each file.
 * A version is matched only as a whole: `10.1.2` and `1.2.30` never match `0.1.2`/`1.2.3`.
 */
export function replaceVersionLiterals(
  repoRoot: string,
  files: readonly string[],
  from: string,
  to: string,
  log: (message: string) => void = () => {},
): void {
  const spellings = [
    { find: from, replace: to },
    { find: from.replaceAll(".", "\\."), replace: to.replaceAll(".", "\\.") },
  ];
  for (const relative of files) {
    const filePath = Path.join(repoRoot, relative);
    let text = FS.readFileSync(filePath, "utf8");
    let count = 0;
    for (const spelling of spellings) {
      const pattern = new RegExp(`(?<![0-9.])${escapeRegExp(spelling.find)}(?![0-9])`, "gu");
      text = text.replace(pattern, () => {
        count += 1;
        return spelling.replace;
      });
    }
    if (count === 0) {
      log(`  note: ${relative} no longer mentions ${from}`);
      continue;
    }
    FS.writeFileSync(filePath, text);
    log(`  ${relative}: ${count} version literal(s)`);
  }
}

/** An entry as older bun releases wrote it: they did not record `libc`. */
function withoutLibc(entry: string): string {
  return entry.replace(/, "libc": (?:"[^"]*"|\[[^\]]*\])/u, "");
}

export const BUN_LOCK_FILES = ["bun.lock", "scripts/desktop-stage-lock/bun.lock"] as const;

/**
 * Prepares the rewrite of the given registry packages in both bun.lock files and returns the
 * function that writes it. Before anything is written, the generator must reproduce each
 * existing entry from the previous version's registry metadata (older bun releases omitted
 * `libc`, so an entry that differs only by that field also counts); if bun's format ever drifts,
 * the bump stops before touching any file.
 */
export async function prepareBunLockRewrites(
  context: BumpContext,
  input: {
    readonly packageName: string;
    readonly previousVersion: string;
    readonly version: string;
    readonly documents: ReadonlyMap<string, NpmVersionDocument>;
    readonly fetchPrevious: (key: string) => Promise<NpmVersionDocument>;
  },
): Promise<() => void> {
  const previousEntries = new Map<string, string>();
  for (const key of input.documents.keys()) {
    previousEntries.set(key, bunLockPackageEntry(key, await input.fetchPrevious(key)));
  }
  const writes: Array<{ filePath: string; relative: string; text: string }> = [];
  for (const relative of BUN_LOCK_FILES) {
    const filePath = Path.join(context.repoRoot, relative);
    let text = FS.readFileSync(filePath, "utf8");
    for (const [key, document] of input.documents) {
      const current = findBunLockPackageEntry(text, key);
      if (current === null) throw new Error(`${relative} has no entry for ${key}.`);
      const expected = previousEntries.get(key)!;
      const next = bunLockPackageEntry(key, document);
      if (current !== expected && current !== withoutLibc(expected) && current !== next) {
        throw new Error(
          `${relative}: the generated entry for ${key} does not match bun's.\n  bun:       ${current}\n  generated: ${expected}\nRegenerate with bun install --lockfile-only and update scripts/lib/runtime-bump/bun-lock.ts.`,
        );
      }
      text = replaceBunLockPackageEntry(text, key, next);
    }
    if (input.previousVersion !== input.version) {
      const result = replaceBunLockWorkspaceSpec(
        text,
        input.packageName,
        input.previousVersion,
        input.version,
      );
      if (result.count === 0) {
        throw new Error(
          `${relative}: no workspace pins ${input.packageName}@${input.previousVersion}.`,
        );
      }
      text = result.text;
    }
    writes.push({ filePath, relative, text });
  }
  return () => {
    for (const write of writes) {
      FS.writeFileSync(write.filePath, write.text);
      context.log(`  ${write.relative}: ${input.documents.size} package entries`);
    }
  };
}

interface ManifestEntry {
  readonly path: string;
  readonly sha256?: string | undefined;
  readonly source: string;
}

/** Replaces one runtime's reviewed entries in the Windows x64 native payload manifest. */
export function updateWindowsNativeManifest(
  repoRoot: string,
  input: {
    readonly pathPrefix: string;
    readonly sourcePrefix: string;
    readonly entries: readonly ManifestEntry[];
  },
): void {
  const filePath = Path.join(repoRoot, "scripts", "windows-native-payload-manifest.json");
  const manifest = JSON.parse(FS.readFileSync(filePath, "utf8")) as {
    windows: Record<string, { preservedPayloads: ManifestEntry[] }>;
  };
  const list = manifest.windows.x64!.preservedPayloads;
  const owned = (entry: ManifestEntry) =>
    entry.path.startsWith(input.pathPrefix) && entry.source.startsWith(input.sourcePrefix);
  const first = list.findIndex(owned);
  if (first === -1)
    throw new Error(`Native payload manifest has no ${input.sourcePrefix} entries.`);
  const kept = list.filter((entry) => !owned(entry));
  const insertAt = list.slice(0, first).filter((entry) => !owned(entry)).length;
  const sorted = [...input.entries].toSorted((left, right) => compareBytes(left.path, right.path));
  manifest.windows.x64!.preservedPayloads = [
    ...kept.slice(0, insertAt),
    ...sorted.map(
      (entry): ManifestEntry =>
        entry.sha256
          ? { path: entry.path, sha256: entry.sha256, source: entry.source }
          : { path: entry.path, source: entry.source },
    ),
    ...kept.slice(insertAt),
  ];
  writeJsonFile(filePath, manifest);
}

/** Adds a line at the top of the Unreleased "Changed" list unless it is already there. */
export function addChangelogLine(repoRoot: string, line: string): void {
  const filePath = Path.join(repoRoot, "CHANGELOG.md");
  const text = FS.readFileSync(filePath, "utf8");
  if (text.includes(line)) return;
  const unreleased = text.indexOf("## Unreleased");
  const changed = text.indexOf("### Changed\n\n", unreleased);
  const nextRelease = text.indexOf("\n## ", unreleased + 1);
  if (unreleased === -1 || changed === -1 || (nextRelease !== -1 && changed > nextRelease)) {
    throw new Error("CHANGELOG.md has no Unreleased/Changed section to add the bump to.");
  }
  const at = changed + "### Changed\n\n".length;
  FS.writeFileSync(filePath, `${text.slice(0, at)}- ${line}\n${text.slice(at)}`);
}

/** Runs the repository formatter on the given files so generated output matches `fmt:check`. */
export function formatFiles(repoRoot: string, files: readonly string[]): void {
  const oxfmt = Path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt");
  const result = spawnSync(process.execPath, [oxfmt, ...files], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`oxfmt failed: ${result.stderr || result.stdout || result.error}`);
  }
}
