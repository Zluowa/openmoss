// FILE: skills.ts
// Purpose: Discover supported external-agent skill directories and copy them into
//          the Moss skill library. Discovery-only is not import.
// Layer: Server import helper

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { WorkspaceImportSkillCopy, WorkspaceImportSourceKind } from "@moss/contracts";
import { normalizeWorkspaceImportSource } from "@moss/contracts";
import { mossSkillsDir } from "../provider/skillsCatalog";
import { isSafeSkillName, skillRootsForSource } from "./paths";
import { createImportIoLimiter, type ImportIoLimiter } from "./ioLimit";
import { readRegularFileNoFollow, writeNewFileNoFollow } from "./safeFile";

const MAX_IMPORTED_SKILLS = 500;

export interface DiscoveredImportSkill {
  readonly name: string;
  readonly source: WorkspaceImportSourceKind;
  readonly path: string;
}

/** Lists a folder once; the listing answers both "is this a skill" and "what is inside". */
async function listSkillFolder(
  dir: string,
  io: ImportIoLimiter,
): Promise<import("node:fs").Dirent[] | null> {
  try {
    return await io(() => fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return null;
  }
}

function listingHasSkillMarkdown(entries: readonly import("node:fs").Dirent[]): boolean {
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md");
}

/** Safe, non-link child folders, in listing order. A link is never followed into a skill. */
function childSkillFolders(entries: readonly import("node:fs").Dirent[]): string[] {
  return entries
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSafeSkillName(entry.name),
    )
    .map((entry) => entry.name);
}

/**
 * Skill folders directly under `root`, or one level further down for grouped skills. Each
 * folder is listed once and the folders are read in parallel through the source limiter;
 * the result keeps the listing order, so the first `MAX_IMPORTED_SKILLS` are the same ones
 * a folder-by-folder read finds.
 */
