// FILE: boardCanvas.ts
// Purpose: Pure TypeScript Whiteboard (白板) canvas schema, op types, shape summary, and
//          lightweight snapshot helpers shared across Moss web and server without requiring
//          `@tldraw/*` packages inside the Moss workspace.
// Layer: Shared model (pure TS, zero DOM or tldraw runtime imports).
// Why: Hosted Canvas holds the live whiteboard runtime in the canvas bundle; Moss server and shared
//      contracts validate ops, summarize shapes, and sync board rooms using portable types.

export const BOARD_COLORS = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export const BOARD_GEOS = [
  "rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "hexagon",
  "star",
  "cloud",
  "arrow-right",
  "check-box",
] as const;
export type BoardGeo = (typeof BOARD_GEOS)[number];

export const BOARD_ARROW_DASHES = ["solid", "dashed", "dotted"] as const;
export type BoardArrowDash = (typeof BOARD_ARROW_DASHES)[number];

export const BOARD_ARROWHEADS = ["none", "arrow", "dot"] as const;
export type BoardArrowhead = (typeof BOARD_ARROWHEADS)[number];

export const BOARD_PEN_HEADS = ["none", "arrow"] as const;
export type BoardPenHead = (typeof BOARD_PEN_HEADS)[number];

export const BOARD_LIMITS = { shapes: 5_000, opsPerEdit: 200, text: 2_000 } as const;
export const BOARD_PAGE_ID = "page:page";

export const BOARD_OP_KINDS = [
  "addNote",
  "addFrame",
  "addText",
  "addShape",
  "addDrawing",
  "addHtml",
  "addTable",
  "addPen",
  "connect",
  "update",
  "delete",
  "arrange",
  "timeline",
  "undo",
  "redo",
] as const;
export type BoardOpKind = (typeof BOARD_OP_KINDS)[number];

/** A shape reference: an existing shape id or a `key` assigned earlier in the same op list. */
type Ref = string;

/** Optional placement relative to an existing shape or earlier key in the same ask. */
export interface BoardRelativePlace {
  readonly rightOf?: Ref;
  readonly leftOf?: Ref;
  readonly below?: Ref;
  readonly above?: Ref;
  readonly gap?: number;
  readonly align?: "start" | "center" | "end";
}

export type BoardOp =
  | ({
      readonly op: "addNote";
      readonly key?: string;
      readonly text: string;
      readonly color?: BoardColor;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addFrame";
      readonly key?: string;
      readonly name: string;
      readonly color?: BoardColor;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addText";
      readonly key?: string;
      readonly text: string;
      readonly size?: "s" | "m" | "l" | "xl";
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addShape";
      readonly key?: string;
      readonly geo: BoardGeo;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly hollow?: boolean;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addDrawing";
      readonly key?: string;
      readonly svg: string;
      readonly alt?: string;
      readonly look?: "marker" | "clean";
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addHtml";
      readonly key?: string;
      readonly title?: string;
      readonly html: string;
      readonly bg?: string;
      readonly radius?: number;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    } & BoardRelativePlace)
  | ({
      readonly op: "addTable";
      readonly key?: string;
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly color?: BoardColor;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
    } & BoardRelativePlace)
  | {
      readonly op: "addPen";
      readonly key?: string;
      readonly points: readonly (readonly [number, number])[];
      readonly color?: BoardColor;
      readonly width?: number;
      readonly head?: BoardPenHead;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "connect";
      readonly key?: string;
      readonly from: Ref;
      readonly to: Ref;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly dash?: BoardArrowDash;
      readonly arrowheadStart?: BoardArrowhead;
      readonly arrowheadEnd?: BoardArrowhead;
      readonly bend?: number;
    }
  | {
      readonly op: "update";
      readonly id: Ref;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly hollow?: boolean;
      readonly frame?: Ref | null;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
      readonly svg?: string;
      readonly look?: "marker" | "clean";
      readonly html?: string;
      readonly title?: string;
      readonly bg?: string;
      readonly radius?: number;
    }
  | { readonly op: "delete"; readonly ids: readonly Ref[] }
  | {
      readonly op: "arrange";
      readonly groups: readonly {
        readonly name: string;
        readonly key?: string;
        readonly color?: BoardColor;
        readonly notes: readonly Ref[];
      }[];
    }
  | {
      readonly op: "timeline";
      readonly key?: string;
      readonly name?: string;
      readonly items: readonly {
        readonly text: string;
        readonly date: string;
        readonly owner?: string;
        readonly color?: BoardColor;
      }[];
    }
  | { readonly op: "undo"; readonly steps?: number }
  | { readonly op: "redo"; readonly steps?: number };

