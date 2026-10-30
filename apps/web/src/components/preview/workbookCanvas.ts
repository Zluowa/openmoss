import {
  columnName,
  getWorkbookCell,
  indexAtOffset,
  normalizeRange,
  type WorkbookCell,
  type WorkbookRange,
  type WorkbookSheet,
} from "~/lib/preview/workbookModel";
import { drawWorkbookChart } from "./workbookChartCanvas";

export const ROW_HEADER_WIDTH = 48;
export const COLUMN_HEADER_HEIGHT = 26;
export type WorkbookGeometry = {
  rows: Float64Array;
  columns: Float64Array;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
};
type Palette = {
  background: string;
  foreground: string;
  header: string;
  border: string;
  muted: string;
};

function visibleIndices(
  offsets: Float64Array,
  scroll: number,
  viewport: number,
  zoom: number,
  frozen: number,
): number[] {
  const result: number[] = [];
  for (let i = 0; i < Math.min(frozen, offsets.length - 1); i += 1)
    if (offsets[i + 1]! > offsets[i]!) result.push(i);
  const start = Math.max(frozen, indexAtOffset(offsets, scroll / zoom));
  const end = Math.min(offsets.length - 2, indexAtOffset(offsets, (scroll + viewport) / zoom) + 1);
  for (let i = start; i <= end; i += 1) if (offsets[i + 1]! > offsets[i]!) result.push(i);
  return result;
}

function drawCell(
  context: CanvasRenderingContext2D,
  cell: WorkbookCell | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
  palette: Palette,
) {
  context.fillStyle = cell?.fill ?? palette.background;
  context.fillRect(x, y, width, height);
  context.strokeStyle = palette.border;
  context.lineWidth = 0.5;
  context.strokeRect(x + 0.25, y + 0.25, width, height);
  if (!cell) return;
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const border = cell.border?.[side];
    if (!border?.style) continue;
    context.strokeStyle = border.color?.argb
      ? `#${border.color.argb.slice(-6)}`
      : palette.foreground;
    context.lineWidth = (border.style === "thick" ? 3 : border.style === "medium" ? 2 : 1) * zoom;
    context.setLineDash(
      border.style.includes("dash") || border.style.includes("Dash")
        ? [4 * zoom, 2 * zoom]
        : border.style === "dotted"
          ? [zoom, zoom]
          : [],
    );
    context.beginPath();
    context.moveTo(side === "right" ? x + width : x, side === "bottom" ? y + height : y);
    context.lineTo(side === "left" ? x : x + width, side === "top" ? y : y + height);
    context.stroke();
  }
  context.setLineDash([]);
  if (!cell.text) return;
  context.save();
  context.beginPath();
  context.rect(x + 2, y + 1, Math.max(0, width - 4), Math.max(0, height - 2));
  context.clip();
  const fontSize = (((cell.font?.size ?? 10) * 96) / 72) * zoom;
  const family = cell.font?.name?.replace(/["\\]/g, "") ?? "Arial";
  context.font = `${cell.font?.italic ? "italic " : ""}${cell.font?.bold ? "bold " : ""}${fontSize}px "${family}", sans-serif`;
  context.fillStyle = cell.color ?? palette.foreground;
  const alignment = cell.alignment?.horizontal ?? (cell.numeric !== undefined ? "right" : "left");
  context.textAlign =
    alignment === "center" || alignment === "centerContinuous"
      ? "center"
      : alignment === "right"
        ? "right"
        : "left";
  context.textBaseline = "middle";
  const indent = (cell.alignment?.indent ?? 0) * 10 * zoom;
  const textX =
    context.textAlign === "right"
      ? x + width - 5 * zoom - indent
      : context.textAlign === "center"
        ? x + width / 2
        : x + 5 * zoom + indent;
  const lineHeight = fontSize * 1.2;
  let lines = cell.text.split(/\r?\n/);
  if (cell.alignment?.wrapText) {
    const wrapped: string[] = [];
    for (const line of lines) {
      let part = "";
      for (const char of line) {
        if (part && context.measureText(part + char).width > width - 10 * zoom) {
          wrapped.push(part);
          part = "";
        }
        part += char;
      }
      wrapped.push(part);
    }
    lines = wrapped;
  }
  const blockHeight = lineHeight * lines.length;
  const vertical = cell.alignment?.vertical ?? "bottom";
  const startY =
    vertical === "top"
      ? y + lineHeight / 2 + 2
      : vertical === "middle"
        ? y + (height - blockHeight + lineHeight) / 2
        : y + height - blockHeight + lineHeight / 2 - 2;
  const rotation = cell.alignment?.textRotation;
  if (typeof rotation === "number" && rotation) {
    context.translate(textX, y + height / 2);
    context.rotate((-rotation * Math.PI) / 180);
    context.translate(-textX, -(y + height / 2));
  }
  lines.forEach((line, index) => {
    const textY = startY + index * lineHeight;
    context.fillText(line, textX, textY);
    if (cell.font?.underline || cell.font?.strike) {
      const measured = context.measureText(line).width;
      const left =
        context.textAlign === "right"
          ? textX - measured
          : context.textAlign === "center"
            ? textX - measured / 2
            : textX;
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1, zoom);
      context.beginPath();
      context.moveTo(left, textY + (cell.font.strike ? 0 : fontSize / 2));
      context.lineTo(left + measured, textY + (cell.font.strike ? 0 : fontSize / 2));
      context.stroke();
    }
  });
  context.restore();
}

