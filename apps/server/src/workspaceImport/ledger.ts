// FILE: ledger.ts
// Purpose: Persist workspace-import provenance so re-import updates threads
//          instead of creating duplicates.
// Layer: Server import helper

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { normalizeWorkspaceImportSource, type WorkspaceImportSourceKind } from "@synara/contracts";

export const WORKSPACE_IMPORT_LEDGER_FILENAME = "workspace-import-ledger.json";

export interface WorkspaceImportLedgerEntry {
  readonly replayFingerprint?: string;
  readonly threadId: string;
  readonly source: WorkspaceImportSourceKind;
  readonly sourceId: string;
  readonly title: string;
  readonly workingDirectory: string;
  readonly importedCount: number;
  readonly sourceUpdatedAt: string;
  readonly importedAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceImportLedger {
  readonly version: 1;
  readonly entries: Record<string, WorkspaceImportLedgerEntry>;
}

const SOURCE_VALUES = ["claude", "claude-code", "cursor", "codex", "grok", "opencode"] as const;
const MAX_LEDGER_ENTRIES = 2_000;
const ledgerWriteTails = new Map<string, Promise<void>>();

function isSource(value: unknown): value is WorkspaceImportSourceKind {
  return typeof value === "string" && (SOURCE_VALUES as readonly string[]).includes(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isBoundedText(value: unknown, max = 2_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isLedgerEntry(value: unknown): value is WorkspaceImportLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    isBoundedText(entry.threadId, 256) &&
    isSource(entry.source) &&
    isBoundedText(entry.sourceId, 1_000) &&
    isBoundedText(entry.title, 1_000) &&
    isBoundedText(entry.workingDirectory, 4_096) &&
    nodePath.isAbsolute(entry.workingDirectory) &&
    isBoundedText(entry.sourceUpdatedAt, 128) &&
    isIsoDate(entry.sourceUpdatedAt) &&
    isBoundedText(entry.importedAt, 128) &&
    isIsoDate(entry.importedAt) &&
    isBoundedText(entry.updatedAt, 128) &&
    isIsoDate(entry.updatedAt) &&
    typeof entry.importedCount === "number" &&
    Number.isSafeInteger(entry.importedCount) &&
    entry.importedCount >= 0 &&
    (entry.replayFingerprint === undefined ||
      (typeof entry.replayFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(entry.replayFingerprint)))
  );
}

async function withLedgerWriteLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = ledgerWriteTails.get(stateDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ledgerWriteTails.set(stateDir, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ledgerWriteTails.get(stateDir) === current) ledgerWriteTails.delete(stateDir);
  }
}

export function workspaceImportLedgerPath(stateDir: string): string {
  return nodePath.join(stateDir, WORKSPACE_IMPORT_LEDGER_FILENAME);
}

export function workspaceImportLedgerKey(
  source: WorkspaceImportSourceKind,
  sourceId: string,
): string {
  return `${normalizeWorkspaceImportSource(source)}:${sourceId}`;
}

export function emptyWorkspaceImportLedger(): WorkspaceImportLedger {
  return { version: 1, entries: {} };
}

export async function readWorkspaceImportLedger(stateDir: string): Promise<WorkspaceImportLedger> {
  try {
    const raw = await fs.readFile(workspaceImportLedgerPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceImportLedger>;
    if (
      parsed.version !== 1 ||
      parsed.entries === null ||
      typeof parsed.entries !== "object" ||
      Array.isArray(parsed.entries)
    ) {
      return emptyWorkspaceImportLedger();
    }
    const entries: Record<string, WorkspaceImportLedgerEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isLedgerEntry(value)) continue;
      const source = normalizeWorkspaceImportSource(value.source);
      const normalized = source === value.source ? value : { ...value, source };
      const canonicalKey = workspaceImportLedgerKey(source, normalized.sourceId);
      // Prefer an already-canonical record over a legacy `claude-code` alias
      // when both are present. Never trust an arbitrary object key as the
      // provenance identity; derive it from the validated entry instead.
      const existing = entries[canonicalKey];
      if (!existing || key === canonicalKey) {
        entries[canonicalKey] = normalized;
      }
      if (Object.keys(entries).length >= MAX_LEDGER_ENTRIES) break;
    }
    return { version: 1, entries };
  } catch {
    return emptyWorkspaceImportLedger();
  }
}

export async function writeWorkspaceImportLedger(
  stateDir: string,
  ledger: WorkspaceImportLedger,
): Promise<void> {
  await withLedgerWriteLock(stateDir, async () => {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = workspaceImportLedgerPath(stateDir);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

export function upsertWorkspaceImportLedgerEntry(
  ledger: WorkspaceImportLedger,
  entry: WorkspaceImportLedgerEntry,
): WorkspaceImportLedger {
  return {
    version: 1,
    entries: {
      ...ledger.entries,
      [workspaceImportLedgerKey(entry.source, entry.sourceId)]: entry,
    },
  };
}
