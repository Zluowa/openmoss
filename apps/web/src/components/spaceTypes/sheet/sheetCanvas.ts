// FILE: sheetCanvas.ts
// Purpose: Paints the 电子表格 grid the Moss way through the engine's render hooks: paper cells,
//          quiet headers with the selection tinted, ink-10% lines, dropdown pills, checkboxes,
//          conditional-format looks, the declared table's header band and row lines, and the
//          brief mark on cells Moss just changed.
// Layer: 资料空间 电子表格 (types stream)
// Exports: makeSheetCanvasHooks, SHEET_GRID_METRICS, SheetPaintState, cellKey.
// Why: The engine draws a spreadsheet of its own look. Its hooks let Moss draw every part a
//      person reads without forking the engine. Colours are the light sheet's; the dark theme
//      is the same canvas turned by one CSS filter, the way a dark sheet stands for a light one.

import { defaultStyle, type Cell } from "@fortune-sheet/core";

import type { RuleLook } from "@moss/shared/spaceItems/sheetRules";
import type { SheetDropdown, SheetRange, SheetTable } from "@moss/shared/spaceItems/sheetWorkbook";

import { SHEET_CANVAS_COLORS } from "~/theme/sheetPalette";

/** Sizes read from the Claude Sheets stylesheet (column 104, row 28, row numbers 48). */
export const SHEET_GRID_METRICS = {
  columnWidth: 104,
  rowHeight: 28,
  rowHeaderWidth: 48,
  columnHeaderHeight: 28,
  fontSize: 10,
} as const;

const {
  paper: PAPER,
  frame: FRAME,
  line: LINE,
  lineStrong: LINE_STRONG,
  ink: INK,
  inkSecondary: INK_SECONDARY,
  accent: ACCENT,
  selectedHeader: SELECTED_HEADER,
  tableHeader: TABLE_HEADER,
  checkboxEdge: CHECKBOX_EDGE,
  white: WHITE,
  flash: FLASH,
  error: ERROR_MARK,
} = SHEET_CANVAS_COLORS;
const ERROR_TEXT = /^#(?:N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!|ERROR!)$/u;

// Grid lines between cells use the engine's shared stroke.
defaultStyle.strokeStyle = LINE;
defaultStyle.fillStyle = INK_SECONDARY;

export const cellKey = (r: number, c: number) => `${r}:${c}`;

export interface SheetPaintState {
  readonly selection: SheetRange | null;
  readonly dropdowns: readonly SheetDropdown[];
  readonly checkboxes: readonly SheetRange[];
  readonly table: SheetTable | undefined;
  /** The last record row of the declared table (inclusive), worked out from the cells. */
  readonly tableLastRow: number | null;
  readonly looks: ReadonlyMap<string, RuleLook>;
  readonly flash: ReadonlySet<string>;
  readonly readOnly: boolean;
  readonly fontFamily: string;
  /** Formula cells show their formula instead of what it comes to. */
  readonly showFormulas: boolean;
  /** Cells of this sheet with an open comment, as "r:c": a corner mark shows them. */
  readonly commentCells: ReadonlySet<string>;
  /** Rewrites a number's shown text in the Sheet's locale (marks, month names); absent for English. */
  readonly localize?: (text: string) => string;
  /** True where the locale's marks differ (1.234,5), so every number is written over. */
  readonly localizeAllNumbers?: boolean;
  /** Formula cells whose block answer cannot spill (something is in the way), as "r:c". */
  readonly spillBlocked?: ReadonlySet<string>;
}

