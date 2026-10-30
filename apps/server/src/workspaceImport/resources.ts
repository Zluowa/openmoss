// FILE: resources.ts
// Purpose: Inventory and safely copy non-chat resources exposed by external
//          agent installations (agents, commands, hooks, MCP, plugins,
//          memory).  Imported files are data only; Moss never executes them.
// Layer: Server import helper

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  WorkspaceImportCategoryKind,
  WorkspaceImportResourceCopy,
  WorkspaceImportSourceKind,
} from "@synara/contracts";
import { normalizeWorkspaceImportSource } from "@synara/contracts";
import { parse as parseToml } from "smol-toml";
import {
  chatRootsForSource,
  decodeClaudeProjectFolderName,
  resourceRootsForSource,
  settingsPathsForSource,
} from "./paths";
import { hashRegularFileNoFollow, readRegularFileNoFollow, writeNewFileNoFollow } from "./safeFile";

const INVENTORY_CATEGORIES = [
  "agents",
  "commands",
  "hooks",
  "mcp",
  "plugins",
  "memory",
] as const satisfies readonly WorkspaceImportCategoryKind[];

const MAX_RESOURCE_FILES = 500;
const MAX_TOTAL_RESOURCE_FILES = 2_000;
const MAX_PROJECT_ROOTS = 500;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const SAFE_TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".toml",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".xml",
  ".ini",
  ".conf",
  ".cfg",
  ".sh",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);
const SECRET_NAME_PATTERN = /(secret|token|credential|password|apikey|api[-_]?key|auth)/i;
const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|jwt|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)/i;
const SECRET_VALUE_PATTERN =
  /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;
const SECRET_ASSIGNMENT_PATTERN =
  /(?:["']?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|jwt|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)["']?\s*[:=]\s*["']?)([^\s"',}]+)/i;
const SECRET_PLACEHOLDER_PATTERN =
  /^(?:\$\{[^}]+\}|\$[A-Z0-9_]+|<[^>]+>|your[-_ ]|replace[-_ ]|redacted|null|none|undefined)$/i;
const REVIEW_ONLY_CATEGORIES = new Set<WorkspaceImportCategoryKind>(["hooks", "mcp", "plugins"]);

export interface DiscoveredImportResource {
  readonly name: string;
  readonly source: WorkspaceImportSourceKind;
  readonly category: WorkspaceImportCategoryKind;
  readonly path: string;
  readonly relativePath: string;
  /** Internal marker; the value is never sent to the renderer. */
  readonly sensitive?: boolean;
}

export interface ImportResourceInventory {
  readonly resources: readonly DiscoveredImportResource[];
  readonly counts: Readonly<Record<WorkspaceImportCategoryKind, number>>;
}

function emptyCounts(): Record<WorkspaceImportCategoryKind, number> {
  return {
    settings: 0,
    skills: 0,
    agents: 0,
    commands: 0,
    hooks: 0,
    mcp: 0,
    plugins: 0,
    memory: 0,
    projects: 0,
    chats: 0,
  };
}

function isSafeFileName(name: string): boolean {
  if (!name || name === "." || name === ".." || SECRET_NAME_PATTERN.test(name)) return false;
  return SAFE_TEXT_EXTENSIONS.has(nodePath.extname(name).toLowerCase()) || !nodePath.extname(name);
}

async function walkResourceRoot(
  root: string,
  source: WorkspaceImportSourceKind,
  category: WorkspaceImportCategoryKind,
): Promise<DiscoveredImportResource[]> {
  const resources: DiscoveredImportResource[] = [];
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return resources;
  } catch {
    return resources;
  }
  const visit = async (current: string, relative: string, depth: number): Promise<void> => {
    if (depth > 5 || resources.length >= MAX_RESOURCE_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCE_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const next = nodePath.join(current, entry.name);
      const nextRelative = relative ? nodePath.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(next, nextRelative, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSafeFileName(entry.name)) continue;
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (stat.size > MAX_RESOURCE_BYTES) continue;
      } catch {
        continue;
      }
      const sensitive = await resourceContainsSecret(next);
      resources.push({
        name: entry.name,
        source,
        category,
        path: next,
        relativePath: nextRelative,
        ...(sensitive ? { sensitive: true } : {}),
      });
    }
  };
  await visit(root, "", 0);
  return resources;
}

/**
 * Inspect only bounded text content for credential-shaped assignments. A
 * filename check alone is insufficient because provider settings are commonly
 * named `settings.json` while still containing an API key. Placeholder values
 * are allowed through so a user can review a non-secret config safely.
 */
