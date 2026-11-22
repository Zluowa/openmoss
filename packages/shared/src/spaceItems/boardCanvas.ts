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

export const BOARD_LIMITS = { shapes: 5_000, opsPerEdit: 200, text: 2_000 } as const;
export const BOARD_PAGE_ID = "page:page";

export const BOARD_OP_KINDS = [
  "addNote",
  "addFrame",
  "addText",
  "addShape",
  "connect",
  "update",
  "delete",
  "arrange",
  "timeline",
] as const;
export type BoardOpKind = (typeof BOARD_OP_KINDS)[number];

/** A shape reference: an existing shape id or a `key` assigned earlier in the same op list. */
type Ref = string;

export type BoardOp =
  | {
      readonly op: "addNote";
      readonly key?: string;
      readonly text: string;
      readonly color?: BoardColor;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "addFrame";
      readonly key?: string;
      readonly name: string;
      readonly color?: BoardColor;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    }
  | {
      readonly op: "addText";
      readonly key?: string;
      readonly text: string;
      readonly size?: "s" | "m" | "l" | "xl";
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "addShape";
      readonly key?: string;
      readonly geo: BoardGeo;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly frame?: Ref;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    }
  | {
      readonly op: "connect";
      readonly key?: string;
      readonly from: Ref;
      readonly to: Ref;
      readonly text?: string;
      readonly color?: BoardColor;
    }
  | {
      readonly op: "update";
      readonly id: Ref;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly x?: number;
      readonly y?: number;
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
    };

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
    case "connect":
      return typeof value.from === "string" && typeof value.to === "string";
    case "update":
      return typeof value.id === "string";
    case "delete":
      return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
    case "arrange":
      return Array.isArray(value.groups);
    case "timeline":
      return Array.isArray(value.items);
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
          name: "白板",
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
    .sort((a, b) => {
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
    return {
      id: shape.id,
      type: shapeType,
      ...(text ? { text: text.slice(0, 500) } : {}),
      ...(color ? { color } : {}),
      x: Math.round(point.x),
      y: Math.round(point.y),
      w: Math.round(size.w),
      h: Math.round(size.h),
      ...(parent?.typeName === "shape" && parent.type === "frame" ? { frame: parent.id } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
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
  return lines.length > 0 ? lines.join("\n") : `白板 ${title}`.trim();
}
