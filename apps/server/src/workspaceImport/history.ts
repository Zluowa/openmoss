// FILE: history.ts
// Purpose: Durable, renderer-safe import history and auto-sync preferences.
// Layer: Server import helper

import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import {
  WORKSPACE_IMPORT_DEFAULT_CATEGORIES,
  type WorkspaceImportCategoryKind,
  type WorkspaceImportHistoryEntry,
  type WorkspaceImportSourceKind,
  type WorkspaceImportSyncPreferences,
} from "@synara/contracts";
import { normalizeWorkspaceImportSource } from "@synara/contracts";

export const WORKSPACE_IMPORT_HISTORY_FILENAME = "workspace-import-history.json";
export const WORKSPACE_IMPORT_SYNC_FILENAME = "workspace-import-sync.json";

const CATEGORY_VALUES = [
  "settings",
  "skills",
  "agents",
  "commands",
  "hooks",
  "mcp",
  "plugins",
  "memory",
  "projects",
  "chats",
] as const;
const SOURCE_VALUES = ["claude", "claude-code", "cursor", "codex", "grok", "opencode"] as const;
const MAX_HISTORY_ENTRIES = 100;
const MAX_SYNC_CATEGORIES = 10;
const MAX_SYNC_SOURCES = 5;
const fileWriteTails = new Map<string, Promise<void>>();

function historyPath(stateDir: string): string {
  return nodePath.join(stateDir, WORKSPACE_IMPORT_HISTORY_FILENAME);
}

function syncPath(stateDir: string): string {
  return nodePath.join(stateDir, WORKSPACE_IMPORT_SYNC_FILENAME);
}

async function withStateFileLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileWriteTails.get(stateDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileWriteTails.set(stateDir, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileWriteTails.get(stateDir) === current) fileWriteTails.delete(stateDir);
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function defaultSync(now: Date = new Date()): WorkspaceImportSyncPreferences {
  return {
    enabled: false,
    categories: [...WORKSPACE_IMPORT_DEFAULT_CATEGORIES],
    sources: [],
    updatedAt: now.toISOString(),
  };
}

function isCategory(value: unknown): value is WorkspaceImportCategoryKind {
  return typeof value === "string" && (CATEGORY_VALUES as readonly string[]).includes(value);
}

function isSource(value: unknown): value is WorkspaceImportSourceKind {
  return typeof value === "string" && (SOURCE_VALUES as readonly string[]).includes(value);
}

function canonicalSources(
  values: readonly WorkspaceImportSourceKind[],
): WorkspaceImportSourceKind[] {
  return [...new Set(values.map((source) => normalizeWorkspaceImportSource(source)))].slice(
    0,
    MAX_SYNC_SOURCES,
  );
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validHistoryEntry(value: unknown): value is WorkspaceImportHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    isIsoDateTime(entry.importedAt) &&
    (entry.status === "success" || entry.status === "partial" || entry.status === "failed") &&
    Array.isArray(entry.sources) &&
    entry.sources.every(isSource) &&
    isNonNegativeInteger(entry.importedCount) &&
    isNonNegativeInteger(entry.failedCount) &&
    isNonNegativeInteger(entry.warningCount) &&
    entry.categories !== null &&
    typeof entry.categories === "object" &&
    CATEGORY_VALUES.every((category) =>
      isNonNegativeInteger((entry.categories as Record<string, unknown>)[category]),
    )
  );
}

export async function readWorkspaceImportHistory(
  stateDir: string,
): Promise<WorkspaceImportHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath(stateDir), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validHistoryEntry).slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

export async function appendWorkspaceImportHistory(
  stateDir: string,
  entry: WorkspaceImportHistoryEntry,
): Promise<void> {
  await withStateFileLock(stateDir, async () => {
    const current = await readWorkspaceImportHistory(stateDir);
    const next = [...current.filter((item) => item.id !== entry.id), entry].slice(
      -MAX_HISTORY_ENTRIES,
    );
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await atomicWrite(historyPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  });
}

export async function readWorkspaceImportSync(
  stateDir: string,
): Promise<WorkspaceImportSyncPreferences> {
  try {
    const parsedValue = JSON.parse(await fs.readFile(syncPath(stateDir), "utf8")) as unknown;
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return defaultSync();
    }
    const parsed = parsedValue as Record<string, unknown>;
    const categories = Array.isArray(parsed.categories) ? parsed.categories.filter(isCategory) : [];
    const sources = Array.isArray(parsed.sources)
      ? canonicalSources(parsed.sources.filter(isSource))
      : [];
    const updatedAt = isIsoDateTime(parsed.updatedAt) ? parsed.updatedAt : new Date().toISOString();
    return {
      enabled: parsed.enabled === true,
      categories: categories.length > 0 ? categories : [...WORKSPACE_IMPORT_DEFAULT_CATEGORIES],
      sources,
      updatedAt,
    };
  } catch {
    return defaultSync();
  }
}

export async function writeWorkspaceImportSync(
  stateDir: string,
  input: {
    readonly enabled: boolean;
    readonly categories: readonly WorkspaceImportCategoryKind[];
    readonly sources: readonly WorkspaceImportSourceKind[];
    readonly now: Date;
  },
): Promise<WorkspaceImportSyncPreferences> {
  return withStateFileLock(stateDir, async () => {
    const categories = [...new Set(input.categories.filter(isCategory))].slice(
      0,
      MAX_SYNC_CATEGORIES,
    );
    const sources = canonicalSources(input.sources.filter(isSource));
    if (input.enabled && (categories.length === 0 || sources.length === 0)) {
      throw new Error(
        "At least one import category and source are required while sync is enabled.",
      );
    }
    const preferences: WorkspaceImportSyncPreferences = {
      enabled: input.enabled,
      categories: categories.length > 0 ? categories : [...WORKSPACE_IMPORT_DEFAULT_CATEGORIES],
      sources,
      updatedAt: input.now.toISOString(),
    };
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await atomicWrite(syncPath(stateDir), `${JSON.stringify(preferences, null, 2)}\n`);
    return preferences;
  });
}

export { defaultSync as defaultWorkspaceImportSync };
