// FILE: SheetEditor.tsx
// Purpose: The 电子表格 editor: the formula row on top (formula sign, field, view tools), the
//          grid in the middle drawn the Moss way, the tool card floating over the grid's foot,
//          charts over the cells, and the sheet bar under it; with .xlsx / .csv import and
//          export and the "让 Moss 修改" requests that carry the selection.
// Layer: 资料空间 电子表格 (types stream). Loaded lazily; the host saves the workbook.
// Exports: SheetEditor, SheetAskRequest.
// Why: The engine (Fortune-sheet, MIT) edits, calculates, copies, pastes, fills and undoes; every
//      part a person sees around and over it is Moss's, laid out the way Claude's Sheets lays it
//      out, and every structural change goes through the same edit model agents use.

import "@fortune-sheet/react/dist/index.css";
import "./sheetEditor.css";

import { Workbook } from "@fortune-sheet/react";
import {
  update as formatWithEngine,
  type Op,
  type Sheet as EngineSheet,
} from "@fortune-sheet/core";
import {
  applySheetEdits,
  readSheetWorkbook,
  SheetEditRefusal,
} from "@moss/shared/spaceItems/sheetEdits";
import { mapFormulaReferences, type AxisChange } from "@moss/shared/spaceItems/sheetFormulaRefs";
import {
  computeWorkbookFormulas,
  setSheetFormulaTimeZone,
} from "@moss/shared/spaceItems/sheetFormulas";
import { evaluateSheetRules } from "@moss/shared/spaceItems/sheetRules";
import {
  formatSheetNumber,
  isDateFormat,
  parseTypedCellInput,
} from "@moss/shared/spaceItems/sheetValues";
import {
  cellAddress,
  columnName,
  delocalizeNumberText,
  filledRange,
  formatSheetRange,
  localizeNumberText,
  SHEET_LOCALES,
  type Sheet,
  type SheetBorderStyle,
  type SheetCell,
  type SheetChart,
  type SheetChartKind,
  type SheetRange,
  type SheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";
import {
  type ComponentRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useTheme } from "~/hooks/useTheme";
import { downloadBlob } from "~/lib/browserDownload";
import {
  DownloadIcon,
  EllipsisIcon,
  FileAddIcon,
  HistoryIcon,
  KeyboardIcon,
  PageCommentIcon,
  Redo2Icon,
  SearchIcon,
  SheetFunctionIcon,
  SparklesIcon,
  TrashCanIcon,
  Undo2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { usePageComments } from "~/pageCommentsStore";
import { ENGINE_DEFAULT_INK } from "~/theme/sheetPalette";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../../chat/chatHeaderControls";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { IconButton } from "../../ui/icon-button";
import { Input } from "../../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { SpaceToolbarButton } from "../shared/SpaceEditorChrome";
import { figuresOf, SheetBar } from "./SheetBar";
import {
  makeSheetCanvasHooks,
  SHEET_GRID_METRICS,
  cellKey,
  type SheetPaintState,
} from "./sheetCanvas";
import { SheetChartView, type ChartCell } from "./SheetChartView";
import { SheetCommentsLayer, type SheetCommentOpen } from "./SheetComments";
import { moveSheetComments, openSheetComments, type SheetCommentCell } from "./sheetComments.logic";
import { fromEngineSheets, sheetLayersOf, toEngineSheets, type SheetLayers } from "./sheetEngine";
import { nextSheetPart, toggleReferenceAt } from "./sheetFormulaKeys";
import { SheetLocaleDialog } from "./SheetLocaleDialog";
import { SheetGroupMarks } from "./SheetGroupMarks";
import type { CellHistoryTarget } from "./SheetCellHistory";
import { sheetCommentLabel } from "./sheetComments.logic";
import {
  columnTexts,
  distinctTexts,
  filterHiddenRows,
  readReaderFilters,
  readerHiddenRows,
  readViewerFilters,
  writeReaderFilters,
  writeViewerFilters,
  type ReaderFilter,
  type ViewerFilter,
} from "./sheetViewerFilters";
import { SheetReaderFilterDialog } from "./SheetReaderFilterDialog";
import { SheetImportDialog } from "./SheetImportDialog";
import { applyImportPlan, firstImportPlan, type ImportPlan } from "./sheetImport.logic";
import { SheetRulesPane } from "./SheetRulesPane";
import type { PaneRule } from "./sheetRulesPane.logic";
import {
  SheetToolCard,
  type SheetBorderEdges,
  type SheetToolActions,
  type SheetToolState,
} from "./SheetToolCard";

type EngineApi = ComponentRef<typeof Workbook>;
type Selection = { r0: number; c0: number; r1: number; c1: number; row: number; col: number };

/** What a person asks Moss from the sheet, with what they had selected. */
export interface SheetAskRequest {
  readonly text: string;
  readonly kind: "change" | "fix" | "fill" | "chart" | "comment";
  readonly sheetName: string;
  readonly sheetNumber: number;
  readonly range: string | null;
  readonly activeCell: string | null;
  readonly isSheetBlank: boolean;
  readonly errors?: readonly { cell: string; error: string; explanation: string }[];
}

const ERROR_EXPLANATIONS: Record<string, string> = {
  "#DIV/0!": "这个公式除以了 0 或空单元格。",
  "#REF!": "这个公式引用的单元格或工作表已经不在了。",
  "#NAME?": "公式里有无法识别的函数或名称。",
  "#VALUE!": "公式里有类型不对的值，常见的是该填数字的地方是文字。",
  "#N/A": "要查找的值没有找到。",
  "#NUM!": "数字太大，或超出了函数能接受的范围。",
  "#NULL!": "两个区域没有交集。",
  "#ERROR!": "这个公式读不懂，请检查有没有写错。",
};
const SHORTCUTS: readonly [string, string][] = [
  ["移动", "方向键、Tab、Enter"],
  ["扩大选区", "Shift + 方向键"],
  ["跳到数据边缘", "Ctrl + 方向键"],
  ["全选", "Ctrl + A"],
  ["编辑单元格", "F2 或直接输入"],
  ["单元格内换行", "Alt + Enter"],
  ["取消输入", "Esc"],
  ["复制 / 剪切 / 粘贴", "Ctrl + C / X / V"],
  ["撤销 / 重做", "Ctrl + Z / Ctrl + Y"],
  ["加粗 / 斜体 / 下划线", "Ctrl + B / I / U"],
  ["删除线", "Ctrl + Shift + X"],
  ["清除内容", "Delete"],
  ["查找", "Ctrl + F"],
  ["查找和替换", "Ctrl + H"],
  ["切换绝对 / 相对引用", "F4（写公式时）"],
  ["在编辑栏、表格、工具和工作表之间移动", "F6 / Shift + F6"],
  ["向下 / 向右填充", "Ctrl + D / Ctrl + R"],
  ["快捷键列表", "Ctrl + /"],
];
const DENSITY_KEY = "moss.sheet.density";
/** A formula with an open range: whole columns (B:B), a column from a cell down (B2:B), whole rows. */
const OPEN_RANGE =
  /(?:^|[^A-Za-z0-9_.$])\$?[A-Za-z]{1,3}(?:\$?\d+)?:\$?[A-Za-z]{1,3}(?![A-Za-z0-9_($])|(?:^|[^A-Za-z0-9_.$:])\$?\d+:\$?\d+(?![\d:])/u;
/** A formula that may answer with a block: a spilling function, or an operator on a range. */
/** The engine merges its settings anew when a prop changes; empty menus stay the same list. */
const NO_MENU: string[] = [];
const MAY_SPILL =
  /\{|\b(?:FILTER|SORT|UNIQUE|SEQUENCE|TRANSPOSE|MMULT)\s*\(|:\$?[A-Z]{1,3}\$?\d+\s*[-+*/^&=<>]|[-+*/^&=<>]\s*\$?[A-Z]{1,3}\$?\d+:/iu;

const LOOK_WORDS = { bold: "加粗", italic: "斜体", underline: "下划线", strike: "删除线" } as const;
const INSERT_WORDS = {
  rowAbove: "已在上方插入行",
  rowBelow: "已在下方插入行",
  columnLeft: "已在左侧插入列",
  columnRight: "已在右侧插入列",
} as const;
/** The sentence a screen reader hears after a tool, or null when a dialog or pane says it. */
function actionWords(name: keyof SheetToolActions, args: readonly unknown[]): string | null {
  const [first] = args;
  switch (name) {
    case "toggle":
      return `已切换${LOOK_WORDS[first as keyof typeof LOOK_WORDS] ?? ""}`;
    case "fontSize":
      return `字号 ${String(first)}`;
    case "color":
      return first === "fill" ? "已设置填充颜色" : "已设置文字颜色";
    case "align":
    case "valign":
      return "已设置对齐方式";
    case "wrap":
      return first ? "已自动换行" : "已取消自动换行";
    case "numberFormat":
      return "已设置数字格式";
    case "decimals":
      return Number(first) > 0 ? "已增加小数位" : "已减少小数位";
    case "borders":
      return "已设置边框";
    case "merge":
      return first ? "已合并单元格" : "已取消合并";
    case "insert":
      return INSERT_WORDS[first as keyof typeof INSERT_WORDS] ?? "已插入";
    case "remove":
      return first === "columns" ? "已删除所选列" : "已删除所选行";
    case "sort":
      return first === "descending" ? "已降序排序" : "已升序排序";
    case "filter":
      return "已切换筛选";
    case "chart":
      return "已插入图表";
    case "freeze":
      return first === "none" ? "已取消冻结" : "已冻结";
    case "clearFormatting":
      return "已清除格式";
    case "table":
      return first ? "已设为表格" : "已取消表格样式";
    case "checkbox":
      return "已插入复选框";
    case "gridlines":
      return first ? "已隐藏网格线" : "已显示网格线";
    case "group":
      return args[1] === "ungroup"
        ? "已取消组合"
        : args[1] === "toggle"
          ? "已收起或展开"
          : "已组合";
    case "askMoss":
      return "已交给 Moss";
    default:
      return null;
  }
}

function safeName(title: string, extension: string) {
  return `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").trim() || "电子表格"}.${extension}`;
}
const rangeOf = (s: Selection) => ({
  row: [s.r0, s.r1] as [number, number],
  column: [s.c0, s.c1] as [number, number],
});
const toRange = (s: Selection): SheetRange => ({ r0: s.r0, c0: s.c0, r1: s.r1, c1: s.c1 });

/** The fields the engine's setSelection writes onto each range it is given. */
const ENGINE_RANGE_FIELDS = [
  "row",
  "column",
  "row_focus",
  "column_focus",
  "left",
  "width",
  "top",
  "height",
  "left_move",
  "width_move",
  "top_move",
  "height_move",
] as const;
/**
 * A range for the engine's setSelection. The engine keeps the object in its state, which is
 * frozen, and writes to it again when React runs the update a second time (StrictMode does; an
 * interrupted render can). Its fields are accessors over a private store: a frozen object's
 * setters still run, so the second write lands instead of throwing.
 */
function engineRange(s: Selection): Record<string, unknown> {
  const store: Record<string, unknown> = { ...rangeOf(s), row_focus: s.row, column_focus: s.col };
  const range: Record<string, unknown> = {};
  for (const key of ENGINE_RANGE_FIELDS)
    Object.defineProperty(range, key, {
      enumerable: true,
      get: () => store[key],
      set: (value: unknown) => {
        store[key] = value;
      },
    });
  return range;
}

/** The smallest block of filled cells around one cell (the table it is in). */
function tableAround(sheet: Sheet, r: number, c: number): SheetRange | null {
  const filled = new Set(
    sheet.cells.filter((cell) => cell.v !== null || cell.f).map((cell) => cellKey(cell.r, cell.c)),
  );
  if (!filled.has(cellKey(r, c))) return null;
  let block = { r0: r, r1: r, c0: c, c1: c };
  for (let grew = true; grew; ) {
    grew = false;
    const has = (rr: number, cc: number) => filled.has(cellKey(rr, cc));
    const rowHas = (rr: number) =>
      Array.from({ length: block.c1 - block.c0 + 1 }, (_, i) => has(rr, block.c0 + i)).some(
        Boolean,
      );
    const colHas = (cc: number) =>
      Array.from({ length: block.r1 - block.r0 + 1 }, (_, i) => has(block.r0 + i, cc)).some(
        Boolean,
      );
    if (block.r0 > 0 && rowHas(block.r0 - 1))
      ((block = { ...block, r0: block.r0 - 1 }), (grew = true));
    if (rowHas(block.r1 + 1)) ((block = { ...block, r1: block.r1 + 1 }), (grew = true));
    if (block.c0 > 0 && colHas(block.c0 - 1))
      ((block = { ...block, c0: block.c0 - 1 }), (grew = true));
    if (colHas(block.c1 + 1)) ((block = { ...block, c1: block.c1 + 1 }), (grew = true));
  }
  return block;
}

export function SheetEditor(props: {
  workbook: SheetWorkbook;
  title: string;
  readOnly?: boolean;
  onChange: (workbook: SheetWorkbook) => void;
  /** Replaces the whole workbook (import, a copied sheet); the editor remounts with the new data. */
  onReplace: (workbook: SheetWorkbook) => void;
  /** The agent the sheet asks, and whether it is working now. */
  moss?: {
    readonly label: string;
    readonly busy: boolean;
    readonly onAsk: (request: SheetAskRequest) => void;
  } | null;
  /** Cells to mark as just changed by Moss, as `sheetId|r:c`. */
  flash?: ReadonlySet<string>;
  /** A card shown over the tool card (Moss's last change, with its undo). */
  notice?: ReactNode;
  /** Cell comments, kept with the page's other comments; null where comments are not offered. */
  comments?: {
    readonly pageKey: string;
    readonly pageTitle: string;
    readonly sourceThreadId: string;
    /** Starts Moss's turn for a comment; resolves to the conversation that answers. */
    readonly ask: ((body: string, cell: SheetCommentCell) => Promise<string | null>) | null;
  } | null;
  /** 版本历史: its button in the view tools and its pane beside the grid. */
  history?: {
    readonly open: boolean;
    readonly onToggle: () => void;
    readonly panel: ReactNode;
  } | null;
  /** A strip over the grid (an earlier version shown view only). */
  banner?: ReactNode;
  /** Where this viewer's filters are kept on their device (per sheet); none when absent. */
  viewerKey?: string | null;
  /** Opens one cell's edit history beside the grid. */
  onCellHistory?: ((target: CellHistoryTarget) => void) | null;
}) {
  const readOnly = props.readOnly ?? false;
  const engine = useRef<EngineApi | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { resolvedTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The engine owns live cells; it is seeded once per mount (the host remounts on import).
  const seeded = useMemo(() => computeWorkbookFormulas(props.workbook), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [live, setLive] = useState<SheetWorkbook>(seeded);
  const liveRef = useRef(live);
  liveRef.current = live;
  const layers = useRef(new Map(seeded.sheets.map((sheet) => [sheet.id, sheetLayersOf(sheet)])));
  const deleted = useRef(seeded.deletedSheets ?? []);
  const [activeId, setActiveId] = useState(seeded.sheets[0]!.id);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const [selection, setSelection] = useState<Selection | null>({
    r0: 0,
    c0: 0,
    r1: 0,
    c1: 0,
    row: 0,
    col: 0,
  });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [draft, setDraft] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showFormulas, setShowFormulas] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">(() => {
    try {
      return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  });
  const [engineEpoch, setEngineEpoch] = useState(0);
  const [selectedChart, setSelectedChart] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [dropdownDialog, setDropdownDialog] = useState(false);
  const [sizeDialog, setSizeDialog] = useState<"column" | "row" | null>(null);
  const [localeDialog, setLocaleDialog] = useState(false);
  // A view-only reader's filters (Moss's own: the engine filters only while editing).
  const [readerFilters, setReaderFilters] = useState<Record<string, ReaderFilter>>(() =>
    readOnly && props.viewerKey ? readReaderFilters(props.viewerKey) : {},
  );
  const [readerDialog, setReaderDialog] = useState<{
    block: ReaderFilter["block"];
    column: number;
  } | null>(null);
  /** The words of a number format to ask Moss for, while its dialog is open. */
  const [formatAsk, setFormatAsk] = useState<string | null>(null);
  /** Formulas whose block answer is blocked (#SPILL!), as "r:c" on the active sheet. */
  const [spillBlocked, setSpillBlocked] = useState<ReadonlySet<string>>(new Set());
  const spillTimer = useRef<number | undefined>(undefined);
  // The Sheet's locale and time zone travel beside the engine's sheets.
  const settings = useRef<Pick<SheetWorkbook, "locale" | "timeZone">>({
    ...(seeded.locale ? { locale: seeded.locale } : {}),
    ...(seeded.timeZone ? { timeZone: seeded.timeZone } : {}),
  });
  useEffect(() => setSheetFormulaTimeZone(settings.current.timeZone), []);
  // What the polite live region says: the selection as it moves, and each tool's result.
  const [announcement, setAnnouncement] = useState("");
  const [geometry, setGeometry] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [importing, setImporting] = useState<{
    fileName: string;
    text: string;
    plan: ImportPlan;
    rows: string[][];
  } | null>(null);
  // ── Comments ────────────────────────────────────────────────────────────────────────────
  const commentsOn = props.comments != null;
  const [commenting, setCommenting] = useState(false);
  const [commentOpen, setCommentOpen] = useState<SheetCommentOpen | null>(null);
  const pageComments = usePageComments(props.comments?.pageKey ?? "");
  const commentThreads = useMemo(
    () => openSheetComments(commentsOn ? pageComments : []),
    [commentsOn, pageComments],
  );
  const commentState = useRef({ enabled: false, on: false, threads: commentThreads });
  commentState.current = { enabled: commentsOn, on: commenting, threads: commentThreads };
  const commentsKey = useRef<string | null>(null);
  commentsKey.current = props.comments?.pageKey ?? null;
  /** Opens the cell's thread, or a new comment on it. */
  const openCellComment = useCallback((r: number, c: number) => {
    const thread = commentState.current.threads.get(`${activeRef.current}|${r}:${c}`);
    setCommentOpen(thread ? { kind: "thread", id: thread.id } : { kind: "new", r, c });
  }, []);
  const pointer = useRef({ x: 0, y: 0 });
  const clipboard = useRef<{ rows: unknown[][] } | null>(null);
  const api = () => engine.current;
  /**
   * Reads something from the engine about a sheet. Nothing while the engine has not loaded that
   * sheet yet: its lookups throw "sheet not found" then (just after mount, or while a sheet is
   * being added), and a read during render must not take the editor down.
   */
  const readEngine = <T,>(read: (e: NonNullable<typeof engine.current>) => T): T | undefined => {
    const e = engine.current;
    if (!e) return undefined;
    try {
      return read(e);
    } catch {
      return undefined;
    }
  };

  const activeSheet = live.sheets.find((sheet) => sheet.id === activeId) ?? live.sheets[0]!;
  const sheetLayers = layers.current.get(activeSheet.id) ?? {};
  const looks = useMemo(() => evaluateSheetRules(activeSheet), [activeSheet]);
  const tableLastRow = useMemo(() => {
    const t = activeSheet.table;
    if (!t) return null;
    if (t.footerR1 !== undefined) return t.footerR1;
    let last = t.headerR1;
    const rows = new Set(
      activeSheet.cells
        .filter((cell) => cell.c >= t.c0 && cell.c <= t.c1 && (cell.v !== null || cell.f))
        .map((cell) => cell.r),
    );
    while (rows.has(last + 1)) last += 1;
    return last;
  }, [activeSheet]);
  const paneRules = useMemo((): readonly PaneRule[] => {
    if (!rulesOpen) return [];
    try {
      const read = readSheetWorkbook(live, 0, {
        kind: "readConditionalFormats",
        sheet: activeSheet.name,
      }) as { rules?: PaneRule[] };
      return read.rules ?? [];
    } catch {
      return [];
    }
  }, [rulesOpen, live, activeSheet.name]);
  // The grid is narrower while the pane is open; the engine measures itself on resize.
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(frame);
  }, [rulesOpen]);
  const commentCells = useMemo(() => {
    const out = new Set<string>();
    for (const key of commentThreads.keys()) {
      const [sheetId, cell] = key.split("|");
      if (sheetId === activeSheet.id && cell) out.add(cell);
    }
    return out;
  }, [commentThreads, activeSheet.id]);
  const flashKeys = useMemo(() => {
    const out = new Set<string>();
    for (const key of props.flash ?? []) {
      const [sheetId, cell] = key.split("|");
      if (sheetId === activeSheet.id && cell) out.add(cell);
    }
    return out;
  }, [props.flash, activeSheet.id]);

  // What the canvas hooks read at paint time.
  const paint = useRef<SheetPaintState>({
    selection: null,
    dropdowns: [],
    checkboxes: [],
    table: undefined,
    tableLastRow: null,
    looks: new Map(),
    flash: new Set(),
    readOnly,
    fontFamily: "sans-serif",
    showFormulas: false,
    commentCells: new Set(),
  } as SheetPaintState);
  // A Sheet with no locale is written zh-CN: its month names are Chinese, its marks 1,234.5.
  const locale = settings.current.locale ?? "zh-CN";
  const localize = useMemo(
    () =>
      locale.startsWith("en") ? undefined : (text: string) => localizeNumberText(text, locale),
    [locale],
  );
  const localizeAllNumbers = SHEET_LOCALES[locale].sample !== "1,234.5";
  paint.current = {
    selection: selection ? toRange(selection) : null,
    dropdowns: sheetLayers.dropdowns ?? [],
    checkboxes: sheetLayers.checkboxes ?? [],
    table: sheetLayers.table,
    tableLastRow,
    looks,
    flash: flashKeys,
    readOnly,
    fontFamily: paint.current.fontFamily,
    showFormulas,
    commentCells,
    ...(localize ? { localize, localizeAllNumbers } : {}),
    spillBlocked,
  } as SheetPaintState;
  useLayoutEffect(() => {
    if (shell.current)
      paint.current = {
        ...paint.current,
        fontFamily: getComputedStyle(shell.current).fontFamily || "sans-serif",
      } as SheetPaintState;
  }, []);

  /** Asks the engine to draw again (layers changed without a cell change). */
  const repaint = useCallback(() => {
    const s = selectionRef.current;
    if (!s) return;
    try {
      api()?.setSelection([engineRange(s)] as never, { id: activeRef.current });
    } catch {
      // Nothing to repaint before the engine is ready.
    }
  }, []);
  // This viewer's filters come back when the sheet opens; they never go into the workbook.
  useEffect(() => {
    const key = props.viewerKey;
    if (!key) return;
    const frame = requestAnimationFrame(() => {
      const e = api();
      if (!e) return;
      const stored = readViewerFilters(key);
      const ops: Op[] = [];
      for (const [sheetId, filter] of Object.entries(stored)) {
        const sheet = liveRef.current.sheets.find((s) => s.id === sheetId);
        if (!sheet || !filter.filter_select) continue;
        const groupHidden: Record<string, number> = {};
        for (const g of layers.current.get(sheetId)?.rowGroups ?? [])
          if (g.collapsed) for (let r = g.start; r <= g.end; r++) groupHidden[r] = 0;
        ops.push(
          { op: "replace", id: sheetId, path: ["filter_select"], value: filter.filter_select },
          { op: "replace", id: sheetId, path: ["filter"], value: filter.filter },
          {
            op: "replace",
            id: sheetId,
            path: ["config", "rowhidden"],
            value: { ...filterHiddenRows(filter.filter), ...groupHidden },
          },
        );
      }
      if (ops.length) {
        try {
          e.applyOp(ops);
        } catch {
          // A filter that no longer fits the sheet is dropped.
          writeViewerFilters(key, {});
        }
      }
    });
    return () => cancelAnimationFrame(frame);
    // Once per engine mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineEpoch, props.viewerKey]);

  // Cell edits repaint by themselves; marks and the formula view need a nudge.
  useEffect(() => {
    repaint();
  }, [flashKeys, showFormulas, commentCells, repaint]);

  const current = useCallback((): SheetWorkbook => {
    const sheets = readEngine((e) => e.getAllSheets());
    return sheets
      ? { ...fromEngineSheets(sheets, layers.current, deleted.current), ...settings.current }
      : liveRef.current;
  }, []);
  const save = useCallback(
    (workbook: SheetWorkbook) => {
      setLive(workbook);
      if (readOnly) return;
      try {
        props.onChange(workbook);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法保存这次修改。");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly],
  );
  /** Runs edits of the shared model on the live workbook (the same edits agents send). */
  const edit = useCallback(
    (edits: unknown[]): SheetWorkbook | null => {
      try {
        return applySheetEdits(current(), edits).workbook;
      } catch (cause) {
        if (cause instanceof SheetEditRefusal) {
          if (cause.refusal !== "nothingToChange") setError(refusalText(cause));
          return null;
        }
        setError(cause instanceof Error ? cause.message : "这次修改没有完成。");
        return null;
      }
    },
    [current],
  );
  /** Takes the layers (dropdowns, rules, charts…) of an edited workbook and saves. */
  const keepLayers = useCallback(
    (next: SheetWorkbook) => {
      for (const sheet of next.sheets) layers.current.set(sheet.id, sheetLayersOf(sheet));
      save(current());
      repaint();
    },
    [current, save, repaint],
  );
  /** Writes the 条件格式 pane's list as the sheet's rules (the edit agents use). */
  const saveRules = useCallback(
    (rules: readonly PaneRule[]): boolean => {
      const sheet = liveRef.current.sheets.find((s) => s.id === activeRef.current);
      if (!sheet) return false;
      const read = readSheetWorkbook(current(), 0, {
        kind: "readConditionalFormats",
        sheet: sheet.name,
      }) as { fingerprint: string; rules?: unknown[] };
      // Saving a rule unchanged is not an edit.
      if (JSON.stringify(read.rules ?? []) === JSON.stringify(rules)) return true;
      const next = edit([
        {
          kind: "replaceConditionalFormats",
          sheet: sheet.name,
          inPlaceOf: read.fingerprint,
          rules,
        },
      ]);
      if (!next) return false;
      setError(null);
      keepLayers(next);
      return true;
    },
    [current, edit, keepLayers],
  );

  const hooks = useMemo(() => {
    const canvas = makeSheetCanvasHooks(() => paint.current);
    return {
      ...canvas,
      afterSelectionChange: (
        sheetId: string,
        selected: { row?: number[]; column?: number[]; row_focus?: number; column_focus?: number },
      ) => {
        if (!selected?.row || !selected.column) return;
        const next = {
          r0: selected.row[0]!,
          r1: selected.row[1]!,
          c0: selected.column[0]!,
          c1: selected.column[1]!,
          row: selected.row_focus ?? selected.row[0]!,
          col: selected.column_focus ?? selected.column[0]!,
        };
        if (sheetId && sheetId !== activeRef.current) setActiveId(sheetId);
        // The engine reports the selection again on its own renders; the same one changes nothing.
        const same = (a: typeof next | null) =>
          !!a &&
          a.r0 === next.r0 &&
          a.r1 === next.r1 &&
          a.c0 === next.c0 &&
          a.c1 === next.c1 &&
          a.row === next.row &&
          a.col === next.col;
        setSelection((now) => (same(now) ? now : next));
        setDraft((now) => (now === null ? now : null));
        setSelectedChart((now) => (now === null ? now : null));
      },
      afterActivateSheet: (id: string) => {
        setActiveId(id);
        setSelectedChart(null);
        setCommentOpen(null);
      },
      // What a person types into a cell is read the Sheet's locale's way before the engine
      // parses it (the engine reads the US way): 1.234,5 is 1234.5, 31.12.2026 is a date.
      beforeUpdateCell: (r: number, c: number, value: unknown) => {
        if (readOnly || typeof value !== "string") return true;
        const text = value.trim();
        if (!text || text.startsWith("=") || text.startsWith("'")) return true;
        const normal = delocalizeNumberText(text, settings.current.locale ?? "zh-CN");
        if (normal === text) return true;
        const kept = liveRef.current.sheets
          .find((sheet) => sheet.id === activeRef.current)
          ?.cells.find((cell) => cell.r === r && cell.c === c)?.s?.format;
        const typed = parseTypedCellInput(normal, kept);
        if (typeof typed.v !== "number") return true;
        const fa = typed.format ?? kept ?? "General";
        const v = typed.v;
        setTimeout(() =>
          api()?.setCellValue(
            r,
            c,
            {
              v,
              m: formatSheetNumber(fa, v),
              ct: { fa, t: isDateFormat(fa) ? "d" : "n" },
            } as never,
            { id: activeRef.current },
          ),
        );
        return false;
      },
    };
  }, [readOnly, openCellComment]);

  // The engine calls onChange from an effect that depends on it: a new function on every
  // render would make every render save, and every save render again. One stable callback reads
  // the latest handler.
  // A click on a cell: the engine's own afterCellMouseDown hook runs from a timer that reads its
  // already-revoked state draft and throws, so it never arrives. The editor listens for the click
  // itself and acts on the cell the engine has just selected.
  const cellClicked = useRef<(row: number, column: number) => void>(() => {});
  const engineChange = useRef<(sheets: EngineSheet[]) => void>(() => {});
  const onEngineChange = useCallback((sheets: EngineSheet[]) => engineChange.current(sheets), []);
  const onOp = useCallback((ops: Op[]) => {
    // Rows and columns the person inserted or deleted move the layers with them.
    for (const op of ops) {
      const value = op.value as
        | {
            type?: "row" | "column";
            index?: number;
            count?: number;
            direction?: string;
            start?: number;
            end?: number;
            id?: string;
          }
        | undefined;
      if (op.op !== "insertRowCol" && op.op !== "deleteRowCol") continue;
      if (!value?.type) continue;
      const sheet = liveRef.current.sheets.find(
        (s) => s.id === (value.id ?? op.id ?? activeRef.current),
      );
      if (!sheet) continue;
      const name = sheet.name;
      const axis = value.type;
      // Open ranges (B:B, B2:B, 2:5) follow the inserted or deleted lines the way closed ones do:
      // the shared mapper works them out from the formulas as they were before the change.
      {
        const change: AxisChange =
          op.op === "insertRowCol"
            ? {
                kind: "insert",
                at: value.direction === "lefttop" ? (value.index ?? 0) : (value.index ?? 0) + 1,
                count: value.count ?? 1,
              }
            : { kind: "delete", start: value.start ?? 0, end: value.end ?? value.start ?? 0 };
        const moved = (i: number) =>
          change.kind === "insert"
            ? i >= change.at
              ? i + change.count
              : i
            : change.kind === "delete"
              ? i < change.start
                ? i
                : i > change.end
                  ? i - (change.end - change.start + 1)
                  : null
              : i;
        const fixes: { sheetId: string; r: number; c: number; f: string }[] = [];
        for (const other of liveRef.current.sheets)
          for (const cell of other.cells) {
            if (!cell.f || !OPEN_RANGE.test(cell.f)) continue;
            const f = mapFormulaReferences(cell.f, other.name, sheet.name, axis, change);
            const here = other.id === sheet.id;
            const r = here && axis === "row" ? moved(cell.r) : cell.r;
            const c = here && axis === "column" ? moved(cell.c) : cell.c;
            if (r !== null && c !== null) fixes.push({ sheetId: other.id, r, c, f });
          }
        if (fixes.length)
          requestAnimationFrame(() => {
            const e = api();
            if (!e) return;
            for (const fix of fixes) e.setCellValue(fix.r, fix.c, fix.f, { id: fix.sheetId });
          });
      }
      if (commentsKey.current)
        moveSheetComments(
          commentsKey.current,
          sheet.id,
          axis,
          op.op === "insertRowCol"
            ? {
                kind: "insert",
                at: value.direction === "lefttop" ? (value.index ?? 0) : (value.index ?? 0) + 1,
                count: value.count ?? 1,
              }
            : { kind: "delete", from: value.start ?? 0, to: value.end ?? value.start ?? 0 },
        );
      const layerOnly: SheetWorkbook = {
        version: 1,
        sheets: liveRef.current.sheets.map((s) => ({
          ...s,
          cells: [],
          ...(layers.current.get(s.id) ?? {}),
        })),
      };
      const editsFor =
        op.op === "insertRowCol"
          ? [
              axis === "row"
                ? {
                    kind: "insertRows",
                    sheet: name,
                    besideRow: (value.index ?? 0) + 1,
                    side: value.direction === "lefttop" ? "above" : "below",
                    count: value.count ?? 1,
                  }
                : {
                    kind: "insertColumns",
                    sheet: name,
                    besideColumn: columnName(value.index ?? 0),
                    side: value.direction === "lefttop" ? "left" : "right",
                    count: value.count ?? 1,
                  },
            ]
          : [
              axis === "row"
                ? {
                    kind: "deleteRows",
                    sheet: name,
                    rows: `${(value.start ?? 0) + 1}:${(value.end ?? value.start ?? 0) + 1}`,
                  }
                : {
                    kind: "deleteColumns",
                    sheet: name,
                    columns: `${columnName(value.start ?? 0)}:${columnName(value.end ?? value.start ?? 0)}`,
                  },
            ];
      try {
        const moved = applySheetEdits(layerOnly, editsFor).workbook;
        for (const s of moved.sheets) layers.current.set(s.id, sheetLayersOf(s));
      } catch {
        // Layers that cannot follow (a sheet of one row) stay where they were.
      }
    }
  }, []);

  // ── Geometry: where a cell is on screen (charts, the dropdown picker) ───────────────────────
  const cellBox = useCallback(
    (r: number, c: number) => {
      const root = shell.current;
      // The cells start after the row numbers and below the column letters: the engine's cell
      // area, not its overlay (which covers the headers too).
      const area = root?.querySelector(".fortune-cell-area") as HTMLElement | null;
      if (!root || !area) return null;
      const widths = readEngine((e) =>
        e.getColumnWidth(
          Array.from({ length: c + 1 }, (_, i) => i),
          { id: activeRef.current },
        ),
      );
      const heights = readEngine((e) =>
        e.getRowHeight(
          Array.from({ length: r + 1 }, (_, i) => i),
          { id: activeRef.current },
        ),
      );
      if (!widths || !heights) return null;
      // Rows and columns the engine hides (folded groups, filters) take no room.
      const config =
        (
          readEngine((e) => e.getSheet({ id: activeRef.current })) as
            | {
                config?: {
                  rowhidden?: Record<string, unknown>;
                  colhidden?: Record<string, unknown>;
                };
              }
            | undefined
        )?.config ?? {};
      const rowHidden = config.rowhidden ?? {};
      const colHidden = config.colhidden ?? {};
      let x = 0;
      let y = 0;
      for (let i = 0; i < c; i++)
        if (!(i in colHidden)) x += (widths[i] ?? SHEET_GRID_METRICS.columnWidth) + 1;
      for (let i = 0; i < r; i++)
        if (!(i in rowHidden)) y += (heights[i] ?? SHEET_GRID_METRICS.rowHeight) + 1;
      const scrollX =
        (root.querySelector(".luckysheet-scrollbar-x") as HTMLElement | null)?.scrollLeft ?? 0;
      const scrollY =
        (root.querySelector(".luckysheet-scrollbar-y") as HTMLElement | null)?.scrollTop ?? 0;
      const grid = root.querySelector("[data-sheet-grid]")!.getBoundingClientRect();
      const cells = area.getBoundingClientRect();
      return {
        left: cells.left - grid.left + (x - scrollX) * zoom,
        top: cells.top - grid.top + (y - scrollY) * zoom,
        width: (widths[c] ?? SHEET_GRID_METRICS.columnWidth) * zoom,
        height: (heights[r] ?? SHEET_GRID_METRICS.rowHeight) * zoom,
      };
    },
    [zoom],
  );
  useEffect(() => {
    const root = shell.current;
    if (!root) return;
    const bump = () => setGeometry((n) => n + 1);
    root.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      root.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  }, []);

  // ── The selection's cells ──────────────────────────────────────────────────────────────
  const byKey = useMemo(
    () => new Map(activeSheet.cells.map((cell) => [cellKey(cell.r, cell.c), cell])),
    [activeSheet],
  );
  const activeCell = selection ? byKey.get(cellKey(selection.row, selection.col)) : undefined;
  /** A cell's text as shown, for a reader's filter. */
  const shownIn = (sheet: Sheet) => {
    const cells = new Map(sheet.cells.map((cell) => [cellKey(cell.r, cell.c), cell]));
    return (r: number, c: number) => {
      const cell = cells.get(cellKey(r, c));
      if (!cell || cell.v === null || cell.v === undefined) return "";
      if (typeof cell.v === "number" && cell.s?.format)
        return formatSheetNumber(cell.s.format, cell.v);
      if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
      return String(cell.v);
    };
  };
  /** Shows the rows a reader's filter keeps (folded groups stay folded). */
  const showReaderFilter = (sheetId: string, filter: ReaderFilter | null) => {
    const e = api();
    const sheet = liveRef.current.sheets.find((x) => x.id === sheetId);
    if (!e || !sheet) return;
    const hidden: Record<string, number> = {};
    for (const g of layers.current.get(sheetId)?.rowGroups ?? [])
      if (g.collapsed) for (let r = g.start; r <= g.end; r++) hidden[r] = 0;
    try {
      e.applyOp([
        {
          op: "replace",
          id: sheetId,
          path: ["config", "rowhidden"],
          value: { ...(filter ? readerHiddenRows(shownIn(sheet), filter) : {}), ...hidden },
        },
      ] as Op[]);
    } catch {
      // A sheet the engine has not laid out yet takes the filter when it opens.
    }
    setGeometry((n) => n + 1);
  };
  const setReaderFilter = (sheetId: string, filter: ReaderFilter | null) => {
    setReaderFilters((now) => {
      const next = { ...now };
      if (filter) next[sheetId] = filter;
      else delete next[sheetId];
      if (props.viewerKey) writeReaderFilters(props.viewerKey, next);
      return next;
    });
    showReaderFilter(sheetId, filter);
    setAnnouncement(filter ? "已筛选" : "已清除筛选");
  };
  // A reader's filters come back when the sheet opens.
  useEffect(() => {
    if (!readOnly) return;
    const frame = requestAnimationFrame(() => {
      for (const [sheetId, filter] of Object.entries(readerFilters))
        showReaderFilter(sheetId, filter);
    });
    return () => cancelAnimationFrame(frame);
    // Once per engine mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineEpoch, readOnly]);
  const activeReaderFilter = readerFilters[activeSheet.id] ?? null;
  useEffect(() => {
    if (!selection) return;
    const single = selection.r0 === selection.r1 && selection.c0 === selection.c1;
    if (!single) {
      setAnnouncement(`已选择 ${formatSheetRange(toRange(selection))}`);
      return;
    }
    const cell = byKey.get(cellKey(selection.row, selection.col));
    const shown =
      cell?.v === null || cell?.v === undefined || cell.v === ""
        ? "空"
        : typeof cell.v === "number" && cell.s?.format
          ? formatSheetNumber(cell.s.format, cell.v)
          : String(cell.v);
    setAnnouncement(
      `${cellAddress(selection.row, selection.col)}，${shown}${cell?.f ? `，公式 ${cell.f}` : ""}`,
    );
    // The words follow the selection; the cells are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selection?.r0,
    selection?.c0,
    selection?.r1,
    selection?.c1,
    selection?.row,
    selection?.col,
    activeId,
  ]);
  const merges = activeSheet.merges ?? [];
  const mergedHere = selection
    ? merges.find(
        (m) =>
          m.r0 <= selection.r1 &&
          m.r1 >= selection.r0 &&
          m.c0 <= selection.c1 &&
          m.c1 >= selection.c0,
      )
    : undefined;
  const figures = useMemo(() => {
    if (!selection) return null;
    const values: unknown[] = [];
    const rows = Math.min(selection.r1, selection.r0 + 5_000);
    for (let r = selection.r0; r <= rows; r++)
      for (let c = selection.c0; c <= selection.c1; c++)
        values.push(byKey.get(cellKey(r, c))?.v ?? null);
    const first = byKey.get(cellKey(selection.row, selection.col))?.s?.format;
    return figuresOf(values, first && !isDateFormat(first) ? first : undefined);
  }, [selection, byKey]);
  const isBlank = filledRange(activeSheet) === null;
  const errorText =
    typeof activeCell?.v === "string" ? ERROR_EXPLANATIONS[activeCell.v] : undefined;

  const ask = (kind: SheetAskRequest["kind"], text: string) => {
    if (!props.moss) return;
    const sheetNumber = live.sheets.findIndex((s) => s.id === activeSheet.id) + 1;
    const errors =
      kind === "fix" && selection
        ? activeSheet.cells
            .filter(
              (cell) =>
                typeof cell.v === "string" &&
                cell.v in ERROR_EXPLANATIONS &&
                cell.r >= selection.r0 &&
                cell.r <= selection.r1 &&
                cell.c >= selection.c0 &&
                cell.c <= selection.c1,
            )
            .slice(0, 8)
            .map((cell) => ({
              cell: cellAddress(cell.r, cell.c),
              error: String(cell.v),
              explanation: ERROR_EXPLANATIONS[String(cell.v)]!,
            }))
        : undefined;
    props.moss.onAsk({
      text,
      kind,
      sheetName: activeSheet.name,
      sheetNumber,
      range: selection ? formatSheetRange(toRange(selection)) : null,
      activeCell: selection ? cellAddress(selection.row, selection.col) : null,
      isSheetBlank: isBlank,
      ...(errors?.length ? { errors } : {}),
    });
  };

  // ── Tool actions ───────────────────────────────────────────────────────────────────────
  const withSelection = (fn: (s: Selection, e: EngineApi) => void) => {
    const s = selectionRef.current;
    const e = api();
    if (!s || !e || readOnly) return;
    setError(null);
    fn(s, e);
  };
  const setFormat = (attr: string, value: unknown) =>
    withSelection((s, e) =>
      e.setCellFormatByRange(attr as never, value as never, rangeOf(s), { id: activeRef.current }),
    );
  const setNumberFormat = (pattern: string) =>
    withSelection((s, e) => {
      e.setCellFormatByRange(
        "ct",
        { fa: pattern, t: pattern === "@" ? "s" : "n" } as never,
        rangeOf(s),
        { id: activeRef.current },
      );
      // The engine paints `m`; refresh it for the numbers that are there.
      for (const cell of activeSheet.cells) {
        if (
          typeof cell.v !== "number" ||
          cell.r < s.r0 ||
          cell.r > s.r1 ||
          cell.c < s.c0 ||
          cell.c > s.c1
        )
          continue;
        let shown: string;
        try {
          shown = isDateFormat(pattern)
            ? formatSheetNumber(pattern, cell.v)
            : String(formatWithEngine(pattern, cell.v));
        } catch {
          shown = formatSheetNumber(pattern, cell.v);
        }
        e.setCellValue(
          cell.r,
          cell.c,
          {
            ...(cell.f ? { f: cell.f } : {}),
            v: cell.v,
            m: shown,
            ct: { fa: pattern, t: isDateFormat(pattern) ? "d" : "n" },
          } as never,
          { id: activeRef.current },
        );
      }
    });
  const writeSheetBack = (next: SheetWorkbook, block: SheetRange) => {
    // Puts the edited block's cells (values, formulas, looks) back into the engine.
    const sheet = next.sheets.find((s) => s.id === activeRef.current);
    const e = api();
    if (!sheet || !e) return;
    const engineSheet = toEngineSheets({ version: 1, sheets: [sheet] })[0]!;
    const byPos = new Map(
      ((engineSheet.celldata ?? []) as { r: number; c: number; v: unknown }[]).map((cell) => [
        cellKey(cell.r, cell.c),
        cell.v,
      ]),
    );
    const rows: unknown[][] = [];
    for (let r = block.r0; r <= block.r1; r++) {
      const row: unknown[] = [];
      for (let c = block.c0; c <= block.c1; c++) row.push(byPos.get(cellKey(r, c)) ?? null);
      rows.push(row);
    }
    e.setCellValuesByRange(
      rows,
      { row: [block.r0, block.r1], column: [block.c0, block.c1] },
      { id: activeRef.current },
    );
  };
  const syncConfig = (next: SheetWorkbook) => {
    // Borders and gridlines live in the engine's sheet config.
    const sheet = next.sheets.find((s) => s.id === activeRef.current);
    const e = api();
    if (!sheet || !e) return;
    const engineSheet = toEngineSheets({ version: 1, sheets: [sheet] })[0] as unknown as {
      config: Record<string, unknown>;
      showGridLines: number;
    };
    e.applyOp([
      {
        op: "replace",
        id: sheet.id,
        path: ["config", "borderInfo"],
        value: engineSheet.config.borderInfo ?? [],
      },
      { op: "replace", id: sheet.id, path: ["showGridLines"], value: engineSheet.showGridLines },
      {
        op: "replace",
        id: sheet.id,
        path: ["config", "rowhidden"],
        value: {
          ...filterHiddenRows(
            (
              readEngine((x) => x.getSheet({ id: sheet.id })) as
                | { filter?: ViewerFilter["filter"] }
                | undefined
            )?.filter ?? null,
          ),
          ...((engineSheet.config.rowhidden as Record<string, number> | undefined) ?? {}),
        },
      },
      {
        op: "replace",
        id: sheet.id,
        path: ["config", "colhidden"],
        value: engineSheet.config.colhidden ?? {},
      },
    ] as Op[]);
    save(current());
  };

  /**
   * After a person's edit, formulas with block answers spill again: the shared evaluator works
   * the sheet out, and the cells it changed (spilled values only) go back into the engine.
   */
  const refreshSpills = () => {
    window.clearTimeout(spillTimer.current);
    spillTimer.current = window.setTimeout(() => {
      const e = api();
      if (!e || readOnly) return;
      const workbook = current();
      const sheet = workbook.sheets.find((s) => s.id === activeRef.current);
      if (!sheet) return;
      if (!sheet.spills?.length && !sheet.cells.some((cell) => cell.f && MAY_SPILL.test(cell.f)))
        return;
      const computed = computeWorkbookFormulas(workbook).sheets.find((s) => s.id === sheet.id);
      if (!computed) return;
      const values = (cells: readonly SheetCell[]) =>
        new Map(cells.filter((cell) => !cell.f).map((cell) => [cellKey(cell.r, cell.c), cell.v]));
      const before = values(sheet.cells);
      const after = values(computed.cells);
      const changed: [number, number][] = [];
      for (const k of new Set([...before.keys(), ...after.keys()]))
        if ((before.get(k) ?? null) !== (after.get(k) ?? null)) {
          const [r, c] = k.split(":").map(Number) as [number, number];
          changed.push([r, c]);
        }
      setSpillBlocked(
        new Set(
          computed.cells
            .filter((cell) => cell.f && cell.v === "#SPILL!")
            .map((cell) => cellKey(cell.r, cell.c)),
        ),
      );
      const lay = layers.current.get(sheet.id) ?? {};
      const rest = Object.fromEntries(
        Object.entries(lay).filter(([k]) => k !== "spills"),
      ) as SheetLayers;
      layers.current.set(sheet.id, computed.spills ? { ...rest, spills: computed.spills } : rest);
      if (!changed.length) {
        save(current());
        return;
      }
      const r0 = Math.min(...changed.map(([r]) => r));
      const r1 = Math.max(...changed.map(([r]) => r));
      const c0 = Math.min(...changed.map(([, c]) => c));
      const c1 = Math.max(...changed.map(([, c]) => c));
      writeSheetBack(
        { ...workbook, sheets: workbook.sheets.map((s) => (s.id === sheet.id ? computed : s)) },
        { r0, r1, c0, c1 },
      );
    }, 250);
  };
  useEffect(() => () => window.clearTimeout(spillTimer.current), []);

  /** Folds or unfolds one group (the gutter's −/+). */
  const foldGroup = (
    axis: "row" | "column",
    group: { start: number; end: number; collapsed: boolean },
  ) => {
    if (readOnly) return;
    const text =
      axis === "row"
        ? `${group.start + 1}:${group.end + 1}`
        : `${columnName(group.start)}:${columnName(group.end)}`;
    const next = edit([
      {
        kind: axis === "row" ? "groupRows" : "groupColumns",
        sheet: activeSheet.name,
        groups: [{ [axis === "row" ? "rows" : "columns"]: text, isCollapsed: !group.collapsed }],
      },
    ]);
    if (!next) return;
    for (const sheet of next.sheets) layers.current.set(sheet.id, sheetLayersOf(sheet));
    syncConfig(next);
    setGeometry((n) => n + 1);
    setAnnouncement(group.collapsed ? "已展开" : "已收起");
  };
  /** The top left of the cell area within the grid, for marks in the header gutters. */
  const cellsOrigin = (() => {
    void geometry;
    const root = shell.current;
    const area = root?.querySelector(".fortune-cell-area");
    const grid = root?.querySelector("[data-sheet-grid]");
    if (!area || !grid) return null;
    const a = area.getBoundingClientRect();
    const g = grid.getBoundingClientRect();
    return { left: a.left - g.left, top: a.top - g.top };
  })();

  /** Text in the selection that reads as a number, date or percent becomes one. */
  const convertTextToNumbers = () => {
    const s = selectionRef.current;
    if (!s || readOnly) return;
    const workbook = current();
    const sheet = workbook.sheets.find((x) => x.id === activeRef.current);
    if (!sheet) return;
    const block = toRange(s);
    let changed = 0;
    const cells = sheet.cells.map((cell) => {
      if (
        cell.r < block.r0 ||
        cell.r > block.r1 ||
        cell.c < block.c0 ||
        cell.c > block.c1 ||
        cell.f ||
        typeof cell.v !== "string"
      )
        return cell;
      const typed = parseTypedCellInput(cell.v.trim());
      if (typed.f || typeof typed.v !== "number") return cell;
      changed++;
      return {
        ...cell,
        v: typed.v,
        ...(typed.format ? { s: { ...cell.s, format: typed.format } } : {}),
      };
    });
    if (!changed) {
      setError("所选单元格里没有能转换成数字的文字。");
      return;
    }
    writeSheetBack(
      {
        ...workbook,
        sheets: workbook.sheets.map((x) => (x.id === sheet.id ? { ...sheet, cells } : x)),
      },
      block,
    );
  };
  /** Widens or narrows the selected columns to their contents. */
  const fitColumnsToText = () => {
    const s = selectionRef.current;
    const e = api();
    if (!s || !e || readOnly) return;
    const next = edit([
      {
        kind: "fitColumns",
        sheet: activeSheet.name,
        columns: `${columnName(s.c0)}:${columnName(s.c1)}`,
      },
    ]);
    const sheet = next?.sheets.find((x) => x.id === activeRef.current);
    if (!sheet) return;
    const widths: Record<string, number> = {};
    for (let c = s.c0; c <= s.c1; c++)
      widths[c] = sheet.columnWidths?.[c] ?? SHEET_GRID_METRICS.columnWidth;
    e.setColumnWidth(widths, { id: activeRef.current });
  };
  /** Takes the dropdowns off the selected cells (each dropdown the selection touches). */
  const removeDropdowns = () => {
    const s = selectionRef.current;
    if (!s || readOnly) return;
    const lay = layers.current.get(activeRef.current) ?? {};
    const block = toRange(s);
    const touches = (range: SheetRange) =>
      range.r0 <= block.r1 && range.r1 >= block.r0 && range.c0 <= block.c1 && range.c1 >= block.c0;
    const kept = (lay.dropdowns ?? []).flatMap((d) => {
      const ranges = d.ranges.filter((range) => !touches(range));
      return ranges.length ? [{ ...d, ranges }] : [];
    });
    const rest = Object.fromEntries(
      Object.entries(lay).filter(([key]) => key !== "dropdowns"),
    ) as SheetLayers;
    layers.current.set(activeRef.current, kept.length ? { ...rest, dropdowns: kept } : rest);
    save(current());
    repaint();
  };
  const inDropdown =
    !!selection &&
    (sheetLayers.dropdowns ?? []).some((d) =>
      d.ranges.some(
        (range) =>
          range.r0 <= selection.r1 &&
          range.r1 >= selection.r0 &&
          range.c0 <= selection.c1 &&
          range.c1 >= selection.c0,
      ),
    );

  const toolState: SheetToolState = {
    bold: !!activeCell?.s?.bold,
    italic: !!activeCell?.s?.italic,
    underline: !!activeCell?.s?.underline,
    strike: !!activeCell?.s?.strike,
    size: activeCell?.s?.size ?? null,
    align: activeCell?.s?.align ?? null,
    valign: activeCell?.s?.valign ?? "top",
    wrap: !!activeCell?.s?.wrap,
    format: activeCell?.s?.format ?? "General",
    isMerged: !!mergedHere,
    canMerge: !!selection && (selection.r1 > selection.r0 || selection.c1 > selection.c0),
    hasTable: !!activeSheet.table,
    gridlinesHidden: !!activeSheet.gridlinesHidden,
    rowGroup: selection
      ? ((sheetLayers.rowGroups ?? []).find(
          (g) => selection.row >= g.start && selection.row <= g.end,
        ) ?? null)
      : null,
    columnGroup: selection
      ? ((sheetLayers.columnGroups ?? []).find(
          (g) => selection.col >= g.start && selection.col <= g.end,
        ) ?? null)
      : null,
    frozenRows: activeSheet.frozenRows ?? 0,
    frozenColumns: activeSheet.frozenColumns ?? 0,
    hasFilter: !!(
      readEngine((e) => e.getSheet({ id: activeSheet.id })) as
        | { filter_select?: unknown }
        | undefined
    )?.filter_select,
    mossLabel: props.moss?.label ?? null,
    mossBusy: props.moss?.busy ?? false,
  };

  const toolActions: SheetToolActions = {
    toggle: (look) => {
      const attr = { bold: "bl", italic: "it", underline: "un", strike: "cl" }[look];
      setFormat(attr, toolState[look] ? 0 : 1);
    },
    fontSize: (points) => setFormat("fs", points),
    color: (kind, hex) =>
      setFormat(
        kind === "text" ? "fc" : "bg",
        hex ?? (kind === "text" ? ENGINE_DEFAULT_INK : null),
      ),
    align: (horizontal) =>
      setFormat("ht", horizontal === null ? null : { center: 0, left: 1, right: 2 }[horizontal]),
    valign: (vertical) => setFormat("vt", { middle: 0, top: 1, bottom: 2 }[vertical]),
    wrap: (on) => setFormat("tb", on ? "2" : "1"),
    numberFormat: setNumberFormat,
    decimals: (step) => {
      const value = typeof activeCell?.v === "number" ? activeCell.v : 0;
      const pattern = toolState.format;
      let next: string;
      if (pattern === "General" || pattern === "@") {
        const shown = String(Number(value.toPrecision(10)));
        const places = shown.includes(".") ? shown.split(".")[1]!.length : 0;
        const want = Math.max(0, places + step);
        next = want ? `0.${"0".repeat(want)}` : "0";
      } else {
        const match = /0(\.0+)?/u.exec(pattern);
        const places = match?.[1] ? match[1].length - 1 : 0;
        const want = places + step;
        if (want < 0) {
          setError("已经是 0 位小数了。");
          return;
        }
        next = match ? pattern.replace(match[0], want ? `0.${"0".repeat(want)}` : "0") : pattern;
      }
      setNumberFormat(next);
    },
    borders: (edges: SheetBorderEdges, style: SheetBorderStyle, color) =>
      withSelection((s) => {
        const next = edit([
          {
            kind: "setBorders",
            sheet: activeSheet.name,
            range: formatSheetRange(toRange(s)),
            edges: edges === "none" ? "all" : edges,
            border:
              edges === "none"
                ? { kind: "none" }
                : {
                    kind: "line",
                    style,
                    color: color ? { kind: "rgb", hex: color } : { kind: "none" },
                  },
          },
        ]);
        if (next) syncConfig(next);
      }),
    merge: (on) =>
      withSelection((s, e) => {
        if (on) {
          const filled = activeSheet.cells.filter(
            (cell) =>
              (cell.v !== null || cell.f) &&
              cell.r >= s.r0 &&
              cell.r <= s.r1 &&
              cell.c >= s.c0 &&
              cell.c <= s.c1,
          );
          if (filled.length > 1) setError("合并后只保留左上角单元格的内容。");
          e.mergeCells([rangeOf(s)], "merge-all", { id: activeRef.current });
        } else e.cancelMerge([rangeOf(s)], { id: activeRef.current });
      }),
    insert: (kind) =>
      withSelection((s, e) => {
        if (kind === "rowAbove")
          e.insertRowOrColumn("row", s.r0, s.r1 - s.r0 + 1, "lefttop", { id: activeRef.current });
        if (kind === "rowBelow")
          e.insertRowOrColumn("row", s.r1, s.r1 - s.r0 + 1, "rightbottom", {
            id: activeRef.current,
          });
        if (kind === "columnLeft")
          e.insertRowOrColumn("column", s.c0, s.c1 - s.c0 + 1, "lefttop", {
            id: activeRef.current,
          });
        if (kind === "columnRight")
          e.insertRowOrColumn("column", s.c1, s.c1 - s.c0 + 1, "rightbottom", {
            id: activeRef.current,
          });
      }),
    remove: (kind) =>
      withSelection((s, e) => {
        if (kind === "rows") e.deleteRowOrColumn("row", s.r0, s.r1, { id: activeRef.current });
        else e.deleteRowOrColumn("column", s.c0, s.c1, { id: activeRef.current });
      }),
    sort: (direction, scope) =>
      withSelection((s) => {
        let block = toRange(s);
        if (scope === "table" || (s.r0 === s.r1 && s.c0 === s.c1)) {
          const around = activeSheet.table
            ? {
                r0: activeSheet.table.headerR1 + 1,
                r1: tableLastRow ?? activeSheet.table.headerR1 + 1,
                c0: activeSheet.table.c0,
                c1: activeSheet.table.c1,
              }
            : tableAround(activeSheet, s.row, s.col);
          if (!around) {
            setError("先选择要排序的单元格。");
            return;
          }
          // A table's header row stays where it is.
          block =
            !activeSheet.table &&
            around.r1 > around.r0 &&
            typeof byKey.get(cellKey(around.r0, s.col))?.v === "string"
              ? { ...around, r0: around.r0 + 1 }
              : around;
        }
        const next = edit([
          {
            kind: "sortCells",
            sheet: activeSheet.name,
            range: formatSheetRange(block),
            byColumn: columnName(s.col),
            direction,
          },
        ]);
        if (next) writeSheetBack(next, block);
      }),
    filter: () =>
      withSelection((s, e) => {
        const sheet = (readEngine((x) => x.getSheet({ id: activeRef.current })) ?? {}) as {
          filter_select?: unknown;
        };
        if (sheet.filter_select) {
          e.applyOp([
            { op: "replace", id: activeRef.current, path: ["filter_select"], value: null },
            { op: "replace", id: activeRef.current, path: ["filter"], value: null },
          ] as Op[]);
          return;
        }
        const t = activeSheet.table;
        const block = t
          ? { r0: t.headerR0, r1: tableLastRow ?? t.headerR1, c0: t.c0, c1: t.c1 }
          : s.r0 === s.r1 && s.c0 === s.c1
            ? tableAround(activeSheet, s.row, s.col)
            : toRange(s);
        if (!block) {
          setError("先选择要筛选的表格。");
          return;
        }
        e.applyOp([
          {
            op: "replace",
            id: activeRef.current,
            path: ["filter_select"],
            value: { row: [block.r0, block.r1], column: [block.c0, block.c1] },
          },
        ] as Op[]);
      }),
    chart: (kind: SheetChartKind) =>
      withSelection((s) => {
        const block =
          s.r0 === s.r1 && s.c0 === s.c1 ? tableAround(activeSheet, s.row, s.col) : toRange(s);
        if (!block) {
          setError("先选择有数据的单元格，再插入图表。");
          return;
        }
        const header = byKey.get(cellKey(block.r0, block.c0 + 1))?.v;
        // Over blank cells beside the table, or under it when the table is wide.
        const topLeft =
          block.c1 < 7 ? cellAddress(block.r0, block.c1 + 2) : cellAddress(block.r1 + 3, block.c0);
        const next = edit([
          {
            kind: "addChart",
            chart: {
              name: typeof header === "string" && header ? header : "图表",
              caption: "",
              kind,
              cells: {
                sheet: activeSheet.name,
                range: formatSheetRange({ ...block, r1: block.r1 + 30 }),
              },
              sheet: activeSheet.name,
              topLeft,
              widthInPixels: 480,
              heightInPixels: 280,
            },
          },
        ]);
        if (next) {
          keepLayers(next);
          const added = next.sheets.find((sheet) => sheet.id === activeSheet.id)?.charts?.at(-1);
          if (added) setSelectedChart(added.id);
        }
      }),
    freeze: (kind) =>
      withSelection((s) => {
        const settings =
          kind === "none"
            ? { lastFrozenRow: null, lastFrozenColumn: null }
            : kind === "rows"
              ? { lastFrozenRow: s.row + 1 }
              : { lastFrozenColumn: columnName(s.col) };
        const next = edit([{ kind: "setSheetSettings", sheet: activeSheet.name, settings }]);
        if (!next) return;
        const sheet = next.sheets.find((x) => x.id === activeRef.current)!;
        const frozen =
          (toEngineSheets({ version: 1, sheets: [sheet] })[0] as unknown as { frozen?: unknown })
            .frozen ?? null;
        api()?.applyOp([
          { op: "replace", id: activeRef.current, path: ["frozen"], value: frozen },
        ] as Op[]);
        save(current());
      }),
    clearFormatting: () =>
      withSelection((s, e) => {
        for (const attr of ["bl", "it", "un", "cl", "fs", "fc", "bg", "ht", "vt", "tb"])
          e.setCellFormatByRange(attr as never, null as never, rangeOf(s), {
            id: activeRef.current,
          });
        const next = edit([
          {
            kind: "setBorders",
            sheet: activeSheet.name,
            range: formatSheetRange(toRange(s)),
            edges: "all",
            border: { kind: "none" },
          },
        ]);
        if (next) syncConfig(next);
      }),
    table: (on) =>
      withSelection((s) => {
        if (!on) {
          const next = edit([{ kind: "setCellTable", sheet: activeSheet.name, cellTable: null }]);
          if (next) keepLayers(next);
          return;
        }
        const block =
          s.r0 === s.r1 && s.c0 === s.c1 ? tableAround(activeSheet, s.row, s.col) : toRange(s);
        if (!block) {
          setError("先选择表格的单元格。");
          return;
        }
        const next = edit([
          {
            kind: "setCellTable",
            sheet: activeSheet.name,
            cellTable: {
              columns: `${columnName(block.c0)}:${columnName(block.c1)}`,
              headerRows: String(block.r0 + 1),
              footerRows: null,
            },
          },
        ]);
        if (next) keepLayers(next);
      }),
    dropdown: () => setDropdownDialog(true),
    checkbox: () =>
      withSelection((s) => {
        const next = edit([
          {
            kind: "formatCells",
            sheet: activeSheet.name,
            ranges: [formatSheetRange(toRange(s))],
            format: { cellControl: { kind: "checkbox" } },
          },
        ]);
        if (next) {
          writeSheetBack(next, toRange(s));
          keepLayers(next);
        }
      }),
    gridlines: (hidden) => {
      const next = edit([
        {
          kind: "setSheetSettings",
          sheet: activeSheet.name,
          settings: { areGridlinesHidden: hidden },
        },
      ]);
      if (next) syncConfig(next);
    },
    rules: () => setRulesOpen(true),
    describeFormat: () => setFormatAsk(""),
    group: (axis, how) => {
      const s = selectionRef.current;
      if (!s || readOnly) return;
      const lay = layers.current.get(activeRef.current) ?? {};
      const at = axis === "row" ? s.row : s.col;
      const span =
        how === "group"
          ? axis === "row"
            ? { start: s.r0, end: s.r1 }
            : { start: s.c0, end: s.c1 }
          : (axis === "row" ? lay.rowGroups : lay.columnGroups)?.find(
              (g) => at >= g.start && at <= g.end,
            );
      if (!span) return;
      const text =
        axis === "row"
          ? `${span.start + 1}:${span.end + 1}`
          : `${columnName(span.start)}:${columnName(span.end)}`;
      const folded = how === "toggle" && "collapsed" in span ? !span.collapsed : false;
      const next = edit([
        how === "ungroup"
          ? {
              kind: axis === "row" ? "ungroupRows" : "ungroupColumns",
              sheet: activeSheet.name,
              groups: [text],
            }
          : {
              kind: axis === "row" ? "groupRows" : "groupColumns",
              sheet: activeSheet.name,
              groups: [{ [axis === "row" ? "rows" : "columns"]: text, isCollapsed: folded }],
            },
      ]);
      if (!next) return;
      for (const sheet of next.sheets) layers.current.set(sheet.id, sheetLayersOf(sheet));
      syncConfig(next);
      setGeometry((n) => n + 1);
    },
    askMoss: (text) => ask("change", text),
  };
  const actions = Object.fromEntries(
    Object.entries(toolActions).map(([name, run]) => [
      name,
      (...args: unknown[]) => {
        (run as (...a: unknown[]) => void)(...args);
        const words = actionWords(name as keyof SheetToolActions, args);
        if (words) setAnnouncement(words);
      },
    ]),
  ) as unknown as SheetToolActions;

  const makeDropdown = (labels: string[]) =>
    withSelection((s) => {
      const options = labels.map((label, i) => ({
        label,
        color: {
          kind: "standard",
          hue: ["blue", "green", "yellow", "red", "purple", "teal", "orange", "magenta", "gray"][
            i % 9
          ],
          shade: 200,
        },
      }));
      const next = edit([
        {
          kind: "makeDropdown",
          sheet: activeSheet.name,
          range: formatSheetRange({ ...toRange(s), r1: Math.max(s.r1, s.r0 + 9) }),
          options,
        },
      ]);
      if (next) keepLayers(next);
    });

  // ── Charts ─────────────────────────────────────────────────────────────────────────────
  const chartRows = (chart: SheetChart): ChartCell[][] => {
    const source = live.sheets.find((sheet) => sheet.id === chart.source.sheetId);
    if (!source) return [];
    const cells = new Map(source.cells.map((cell) => [cellKey(cell.r, cell.c), cell]));
    const rows: ChartCell[][] = [];
    const { r0, r1, c0, c1 } = chart.source.range;
    let lastFilled = r0;
    for (let r = r0; r <= Math.min(r1, r0 + 2_000); r++)
      for (let c = c0; c <= c1; c++) if (cells.get(cellKey(r, c))?.v != null) lastFilled = r;
    for (let r = r0; r <= lastFilled; r++) {
      const row: ChartCell[] = [];
      for (let c = c0; c <= c1; c++) {
        const cell = cells.get(cellKey(r, c));
        const value = cell?.v ?? null;
        row.push({
          value,
          text:
            value === null
              ? ""
              : typeof value === "number"
                ? formatSheetNumber(cell?.s?.format, value)
                : String(value),
        });
      }
      rows.push(row);
    }
    return rows;
  };
  const moveChart = (chart: SheetChart, dx: number, dy: number, dw: number, dh: number) => {
    const box = cellBox(chart.anchor.r, chart.anchor.c);
    if (!box) return;
    // Find the cell the moved corner now lies in.
    let r = chart.anchor.r;
    let c = chart.anchor.c;
    let x = chart.anchor.dx + dx / zoom;
    let y = chart.anchor.dy + dy / zoom;
    const width = (col: number) =>
      (readEngine((e) => e.getColumnWidth([col], { id: activeRef.current })[col]) ??
        SHEET_GRID_METRICS.columnWidth) + 1;
    const height = (row: number) =>
      (readEngine((e) => e.getRowHeight([row], { id: activeRef.current })[row]) ??
        SHEET_GRID_METRICS.rowHeight) + 1;
    while (x < 0 && c > 0) x += width(--c);
    while (x >= width(c)) x -= width(c++);
    while (y < 0 && r > 0) y += height(--r);
    while (y >= height(r)) y -= height(r++);
    const next = edit([
      {
        kind: "setChart",
        chartId: chart.id,
        chart: {
          name: chart.name,
          caption: chart.caption,
          kind: chart.kind,
          ...(chart.code !== undefined ? { code: chart.code } : {}),
          cells: {
            sheet: live.sheets.find((s) => s.id === chart.source.sheetId)?.name ?? activeSheet.name,
            range: formatSheetRange(chart.source.range),
          },
          sheet: activeSheet.name,
          topLeft: cellAddress(r, c),
          offsetFromAnchorCell: {
            xInPixels: Math.max(0, Math.round(x)),
            yInPixels: Math.max(0, Math.round(y)),
          },
          widthInPixels: Math.max(120, Math.round(chart.width + dw / zoom)),
          heightInPixels: Math.max(80, Math.round(chart.height + dh / zoom)),
        },
      },
    ]);
    if (next) keepLayers(next);
  };
  const deleteChart = (id: string) => {
    const next = edit([{ kind: "deleteChart", chartId: id }]);
    if (next) {
      setSelectedChart(null);
      keepLayers(next);
    }
  };
  useEffect(() => {
    if (!selectedChart || readOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        deleteChart(selectedChart);
      }
      if (event.key === "Escape") setSelectedChart(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ── Keyboard: shortcuts list, strikethrough ──────────────────────────────────────────────
  useEffect(() => {
    const root = shell.current;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === "/") {
        event.preventDefault();
        setKeysOpen(true);
      } else if (mod && event.shiftKey && event.key.toLowerCase() === "x" && !readOnly) {
        event.preventDefault();
        actions.toggle("strike");
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  });

  // ── Import / export ──────────────────────────────────────────────────────────────────────
  const exportAs = async (format: "xlsx" | "csv") => {
    setError(null);
    setBusy(format === "xlsx" ? "正在导出 Excel…" : "正在导出 CSV…");
    try {
      const { workbookToXlsx, workbookSheetToCsv } = await import("./sheetXlsx");
      const workbook = current();
      if (format === "xlsx") {
        const bytes = await workbookToXlsx(workbook);
        downloadBlob(
          new Blob([bytes as BlobPart], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          safeName(props.title, "xlsx"),
        );
      } else {
        const index = Math.max(
          0,
          workbook.sheets.findIndex((s) => s.id === activeRef.current),
        );
        downloadBlob(
          new Blob([workbookSheetToCsv(workbook, index)], { type: "text/csv;charset=utf-8" }),
          safeName(`${props.title}-${workbook.sheets[index]!.name}`, "csv"),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? `导出失败：${cause.message}` : "导出失败。");
    } finally {
      setBusy(null);
    }
  };
  const importFile = async (file: File) => {
    setError(null);
    setBusy("正在导入…");
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("文件太大，请导入 20 MB 以内的文件。");
      if (/\.(csv|tsv|txt)$/iu.test(file.name)) {
        // A text file shows how it reads first; it lands from the dialog.
        const text = await file.text();
        const first = firstImportPlan(text, file.name);
        setImporting({ fileName: file.name, text, plan: first.plan, rows: first.rows });
        return;
      }
      const { xlsxToWorkbook, appendImportedSheets } = await import("./sheetXlsx");
      const imported = await xlsxToWorkbook(await file.arrayBuffer());
      const before = current();
      props.onReplace(appendImportedSheets(before, imported));
      toastManager.add({
        type: "success",
        title: `已导入 ${imported.sheets.length} 张工作表`,
        actionProps: { children: "撤销导入", onClick: () => props.onReplace(before) },
      });
    } catch (cause) {
      setError(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败。");
    } finally {
      setBusy(null);
    }
  };

  const finishImport = (plan: ImportPlan, rows: string[][]) => {
    try {
      const before = current();
      const outcome = applyImportPlan(plan, rows, before, activeRef.current);
      const target = outcome.workbook.sheets.find((sheet) => sheet.id === outcome.sheetId);
      setImporting(null);
      props.onReplace(outcome.workbook);
      toastManager.add({
        type: "success",
        title:
          outcome.updated !== undefined
            ? `“${target?.name ?? ""}”更新了 ${outcome.updated} 行，新增 ${outcome.added ?? 0} 行`
            : `已导入 ${outcome.rowCount} 行到“${target?.name ?? plan.sheetName}”`,
        ...(outcome.unmatched.length
          ? {
              description: `${outcome.unmatched.map((name) => `“${name}”`).join("、")} 在这张表里没有对应的列，没有导入。`,
            }
          : {}),
        actionProps: { children: "撤销导入", onClick: () => props.onReplace(before) },
      });
    } catch (cause) {
      setError(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败。");
      setImporting(null);
    }
  };

  // ── Sheets ───────────────────────────────────────────────────────────────────────────────
  const renameSheet = (id: string, name: string): string | null => {
    const sheet = live.sheets.find((s) => s.id === id);
    if (!sheet || sheet.name === name) return null;
    const next = edit([{ kind: "renameSheet", sheet: sheet.name, name }]);
    if (!next) return "这个名称不能用：可能已有同名工作表，或含有 \\ / ? * [ ] :。";
    setError(null);
    api()?.setSheetName(name, { id });
    // Formulas on every sheet that name it follow.
    props.onReplace({
      ...next,
      sheets: next.sheets.map((s) => ({ ...s, ...(layers.current.get(s.id) ?? {}) })),
    });
    return null;
  };
  const duplicateSheet = (id: string) => {
    const workbook = current();
    const sheet = workbook.sheets.find((s) => s.id === id);
    if (!sheet) return;
    let name = `${sheet.name} 副本`;
    for (let n = 2; workbook.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()); n++)
      name = `${sheet.name} 副本 ${n}`;
    const copyId = `sheet${Date.now().toString(36)}`;
    // The copy's charts are new charts; one that drew from this sheet draws from the copy.
    const fixed: Sheet = {
      ...sheet,
      id: copyId,
      name,
      ...(sheet.charts
        ? {
            charts: sheet.charts.map((chart) => ({
              ...chart,
              id: `cht_${Math.random().toString(36).slice(2, 10)}`,
              source:
                chart.source.sheetId === sheet.id
                  ? { ...chart.source, sheetId: copyId }
                  : chart.source,
            })),
          }
        : {}),
    };
    const index = workbook.sheets.indexOf(sheet);
    props.onReplace({
      ...workbook,
      sheets: [...workbook.sheets.slice(0, index + 1), fixed, ...workbook.sheets.slice(index + 1)],
    });
  };
  const moveSheet = (id: string, by: -1 | 1) => {
    const workbook = current();
    const index = workbook.sheets.findIndex((s) => s.id === id);
    const to = index + by;
    if (index < 0 || to < 0 || to >= workbook.sheets.length) return;
    const order: Record<string, number> = {};
    const ids = workbook.sheets.map((s) => s.id);
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    ids.forEach((sid, i) => (order[sid] = i));
    api()?.setSheetOrder(order);
  };
  const deleteSheet = (id: string) => {
    const workbook = current();
    if (workbook.sheets.length === 1) return;
    const sheet = workbook.sheets.find((s) => s.id === id);
    if (!sheet) return;
    const next = edit([{ kind: "deleteSheet", sheet: sheet.name }]);
    if (!next) return;
    deleted.current = next.deletedSheets ?? [];
    props.onReplace(next);
  };
  const addSheet = () => {
    const workbook = current();
    let n = workbook.sheets.length + 1;
    while (workbook.sheets.some((s) => s.name === `工作表${n}`)) n += 1;
    const next = edit([{ kind: "addSheet", name: `工作表${n}` }]);
    if (next) props.onReplace(next);
  };

  // ── Formula row ──────────────────────────────────────────────────────────────────────────
  const shownInField =
    draft ??
    activeCell?.f ??
    (activeCell?.v === null || activeCell?.v === undefined
      ? ""
      : typeof activeCell.v === "boolean"
        ? activeCell.v
          ? "TRUE"
          : "FALSE"
        : typeof activeCell.v === "number" &&
            activeCell.s?.format &&
            isDateFormat(activeCell.s.format)
          ? formatSheetNumber(activeCell.s.format, activeCell.v)
          : String(activeCell.v));
  const commitDraft = () => {
    if (draft === null || !selection) return;
    const e = api();
    const typed = parseTypedCellInput(
      delocalizeNumberText(draft, settings.current.locale ?? "zh-CN"),
      activeCell?.s?.format,
    );
    if (e) {
      if (typed.f) {
        e.setCellValue(selection.row, selection.col, typed.f, { id: activeRef.current });
        // TODAY() and NOW() in a cell with no format show as a date, not a day number.
        const clock = /^=\s*(TODAY|NOW)\s*\(\s*\)\s*$/iu.exec(typed.f)?.[1]?.toUpperCase();
        const plain = !activeCell?.s?.format || activeCell.s.format === "General";
        if (clock && plain) {
          const fa = clock === "NOW" ? "yyyy-mm-dd h:mm" : "yyyy-mm-dd";
          e.setCellFormat(
            selection.row,
            selection.col,
            "ct",
            { fa, t: "d" },
            {
              id: activeRef.current,
            },
          );
        }
      } else if (typed.v === null)
        e.clearCell(selection.row, selection.col, { id: activeRef.current });
      else {
        const format = typed.format ?? activeCell?.s?.format;
        const m =
          typeof typed.v === "number" && format
            ? formatSheetNumber(format, typed.v)
            : typeof typed.v === "boolean"
              ? typed.v
                ? "TRUE"
                : "FALSE"
              : String(typed.v);
        e.setCellValue(
          selection.row,
          selection.col,
          {
            v: typed.v,
            m,
            ct: {
              fa: format ?? "General",
              t:
                typeof typed.v === "number"
                  ? isDateFormat(format)
                    ? "d"
                    : "n"
                  : typeof typed.v === "boolean"
                    ? "b"
                    : "g",
            },
          } as never,
          { id: activeRef.current },
        );
      }
    }
    setDraft(null);
  };

  const setEngineZoom = (next: number) => {
    const z = Math.min(4, Math.max(0.25, Math.round(next * 100) / 100));
    setZoom(z);
    api()?.applyOp([
      { op: "replace", id: activeRef.current, path: ["zoomRatio"], value: z },
    ] as Op[]);
  };
  const chooseDensity = (next: "comfortable" | "compact") => {
    setDensity(next);
    try {
      window.localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // Kept for this page only.
    }
    // Row heights are an engine setting: seed it again with the live cells.
    liveRef.current = current();
    setEngineEpoch((n) => n + 1);
  };
  const engineData = useMemo(
    () => toEngineSheets(engineEpoch === 0 ? seeded : liveRef.current, activeRef.current),
    // Re-seeded only when the row density changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engineEpoch],
  );

  const charts = activeSheet.charts ?? [];
  void geometry;
  const pickerDropdown = picker
    ? sheetLayers.dropdowns?.find((d) =>
        d.ranges.some(
          (r) => picker.r >= r.r0 && picker.r <= r.r1 && picker.c >= r.c0 && picker.c <= r.c1,
        ),
      )
    : undefined;

  const viewTools = (
    <div className="flex shrink-0 items-center gap-1 pr-2" data-sheet-view-tools>
      {errorText && !readOnly ? (
        <span
          className="flex items-center gap-1 text-ui-sm text-muted-foreground"
          data-sheet-error-note
        >
          <span className="max-w-64 truncate">{errorText}</span>
          {props.moss ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.moss.busy}
              onClick={() => ask("fix", "修复这些单元格里的错误。")}
            >
              <SparklesIcon /> 让 Moss 修复
            </Button>
          ) : null}
        </span>
      ) : null}
      {commentsOn ? (
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={commenting}
          aria-label={
            commentThreads.size
              ? `评论，${commentThreads.size} 条未解决`
              : commenting
                ? "退出评论"
                : "评论"
          }
          title={commenting ? "退出评论 (Esc)" : "评论单元格"}
          data-testid="sheet-comments"
          className={cn(
            "gap-1 tabular-nums",
            commenting ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          onClick={() => {
            setCommenting((on) => !on);
            setCommentOpen(null);
          }}
        >
          <PageCommentIcon aria-hidden />
          {commentThreads.size ? commentThreads.size : null}
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              className="tabular-nums text-muted-foreground"
              data-testid="sheet-zoom"
              aria-label={`缩放 ${Math.round(zoom * 100)}%`}
            />
          }
        >
          {Math.round(zoom * 100)}%
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" className="w-60">
          <MenuGroup>
            <MenuItem closeOnClick={false} onClick={() => setEngineZoom(zoom + 0.1)}>
              <ZoomInIcon aria-hidden /> 放大
            </MenuItem>
            <MenuItem closeOnClick={false} onClick={() => setEngineZoom(zoom - 0.1)}>
              <ZoomOutIcon aria-hidden /> 缩小
            </MenuItem>
            <MenuItem onClick={() => setEngineZoom(1)}>恢复到 100%</MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem
            onClick={() => setShowFormulas((on) => !on)}
            data-checked={showFormulas ? "" : undefined}
          >
            {showFormulas ? "隐藏公式" : "显示公式"}
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger>行距（只对你生效）</MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-36">
              <MenuItem
                onClick={() => chooseDensity("comfortable")}
                data-checked={density === "comfortable" ? "" : undefined}
              >
                舒适
              </MenuItem>
              <MenuItem
                onClick={() => chooseDensity("compact")}
                data-checked={density === "compact" ? "" : undefined}
              >
                紧凑
              </MenuItem>
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          <MenuItem disabled={readOnly} onClick={() => api()?.handleUndo()}>
            <Undo2Icon aria-hidden /> 撤销
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => api()?.handleRedo()}>
            <Redo2Icon aria-hidden /> 重做
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => pressEngineKey("f")}>
            <SearchIcon aria-hidden /> 查找
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => pressEngineKey("h")}>
            查找和替换
          </MenuItem>
          <MenuItem onClick={() => setKeysOpen(true)}>
            <KeyboardIcon aria-hidden /> 键盘快捷键
          </MenuItem>
          <MenuItem onClick={() => setLocaleDialog(true)} data-testid="sheet-locale-open">
            区域和时区…
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {props.history ? (
        <IconButton
          size="icon-xs"
          variant="chrome"
          label="版本历史"
          tooltip="版本历史"
          tooltipSide="bottom"
          aria-pressed={props.history.open}
          data-testid="sheet-history-button"
          className={cn(
            DOCK_HEADER_ICON_BUTTON_CLASS,
            props.history.open ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          onClick={() => {
            setRulesOpen(false);
            props.history?.onToggle();
          }}
        >
          <HistoryIcon className="size-4" aria-hidden />
        </IconButton>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              size="icon-xs"
              variant="chrome"
              label="导入和下载"
              tooltip="导入和下载"
              tooltipSide="bottom"
              className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "text-muted-foreground")}
            >
              <EllipsisIcon className="size-4" aria-hidden />
            </IconButton>
          }
          data-testid="sheet-file-menu"
        />
        <ComposerPickerMenuPopup align="end" className="w-56">
          {readOnly ? null : (
            <>
              <MenuItem onClick={() => fileInput.current?.click()}>
                <FileAddIcon aria-hidden /> 导入 CSV 或 Excel…
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuGroupLabel>下载</MenuGroupLabel>
          <MenuItem onClick={() => void exportAs("xlsx")}>
            <DownloadIcon aria-hidden /> Excel 工作簿（.xlsx）
          </MenuItem>
          <MenuItem onClick={() => void exportAs("csv")}>
            <DownloadIcon aria-hidden /> 当前工作表（.csv）
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );

  function pressEngineKey(key: "f" | "h") {
    // The engine's find bar opens from its own shortcut.
    const target =
      shell.current?.querySelector(".fortune-sheet-container, .fortune-container") ?? shell.current;
    target?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: true,
        bubbles: true,
      }),
    );
  }

  const above =
    props.notice ??
    (isBlank && !readOnly ? (
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-card border border-border bg-popover px-3 py-2 text-ui-sm shadow-xl"
        data-sheet-empty
      >
        <span className="text-muted-foreground">
          {props.moss ? "让 Moss 填写这张表，或导入一个文件。" : "导入一个文件开始。"}
        </span>
        {props.moss ? (
          <Button
            size="xs"
            variant="outline"
            disabled={props.moss.busy}
            onClick={() => ask("fill", "")}
          >
            <SparklesIcon /> 让 Moss 填写
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>
          <FileAddIcon /> 导入文件
        </Button>
      </div>
    ) : null);

  cellClicked.current = (row: number, column: number) => {
    const notes = commentState.current;
    if (notes.enabled) {
      // While commenting, a click comments; otherwise a commented cell shows its thread.
      if (notes.on) {
        openCellComment(row, column);
        return;
      }
      const thread = notes.threads.get(`${activeRef.current}|${row}:${column}`);
      setCommentOpen(thread ? { kind: "thread", id: thread.id } : null);
    }
    if (readOnly) return;
    const lay = layers.current.get(activeRef.current) ?? {};
    const inside = (range: SheetRange) =>
      row >= range.r0 && row <= range.r1 && column >= range.c0 && column <= range.c1;
    if (lay.dropdowns?.some((d) => d.ranges.some(inside))) {
      setPicker({ r: row, c: column, x: pointer.current.x, y: pointer.current.y });
      return;
    }
    if (lay.checkboxes?.some(inside)) {
      const value = readEngine((e) => e.getCellValue(row, column, { id: activeRef.current }));
      const checked =
        value === true || (typeof value === "string" && value.toUpperCase() === "TRUE");
      api()?.setCellValue(row, column, {
        v: !checked,
        m: !checked ? "TRUE" : "FALSE",
        ct: { fa: "General", t: "b" },
      } as never);
    }
  };
  engineChange.current = (sheets: EngineSheet[]) => {
    refreshSpills();
    if (props.viewerKey) {
      const filters: Record<string, ViewerFilter> = {};
      for (const sheet of sheets as unknown as {
        id?: string;
        filter_select?: unknown;
        filter?: ViewerFilter["filter"];
      }[])
        if (sheet.id && sheet.filter_select)
          filters[sheet.id] = {
            filter_select: sheet.filter_select,
            filter: sheet.filter ?? null,
          };
      writeViewerFilters(props.viewerKey, filters);
    }
    if (readOnly) return;
    try {
      save({
        ...fromEngineSheets(sheets, layers.current, deleted.current),
        ...settings.current,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存这次修改。");
    }
  };
  return (
    <div
      ref={shell}
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-sheet-editor
      data-sheet-theme={resolvedTheme === "dark" ? "dark" : "light"}
      data-sheet-density={density}
      role="region"
      aria-label={`电子表格：${props.title}`}
      onPointerDownCapture={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || !target.closest(".fortune-cell-area")) return;
        // After the engine has moved the selection to the clicked cell.
        requestAnimationFrame(() => {
          const at = selectionRef.current;
          if (at) cellClicked.current(at.row, at.col);
        });
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "F6" || !shell.current) return;
        if (nextSheetPart(shell.current, event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenuCapture={(event) => {
        if (
          !(event.target as HTMLElement).closest("[data-sheet-grid]") ||
          (event.target as HTMLElement).closest("[data-sheet-chart]")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        setContext({ x: event.clientX, y: event.clientY });
      }}
    >
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      <div className="flex h-9 shrink-0 items-center border-b border-border" data-sheet-formula-row>
        <span
          className="flex w-12 shrink-0 items-center justify-center text-muted-foreground"
          aria-hidden
        >
          <SheetFunctionIcon className="size-4" />
        </span>
        <input
          aria-label="编辑栏"
          data-testid="sheet-formula-field"
          value={shownInField}
          readOnly={readOnly || !selection}
          placeholder={readOnly ? "" : "输入 = 开始写公式"}
          onFocus={() => setDraft(shownInField)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commitDraft()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "F4" && !readOnly) {
              const field = event.currentTarget;
              const next = toggleReferenceAt(
                field.value,
                field.selectionStart ?? field.value.length,
              );
              if (next) {
                event.preventDefault();
                setDraft(next.text);
                requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
              }
            } else if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
              (event.target as HTMLInputElement).blur();
            } else if (event.key === "Escape") {
              setDraft(null);
              (event.target as HTMLInputElement).blur();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-[inherit] text-ui outline-none placeholder:text-muted-foreground"
        />
        {busy ? (
          <span role="status" className="px-2 text-ui-sm text-muted-foreground">
            {busy}
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="flex items-center gap-1 px-2 text-ui-sm text-destructive">
            {error}
            <IconButton
              size="icon-xs"
              variant="ghost"
              label="关闭提示"
              onClick={() => setError(null)}
            >
              <XIcon className="size-3" aria-hidden />
            </IconButton>
          </span>
        ) : null}
        {viewTools}
      </div>
      {props.banner}
      {readOnly && activeReaderFilter ? (
        <div
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-ui-sm"
          data-sheet-reader-filter-strip
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            已筛选 {columnName(activeReaderFilter.column)} 列：保留 {activeReaderFilter.keep.length}{" "}
            个值。只有你看到。
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              setReaderDialog({
                block: activeReaderFilter.block,
                column: activeReaderFilter.column,
              })
            }
          >
            修改
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setReaderFilter(activeSheet.id, null)}>
            清除筛选
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1" data-sheet-grid data-sheet-engine>
          <Workbook
            key={engineEpoch}
            ref={engine}
            data={engineData}
            lang="zh"
            allowEdit={!readOnly}
            showToolbar={false}
            showFormulaBar={false}
            showSheetTabs={false}
            cellContextMenu={NO_MENU}
            headerContextMenu={NO_MENU}
            sheetTabContextMenu={NO_MENU}
            rowHeaderWidth={SHEET_GRID_METRICS.rowHeaderWidth}
            columnHeaderHeight={SHEET_GRID_METRICS.columnHeaderHeight}
            defaultColWidth={SHEET_GRID_METRICS.columnWidth}
            defaultRowHeight={density === "compact" ? 23 : SHEET_GRID_METRICS.rowHeight}
            defaultFontSize={SHEET_GRID_METRICS.fontSize}
            row={1000}
            column={26}
            hooks={hooks as never}
            onOp={onOp}
            onChange={onEngineChange}
          />
          <div
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
            data-sheet-over-grid
          >
            {(() => {
              if (!selection) return null;
              const spill = (sheetLayers.spills ?? []).find(
                (sp) =>
                  (sp.r === selection.row && sp.c === selection.col) ||
                  sp.cells.some(([r, c]) => r === selection.row && c === selection.col),
              );
              if (!spill || !spill.cells.length) return null;
              const rows = [spill.r, ...spill.cells.map(([r]) => r)];
              const cols = [spill.c, ...spill.cells.map(([, c]) => c)];
              const top = cellBox(Math.min(...rows), Math.min(...cols));
              const bottom = cellBox(Math.max(...rows), Math.max(...cols));
              if (!top || !bottom) return null;
              return (
                <div
                  aria-hidden
                  data-sheet-spill-outline
                  className="absolute border border-dashed border-[var(--color-text-accent)]"
                  style={{
                    left: top.left,
                    top: top.top,
                    width: bottom.left + bottom.width - top.left,
                    height: bottom.top + bottom.height - top.top,
                  }}
                />
              );
            })()}
            <SheetGroupMarks
              rowGroups={sheetLayers.rowGroups ?? []}
              columnGroups={sheetLayers.columnGroups ?? []}
              cellBox={cellBox}
              origin={cellsOrigin}
              readOnly={readOnly}
              onFold={foldGroup}
            />
            {charts.map((chart) => {
              const box = cellBox(chart.anchor.r, chart.anchor.c);
              if (!box) return null;
              return (
                <SheetChartView
                  key={chart.id}
                  chart={{
                    ...chart,
                    width: Math.round(chart.width * zoom),
                    height: Math.round(chart.height * zoom),
                  }}
                  rows={chartRows(chart)}
                  left={box.left + chart.anchor.dx * zoom}
                  top={box.top + chart.anchor.dy * zoom}
                  selected={selectedChart === chart.id}
                  readOnly={readOnly}
                  onSelect={() => setSelectedChart(chart.id)}
                  onMove={(dx, dy, dw, dh) => moveChart(chart, dx, dy, dw, dh)}
                />
              );
            })}
            {selectedChart && !readOnly
              ? (() => {
                  const chart = charts.find((c) => c.id === selectedChart);
                  const box = chart ? cellBox(chart.anchor.r, chart.anchor.c) : null;
                  if (!chart || !box) return null;
                  return (
                    <div
                      className="pointer-events-auto absolute flex items-center gap-0.5 rounded-control border border-border bg-popover p-0.5 shadow-xl"
                      style={{
                        left: box.left + chart.anchor.dx * zoom + chart.width * zoom - 64,
                        top: box.top + chart.anchor.dy * zoom + 6,
                      }}
                    >
                      {props.moss ? (
                        <SpaceToolbarButton
                          icon={SparklesIcon}
                          label="让 Moss 修改这个图表"
                          onClick={() => ask("chart", `修改图表“${chart.name}”：`)}
                        />
                      ) : null}
                      <SpaceToolbarButton
                        icon={TrashCanIcon}
                        label="删除图表"
                        shortcut="Delete"
                        onClick={() => deleteChart(chart.id)}
                        testId="sheet-chart-delete"
                      />
                    </div>
                  );
                })()
              : null}
          </div>
          {props.comments ? (
            <SheetCommentsLayer
              pageKey={props.comments.pageKey}
              pageTitle={props.comments.pageTitle}
              sourceThreadId={props.comments.sourceThreadId}
              sheet={{ id: activeSheet.id, name: activeSheet.name }}
              comments={pageComments}
              commenting={commenting}
              onCommentingChange={setCommenting}
              open={commentOpen}
              onOpenChange={setCommentOpen}
              cellBox={cellBox}
              pane={{
                width:
                  shell.current?.querySelector<HTMLElement>("[data-sheet-grid]")?.clientWidth ?? 0,
                height:
                  shell.current?.querySelector<HTMLElement>("[data-sheet-grid]")?.clientHeight ?? 0,
              }}
              geometry={geometry}
              ask={props.comments.ask}
            />
          ) : null}
          {readOnly ? null : (
            <SheetToolCard state={toolState} actions={actions} readOnly={readOnly} above={above} />
          )}
        </div>
        {props.history?.open ? (
          props.history.panel
        ) : rulesOpen ? (
          <SheetRulesPane
            sheetName={activeSheet.name}
            rules={paneRules}
            selection={selection ? formatSheetRange(toRange(selection)) : null}
            readOnly={readOnly}
            onSave={saveRules}
            onAskMoss={
              props.moss && !readOnly
                ? (text) =>
                    ask(
                      "change",
                      `为这些单元格写条件格式规则（读 moss_sheet_guide 的 rules 主题，用 replaceConditionalFormats）：${text}`,
                    )
                : null
            }
            onClose={() => setRulesOpen(false)}
          />
        ) : null}
      </div>
      <SheetBar
        sheets={live.sheets.map((sheet) => ({ id: sheet.id, name: sheet.name }))}
        activeId={activeSheet.id}
        readOnly={readOnly}
        figures={figures}
        onActivate={(id) => {
          api()?.activateSheet({ id });
          setActiveId(id);
        }}
        onAdd={addSheet}
        onImport={() => fileInput.current?.click()}
        onRename={renameSheet}
        onDuplicate={duplicateSheet}
        onMove={moveSheet}
        onDelete={deleteSheet}
      />
      {/* The dropdown picker of a cell. */}
      <Menu open={!!picker && !!pickerDropdown} onOpenChange={(open) => !open && setPicker(null)}>
        <ComposerPickerMenuPopup
          anchor={
            picker
              ? { getBoundingClientRect: () => new DOMRect(picker.x, picker.y, 1, 1) }
              : undefined
          }
          align="start"
          className="max-h-80 w-56 overflow-y-auto"
        >
          {pickerDropdown?.options.map((option) => (
            <MenuItem
              key={option.id}
              onClick={() => {
                if (picker)
                  api()?.setCellValue(picker.r, picker.c, option.label, { id: activeRef.current });
                setPicker(null);
              }}
            >
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-full border border-border"
                style={{ background: option.color ?? "transparent" }}
              />
              {option.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              if (picker) api()?.clearCell(picker.r, picker.c, { id: activeRef.current });
              setPicker(null);
            }}
          >
            清除
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {/* The cell menu. */}
      <Menu open={!!context} onOpenChange={(open) => !open && setContext(null)}>
        <ComposerPickerMenuPopup
          anchor={
            context
              ? { getBoundingClientRect: () => new DOMRect(context.x, context.y, 1, 1) }
              : undefined
          }
          align="start"
          className="w-60"
          data-sheet-cell-menu
        >
          <MenuItem onClick={() => copyCells(false)}>复制</MenuItem>
          <MenuItem disabled={readOnly} onClick={() => copyCells(true)}>
            剪切
          </MenuItem>
          <MenuItem disabled={readOnly || !clipboard.current} onClick={() => pasteCells(false)}>
            粘贴
          </MenuItem>
          <MenuItem disabled={readOnly || !clipboard.current} onClick={() => pasteCells(true)}>
            只粘贴值
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={readOnly}
            onClick={() =>
              withSelection((s, e) =>
                e.setCellValuesByRange(
                  Array.from({ length: s.r1 - s.r0 + 1 }, () =>
                    Array.from({ length: s.c1 - s.c0 + 1 }, () => null),
                  ),
                  rangeOf(s),
                  { id: activeRef.current },
                ),
              )
            }
          >
            清除内容
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={actions.clearFormatting}>
            清除格式
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={convertTextToNumbers}>
            把文字转换成数字
          </MenuItem>
          {inDropdown ? (
            <MenuItem disabled={readOnly} onClick={removeDropdowns}>
              删除下拉列表
            </MenuItem>
          ) : null}
          <MenuItem disabled={readOnly} onClick={fitColumnsToText}>
            列宽适应内容
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => setSizeDialog("column")}>
            设置列宽…
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => setSizeDialog("row")}>
            设置行高…
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={readOnly} onClick={() => actions.insert("rowAbove")}>
            在上方插入行
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => actions.insert("rowBelow")}>
            在下方插入行
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => actions.insert("columnLeft")}>
            在左侧插入列
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => actions.insert("columnRight")}>
            在右侧插入列
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => actions.remove("rows")}>
            删除所选行
          </MenuItem>
          <MenuItem disabled={readOnly} onClick={() => actions.remove("columns")}>
            删除所选列
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={readOnly || (!toolState.isMerged && !toolState.canMerge)}
            onClick={() => actions.merge(!toolState.isMerged)}
          >
            {toolState.isMerged ? "取消合并" : "合并单元格"}
          </MenuItem>
          <MenuItem onClick={() => setRulesOpen(true)}>条件格式…</MenuItem>
          {readOnly && selection ? (
            <MenuItem
              data-testid="sheet-reader-filter-open"
              onClick={() => {
                const t = activeSheet.table;
                const block = activeReaderFilter
                  ? activeReaderFilter.block
                  : t
                    ? { r0: t.headerR0, r1: tableLastRow ?? t.headerR1, c0: t.c0, c1: t.c1 }
                    : (tableAround(activeSheet, selection.row, selection.col) ??
                      toRange(selection));
                const column = Math.min(Math.max(selection.col, block.c0), block.c1);
                setReaderDialog({ block, column });
              }}
            >
              筛选这一列…
            </MenuItem>
          ) : null}
          {props.onCellHistory && selection ? (
            <MenuItem
              onClick={() =>
                props.onCellHistory?.({
                  sheetId: activeSheet.id,
                  r: selection.row,
                  c: selection.col,
                  label: sheetCommentLabel(activeSheet.name, selection.row, selection.col),
                })
              }
            >
              查看编辑历史
            </MenuItem>
          ) : null}
          {toolState.rowGroup ? (
            <MenuItem disabled={readOnly} onClick={() => actions.group("row", "toggle")}>
              {toolState.rowGroup.collapsed ? "展开这组行" : "收起这组行"}
            </MenuItem>
          ) : null}
          {toolState.columnGroup ? (
            <MenuItem disabled={readOnly} onClick={() => actions.group("column", "toggle")}>
              {toolState.columnGroup.collapsed ? "展开这组列" : "收起这组列"}
            </MenuItem>
          ) : null}
          {commentsOn ? (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => {
                  const s = selectionRef.current;
                  if (s) openCellComment(s.row, s.col);
                }}
              >
                <PageCommentIcon aria-hidden />
                {selection &&
                commentThreads.has(`${activeSheet.id}|${selection.row}:${selection.col}`)
                  ? "打开评论"
                  : "评论"}
              </MenuItem>
            </>
          ) : null}
          {props.moss ? (
            <>
              <MenuSeparator />
              <MenuItem disabled={readOnly || props.moss.busy} onClick={() => ask("change", "")}>
                <SparklesIcon aria-hidden /> 让 Moss 处理这些单元格
              </MenuItem>
            </>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
      {importing ? (
        <SheetImportDialog
          fileName={importing.fileName}
          text={importing.text}
          firstPlan={importing.plan}
          firstRows={importing.rows}
          activeSheetName={activeSheet.name}
          activeSheetHeadings={activeSheet.cells
            .filter((cell) => cell.r === 0 && typeof cell.v === "string")
            .map((cell) => String(cell.v))}
          onImport={finishImport}
          onCancel={() => setImporting(null)}
          onAskMoss={
            props.moss && !readOnly
              ? () => {
                  const text = importing.text;
                  const excerpt = text.length > 30_000 ? text.slice(0, 30_000) : text;
                  setImporting(null);
                  ask(
                    "change",
                    [
                      `导入文件“${importing.fileName}”：先看清表格从哪里开始、到哪里结束，哪一行是标题，每列是什么（文字、数字、金额、百分比、日期），再用 addSheet 和 writeCells 放进一张新工作表，给列设好格式。不确定的地方先问我。`,
                      text.length > excerpt.length
                        ? `（文件有 ${text.length} 个字符，下面是前 30000 个；先导入这些，再告诉我还缺多少。）`
                        : "",
                      "```",
                      excerpt,
                      "```",
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  );
                }
              : null
          }
        />
      ) : null}
      <Dialog open={keysOpen} onOpenChange={setKeysOpen}>
        <DialogPopup className="max-w-md" showCloseButton>
          <div className="flex flex-col gap-3 p-5" data-sheet-keys>
            <DialogTitle>键盘快捷键</DialogTitle>
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-ui-sm">
              {SHORTCUTS.map(([what, keys]) => (
                <div key={what} className="contents">
                  <dt className="text-muted-foreground">{what}</dt>
                  <dd className="text-right tabular-nums">{keys}</dd>
                </div>
              ))}
            </dl>
          </div>
        </DialogPopup>
      </Dialog>
      {formatAsk !== null ? (
        <Dialog open onOpenChange={(open) => !open && setFormatAsk(null)}>
          <DialogPopup className="max-w-sm" showCloseButton>
            <form
              className="flex flex-col gap-3 p-5"
              data-sheet-format-ask
              onSubmit={(event) => {
                event.preventDefault();
                const words = formatAsk.trim();
                if (!words) return;
                setFormatAsk(null);
                ask(
                  "change",
                  `把这些单元格的数字格式设成：${words}。用 formatCells 的 numberFormat 写一个格式（读 moss_sheet_guide 的 formats 主题），不要改单元格里的值。`,
                );
              }}
            >
              <DialogTitle>描述一个格式</DialogTitle>
              <Input
                size="sm"
                autoFocus
                aria-label="想要的格式"
                placeholder="比如：显示成万元，保留一位小数"
                value={formatAsk}
                onChange={(event) => setFormatAsk(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setFormatAsk(null)}>
                  取消
                </Button>
                <Button type="submit" disabled={!formatAsk.trim()}>
                  交给 Moss
                </Button>
              </div>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {readerDialog
        ? (() => {
            const shownAt = shownIn(activeSheet);
            const rows = columnTexts(shownAt, readerDialog);
            const values = distinctTexts(rows);
            const heading = shownAt(readerDialog.block.r0, readerDialog.column);
            const same = activeReaderFilter && activeReaderFilter.column === readerDialog.column;
            return (
              <SheetReaderFilterDialog
                columnLabel={`${columnName(readerDialog.column)} 列${heading ? `（${heading}）` : ""}`}
                values={values}
                keep={same && activeReaderFilter ? activeReaderFilter.keep : values}
                onCancel={() => setReaderDialog(null)}
                onClear={() => {
                  setReaderDialog(null);
                  setReaderFilter(activeSheet.id, null);
                }}
                onApply={(keep) => {
                  setReaderDialog(null);
                  setReaderFilter(
                    activeSheet.id,
                    keep.length === values.length
                      ? null
                      : {
                          sheetId: activeSheet.id,
                          block: readerDialog.block,
                          column: readerDialog.column,
                          keep,
                        },
                  );
                }}
              />
            );
          })()
        : null}
      {localeDialog ? (
        <SheetLocaleDialog
          locale={settings.current.locale ?? "zh-CN"}
          timeZone={settings.current.timeZone ?? null}
          readOnly={readOnly}
          onCancel={() => setLocaleDialog(false)}
          onApply={(nextLocale, nextZone) => {
            setLocaleDialog(false);
            const next = edit([
              { kind: "setLocale", locale: nextLocale },
              { kind: "setTimeZone", timeZone: nextZone },
            ]);
            if (!next) return;
            settings.current = {
              ...(next.locale ? { locale: next.locale } : {}),
              ...(next.timeZone ? { timeZone: next.timeZone } : {}),
            };
            setSheetFormulaTimeZone(next.timeZone);
            // TODAY / NOW and every number's look follow: the sheet opens again with them.
            props.onReplace({
              ...next,
              sheets: next.sheets.map((s) => ({ ...s, ...(layers.current.get(s.id) ?? {}) })),
            });
          }}
        />
      ) : null}
      {selection ? (
        // The cells around the selection as a table a screen reader can browse: the grid itself
        // is a canvas.
        <table
          className="sr-only"
          aria-label={`${activeSheet.name}：所选单元格附近`}
          data-sheet-reader-table
        >
          <thead>
            <tr>
              <th scope="col">行</th>
              {Array.from({ length: 10 }, (_, j) => Math.max(0, selection.col - 4) + j).map((c) => (
                <th key={c} scope="col">
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 20 }, (_, i) => Math.max(0, selection.row - 9) + i).map((r) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: 10 }, (_, j) => Math.max(0, selection.col - 4) + j).map(
                  (c) => {
                    const cell = byKey.get(cellKey(r, c));
                    const shown =
                      cell?.v === null || cell?.v === undefined
                        ? ""
                        : typeof cell.v === "number" && cell.s?.format
                          ? formatSheetNumber(cell.s.format, cell.v)
                          : String(cell.v);
                    return (
                      <td key={c}>
                        {shown}
                        {cell?.f ? `（公式 ${cell.f}）` : ""}
                        {r === selection.row && c === selection.col ? "（选中）" : ""}
                      </td>
                    );
                  },
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only" data-sheet-announcer>
        {announcement}
      </div>
      <DropdownDialog
        open={dropdownDialog}
        onOpenChange={setDropdownDialog}
        onMake={(labels) => makeDropdown(labels)}
      />
      {sizeDialog ? (
        <SizeDialog
          axis={sizeDialog}
          current={
            selection
              ? sizeDialog === "column"
                ? (readEngine(
                    (e) =>
                      e.getColumnWidth([selection.c0], { id: activeRef.current })[selection.c0],
                  ) ?? SHEET_GRID_METRICS.columnWidth)
                : (readEngine(
                    (e) => e.getRowHeight([selection.r0], { id: activeRef.current })[selection.r0],
                  ) ?? SHEET_GRID_METRICS.rowHeight)
              : SHEET_GRID_METRICS.columnWidth
          }
          onCancel={() => setSizeDialog(null)}
          onApply={(pixels) => {
            const s = selectionRef.current;
            const e = api();
            setSizeDialog(null);
            if (!s || !e || readOnly) return;
            const sizes: Record<string, number> = {};
            if (sizeDialog === "column") {
              for (let c = s.c0; c <= s.c1; c++) sizes[c] = pixels;
              e.setColumnWidth(sizes, { id: activeRef.current });
            } else {
              for (let r = s.r0; r <= s.r1; r++) sizes[r] = pixels;
              e.setRowHeight(sizes, { id: activeRef.current });
            }
          }}
        />
      ) : null}
    </div>
  );

  function copyCells(cut: boolean) {
    withSelection((s, e) => {
      const rows = e.getCellsByRange(rangeOf(s), { id: activeRef.current });
      clipboard.current = { rows };
      const text = rows
        .map((row) => row.map((cell) => (cell?.m ?? cell?.v ?? "").toString()).join("\t"))
        .join("\n");
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      if (cut)
        e.setCellValuesByRange(
          rows.map((row) => row.map(() => null)),
          rangeOf(s),
          { id: activeRef.current },
        );
    });
  }
  function pasteCells(valuesOnly: boolean) {
    withSelection((s, e) => {
      const rows = clipboard.current?.rows;
      if (!rows?.length) return;
      const data = rows.map((row) =>
        row.map((cell) => {
          const c = cell as { v?: unknown; m?: unknown; ct?: unknown } | null;
          if (!c) return null;
          return valuesOnly ? { v: c.v, m: c.m, ct: c.ct } : c;
        }),
      );
      e.setCellValuesByRange(
        data,
        { row: [s.r0, s.r0 + data.length - 1], column: [s.c0, s.c0 + (data[0]?.length ?? 1) - 1] },
        { id: activeRef.current },
      );
    });
  }
}

function refusalText(cause: SheetEditRefusal): string {
  switch (cause.refusal) {
    case "notAnOption":
      return `${cause.address ?? "有的单元格"}里的内容不是下拉菜单的选项。`;
    case "wouldSplitMerge":
    case "insideAMergedRange":
      return "选区里有合并的单元格，先取消合并。";
    case "mergeHasContent":
      return "合并区域里不止一个单元格有内容。";
    case "sheetNameTaken":
      return "已经有同名的工作表。";
    case "onlySheet":
      return "这是唯一的工作表，不能删除。";
    case "outsideTheSheet":
      return "选区超出了工作表。";
    default:
      return "这次修改没有完成。";
  }
}

/** 设置列宽 / 设置行高: one number in pixels for every selected column or row. */
function SizeDialog(props: {
  axis: "column" | "row";
  current: number;
  onApply: (pixels: number) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(String(Math.round(props.current)));
  const pixels = Number(text);
  const max = props.axis === "column" ? 2000 : 800;
  const ok = Number.isInteger(pixels) && pixels >= 10 && pixels <= max;
  const label = props.axis === "column" ? "列宽" : "行高";
  return (
    <Dialog open onOpenChange={(open) => !open && props.onCancel()}>
      <DialogPopup className="max-w-xs" showCloseButton>
        <form
          className="flex flex-col gap-3 p-5"
          data-sheet-size-dialog
          onSubmit={(event) => {
            event.preventDefault();
            if (ok) props.onApply(pixels);
          }}
        >
          <DialogTitle>设置{label}</DialogTitle>
          <label className="flex items-center gap-2 text-ui">
            <Input
              size="sm"
              autoFocus
              inputMode="numeric"
              aria-label={`${label}（像素）`}
              aria-invalid={!ok}
              value={text}
              className="w-24"
              onChange={(event) => setText(event.target.value.replace(/[^0-9]/gu, ""))}
              onKeyDown={(event) => event.stopPropagation()}
            />
            像素
          </label>
          {ok ? null : (
            <p className="text-ui-sm text-destructive">请输入 10 到 {max} 之间的整数。</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={!ok}>
              确定
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DropdownDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMake: (labels: string[]) => void;
}) {
  const [text, setText] = useState("待办\n进行中\n完成");
  const labels = [
    ...new Set(
      text
        .split(/\n|,|，/u)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-sm" showCloseButton>
        <form
          className="flex flex-col gap-3 p-5"
          data-sheet-dropdown-dialog
          onSubmit={(event) => {
            event.preventDefault();
            if (!labels.length) return;
            props.onMake(labels);
            props.onOpenChange(false);
          }}
        >
          <DialogTitle>添加下拉菜单</DialogTitle>
          <p className="text-ui-sm text-muted-foreground">
            每行一个选项。所选单元格和下面 10 行都会用这个下拉菜单。
          </p>
          <textarea
            aria-label="下拉菜单选项"
            value={text}
            rows={5}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            className="rounded-control border border-input bg-background px-2.5 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!labels.length}>
              添加
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