export interface BoardShapeSummary {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly color?: string;
  /** Page coordinates of the top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The frame this shape sits in. */
  readonly frame?: string;
  /** For a connector: the shapes it joins. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** 1-based index matching an attached vision image in the same ask. */
  readonly picture?: number;
}

export interface BoardCanvasRecord {
  readonly id: string;
  readonly typeName: string;
  readonly type?: string;
  readonly parentId?: string;
  readonly x?: number;
  readonly y?: number;
  readonly index?: string;
  readonly props?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface BoardCanvasSnapshot {
  readonly store: Readonly<Record<string, BoardCanvasRecord>>;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface BoardCanvasDocument {
  readonly version: 2;
  readonly snapshot: BoardCanvasSnapshot;
}

const NOTE_SIZE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoardColor(value: unknown): value is BoardColor {
  return typeof value === "string" && (BOARD_COLORS as readonly string[]).includes(value);
}

export function isBoardGeo(value: unknown): value is BoardGeo {
  return typeof value === "string" && (BOARD_GEOS as readonly string[]).includes(value);
}

function isBoardArrowDash(value: unknown): value is BoardArrowDash {
  return typeof value === "string" && (BOARD_ARROW_DASHES as readonly string[]).includes(value);
}

function isBoardArrowhead(value: unknown): value is BoardArrowhead {
  return typeof value === "string" && (BOARD_ARROWHEADS as readonly string[]).includes(value);
}

function isBoardPenHead(value: unknown): value is BoardPenHead {
  return typeof value === "string" && (BOARD_PEN_HEADS as readonly string[]).includes(value);
}

export function isBoardOp(value: unknown): value is BoardOp {
  if (!isRecord(value) || typeof value.op !== "string") return false;
  if (!(BOARD_OP_KINDS as readonly string[]).includes(value.op)) return false;
  switch (value.op) {
    case "addNote":
    case "addText":
      return typeof value.text === "string";
    case "addFrame":
      return typeof value.name === "string";
    case "addShape":
      return isBoardGeo(value.geo);
    case "addDrawing":
      return typeof value.svg === "string" && value.svg.trim().length > 0;
    case "addHtml":
      return (
        typeof value.html === "string" &&
        value.html.trim().length > 0 &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.bg === undefined || typeof value.bg === "string") &&
        (value.radius === undefined || isFiniteNumber(value.radius))
      );
    case "addTable":
      return (
        Array.isArray(value.headers) &&
        value.headers.length >= 1 &&
        value.headers.length <= 20 &&
        value.headers.every((cell) => typeof cell === "string") &&
        Array.isArray(value.rows) &&
        value.rows.length <= 100 &&
        value.rows.every(
          (row) =>
            Array.isArray(row) && row.length <= 20 && row.every((cell) => typeof cell === "string"),
        )
      );
    case "addPen":
      return (
        Array.isArray(value.points) &&
        value.points.length >= 2 &&
        value.points.length <= 500 &&
        value.points.every(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            isFiniteNumber(point[0]) &&
            isFiniteNumber(point[1]),
        ) &&
        (value.width === undefined || (isFiniteNumber(value.width) && value.width > 0)) &&
        (value.head === undefined || isBoardPenHead(value.head))
      );
    case "connect":
      return (
        typeof value.from === "string" &&
        typeof value.to === "string" &&
        (value.dash === undefined || isBoardArrowDash(value.dash)) &&
        (value.arrowheadStart === undefined || isBoardArrowhead(value.arrowheadStart)) &&
        (value.arrowheadEnd === undefined || isBoardArrowhead(value.arrowheadEnd)) &&
        (value.bend === undefined || isFiniteNumber(value.bend))
      );
    case "update":
      return (
        typeof value.id === "string" &&
        (value.hollow === undefined || typeof value.hollow === "boolean") &&
        (value.frame === undefined || value.frame === null || typeof value.frame === "string")
      );
    case "delete":
      return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
    case "arrange":
      return Array.isArray(value.groups);
    case "timeline":
      return Array.isArray(value.items);
    case "undo":
    case "redo":
      return (
        value.steps === undefined ||
        (isFiniteNumber(value.steps) &&
          Number.isInteger(value.steps) &&
          value.steps >= 1 &&
          value.steps <= 20)
      );
    default:
      return false;
  }
}

export function createBoardCanvasDocument(): BoardCanvasDocument {
  return {
    version: 2,
    snapshot: {
      store: {
        "document:document": {
          id: "document:document",
          typeName: "document",
        },
        [BOARD_PAGE_ID]: {
          id: BOARD_PAGE_ID,
          typeName: "page",
          name: "画布",
          index: "a1",
          meta: {},
        },
      },
      schema: { schemaVersion: 2, sequences: {} },
    },
  };
}

export function parseBoardCanvasDocument(input: string | unknown): BoardCanvasDocument {
  const parsed = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isRecord(parsed)) throw new Error("Invalid board: expected an object");
  if (parsed.version === 1) return createBoardCanvasDocument();
  if (parsed.version !== 2) throw new Error("Invalid board: version must be 2");
  if (!isRecord(parsed.snapshot) || !isRecord(parsed.snapshot.store)) {
    throw new Error("Invalid board: snapshot.store is missing");
  }
  const storeEntries = Object.entries(parsed.snapshot.store);
  let shapeCount = 0;
  const cleanStore: Record<string, BoardCanvasRecord> = {};
  for (const [key, rawRecord] of storeEntries) {
    if (!isRecord(rawRecord) || typeof rawRecord.typeName !== "string") {
      throw new Error(`Invalid board: record ${key} is malformed`);
    }
    const id = typeof rawRecord.id === "string" && rawRecord.id ? rawRecord.id : key;
    if (rawRecord.typeName === "shape") {
      shapeCount += 1;
      if (shapeCount > BOARD_LIMITS.shapes) {
        throw new Error(`Invalid board: a board holds at most ${BOARD_LIMITS.shapes} shapes`);
      }
    }
    cleanStore[id] = { ...rawRecord, id } as BoardCanvasRecord;
  }
  return {
    version: 2,
    snapshot: {
      store: cleanStore,
      ...(isRecord(parsed.snapshot.schema) ? { schema: parsed.snapshot.schema } : {}),
    },
  };
}

