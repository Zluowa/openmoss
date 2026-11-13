// FILE: sheetCellHistory.logic.ts
// Purpose: Which versions changed one cell, from the cell as each version held it.
// Layer: 资料空间 电子表格 (pure logic)
// Exports: CellHistoryTarget, CellHistoryEntry, cellHistoryEntries.

import type { PageVersion } from "@moss/contracts";

export interface CellHistoryTarget {
  readonly sheetId: string;
  readonly r: number;
  readonly c: number;
  /** "预算!C3". */
  readonly label: string;
}

export interface CellHistoryEntry {
  readonly revision: number;
  readonly createdAt: string;
  readonly author: PageVersion["author"];
  /** What the cell held from this version on; null when it was emptied. */
  readonly shown: string | null;
}

/**
 * The changes of one cell, newest first, from versions read newest first: each entry is a
 * version where the cell came to hold something other than in the version before it.
 */
export function cellHistoryEntries(
  versions: readonly {
    revision: number;
    createdAt: string;
    author: PageVersion["author"];
    shown: string | null;
  }[],
): CellHistoryEntry[] {
  const out: CellHistoryEntry[] = [];
  for (const [i, version] of versions.entries()) {
    const older = versions[i + 1];
    if (older === undefined) {
      if (version.shown !== null) out.push(version);
      continue;
    }
    if (older.shown !== version.shown) out.push(version);
  }
  return out;
}