export function drawWorkbook(
  canvas: HTMLCanvasElement,
  sheet: WorkbookSheet,
  geometry: WorkbookGeometry,
  selection: WorkbookRange,
  images: Map<string, HTMLImageElement>,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height, rows, columns, zoom, scrollLeft, scrollTop } = geometry;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = getComputedStyle(canvas);
  const palette: Palette = {
    background: styles.getPropertyValue("--workbook-paper").trim() || "#fff",
    foreground: styles.getPropertyValue("--workbook-ink").trim() || "#202124",
    header: styles.getPropertyValue("--workbook-header").trim() || "#f8f9fa",
    border: styles.getPropertyValue("--workbook-grid").trim() || "#e1e3e6",
    muted: "#68707a",
  };
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  const visibleRows = visibleIndices(rows, scrollTop, height, zoom, sheet.frozenRows);
  const visibleColumns = visibleIndices(columns, scrollLeft, width, zoom, sheet.frozenColumns);
  const frozenWidth = (columns[Math.min(sheet.frozenColumns, columns.length - 1)] ?? 0) * zoom;
  const frozenHeight = (rows[Math.min(sheet.frozenRows, rows.length - 1)] ?? 0) * zoom;
  const normalized = normalizeRange(selection);
  for (const frozenY of [false, true])
    for (const frozenX of [false, true]) {
      const offsetX = frozenX ? 0 : scrollLeft;
      const offsetY = frozenY ? 0 : scrollTop;
      const clipX = ROW_HEADER_WIDTH + (frozenX ? 0 : frozenWidth);
      const clipY = COLUMN_HEADER_HEIGHT + (frozenY ? 0 : frozenHeight);
      const clipWidth = frozenX ? frozenWidth : width - clipX;
      const clipHeight = frozenY ? frozenHeight : height - clipY;
      if (clipWidth <= 0 || clipHeight <= 0) continue;
      context.save();
      context.beginPath();
      context.rect(clipX, clipY, clipWidth, clipHeight);
      context.clip();
      const mergeKeys = new Set<string>();
      for (const row of visibleRows) {
        if (row < sheet.frozenRows !== frozenY) continue;
        for (const col of visibleColumns) {
          if (col < sheet.frozenColumns !== frozenX) continue;
          const merge = sheet.merges.find(
            ({ start, end }) =>
              row >= start.row && row <= end.row && col >= start.col && col <= end.col,
          );
          const first = merge?.start ?? { row, col };
          const last = merge?.end ?? first;
          if (merge) {
            const key = `${first.row}:${first.col}`;
            if (mergeKeys.has(key)) continue;
            mergeKeys.add(key);
          }
          const x = ROW_HEADER_WIDTH + columns[first.col]! * zoom - offsetX;
          const y = COLUMN_HEADER_HEIGHT + rows[first.row]! * zoom - offsetY;
          const cellWidth = (columns[last.col + 1]! - columns[first.col]!) * zoom;
          const cellHeight = (rows[last.row + 1]! - rows[first.row]!) * zoom;
          drawCell(
            context,
            getWorkbookCell(sheet, first),
            x,
            y,
            cellWidth,
            cellHeight,
            zoom,
            palette,
          );
        }
      }
      for (const image of sheet.images) {
        const source = images.get(image.src);
        if (!source?.complete || !source.naturalWidth) continue;
        const axis = (offsets: Float64Array, position: number) => {
          const index = Math.min(Math.floor(position), offsets.length - 2);
          return offsets[index]! + (offsets[index + 1]! - offsets[index]!) * (position - index);
        };
        const x = axis(columns, image.from.col),
          y = axis(rows, image.from.row);
        const imageWidth = image.to
          ? axis(columns, image.to.col) - x
          : (image.width ?? source.naturalWidth);
        const imageHeight = image.to
          ? axis(rows, image.to.row) - y
          : (image.height ?? source.naturalHeight);
        context.drawImage(
          source,
          ROW_HEADER_WIDTH + x * zoom - offsetX,
          COLUMN_HEADER_HEIGHT + y * zoom - offsetY,
          imageWidth * zoom,
          imageHeight * zoom,
        );
      }
      for (const chart of sheet.charts) {
        const axis = (offsets: Float64Array, position: number) => {
          const index = Math.min(Math.floor(position), offsets.length - 2);
          return offsets[index]! + (offsets[index + 1]! - offsets[index]!) * (position - index);
        };
        const x = axis(columns, chart.from.col),
          y = axis(rows, chart.from.row);
        const chartWidth = chart.to ? axis(columns, chart.to.col) - x : (chart.width ?? 480);
        const chartHeight = chart.to ? axis(rows, chart.to.row) - y : (chart.height ?? 288);
        drawWorkbookChart(
          context,
          chart,
          ROW_HEADER_WIDTH + x * zoom - offsetX,
          COLUMN_HEADER_HEIGHT + y * zoom - offsetY,
          chartWidth * zoom,
          chartHeight * zoom,
          zoom,
        );
      }
      const x = ROW_HEADER_WIDTH + columns[normalized.start.col]! * zoom - offsetX;
      const y = COLUMN_HEADER_HEIGHT + rows[normalized.start.row]! * zoom - offsetY;
      const selectionWidth =
        (columns[normalized.end.col + 1]! - columns[normalized.start.col]!) * zoom;
      const selectionHeight = (rows[normalized.end.row + 1]! - rows[normalized.start.row]!) * zoom;
      context.fillStyle = "rgba(2,133,255,.12)";
      context.fillRect(x, y, selectionWidth, selectionHeight);
      context.strokeStyle = "rgb(2,133,255)";
      context.lineWidth = 2;
      context.strokeRect(
        x + 1,
        y + 1,
        Math.max(0, selectionWidth - 2),
        Math.max(0, selectionHeight - 2),
      );
      context.restore();
    }
  // Headers stay pinned to their axes; frozen headers are painted last.
  context.font = "11px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const frozen of [false, true]) {
    for (const col of visibleColumns) {
      if (col < sheet.frozenColumns !== frozen) continue;
      const x = ROW_HEADER_WIDTH + columns[col]! * zoom - (frozen ? 0 : scrollLeft);
      const cellWidth = (columns[col + 1]! - columns[col]!) * zoom;
      if (x + cellWidth < ROW_HEADER_WIDTH) continue;
      context.fillStyle =
        col >= normalized.start.col && col <= normalized.end.col ? "#dceeff" : palette.header;
      context.fillRect(x, 0, cellWidth, COLUMN_HEADER_HEIGHT);
      context.strokeStyle = palette.border;
      context.lineWidth = 0.5;
      context.strokeRect(x, 0, cellWidth, COLUMN_HEADER_HEIGHT);
      context.fillStyle = palette.muted;
      context.fillText(columnName(col), x + cellWidth / 2, COLUMN_HEADER_HEIGHT / 2);
    }
    for (const row of visibleRows) {
      if (row < sheet.frozenRows !== frozen) continue;
      const y = COLUMN_HEADER_HEIGHT + rows[row]! * zoom - (frozen ? 0 : scrollTop);
      const cellHeight = (rows[row + 1]! - rows[row]!) * zoom;
      if (y + cellHeight < COLUMN_HEADER_HEIGHT) continue;
      context.fillStyle =
        row >= normalized.start.row && row <= normalized.end.row ? "#dceeff" : palette.header;
      context.fillRect(0, y, ROW_HEADER_WIDTH, cellHeight);
      context.strokeStyle = palette.border;
      context.lineWidth = 0.5;
      context.strokeRect(0, y, ROW_HEADER_WIDTH, cellHeight);
      context.fillStyle = palette.muted;
      context.fillText(String(row + 1), ROW_HEADER_WIDTH / 2, y + cellHeight / 2);
    }
  }
  context.fillStyle = palette.header;
  context.fillRect(0, 0, ROW_HEADER_WIDTH, COLUMN_HEADER_HEIGHT);
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(0, 0, ROW_HEADER_WIDTH, COLUMN_HEADER_HEIGHT);
  context.strokeStyle = "#9aa0a6";
  if (frozenWidth) {
    context.beginPath();
    context.moveTo(ROW_HEADER_WIDTH + frozenWidth, 0);
    context.lineTo(ROW_HEADER_WIDTH + frozenWidth, height);
    context.stroke();
  }
  if (frozenHeight) {
    context.beginPath();
    context.moveTo(0, COLUMN_HEADER_HEIGHT + frozenHeight);
    context.lineTo(width, COLUMN_HEADER_HEIGHT + frozenHeight);
    context.stroke();
  }
}