function extractRichPlainText(node: unknown, budget = { left: 4_000 }): string {
  if (budget.left <= 0 || !isRecord(node)) return "";
  budget.left -= 1;
  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content)
    ? node.content.map((child) => extractRichPlainText(child, budget))
    : [];
  return own + children.join(node.type === "doc" ? "\n" : "");
}

function readShapeText(shape: BoardCanvasRecord): string {
  const props = isRecord(shape.props) ? shape.props : {};
  if (typeof props.name === "string" && shape.type === "frame") return props.name;
  if (typeof props.title === "string" && shape.type === "moss-html") return props.title;
  if (props.richText !== undefined) return extractRichPlainText(props.richText).trim();
  return typeof props.text === "string" ? props.text : "";
}

function readShapeSize(shape: BoardCanvasRecord): { w: number; h: number } {
  const props = isRecord(shape.props) ? shape.props : {};
  const scale = isFiniteNumber(props.scale) ? props.scale : 1;
  const growY = isFiniteNumber(props.growY) ? props.growY : 0;
  if (shape.type === "note") {
    return { w: NOTE_SIZE * scale, h: (NOTE_SIZE + growY) * scale };
  }
  if (shape.type === "text") {
    return { w: (isFiniteNumber(props.w) ? props.w : 160) * scale, h: 40 * scale };
  }
  return {
    w: (isFiniteNumber(props.w) ? props.w : 100) * scale,
    h: ((isFiniteNumber(props.h) ? props.h : 100) + growY) * scale,
  };
}

