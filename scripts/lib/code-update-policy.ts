// Which commits a code update can carry onto an installed shell, decided at build time.
//
// A code update replaces the same archive folders a fast refresh does (desktop main and preloads, the
// server bundle with the web client), so the fast-refresh policy decides it, plus two rules of its own:
// the shell's boot entry runs from the installed archive (a change to it only takes effect with a
// full installer), and a migration may not raise the reader floor above what the shell knows, because
// an automatic rollback would then meet a database the older code cannot open.
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md §1.3 and §4.4.

import {
  classifyFastRefreshChanges,
  type FastRefreshRefusal,
} from "./desktop-fast-refresh-policy.ts";

const BOOT_FILES = /^apps\/desktop\/src\/codeUpdateBoot[^/]*\.ts$/u;
const isTest = (path: string) => /\.test\.[cm]?[jt]s$/u.test(path);

export const MIGRATIONS_SOURCE = "apps/server/src/persistence/Migrations.ts";

type ReadFile = (path: string) => { before: string | null; after: string | null };

/** Refusals for carrying the changes between a shell's commit and the new commit as a code update. */
export function classifyCodeUpdateChanges(
  changedPaths: ReadonlyArray<string>,
  read: ReadFile,
): FastRefreshRefusal[] {
  const refusals = classifyFastRefreshChanges(changedPaths, read);
  for (const raw of changedPaths) {
    const path = raw.replaceAll("\\", "/");
    if (BOOT_FILES.test(path) && !isTest(path)) {
      refusals.push({ path, reason: "the shell's boot entry (runs from the installed archive)" });
    }
  }
  if (changedPaths.some((path) => path.replaceAll("\\", "/") === MIGRATIONS_SOURCE)) {
    const { before, after } = read(MIGRATIONS_SOURCE);
    const shell = before === null ? null : readMigrationLevels(before);
    const next = after === null ? null : readMigrationLevels(after);
    if (!shell || !next) {
      refusals.push({ path: MIGRATIONS_SOURCE, reason: "could not read the migration list" });
    } else if (next.readerFloor > shell.latest) {
      refusals.push({
        path: MIGRATIONS_SOURCE,
        reason: `a migration raises the reader floor to ${next.readerFloor}, above the shell's latest ${shell.latest} (a rollback could not open the database)`,
      });
    }
  }
  return refusals;
}

export interface MigrationLevels {
  /** The newest migration id. */
  readonly latest: number;
  /** The newest id not declared additive: what a build must know to open the database. */
  readonly readerFloor: number;
}

/**
 * Reads the migration ids from Migrations.ts source text: `migrationEntries` rows `[id, "Name", …]`
 * and the additive list `MIGRATIONS_OLDER_READERS_MAY_IGNORE` rows `[id, "Name"]` (absent in older
 * sources: nothing additive). Null when the migration list cannot be found.
 */
export function readMigrationLevels(source: string): MigrationLevels | null {
  const list = (start: string) => {
    const at = source.indexOf(start);
    if (at < 0) return null;
    const end = source.indexOf("] as const", at);
    const close = source.indexOf("\n];", at);
    const stop = [end, close].filter((index) => index > at).toSorted((a, b) => a - b)[0];
    if (stop === undefined) return null;
    return [...source.slice(at, stop).matchAll(/^\s*\[(\d+),\s*"/gmu)].map((m) => Number(m[1]));
  };
  const entries = list("export const migrationEntries = [");
  const additive = list("export const MIGRATIONS_OLDER_READERS_MAY_IGNORE");
  if (!entries || entries.length === 0) return null;
  const additiveIds = new Set(additive ?? []);
  return {
    latest: Math.max(...entries),
    readerFloor: Math.max(...entries.filter((id) => !additiveIds.has(id))),
  };
}
