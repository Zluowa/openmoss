import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  cellAddress,
  dimensionOffsets,
  getWorkbookCell,
  indexAtOffset,
  mergeAt,
  normalizeRange,
  parseRange,
  rangeAddress,
  selectionText,
  type PreviewWorkbook,
  type WorkbookAnnotation,
  type WorkbookPoint,
  type WorkbookRange,
} from "~/lib/preview/workbookModel";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "~/file-icons";
import { DownloadIcon, RefreshCwIcon } from "~/lib/icons";
import { OpenInPicker } from "../chat/OpenInPicker";

import { COLUMN_HEADER_HEIGHT, drawWorkbook, ROW_HEADER_WIDTH } from "./workbookCanvas";

type Props = {
  workbook: PreviewWorkbook;
  className?: string | undefined;
  onAnnotate?: ((annotation: WorkbookAnnotation) => void) | undefined;
  filePath?: string | undefined;
  cwd?: string | null | undefined;
  downloadUrl?: string | undefined;
  onReload?: (() => void) | undefined;
};
const INITIAL_SELECTION: WorkbookRange = { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } };

export function WorkbookPreview({
  workbook,
  className,
  onAnnotate,
  filePath,
  cwd,
  downloadUrl,
  onReload,
}: Props) {
  const visibleSheets = workbook.sheets.filter((item) => !item.hidden);
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = visibleSheets[activeSheet] ?? visibleSheets[0] ?? workbook.sheets[0]!;
  const [selection, setSelection] = useState<WorkbookRange>(INITIAL_SELECTION);
  const [address, setAddress] = useState("A1");
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [notice, setNotice] = useState("");
  const [, setImageRevision] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointerAnchor = useRef<WorkbookPoint | null>(null);
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const savedSelections = useRef(new Map<string, WorkbookRange>());
  const activeCellId = useId();
  const rowCount = Math.min(1_048_576, Math.max(100, sheet.rowCount + 50));
  const columnCount = Math.min(16_384, Math.max(26, sheet.columnCount + 10));
  const rows = useMemo(
    () => dimensionOffsets(rowCount, sheet.rowHeights, sheet.hiddenRows, 24),
    [rowCount, sheet],
  );
  const columns = useMemo(
    () => dimensionOffsets(columnCount, sheet.columnWidths, sheet.hiddenColumns, 96),
    [columnCount, sheet],
  );
  const selectedCell = getWorkbookCell(
    sheet,
    mergeAt(sheet, selection.start)?.start ?? selection.start,
  );
  const normalized = normalizeRange(selection);
  const selectedAddress = rangeAddress(selection);
  const openInTarget = filePath
    ? /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(filePath)
      ? filePath
      : cwd
        ? `${cwd.replace(/[\\/]$/, "")}/${filePath}`
        : null
    : null;

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    for (const image of sheet.images) {
      if (imageCache.current.has(image.src)) continue;
      const element = new Image();
      element.onload = () => {
        if (!cancelled) setImageRevision((revision) => revision + 1);
      };
      element.src = image.src;
      imageCache.current.set(image.src, element);
    }
    return () => {
      cancelled = true;
    };
  }, [sheet]);
  useEffect(() => {
    if (canvas.current)
      drawWorkbook(
        canvas.current,
        sheet,
        { rows, columns, zoom, scrollLeft: scroll.left, scrollTop: scroll.top, ...size },
        selection,
        imageCache.current,
      );
  });

  const chooseSelection = useCallback(
    (range: WorkbookRange, reveal = false) => {
      const clamp = (point: WorkbookPoint): WorkbookPoint => ({
        row: Math.max(0, Math.min(rowCount - 1, point.row)),
        col: Math.max(0, Math.min(columnCount - 1, point.col)),
      });
      const next = { start: clamp(range.start), end: clamp(range.end) };
      setSelection(next);
      setAddress(rangeAddress(next));
      setNotice("");
      if (reveal && viewport.current) {
        const element = viewport.current;
        const point = next.end;
        const frozenWidth = columns[Math.min(sheet.frozenColumns, columnCount)]! * zoom;
        const frozenHeight = rows[Math.min(sheet.frozenRows, rowCount)]! * zoom;
        if (point.col >= sheet.frozenColumns) {
          const left = columns[point.col]! * zoom;
          const right = columns[point.col + 1]! * zoom;
          if (left < element.scrollLeft + frozenWidth)
            element.scrollLeft = Math.max(0, left - frozenWidth);
          else if (right > element.scrollLeft + element.clientWidth - ROW_HEADER_WIDTH)
            element.scrollLeft = right - element.clientWidth + ROW_HEADER_WIDTH;
        }
        if (point.row >= sheet.frozenRows) {
          const top = rows[point.row]! * zoom;
          const bottom = rows[point.row + 1]! * zoom;
          if (top < element.scrollTop + frozenHeight)
            element.scrollTop = Math.max(0, top - frozenHeight);
          else if (bottom > element.scrollTop + element.clientHeight - COLUMN_HEADER_HEIGHT)
            element.scrollTop = bottom - element.clientHeight + COLUMN_HEADER_HEIGHT;
        }
      }
    },
    [rowCount, columnCount, columns, rows, sheet, zoom],
  );

  const pointerPoint = (event: PointerEvent<HTMLCanvasElement>): WorkbookPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left - ROW_HEADER_WIDTH;
    const y = event.clientY - bounds.top - COLUMN_HEADER_HEIGHT;
    const frozenWidth = columns[Math.min(sheet.frozenColumns, columnCount)]! * zoom;
    const frozenHeight = rows[Math.min(sheet.frozenRows, rowCount)]! * zoom;
    return {
      row: indexAtOffset(rows, (y + (y < frozenHeight ? 0 : scroll.top)) / zoom),
      col: indexAtOffset(columns, (x + (x < frozenWidth ? 0 : scroll.left)) / zoom),
    };
  };
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const control = event.ctrlKey || event.metaKey;
    const point = { ...(event.shiftKey ? selection.end : selection.start) };
    const merge = mergeAt(sheet, point);
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        point.row = control ? Math.max(0, sheet.rowCount - 1) : (merge?.end.row ?? point.row) + 1;
        break;
      case "ArrowUp":
        point.row = control ? 0 : (merge?.start.row ?? point.row) - 1;
        break;
      case "ArrowRight":
        point.col = control
          ? Math.max(0, sheet.columnCount - 1)
          : (merge?.end.col ?? point.col) + 1;
        break;
      case "ArrowLeft":
        point.col = control ? 0 : (merge?.start.col ?? point.col) - 1;
        break;
      case "Tab":
        point.col += event.shiftKey ? -1 : 1;
        break;
      case "Enter":
        point.row += event.shiftKey ? -1 : 1;
        break;
      case "PageDown":
        point.row += Math.max(1, Math.floor(size.height / (24 * zoom)) - 1);
        break;
      case "PageUp":
        point.row -= Math.max(1, Math.floor(size.height / (24 * zoom)) - 1);
        break;
      case "Home":
        point.col = 0;
        if (control) point.row = 0;
        break;
      case "End":
        point.col = Math.max(0, sheet.columnCount - 1);
        if (control) point.row = Math.max(0, sheet.rowCount - 1);
        break;
      case "a":
      case "A":
        if (control) {
          event.preventDefault();
          chooseSelection({
            start: { row: 0, col: 0 },
            end: { row: Math.max(0, sheet.rowCount - 1), col: Math.max(0, sheet.columnCount - 1) },
          });
          return;
        }
        handled = false;
        break;
      case "Escape":
        chooseSelection({ start: selection.start, end: selection.start });
        event.preventDefault();
        return;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    const backwards =
      ["ArrowUp", "ArrowLeft", "PageUp", "Home"].includes(event.key) ||
      (event.shiftKey && ["Tab", "Enter"].includes(event.key));
    const delta = backwards ? -1 : 1;
    while (sheet.hiddenRows.has(point.row) && point.row >= 0 && point.row < rowCount)
      point.row += delta;
    while (sheet.hiddenColumns.has(point.col) && point.col >= 0 && point.col < columnCount)
      point.col += delta;
    const target = mergeAt(sheet, point);
    const expand = event.shiftKey && !["Tab", "Enter"].includes(event.key);
    chooseSelection(
      {
        start: expand ? selection.start : (target?.start ?? point),
        end: expand ? point : (target?.end ?? point),
      },
      true,
    );
  };
  const changeSheet = (index: number) => {
    savedSelections.current.set(sheet.name, selection);
    setActiveSheet(index);
    const next = savedSelections.current.get(visibleSheets[index]!.name) ?? INITIAL_SELECTION;
    setSelection(next);
    setAddress(rangeAddress(next));
    setNotice("");
    viewport.current?.scrollTo(0, 0);
  };
  const applyZoom = (next: number) => setZoom(Math.max(0.25, Math.min(4, next)));
  const fit = () =>
    applyZoom((size.width - ROW_HEADER_WIDTH - 4) / columns[Math.max(1, sheet.columnCount)]!);
  const annotate = () => {
    try {
      onAnnotate?.({
        sheetName: sheet.name,
        range: selectedAddress,
        quote: selectionText(sheet, selection),
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to attach this range.");
    }
  };

  return (
    <div
      className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
      data-workbook-preview="true"
    >
      {filePath ? (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3 [container-name:header-actions] [container-type:inline-size]">
          <span className="min-w-0 flex-1 truncate text-ui-lg font-medium" title={filePath}>
            {basenameOfPath(filePath)}
          </span>
          {onReload ? (
            <button
              type="button"
              aria-label="Reload file from disk"
              onClick={onReload}
              className="rounded p-1.5 hover:bg-muted"
            >
              <RefreshCwIcon className="size-4" />
            </button>
          ) : null}
          {downloadUrl ? (
            <a
              aria-label="Download spreadsheet"
              href={downloadUrl}
              download={basenameOfPath(filePath)}
              className="rounded p-1.5 hover:bg-muted"
            >
              <DownloadIcon className="size-4" />
            </a>
          ) : null}
          <OpenInPicker openInTarget={openInTarget} defaultEditor="system-default" />
        </div>
      ) : null}
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-ui-sm"
        data-testid="workbook-formula-bar"
      >
        <input
          aria-label="Cell or range address"
          className="w-20 rounded-md bg-transparent px-1 py-1 text-ui-sm outline-none focus:ring-1 focus:ring-ring"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onBlur={() => setAddress(selectedAddress)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const bang = address.lastIndexOf("!");
            const parsed = parseRange(bang >= 0 ? address.slice(bang + 1) : address);
            if (!parsed) {
              setNotice("Enter a cell or range, such as A1 or B2:D8.");
              return;
            }
            if (bang >= 0) {
              const name = address.slice(0, bang).replace(/^'|'$/g, "").replaceAll("''", "'");
              const index = visibleSheets.findIndex((item) => item.name === name);
              if (index < 0) {
                setNotice("This worksheet is not available.");
                return;
              }
              if (index !== activeSheet) {
                savedSelections.current.set(name, parsed);
                changeSheet(index);
                return;
              }
            }
            if (parsed.end.row >= rowCount || parsed.end.col >= columnCount) {
              setNotice("This range is outside the preview's worksheet bounds.");
              return;
            }
            chooseSelection(parsed, true);
            canvas.current?.focus();
          }}
        />
        <div className="h-8 w-px shrink-0 bg-border/60" />
        <button
          type="button"
          aria-label="Insert function"
          disabled
          className="inline-flex size-8 shrink-0 items-center justify-center font-serif text-base italic text-muted-foreground opacity-50"
        >
          ƒx
        </button>
        <input
          aria-label="Formula bar"
          value={selectedCell?.formula ?? selectedCell?.text ?? ""}
          readOnly
          className={cn(
            "min-w-0 flex-1 border-0 bg-transparent px-1.5 text-ui-sm outline-none",
            selectedCell?.formula && "font-mono",
          )}
        />
        {onAnnotate ? (
          <button
            type="button"
            onClick={annotate}
            className="shrink-0 rounded px-2 py-1 hover:bg-muted"
            aria-label="Attach selected range to chat"
          >
            Ask about this
          </button>
        ) : null}
        <select
          aria-label="Spreadsheet zoom"
          className="rounded bg-transparent px-1 py-1 text-ui-sm"
          value={String(Math.round(zoom * 100))}
          onChange={(event) =>
            event.target.value === "fit" ? fit() : applyZoom(Number(event.target.value) / 100)
          }
        >
          <option value="fit">Fit width</option>
          {Array.from(new Set([25, 50, 75, 100, 125, 150, 200, 300, 400, Math.round(zoom * 100)]))
            .sort((a, b) => a - b)
            .map((value) => (
              <option key={value} value={value}>
                {value}%
              </option>
            ))}
        </select>
      </div>
      {workbook.warnings.length ? (
        <div
          role="note"
          className="shrink-0 border-b border-border/60 px-3 py-1.5 text-ui-sm text-muted-foreground"
        >
          {workbook.warnings.join(" ")}
        </div>
      ) : null}
      <div
        ref={viewport}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        data-testid="workbook-viewport"
        onScroll={(event) =>
          setScroll({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })
        }
      >
        <div
          style={{
            width: columns[columnCount]! * zoom + ROW_HEADER_WIDTH,
            height: rows[rowCount]! * zoom + COLUMN_HEADER_HEIGHT,
          }}
        >
          <canvas
            ref={canvas}
            tabIndex={0}
            role="grid"
            aria-label="Spreadsheet canvas"
            aria-rowcount={sheet.rowCount}
            aria-colcount={sheet.columnCount}
            aria-readonly="true"
            aria-activedescendant={activeCellId}
            className="sticky top-0 left-0 block touch-none outline-none"
            style={{ width: size.width, height: size.height }}
            onKeyDown={keyDown}
            onCopy={(event) => {
              try {
                event.clipboardData.setData("text/plain", selectionText(sheet, selection));
                event.preventDefault();
              } catch (error) {
                setNotice(error instanceof Error ? error.message : "Unable to copy this range.");
              }
            }}
            onWheel={(event) => {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                applyZoom(zoom * Math.exp(-event.deltaY * 0.002));
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = pointerPoint(event);
              const bounds = event.currentTarget.getBoundingClientRect();
              const headerRow = event.clientY - bounds.top < COLUMN_HEADER_HEIGHT;
              const headerCol = event.clientX - bounds.left < ROW_HEADER_WIDTH;
              if (headerRow || headerCol) {
                chooseSelection({
                  start: { row: headerRow ? 0 : point.row, col: headerCol ? 0 : point.col },
                  end: {
                    row: headerRow ? Math.max(0, sheet.rowCount - 1) : point.row,
                    col: headerCol ? Math.max(0, sheet.columnCount - 1) : point.col,
                  },
                });
                return;
              }
              const merge = mergeAt(sheet, point);
              pointerAnchor.current = event.shiftKey ? selection.start : (merge?.start ?? point);
              chooseSelection({ start: pointerAnchor.current, end: merge?.end ?? point });
            }}
            onPointerMove={(event) => {
              if (pointerAnchor.current)
                chooseSelection({ start: pointerAnchor.current, end: pointerPoint(event) });
            }}
            onPointerUp={() => {
              pointerAnchor.current = null;
            }}
            onPointerCancel={() => {
              pointerAnchor.current = null;
            }}
          >
            <span
              id={activeCellId}
              role="gridcell"
              aria-rowindex={selection.start.row + 1}
              aria-colindex={selection.start.col + 1}
            >
              {cellAddress(selection.start)}: {selectedCell?.text ?? "Empty"}
            </span>
          </canvas>
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-y border-border/60 px-2 text-ui-sm">
        <div
          role="tablist"
          aria-label="Worksheets"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {visibleSheets.map((item, index) => (
            <button
              role="tab"
              type="button"
              key={item.name}
              aria-selected={item === sheet}
              onClick={() => changeSheet(index)}
              className={cn(
                "h-7 max-w-52 shrink-0 truncate rounded-lg px-2 py-1 text-ui-lg",
                item === sheet
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {item.name}
            </button>
          ))}
        </div>
        <span className="shrink-0 text-muted-foreground" aria-live="polite">
          {normalized.end.row - normalized.start.row + 1}R ×{" "}
          {normalized.end.col - normalized.start.col + 1}C
        </span>
      </div>
      {notice ? (
        <div role="status" className="shrink-0 px-3 py-1.5 text-ui-sm text-muted-foreground">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