function resolvePagePoint(
  store: Readonly<Record<string, BoardCanvasRecord>>,
  shape: BoardCanvasRecord,
): { x: number; y: number } {
  let x = isFiniteNumber(shape.x) ? shape.x : 0;
  let y = isFiniteNumber(shape.y) ? shape.y : 0;
  let parentId = typeof shape.parentId === "string" ? shape.parentId : undefined;
  let guard = 0;
  while (parentId && guard < 32) {
    guard += 1;
    const parent = store[parentId];
    if (!parent || parent.typeName !== "shape") break;
    x += isFiniteNumber(parent.x) ? parent.x : 0;
    y += isFiniteNumber(parent.y) ? parent.y : 0;
    parentId = typeof parent.parentId === "string" ? parent.parentId : undefined;
  }
  return { x, y };
}

export function summarizeBoardCanvas(
  board: BoardCanvasDocument,
  limit = 400,
): { shapes: BoardShapeSummary[]; truncated: boolean } {
  const store = board.snapshot.store;
  const allRecords = Object.values(store);
  const bindings = allRecords.filter(
    (record) => record.typeName === "binding" && record.type === "arrow",
  );
  const allShapes = allRecords
    .filter((record) => record.typeName === "shape")
    .toSorted((a, b) => {
      const ia = typeof a.index === "string" ? a.index : "";
      const ib = typeof b.index === "string" ? b.index : "";
      return ia < ib ? -1 : ia > ib ? 1 : a.id.localeCompare(b.id);
    });
  const shapes = allShapes.slice(0, limit).map((shape): BoardShapeSummary => {
    const point = resolvePagePoint(store, shape);
    const size = readShapeSize(shape);
    const text = readShapeText(shape);
    const parent = typeof shape.parentId === "string" ? store[shape.parentId] : undefined;
    const props = isRecord(shape.props) ? shape.props : {};
    const ends = bindings.filter((binding) => binding.fromId === shape.id);
    const terminalTarget = (terminal: "start" | "end") => {
      const hit = ends.find(
        (binding) => isRecord(binding.props) && binding.props.terminal === terminal,
      );
      return typeof hit?.toId === "string" ? hit.toId : undefined;
    };
    const color = typeof props.color === "string" ? props.color : undefined;
    const shapeType =
      shape.type === "geo" && typeof props.geo === "string"
        ? `geo:${props.geo}`
        : (shape.type ?? "unknown");
    const from = shape.type === "arrow" ? terminalTarget("start") : undefined;
    const to = shape.type === "arrow" ? terminalTarget("end") : undefined;
    const summary: {
      id: string;
      type: string;
      text?: string;
      color?: string;
      x: number;
      y: number;
      w: number;
      h: number;
      frame?: string;
      from?: string;
      to?: string;
    } = {
      id: shape.id,
      type: shapeType,
      x: Math.round(point.x),
      y: Math.round(point.y),
      w: Math.round(size.w),
      h: Math.round(size.h),
    };
    if (text) summary.text = text.slice(0, 500);
    if (color) summary.color = color;
    if (parent?.typeName === "shape" && parent.type === "frame") summary.frame = parent.id;
    if (from) summary.from = from;
    if (to) summary.to = to;
    return summary;
  });
  return { shapes, truncated: allShapes.length > limit };
}

export function projectBoardCanvas(board: BoardCanvasDocument, title = ""): string {
  const { shapes } = summarizeBoardCanvas(board, 2_000);
  const frames = shapes.filter((shape) => shape.type === "frame");
  const lines: string[] = [];
  for (const frame of frames) {
    lines.push(`## ${frame.text || "框架"}`);
    for (const shape of shapes) {
      if (shape.frame === frame.id && shape.text) {
        lines.push(`- ${shape.text.replace(/\s+/gu, " ")}`);
      }
    }
  }
  const loose = shapes.filter((shape) => !shape.frame && shape.type !== "frame" && shape.text);
  if (loose.length > 0) {
    if (frames.length > 0) lines.push("## 其他");
    for (const shape of loose) {
      lines.push(`- ${shape.text!.replace(/\s+/gu, " ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : `画布 ${title}`.trim();
}