function resourceBytesContainSecret(buffer: Uint8Array): boolean {
  const raw = Buffer.from(buffer).toString("utf8");
  // Binary data is not safe to activate as an imported agent resource. Keep
  // it quarantined instead of trying to interpret bytes as text.
  if (raw.includes("\u0000")) return true;
  if (SECRET_VALUE_PATTERN.test(raw)) return true;
  for (const line of raw.split(/\r?\n/u)) {
    const match = SECRET_ASSIGNMENT_PATTERN.exec(line);
    if (!match || !SECRET_KEY_PATTERN.test(match[0])) continue;
    const value = match[1]?.trim() ?? "";
    if (value.length >= 8 && !SECRET_PLACEHOLDER_PATTERN.test(value)) return true;
  }
  return false;
}

async function resourceContainsSecret(path: string): Promise<boolean> {
  try {
    return resourceBytesContainSecret(await readRegularFileNoFollow(path, MAX_RESOURCE_BYTES));
  } catch {
    return true;
  }
}

export async function discoverImportResources(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<ImportResourceInventory> {
  const source = normalizeWorkspaceImportSource(input.source);
  const resources: DiscoveredImportResource[] = [];
  const seen = new Set<string>();
  for (const category of INVENTORY_CATEGORIES) {
    if (resources.length >= MAX_TOTAL_RESOURCE_FILES) break;
    for (const root of resourceRootsForSource(source, category, input)) {
      if (resources.length >= MAX_TOTAL_RESOURCE_FILES) break;
      for (const resource of await walkResourceRoot(root, source, category)) {
        if (resources.length >= MAX_TOTAL_RESOURCE_FILES) break;
        const key = `${category}:${nodePath.resolve(resource.path)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resources.push(resource);
      }
    }
  }
  const counts = emptyCounts();
  for (const resource of resources) counts[resource.category] += 1;
  return { resources, counts };
}

/** Count project/workspace folders without reading their contents. */
export async function countImportProjects(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fallbackCwd?: string;
}): Promise<number> {
  return (
    await discoverImportProjectRoots({
      ...input,
      fallbackCwd: input.fallbackCwd ?? input.homeDir,
    })
  ).length;
}

function pathContainedBy(candidate: string, root: string): boolean {
  const resolvedCandidate = nodePath.resolve(candidate);
  const resolvedRoot = nodePath.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${nodePath.sep}`)
  );
}

const PROJECT_METADATA_FILE_BYTES = 128 * 1024;
const PROJECT_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_METADATA_FILES = 500;
const PROJECT_PATH_KEYS = new Set([
  "cwd",
  "workingdirectory",
  "working_directory",
  "workdir",
  "workspace",
  "workspaceroot",
  "folder",
  "folderuri",
  "rootpath",
  "root",
  "directory",
  "projectpath",
]);

function pathFromProjectMetadata(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file://")) {
    try {
      const parsed = new URL(trimmed);
      return decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  return nodePath.isAbsolute(trimmed) ? trimmed : null;
}

async function readCodexConfiguredProjectPaths(input: {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<string[]> {
  for (const filePath of settingsPathsForSource("codex", input)) {
    try {
      const raw = (await readRegularFileNoFollow(filePath, PROJECT_SETTINGS_FILE_BYTES)).toString(
        "utf8",
      );
      const parsed = filePath.toLowerCase().endsWith(".toml")
        ? parseToml(raw)
        : (JSON.parse(raw) as unknown);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const projects = (parsed as Record<string, unknown>).projects;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
      return Object.keys(projects)
        .map(pathFromProjectMetadata)
        .filter((path): path is string => path !== null)
        .map((path) => nodePath.resolve(path));
    } catch {
      // Try the next documented Codex settings format.
    }
  }
  return [];
}

function collectProjectMetadataPaths(
  value: unknown,
  into: string[],
  keyHint?: string,
  depth = 0,
): void {
  if (depth > 5) return;
  if (typeof value === "string" && keyHint && PROJECT_PATH_KEYS.has(keyHint.toLowerCase())) {
    const path = pathFromProjectMetadata(value);
    if (path) into.push(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProjectMetadataPaths(item, into, keyHint, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectProjectMetadataPaths(child, into, key, depth + 1);
  }
}

async function readProjectMetadataPaths(projectDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 2 || files.length >= 8) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= 32 || entry.name.startsWith(".")) continue;
      const path = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
      ) {
        files.push(path);
      }
    }
  };
  await visit(projectDirectory, 0);
  const paths: string[] = [];
  for (const file of files) {
    try {
      const raw = (await readRegularFileNoFollow(file, PROJECT_METADATA_FILE_BYTES)).toString(
        "utf8",
      );
      if (file.endsWith(".jsonl")) {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            collectProjectMetadataPaths(JSON.parse(trimmed) as unknown, paths);
          } catch {
            // Ignore malformed transcript lines and inspect the remaining ones.
          }
        }
      } else {
        try {
          collectProjectMetadataPaths(JSON.parse(raw) as unknown, paths);
        } catch {
          // A non-index JSON file is not a project descriptor.
        }
      }
    } catch {
      continue;
    }
  }
  return [...new Set(paths.map((path) => nodePath.resolve(path)))];
}