async function collectSkillsFromRoot(
  root: string,
  source: WorkspaceImportSourceKind,
  io: ImportIoLimiter,
): Promise<DiscoveredImportSkill[]> {
  try {
    const rootStat = await io(() => fs.lstat(root));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const entries = await listSkillFolder(root, io);
  if (!entries) return [];
  const perChild = await Promise.all(
    childSkillFolders(entries).map(async (name): Promise<DiscoveredImportSkill[]> => {
      const childPath = nodePath.join(root, name);
      const childEntries = await listSkillFolder(childPath, io);
      if (!childEntries) return [];
      if (listingHasSkillMarkdown(childEntries)) return [{ name, source, path: childPath }];
      const nested = await Promise.all(
        childSkillFolders(childEntries).map(async (nestedName) => {
          const nestedPath = nodePath.join(childPath, nestedName);
          const nestedEntries = await listSkillFolder(nestedPath, io);
          return nestedEntries && listingHasSkillMarkdown(nestedEntries)
            ? [{ name: nestedName, source, path: nestedPath }]
            : [];
        }),
      );
      return nested.flat();
    }),
  );
  return perChild.flat().slice(0, MAX_IMPORTED_SKILLS);
}

export async function discoverImportSkills(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The source's filesystem limiter, shared with its other probe steps. */
  readonly io?: ImportIoLimiter | undefined;
}): Promise<DiscoveredImportSkill[]> {
  const io = input.io ?? createImportIoLimiter();
  const pathInput = {
    source: input.source,
    homeDir: input.homeDir,
    env: input.env,
    ...(input.platform ? { platform: input.platform } : {}),
  };
  const roots = skillRootsForSource(input.source, pathInput);
  const perRoot = await Promise.all(
    roots.map(async (root) => {
      const skills = await collectSkillsFromRoot(root, input.source, io);
      const realPaths = await Promise.all(
        skills.map((skill) => io(() => fs.realpath(skill.path)).catch(() => null)),
      );
      return skills.map((skill, index) => ({ skill, realPath: realPaths[index] ?? null }));
    }),
  );
  const discovered: DiscoveredImportSkill[] = [];
  const seen = new Set<string>();
  for (const { skill, realPath } of perRoot.flat()) {
    if (discovered.length >= MAX_IMPORTED_SKILLS) break;
    if (realPath === null) continue;
    const key = `${normalizeWorkspaceImportSource(skill.source)}:${realPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    discovered.push(skill);
  }
  return discovered;
}

async function skillContentsSignature(dir: string): Promise<string | null> {
  const parts: string[] = [];
  let failed = false;
  const walk = async (current: string, relative: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      failed = true;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(nextPath, nextRelative);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let contents: Buffer;
      try {
        contents = await readRegularFileNoFollow(nextPath, 2 * 1024 * 1024);
      } catch {
        failed = true;
        continue;
      }
      parts.push(`${nextRelative}:${contents.length}:${contents.toString("utf8")}`);
    }
  };
  await walk(dir, "");
  return failed ? null : parts.join("\n");
}

async function skillTreeIsSafe(dir: string): Promise<boolean> {
  const state = { entries: 0, bytes: 0 };
  const visit = async (current: string, depth: number): Promise<boolean> => {
    if (depth > 8 || state.entries > 2_000 || state.bytes > 16 * 1024 * 1024) return false;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      state.entries += 1;
      if (entry.isSymbolicLink()) return false;
      const path = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(path, depth + 1))) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      try {
        const size = (await fs.stat(path)).size;
        if (size > 2 * 1024 * 1024) return false;
        state.bytes += size;
        if (state.bytes > 16 * 1024 * 1024) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  return visit(dir, 0);
}

async function copySkillTreeAtomically(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const state = { entries: 0, bytes: 0 };
  const copyContents = async (current: string, target: string, depth: number): Promise<void> => {
    if (depth > 8 || state.entries > 2_000 || state.bytes > 16 * 1024 * 1024) {
      throw new Error("Skill exceeds the safety limits.");
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      state.entries += 1;
      if (entry.isSymbolicLink()) throw new Error("Skill source contains a symlink.");
      const sourcePath = nodePath.join(current, entry.name);
      const targetPath = nodePath.join(target, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { mode: 0o700 });
        await copyContents(sourcePath, targetPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("Skill source contains an unsupported entry.");
      const contents = await readRegularFileNoFollow(sourcePath, 2 * 1024 * 1024);
      state.bytes += contents.byteLength;
      if (state.bytes > 16 * 1024 * 1024) throw new Error("Skill exceeds the byte limit.");
      await writeNewFileNoFollow(targetPath, contents, 0o600);
    }
  };
  try {
    await fs.mkdir(temporary, { mode: 0o700 });
    await copyContents(source, temporary, 0);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function nextSkillDestination(input: {
  readonly libraryDir: string;
  readonly name: string;
  readonly canonicalSource: string;
  readonly sourceSignature: string;
}): Promise<{
  readonly path: string;
  readonly destinationName: string;
  readonly unchanged: boolean;
} | null> {
  const candidates = [
    input.name,
    `${input.canonicalSource}-${input.name}`,
    ...Array.from(
      { length: 100 },
      (_, index) => `${input.canonicalSource}-${input.name}-${index + 2}`,
    ),
  ];
  for (const destinationName of candidates) {
    const path = nodePath.join(input.libraryDir, destinationName);
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = await fs.lstat(path);
    } catch {
      stat = null;
    }
    if (!stat) return { path, destinationName, unchanged: false };
    // Never follow or replace a pre-existing symlink. It could redirect a
    // seemingly safe skill import outside the Moss library.
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await skillTreeIsSafe(path))) continue;
    if ((await skillContentsSignature(path)) === input.sourceSignature) {
      return { path, destinationName, unchanged: true };
    }
  }
  return null;
}

export async function copyImportSkills(input: {
  readonly skills: readonly DiscoveredImportSkill[];
  readonly mossBaseDir: string;
}): Promise<WorkspaceImportSkillCopy[]> {
  const libraryDir = mossSkillsDir(input.mossBaseDir);
  await fs.mkdir(libraryDir, { recursive: true });
  const results: WorkspaceImportSkillCopy[] = [];

  for (const skill of input.skills.slice(0, MAX_IMPORTED_SKILLS)) {
    if (!(await skillTreeIsSafe(skill.path))) {
      results.push({
        name: skill.name,
        source: skill.source,
        action: "skipped",
        reason: "The skill contains a symlink, unsupported entry, or exceeds the safety limits.",
      });
      continue;
    }
    const canonicalSource = normalizeWorkspaceImportSource(skill.source);
    const sourceSignature = await skillContentsSignature(skill.path);
    if (sourceSignature === null) {
      results.push({
        name: skill.name,
        source: skill.source,
        action: "skipped",
        reason: "The skill could not be read safely.",
      });
      continue;
    }
    const destination = await nextSkillDestination({
      libraryDir,
      name: skill.name,
      canonicalSource,
      sourceSignature,
    });
    if (!destination) {
      results.push({
        name: skill.name,
        source: skill.source,
        action: "skipped",
        reason: "Too many conflicting skill names already exist in the Moss library.",
      });
      continue;
    }
    if (destination.unchanged) {
      results.push({
        name: skill.name,
        source: skill.source,
        action: "unchanged",
        ...(destination.destinationName !== skill.name
          ? { destinationName: destination.destinationName }
          : {}),
      });
      continue;
    }
    try {
      await copySkillTreeAtomically(skill.path, destination.path);
    } catch {
      // A concurrent import may have claimed the destination. Report it as a
      // skipped item rather than replacing another user's skill.
      results.push({
        name: skill.name,
        source: skill.source,
        action: "skipped",
        reason: "The destination changed while the skill was being imported.",
      });
      continue;
    }
    results.push({
      name: skill.name,
      source: skill.source,
      action: "copied",
      ...(destination.destinationName !== skill.name
        ? { destinationName: destination.destinationName }
        : {}),
    });
  }

  return results;
}
