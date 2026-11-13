// FILE: sheetViewerFilters.ts
// Purpose: A 电子表格's filters belong to the person looking, as in Claude's Sheets ("only for
//          you"): they never go into the saved workbook, and each viewer's are kept on their device
//          per sheet, so they come back when the sheet opens again.
// Layer: 资料空间 电子表格 (viewer state)
// Exports: ViewerFilter, readViewerFilters, writeViewerFilters, filterHiddenRows.

/** The engine's own filter state for one sheet: the filtered block and each column's choice. */
export interface ViewerFilter {
  readonly filter_select: unknown;
  readonly filter: Record<
    string,
    { readonly rowhidden?: Record<string, unknown> } & Record<string, unknown>
  > | null;
}

const PREFIX = "moss.sheet.filters:";

export function readViewerFilters(key: string): Record<string, ViewerFilter> {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ViewerFilter>) : {};
  } catch {
    return {};
  }
}

export function writeViewerFilters(key: string, filters: Record<string, ViewerFilter>): void {
  try {
    if (Object.keys(filters).length)
      window.localStorage.setItem(PREFIX + key, JSON.stringify(filters));
    else window.localStorage.removeItem(PREFIX + key);
  } catch {
    // A viewer without storage keeps their filters for this visit only.
  }
}

/** The rows a filter hides, as the engine's hidden-row map. */
export function filterHiddenRows(filter: ViewerFilter["filter"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const column of Object.values(filter ?? {}))
    for (const row of Object.keys(column?.rowhidden ?? {})) out[row] = 0;
  return out;
}

// ── Filters for a view-only reader ──────────────────────────────────────────────────────────
// The engine filters only while editing is allowed, so a reader's filter is Moss's own: the
// rows it hides are a view, never saved, and kept on the reader's device like other filters.

export interface ReaderFilter {
  readonly sheetId: string;
  /** The filtered block: its first row is the headings and is never hidden. */
  readonly block: {
    readonly r0: number;
    readonly r1: number;
    readonly c0: number;
    readonly c1: number;
  };
  readonly column: number;
  /** The shown texts kept; every other row of the block is hidden. */
  readonly keep: readonly string[];
}

const READER_PREFIX = "moss.sheet.readerFilters:";

export function readReaderFilters(key: string): Record<string, ReaderFilter> {
  try {
    const raw = window.localStorage.getItem(READER_PREFIX + key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ReaderFilter>) : {};
  } catch {
    return {};
  }
}

export function writeReaderFilters(key: string, filters: Record<string, ReaderFilter>): void {
  try {
    if (Object.keys(filters).length)
      window.localStorage.setItem(READER_PREFIX + key, JSON.stringify(filters));
    else window.localStorage.removeItem(READER_PREFIX + key);
  } catch {
    // Kept for this visit only.
  }
}

/** Each row's shown text in one column of the block (below its headings). */
export function columnTexts(
  shownAt: (r: number, c: number) => string,
  filter: Pick<ReaderFilter, "block" | "column">,
): { readonly r: number; readonly text: string }[] {
  const out: { r: number; text: string }[] = [];
  for (let r = filter.block.r0 + 1; r <= filter.block.r1; r++)
    out.push({ r, text: shownAt(r, filter.column) });
  return out;
}

/** The distinct shown texts of a column, in first-seen order, blanks last as "". */
export function distinctTexts(rows: readonly { readonly text: string }[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) if (row.text !== "") seen.add(row.text);
  const out = [...seen];
  if (rows.some((row) => row.text === "")) out.push("");
  return out;
}

/** The rows a reader's filter hides, as the engine's hidden-row map. */
export function readerHiddenRows(
  shownAt: (r: number, c: number) => string,
  filter: ReaderFilter,
): Record<string, number> {
  const keep = new Set(filter.keep);
  const out: Record<string, number> = {};
  for (const row of columnTexts(shownAt, filter)) if (!keep.has(row.text)) out[row.r] = 0;
  return out;
}