async function readChatMetadataPaths(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 6 || files.length >= MAX_CHAT_METADATA_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      const rootStat = await fs.lstat(current);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_CHAT_METADATA_FILES || entry.name.startsWith(".")) continue;
      const path = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
      ) {
        files.push(path);
      }
    }
  };
  for (const root of chatRootsForSource(input.source, input)) {
    if (files.length >= MAX_CHAT_METADATA_FILES) break;
    await visit(root, 0);
  }
  const paths: string[] = [];
  for (const file of files) {
    try {
      const raw = (await readRegularFileNoFollow(file, PROJECT_METADATA_FILE_BYTES)).toString(
        "utf8",
      );
      if (file.endsWith(".jsonl")) {
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            collectProjectMetadataPaths(JSON.parse(trimmed) as unknown, paths);
          } catch {
            // Ignore malformed lines and keep scanning the bounded file.
          }
        }
      } else {
        try {
          collectProjectMetadataPaths(JSON.parse(raw) as unknown, paths);
        } catch {
          // Ignore unrelated JSON files.
        }
      }
    } catch {
      continue;
    }
  }
  return [...new Set(paths.map((path) => nodePath.resolve(path)))];
}

/**
 * Resolve existing workspace folders represented by provider project indexes.
 * Claude and Cursor store encoded workspace names beside their transcripts.
 * Prefer an explicit cwd/folder field from the index/transcript and fall back
 * to the legacy encoded name only when the decoded path currently exists.
 * Other providers may store real project folders directly under their projects
 * root.
 */
export async function discoverImportProjectRoots(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fallbackCwd?: string;
}): Promise<string[]> {
  const source = normalizeWorkspaceImportSource(input.source);
  const roots: string[] = [];
  const seen = new Set<string>();
  const allowedRoots = [input.homeDir, ...(input.fallbackCwd ? [input.fallbackCwd] : [])].map(
    (root) => nodePath.resolve(root),
  );
  const initialAllowedRoots = [...allowedRoots];
  for (const root of initialAllowedRoots) {
    const real = await fs.realpath(root).catch(() => null);
    if (real && !allowedRoots.includes(real)) allowedRoots.push(real);
  }
  const metadataCandidates = await readChatMetadataPaths({
    source,
    homeDir: input.homeDir,
    platform: input.platform,
    env: input.env,
  });
  for (const candidate of metadataCandidates) {
    if (roots.length >= MAX_PROJECT_ROOTS) break;
    let real: string;
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      real = await fs.realpath(candidate);
    } catch {
      continue;
    }
    if (!allowedRoots.some((allowed) => pathContainedBy(real, allowed))) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(real);
  }
  if (source === "codex" && roots.length < MAX_PROJECT_ROOTS) {
    // Codex keeps a first-class [projects."/absolute/path"] index in
    // config.toml. Session metadata is incomplete (and capped for safety),
    // so include configured paths only after the same existing-directory,
    // symlink and home/workspace-boundary checks used for transcript paths.
    for (const candidate of await readCodexConfiguredProjectPaths({
      homeDir: input.homeDir,
      platform: input.platform,
      env: input.env,
    })) {
      if (roots.length >= MAX_PROJECT_ROOTS) break;
      let real: string;
      try {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        real = await fs.realpath(candidate);
      } catch {
        continue;
      }
      if (!allowedRoots.some((allowed) => pathContainedBy(real, allowed))) continue;
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push(real);
    }
  }
  for (const root of resourceRootsForSource(source, "projects", input)) {
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (roots.length >= MAX_PROJECT_ROOTS || !entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const projectDirectory = nodePath.join(root, entry.name);
      const candidates =
        source === "claude" || source === "cursor"
          ? [
              ...(await readProjectMetadataPaths(projectDirectory)),
              decodeClaudeProjectFolderName(entry.name),
            ]
          : [projectDirectory];
      // A provider path can be selected through an environment variable, but
      // project metadata is still untrusted. Only import existing workspaces
      // under the user's home or the configured Moss cwd; never treat the
      // provider's own root as an authorization boundary.
      const rootsForValidation = allowedRoots;
      for (const candidate of candidates) {
        if (!candidate || !nodePath.isAbsolute(candidate)) continue;
        let real: string;
        try {
          const stat = await fs.lstat(candidate);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          real = await fs.realpath(candidate);
        } catch {
          continue;
        }
        if (!rootsForValidation.some((allowed) => pathContainedBy(real, allowed))) continue;
        if (seen.has(real)) continue;
        seen.add(real);
        roots.push(real);
        break;
      }
    }
  }
  return roots;
}