type Info = {
  row: number;
  column: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

const within = (range: SheetRange, r: number, c: number) =>
  r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

function dropdownAt(state: SheetPaintState, r: number, c: number) {
  return state.dropdowns.find((d) => d.ranges.some((range) => within(range, r, c)));
}
function isCheckbox(state: SheetPaintState, r: number, c: number) {
  return state.checkboxes.some((range) => within(range, r, c));
}
function inTableHeader(state: SheetPaintState, r: number, c: number) {
  const t = state.table;
  return !!t && c >= t.c0 && c <= t.c1 && r >= t.headerR0 && r <= t.headerR1;
}
function inTableBody(state: SheetPaintState, r: number, c: number) {
  const t = state.table;
  if (!t || c < t.c0 || c > t.c1 || r <= t.headerR1) return false;
  const last = t.footerR1 ?? state.tableLastRow ?? t.headerR1;
  return r <= last;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cellText(cell: Cell | null, formulas = false): string {
  if (!cell) return "";
  if (formulas && typeof cell.f === "string" && cell.f) return cell.f;
  const m = cell.m ?? cell.v;
  if (m === undefined || m === null) return "";
  if (typeof m === "boolean") return m ? "TRUE" : "FALSE";
  return String(m);
}

/** Redraws a cell's text with a different look (rule font, the table header's weight). */
function drawText(
  ctx: CanvasRenderingContext2D,
  cell: Cell | null,
  info: Info,
  look: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    underline?: "single" | "double";
    color?: string;
  },
  fill: string,
  fontFamily: string,
  formulas = false,
  localize?: (text: string) => string,
) {
  const shown = cellText(cell, formulas);
  const text =
    localize && typeof cell?.v === "number" && !(formulas && cell?.f) ? localize(shown) : shown;
  const width = info.endX - info.startX;
  const height = info.endY - info.startY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(info.startX, info.startY, width - 1, height - 1);
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(info.startX, info.startY, width - 1, height - 1);
  if (text) {
    const size = (Number(cell?.fs) || SHEET_GRID_METRICS.fontSize) * (4 / 3);
    const bold = look.bold ?? Number(cell?.bl) === 1;
    const italic = look.italic ?? Number(cell?.it) === 1;
    ctx.font = `${italic ? "italic " : ""}${bold ? 600 : 400} ${size}px ${fontFamily}`;
    ctx.fillStyle = look.color ?? (typeof cell?.fc === "string" ? cell.fc : INK);
    ctx.textBaseline = "middle";
    const numeric = typeof cell?.v === "number";
    const align = cell?.ht === undefined || cell?.ht === null ? (numeric ? 2 : 1) : Number(cell.ht);
    const pad = 6;
    const measured = ctx.measureText(text).width;
    const x =
      align === 0
        ? info.startX + (width - measured) / 2
        : align === 2
          ? info.endX - pad - measured
          : info.startX + pad;
    const y = info.startY + Math.min(height, SHEET_GRID_METRICS.rowHeight) / 2;
    ctx.fillText(text, x, y);
    const strike = look.strike ?? Number(cell?.cl) === 1;
    if (strike || look.underline) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (strike) {
        ctx.moveTo(x, y + 0.5);
        ctx.lineTo(x + measured, y + 0.5);
      }
      if (look.underline) {
        ctx.moveTo(x, y + size / 2 + 1);
        ctx.lineTo(x + measured, y + size / 2 + 1);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  info: Info,
  label: string,
  color: string | undefined,
  editable: boolean,
  fontFamily: string,
) {
  const width = info.endX - info.startX;
  const x = info.startX + 4;
  const y = info.startY + 4;
  const w = width - 9;
  const h = 20;
  ctx.save();
  ctx.beginPath();
  ctx.rect(info.startX, info.startY, width - 1, info.endY - info.startY - 1);
  ctx.clip();
  ctx.fillStyle = PAPER;
  ctx.fillRect(info.startX, info.startY, width - 1, info.endY - info.startY - 1);
  if (label || editable) {
    roundRect(ctx, x, y, w, h, 10);
    if (label && color) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = LINE_STRONG;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.font = `400 12px ${fontFamily}`;
    ctx.fillStyle = INK;
    ctx.textBaseline = "middle";
    const room = w - (editable ? 26 : 16);
    let text = label;
    while (text && ctx.measureText(text).width > room) text = text.slice(0, -1);
    if (text !== label && text) text = `${text.slice(0, -1)}…`;
    ctx.fillText(text, x + 8, y + h / 2 + 0.5);
    if (editable) {
      const cx = x + w - 11;
      const cy = y + h / 2;
      ctx.strokeStyle = INK_SECONDARY;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - 1.5);
      ctx.lineTo(cx, cy + 1.5);
      ctx.lineTo(cx + 3, cy - 1.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawCheckbox(ctx: CanvasRenderingContext2D, info: Info, cell: Cell | null, fill: string) {
  const value = cell?.v;
  const checked =
    value === true || (typeof value === "string" && value.toUpperCase() === "TRUE") || value === 1;
  const unchecked =
    value === false ||
    (typeof value === "string" && value.toUpperCase() === "FALSE") ||
    value === 0;
  if (!checked && !unchecked) return;
  const width = info.endX - info.startX;
  const size = 14;
  const x = info.startX + (width - size) / 2;
  const y =
    info.startY + (Math.min(info.endY - info.startY, SHEET_GRID_METRICS.rowHeight) - size) / 2;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(info.startX, info.startY, width - 1, info.endY - info.startY - 1);
  roundRect(ctx, x, y, size, size, 3.5);
  if (checked) {
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 1.75;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x + 3.5, y + 7.25);
    ctx.lineTo(x + 6, y + 9.75);
    ctx.lineTo(x + 10.5, y + 4.5);
    ctx.stroke();
  } else {
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.strokeStyle = CHECKBOX_EDGE;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
  ctx.restore();
}

function headerCell(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  selected: boolean,
  vertical: boolean,
  fontFamily: string,
) {
  ctx.save();
  ctx.fillStyle = selected ? SELECTED_HEADER : FRAME;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // The line between headers, and the line under (or beside) the header strip.
  if (vertical) {
    ctx.moveTo(x, y + h - 0.5);
    ctx.lineTo(x + w, y + h - 0.5);
    ctx.moveTo(x + w - 0.5, y);
    ctx.lineTo(x + w - 0.5, y + h);
  } else {
    ctx.moveTo(x + w - 0.5, y);
    ctx.lineTo(x + w - 0.5, y + h);
    ctx.moveTo(x, y + h - 0.5);
    ctx.lineTo(x + w, y + h - 0.5);
  }
  ctx.stroke();
  if (selected) {
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x + w - 0.5, y);
      ctx.lineTo(x + w - 0.5, y + h);
    } else {
      ctx.moveTo(x, y + h - 0.5);
      ctx.lineTo(x + w, y + h - 0.5);
    }
    ctx.stroke();
  }
  ctx.font = `400 12px ${fontFamily}`;
  ctx.fillStyle = selected ? INK : INK_SECONDARY;
  ctx.textBaseline = "middle";
  const measured = ctx.measureText(text).width;
  ctx.fillText(text, x + (w - measured) / 2, y + h / 2 + 0.5);
  ctx.restore();
}

/** Hooks for the engine. `state` is read at paint time, so the hooks object never changes. */
export function makeSheetCanvasHooks(state: () => SheetPaintState) {
  return {
    beforeRenderColumnHeaderCell: (
      columnChar: string,
      columnIndex: number,
      left: number,
      width: number,
      height: number,
      ctx: CanvasRenderingContext2D,
    ) => {
      const s = state();
      const selected =
        !!s.selection && columnIndex >= s.selection.c0 && columnIndex <= s.selection.c1;
      headerCell(ctx, columnChar, left, 0, width, height, selected, false, s.fontFamily);
      return false;
    },
    beforeRenderRowHeaderCell: (
      rowNumber: string,
      rowIndex: number,
      top: number,
      width: number,
      height: number,
      ctx: CanvasRenderingContext2D,
    ) => {
      const s = state();
      const selected = !!s.selection && rowIndex >= s.selection.r0 && rowIndex <= s.selection.r1;
      headerCell(ctx, rowNumber, 0, top, width, height, selected, true, s.fontFamily);
      return false;
    },
    beforeRenderCell: (_cell: Cell | null, info: Info, ctx: CanvasRenderingContext2D) => {
      const s = state();
      const look = s.looks.get(cellKey(info.row, info.column));
      const plain = typeof ctx.fillStyle === "string" && ctx.fillStyle.toUpperCase() === WHITE;
      if (look?.fill) ctx.fillStyle = look.fill;
      else if (plain)
        ctx.fillStyle = inTableHeader(s, info.row, info.column) ? TABLE_HEADER : PAPER;
      return true;
    },
    afterRenderCell: (cell: Cell | null, info: Info, ctx: CanvasRenderingContext2D) => {
      const s = state();
      const { row: r, column: c } = info;
      const key = cellKey(r, c);
      const look = s.looks.get(key);
      const fill =
        look?.fill ??
        (typeof cell?.bg === "string" && cell.bg
          ? cell.bg
          : inTableHeader(s, r, c)
            ? TABLE_HEADER
            : PAPER);
      const dropdown = dropdownAt(s, r, c);
      if (dropdown) {
        const label = cellText(cell);
        const option = dropdown.options.find((o) => o.label.toLowerCase() === label.toLowerCase());
        drawPill(ctx, info, label, option?.color, !s.readOnly, s.fontFamily);
      } else if (isCheckbox(s, r, c)) {
        drawCheckbox(ctx, info, cell, fill);
      } else {
        const header = inTableHeader(s, r, c) && Number(cell?.bl) !== 1;
        const font =
          look &&
          (look.color ||
            look.bold !== undefined ||
            look.italic !== undefined ||
            look.strike !== undefined ||
            look.underline);
        const formula = s.showFormulas && typeof cell?.f === "string" && cell.f !== "";
        // A number in a 1.234,5 locale is written over the engine's 1,234.5.
        const localized =
          !!s.localize &&
          typeof cell?.v === "number" &&
          (!!s.localizeAllNumbers || /mmm/iu.test(String(cell?.ct?.fa ?? "")));
        if (header || font || formula || localized)
          drawText(
            ctx,
            cell,
            info,
            { ...(header ? { bold: true } : {}), ...(look ?? {}) },
            fill,
            s.fontFamily,
            s.showFormulas,
            s.localize,
          );
      }
      if (inTableBody(s, r, c) || inTableHeader(s, r, c)) {
        ctx.save();
        ctx.strokeStyle = inTableHeader(s, r, c) && r === s.table?.headerR1 ? LINE_STRONG : LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(info.startX, info.endY - 0.5);
        ctx.lineTo(info.endX, info.endY - 0.5);
        ctx.stroke();
        ctx.restore();
      }
      if (s.flash.has(key)) {
        ctx.save();
        ctx.fillStyle = FLASH;
        ctx.fillRect(
          info.startX,
          info.startY,
          info.endX - info.startX - 1,
          info.endY - info.startY - 1,
        );
        ctx.restore();
      }
      if (s.spillBlocked?.has(key)) {
        // The engine shows the block's first value; the cell says why it did not spill.
        drawText(
          ctx,
          { ...cell, v: "#SPILL!", m: "#SPILL!" } as Cell,
          info,
          {},
          fill,
          s.fontFamily,
        );
      }
      if ((typeof cell?.v === "string" && ERROR_TEXT.test(cell.v)) || s.spillBlocked?.has(key)) {
        // An error cell's mark: a small triangle in the top left, as spreadsheets show it.
        const size = 6;
        ctx.save();
        ctx.fillStyle = ERROR_MARK;
        ctx.beginPath();
        ctx.moveTo(info.startX, info.startY);
        ctx.lineTo(info.startX + size, info.startY);
        ctx.lineTo(info.startX, info.startY + size);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      if (s.commentCells.has(key)) {
        // A comment's corner mark: a small triangle in the cell's top right.
        const size = 6;
        ctx.save();
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.moveTo(info.endX - 1 - size, info.startY);
        ctx.lineTo(info.endX - 1, info.startY);
        ctx.lineTo(info.endX - 1, info.startY + size);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    },
  };
}
