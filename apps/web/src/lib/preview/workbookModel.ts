import type { Borders, Font, Alignment } from "exceljs";

export type WorkbookPoint = { row: number; col: number };
export type WorkbookRange = { start: WorkbookPoint; end: WorkbookPoint };
export type WorkbookCell = {
  text: string;
  formula?: string | undefined;
  numeric?: number | undefined;
  font?: Partial<Font> | undefined;
  alignment?: Partial<Alignment> | undefined;
  fill?: string | undefined;
  color?: string | undefined;
  border?: Partial<Borders> | undefined;
  hyperlink?: string | undefined;
};
export type WorkbookImage = {
  src: string;
  from: WorkbookPoint;
  to?: WorkbookPoint | undefined;
  width?: number | undefined;
  height?: number | undefined;
};
export type WorkbookChart = {
  title: string;
  kind: "bar" | "line" | "pie" | "doughnut" | "area" | "scatter";
  horizontal: boolean;
  grouping: "standard" | "stacked" | "percentStacked";
  categories: string[];
  series: {
    name: string;
    values: (number | null)[];
    color: string;
    xValues?: (number | null)[] | undefined;
  }[];
  from: WorkbookPoint;
  to?: WorkbookPoint | undefined;
  width?: number | undefined;
  height?: number | undefined;
  legend: boolean;
  showValues: boolean;
};
export type WorkbookSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: Map<number, Map<number, WorkbookCell>>;
  rowHeights: Map<number, number>;
  columnWidths: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenColumns: Set<number>;
  merges: WorkbookRange[];
  frozenRows: number;
  frozenColumns: number;
  images: WorkbookImage[];
  charts: WorkbookChart[];
  hidden?: boolean;
};
export type PreviewWorkbook = { sheets: WorkbookSheet[]; warnings: string[] };
export type WorkbookAnnotation = { sheetName: string; range: string; quote: string; body?: string };

export const MAX_WORKBOOK_ROWS = 1_048_576;
export const MAX_WORKBOOK_COLUMNS = 16_384;

export function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function cellAddress(point: WorkbookPoint): string {
  return `${columnName(point.col)}${point.row + 1}`;
}

export function normalizeRange(range: WorkbookRange): WorkbookRange {
  return {
    start: {
      row: Math.min(range.start.row, range.end.row),
      col: Math.min(range.start.col, range.end.col),
    },
    end: {
      row: Math.max(range.start.row, range.end.row),
      col: Math.max(range.start.col, range.end.col),
    },
  };
}

export function rangeAddress(range: WorkbookRange): string {
  const normalized = normalizeRange(range);
  const first = cellAddress(normalized.start);
  const last = cellAddress(normalized.end);
  return first === last ? first : `${first}:${last}`;
}

export function parseRange(input: string): WorkbookRange | null {
  const match = /^\$?([a-z]+)\$?([1-9]\d*)(?::\$?([a-z]+)\$?([1-9]\d*))?$/i.exec(input.trim());
  if (!match) return null;
  const point = (letters: string, row: string): WorkbookPoint => {
    let col = 0;
    for (const letter of letters.toUpperCase()) col = col * 26 + letter.charCodeAt(0) - 64;
    return { row: Number(row) - 1, col: col - 1 };
  };
  const start = point(match[1]!, match[2]!);
  const end = point(match[3] ?? match[1]!, match[4] ?? match[2]!);
  if ([start, end].some((p) => p.row >= MAX_WORKBOOK_ROWS || p.col >= MAX_WORKBOOK_COLUMNS))
    return null;
  return normalizeRange({ start, end });
}

export function emptySheet(name: string): WorkbookSheet {
  return {
    name,
    rowCount: 0,
    columnCount: 0,
    cells: new Map(),
    rowHeights: new Map(),
    columnWidths: new Map(),
    hiddenRows: new Set(),
    hiddenColumns: new Set(),
    merges: [],
    frozenRows: 0,
    frozenColumns: 0,
    images: [],
    charts: [],
  };
}

export function getWorkbookCell(
  sheet: WorkbookSheet,
  point: WorkbookPoint,
): WorkbookCell | undefined {
  return sheet.cells.get(point.row)?.get(point.col);
}

export function mergeAt(sheet: WorkbookSheet, point: WorkbookPoint): WorkbookRange | undefined {
  return sheet.merges.find(
    ({ start, end }) =>
      point.row >= start.row &&
      point.row <= end.row &&
      point.col >= start.col &&
      point.col <= end.col,
  );
}

export function selectionText(sheet: WorkbookSheet, range: WorkbookRange): string {
  const { start, end } = normalizeRange(range);
  // An accidental Select All must not allocate a billion-cell clipboard payload.
  if ((end.row - start.row + 1) * (end.col - start.col + 1) > 1_000_000) {
    throw new Error("Select fewer than 1,000,000 cells to copy.");
  }
  const rows: string[] = [];
  for (let row = start.row; row <= end.row; row += 1) {
    const cells: string[] = [];
    for (let col = start.col; col <= end.col; col += 1) {
      const text = getWorkbookCell(sheet, { row, col })?.text ?? "";
      cells.push(/[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
    }
    rows.push(cells.join("\t"));
  }
  return rows.join("\n");
}

/** RFC 4180 field quoting, including BOM, empty records, and CRLF inside quotes. */
export function parseDelimited(input: string, separator: string): string[][] {
  if (separator.length !== 1) throw new Error("A delimiter must be one character.");
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let endedRecord = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    endedRecord = false;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      endedRecord = true;
    } else cell += char;
  }
  if (quoted) throw new Error("The spreadsheet contains an unterminated quoted field.");
  if (!endedRecord) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function readDelimitedWorkbook(
  input: string,
  separator: string,
  name = "Sheet1",
): PreviewWorkbook {
  const rows = parseDelimited(input, separator);
  if (rows.length > MAX_WORKBOOK_ROWS)
    throw new Error("This spreadsheet exceeds Excel's row limit.");
  const sheet = emptySheet(name);
  sheet.rowCount = rows.length;
  rows.forEach((row, rowIndex) => {
    if (row.length > MAX_WORKBOOK_COLUMNS)
      throw new Error("This spreadsheet exceeds Excel's column limit.");
    sheet.columnCount = Math.max(sheet.columnCount, row.length);
    const cells = new Map<number, WorkbookCell>();
    row.forEach((text, col) => {
      if (text !== "") cells.set(col, { text });
    });
    if (cells.size > 0) sheet.cells.set(rowIndex, cells);
  });
  return { sheets: [sheet], warnings: [] };
}

/** Logical offsets let the viewport render only visible cells, even for million-row CSVs. */
export function dimensionOffsets(
  count: number,
  overrides: Map<number, number>,
  hidden: Set<number>,
  fallback: number,
): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1)
    offsets[index + 1] =
      offsets[index]! + (hidden.has(index) ? 0 : Math.max(1, overrides.get(index) ?? fallback));
  return offsets;
}

export function indexAtOffset(offsets: Float64Array, value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle]! <= value) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, offsets.length - 2);
}