function safeDestinationPath(
  root: string,
  source: string,
  category: string,
  relative: string,
): string | null {
  if (!root || !source || !category || !relative || nodePath.isAbsolute(relative)) return null;
  const destinationRoot = nodePath.resolve(root, source, category);
  const destination = nodePath.resolve(destinationRoot, relative);
  if (
    destination !== destinationRoot &&
    !destination.startsWith(`${destinationRoot}${nodePath.sep}`)
  )
    return null;
  return destination;
}

async function fileHash(path: string): Promise<string | null> {
  try {
    return await hashRegularFileNoFollow(path, MAX_RESOURCE_BYTES);
  } catch {
    return null;
  }
}

async function isNonSymlinkRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function copyResourceAtomically(contents: Uint8Array, destination: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeNewFileNoFollow(temporary, contents);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function copyImportResources(input: {
  readonly resources: readonly DiscoveredImportResource[];
  readonly destinationRoot: string;
  readonly selectedCategories: ReadonlySet<WorkspaceImportCategoryKind>;
}): Promise<WorkspaceImportResourceCopy[]> {
  const results: WorkspaceImportResourceCopy[] = [];
  for (const resource of input.resources.slice(0, MAX_TOTAL_RESOURCE_FILES)) {
    if (!input.selectedCategories.has(resource.category)) continue;
    const reviewRequired =
      resource.sensitive === true || REVIEW_ONLY_CATEGORIES.has(resource.category);
    if (resource.sensitive) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "Credential-shaped content was detected; the file was not copied.",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    if (!(await isNonSymlinkRegularFile(resource.path))) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "The source changed to a non-regular file while importing.",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    // Hooks/MCP/plugins are copied for review only.  The UI can surface these
    // as "needs attention"; no copied file is registered as executable.
    const destination = safeDestinationPath(
      input.destinationRoot,
      normalizeWorkspaceImportSource(resource.source),
      resource.category,
      resource.relativePath,
    );
    if (!destination) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "Unsafe destination path.",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    if (!(await isNonSymlinkRegularFile(resource.path))) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "The source changed while importing.",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    let sourceContents: Buffer;
    try {
      sourceContents = await readRegularFileNoFollow(resource.path, MAX_RESOURCE_BYTES);
    } catch {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "The source file could not be read.",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    const sourceHash = crypto.createHash("sha256").update(sourceContents).digest("hex");
    // Re-check the exact byte snapshot that will be written. A source can be
    // replaced between discovery and apply; never copy a newly introduced
    // credential-bearing file into the quarantine tree.
    if (resourceBytesContainSecret(sourceContents)) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "Credential-shaped content was detected; the file was not copied.",
        reviewRequired: true,
        quarantined: true,
      });
      continue;
    }
    let destinationExists = false;
    try {
      const destinationStat = await fs.lstat(destination);
      destinationExists = true;
      if (
        destinationStat.isSymbolicLink() ||
        !destinationStat.isFile() ||
        destinationStat.size > MAX_RESOURCE_BYTES
      ) {
        results.push({
          name: resource.relativePath,
          source: resource.source,
          category: resource.category,
          action: "skipped",
          reason: "The quarantine destination is not a regular file.",
          reviewRequired,
          quarantined: true,
        });
        continue;
      }
    } catch (error) {
      if ((error as { readonly code?: string }).code !== "ENOENT") {
        results.push({
          name: resource.relativePath,
          source: resource.source,
          category: resource.category,
          action: "skipped",
          reason: "The quarantine destination could not be checked.",
          reviewRequired,
          quarantined: true,
        });
        continue;
      }
    }
    const destinationHash = destinationExists ? await fileHash(destination) : null;
    if (destinationHash === sourceHash) {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "unchanged",
        reviewRequired,
        quarantined: true,
      });
      continue;
    }
    try {
      if (destinationExists && !(await isNonSymlinkRegularFile(destination))) {
        throw new Error("unsafe destination");
      }
      await fs.mkdir(nodePath.dirname(destination), { recursive: true });
      await copyResourceAtomically(sourceContents, destination);
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: destinationHash ? "updated" : "copied",
        reviewRequired,
        quarantined: true,
      });
    } catch {
      results.push({
        name: resource.relativePath,
        source: resource.source,
        category: resource.category,
        action: "skipped",
        reason: "The source file could not be copied.",
        reviewRequired,
        quarantined: true,
      });
    }
  }
  return results;
}

export { INVENTORY_CATEGORIES };
