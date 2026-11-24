// FILE: mossCanvasMutate.ts
// Purpose: Server-side Whiteboard/Canvas mutation engine for AI MCP (`moss_canvas_mutate`).
//          Mutates conversation Canvas `.tldr` snapshots in place via hosted Canvas storage
//          with exact tldraw@5.3.2 schema, richText, binding, and fractional-index invariants.
// Layer: Server storage + Canvas snapshot domain logic (zero sync FS calls).

import { randomUUID } from "node:crypto";
import {
  BOARD_PAGE_ID,
  isBoardColor,
  isBoardGeo,
  type BoardColor,
  type BoardGeo,
} from "@moss/shared/spaceItems/boardCanvas";
import { mossCanvasStorageExists, mossCanvasStorageFor } from "./mossCanvasStorage";
import { summarizeMossCanvasSnapshot, type MossCanvasShapeSummary } from "./mossCanvasSummary";
import type { MossCanvasWorkspace } from "./mossCanvasWorkspace";
import { MossMediaJobsError, type MossMediaIdentity } from "./mossMediaJobsService";

export const MOSS_CANVAS_MUTATE_OP_KINDS = [
  "addFrame",
  "addNote",
  "addText",
  "addShape",
  "connect",
  "update",
  "delete",
  "clear",
] as const;

export type MossCanvasMutateOpKind = (typeof MOSS_CANVAS_MUTATE_OP_KINDS)[number];

export const MOSS_CANVAS_TEXT_SIZES = ["s", "m", "l", "xl"] as const;
export type MossCanvasTextSize = (typeof MOSS_CANVAS_TEXT_SIZES)[number];

export const MOSS_CANVAS_MUTATE_LIMITS = {
  maxOpsPerCall: 100,
  maxTextLength: 2_000,
  maxFrameNameLength: 200,
  maxShapes: 2_000,
  maxCoord: 1_000_000,
  maxSize: 20_000,
} as const;

export type MossCanvasMutateOp =
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
      readonly op: "addNote";
      readonly key?: string;
      readonly text: string;
      readonly color?: BoardColor;
      readonly frame?: string;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "addText";
      readonly key?: string;
      readonly text: string;
      readonly size?: MossCanvasTextSize;
      readonly color?: BoardColor;
      readonly frame?: string;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "addShape";
      readonly key?: string;
      readonly geo: BoardGeo;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly frame?: string;
      readonly x?: number;
      readonly y?: number;
      readonly w?: number;
      readonly h?: number;
    }
  | {
      readonly op: "connect";
      readonly key?: string;
      readonly from: string;
      readonly to: string;
      readonly text?: string;
      readonly color?: BoardColor;
    }
  | {
      readonly op: "update";
      readonly id: string;
      readonly text?: string;
      readonly color?: BoardColor;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly op: "delete";
      readonly ids: readonly string[];
    }
  | {
      readonly op: "clear";
    };

/** Exact `tldraw@5.3.2` + `hoola-card` schema captured from the pinned built Canvas bundle. */
export const MOSS_CANVAS_TLDRAW_SCHEMA = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.store": 5,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 26,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 6,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.user": 1,
    "com.tldraw.asset.image": 6,
    "com.tldraw.asset.video": 5,
    "com.tldraw.asset.bookmark": 2,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.text": 4,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 5,
    "com.tldraw.shape.geo": 12,
    "com.tldraw.shape.note": 13,
    "com.tldraw.shape.line": 5,
    "com.tldraw.shape.frame": 1,
    "com.tldraw.shape.arrow": 8,
    "com.tldraw.shape.highlight": 4,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.image": 5,
    "com.tldraw.shape.video": 4,
    "com.tldraw.shape.hoola-card": 0,
    "com.tldraw.binding.arrow": 1,
    "com.tldraw.comment-thread": 3,
    "com.tldraw.comment": 1,
    "com.tldraw.comment-reaction": 1,
  },
} as const;

export interface MossCanvasMutateSnapshotResult {
  readonly snapshot: Record<string, unknown>;
  readonly created: Readonly<Record<string, string>>;
  readonly deletedCount: number;
  readonly shapeCounts: Readonly<Record<string, number>>;
  readonly shapes: readonly MossCanvasShapeSummary[];
  readonly truncated: boolean;
}

export interface MossCanvasMutateResult {
  readonly revision: string;
  readonly created: Readonly<Record<string, string>>;
  readonly deletedCount: number;
  readonly shapeCounts: Readonly<Record<string, number>>;
  readonly shapes: readonly MossCanvasShapeSummary[];
  readonly truncated: boolean;
}

const NOTE_SIZE = 200;
const SHAPE_DEFAULT_W = 200;
const SHAPE_DEFAULT_H = 120;
const TEXT_DEFAULT_W = 300;
const TEXT_DEFAULT_H = 40;
const GAP = 40;
const FRAME_HEADER_OFFSET = 20;
const ROOT_GRID_WRAP_WIDTH = 1_120;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteCoord(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MOSS_CANVAS_MUTATE_LIMITS.maxCoord
  );
}

function isFinitePositiveSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MOSS_CANVAS_MUTATE_LIMITS.maxSize
  );
}

function invalidOp(): never {
  throw new MossMediaJobsError("invalid_request");
}

function checkText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) invalidOp();
  return value;
}

function checkKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) invalidOp();
  return value;
}

function checkColor(value: unknown): BoardColor | undefined {
  if (value === undefined) return undefined;
  if (!isBoardColor(value)) invalidOp();
  return value;
}

function checkOptionalPoint(obj: Record<string, unknown>): { x?: number; y?: number } {
  if ((obj.x === undefined) !== (obj.y === undefined)) invalidOp();
  if (obj.x === undefined) return {};
  if (!isFiniteCoord(obj.x) || !isFiniteCoord(obj.y)) invalidOp();
  return { x: obj.x, y: obj.y };
}

function checkAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) invalidOp();
  }
}

export function parseMossCanvasMutateOps(raw: unknown): MossCanvasMutateOp[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MOSS_CANVAS_MUTATE_LIMITS.maxOpsPerCall
  ) {
    invalidOp();
  }
  const seenKeys = new Set<string>();
  const registerKey = (key: string | undefined) => {
    if (key === undefined) return;
    if (seenKeys.has(key)) invalidOp();
    seenKeys.add(key);
  };

  return raw.map((item): MossCanvasMutateOp => {
    if (!isRecord(item) || typeof item.op !== "string") invalidOp();
    switch (item.op) {
      case "addFrame": {
        checkAllowedKeys(item, ["op", "key", "name", "color", "x", "y", "w", "h"]);
        const key = checkKey(item.key);
        registerKey(key);
        const name = checkText(item.name, MOSS_CANVAS_MUTATE_LIMITS.maxFrameNameLength);
        const color = checkColor(item.color);
        const pt = checkOptionalPoint(item);
        if (item.w !== undefined && !isFinitePositiveSize(item.w)) invalidOp();
        if (item.h !== undefined && !isFinitePositiveSize(item.h)) invalidOp();
        return {
          op: "addFrame",
          name,
          ...(key !== undefined ? { key } : {}),
          ...(color !== undefined ? { color } : {}),
          ...pt,
          ...(item.w !== undefined ? { w: item.w as number } : {}),
          ...(item.h !== undefined ? { h: item.h as number } : {}),
        };
      }
      case "addNote": {
        checkAllowedKeys(item, ["op", "key", "text", "color", "frame", "x", "y"]);
        const key = checkKey(item.key);
        registerKey(key);
        const text = checkText(item.text, MOSS_CANVAS_MUTATE_LIMITS.maxTextLength);
        const color = checkColor(item.color);
        if (item.frame !== undefined && (typeof item.frame !== "string" || !item.frame))
          invalidOp();
        const pt = checkOptionalPoint(item);
        return {
          op: "addNote",
          text,
          ...(key !== undefined ? { key } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(item.frame !== undefined ? { frame: item.frame as string } : {}),
          ...pt,
        };
      }
      case "addText": {
        checkAllowedKeys(item, ["op", "key", "text", "size", "color", "frame", "x", "y"]);
        const key = checkKey(item.key);
        registerKey(key);
        const text = checkText(item.text, MOSS_CANVAS_MUTATE_LIMITS.maxTextLength);
        if (
          item.size !== undefined &&
          (typeof item.size !== "string" ||
            !(MOSS_CANVAS_TEXT_SIZES as readonly string[]).includes(item.size))
        ) {
          invalidOp();
        }
        const color = checkColor(item.color);
        if (item.frame !== undefined && (typeof item.frame !== "string" || !item.frame))
          invalidOp();
        const pt = checkOptionalPoint(item);
        return {
          op: "addText",
          text,
          ...(key !== undefined ? { key } : {}),
          ...(item.size !== undefined ? { size: item.size as MossCanvasTextSize } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(item.frame !== undefined ? { frame: item.frame as string } : {}),
          ...pt,
        };
      }
      case "addShape": {
        checkAllowedKeys(item, ["op", "key", "geo", "text", "color", "frame", "x", "y", "w", "h"]);
        const key = checkKey(item.key);
        registerKey(key);
        if (!isBoardGeo(item.geo)) invalidOp();
        const text =
          item.text === undefined
            ? undefined
            : checkText(item.text, MOSS_CANVAS_MUTATE_LIMITS.maxTextLength);
        const color = checkColor(item.color);
        if (item.frame !== undefined && (typeof item.frame !== "string" || !item.frame))
          invalidOp();
        const pt = checkOptionalPoint(item);
        if (item.w !== undefined && !isFinitePositiveSize(item.w)) invalidOp();
        if (item.h !== undefined && !isFinitePositiveSize(item.h)) invalidOp();
        return {
          op: "addShape",
          geo: item.geo,
          ...(key !== undefined ? { key } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(item.frame !== undefined ? { frame: item.frame as string } : {}),
          ...pt,
          ...(item.w !== undefined ? { w: item.w as number } : {}),
          ...(item.h !== undefined ? { h: item.h as number } : {}),
        };
      }
      case "connect": {
        checkAllowedKeys(item, ["op", "key", "from", "to", "text", "color"]);
        const key = checkKey(item.key);
        registerKey(key);
        if (
          typeof item.from !== "string" ||
          !item.from ||
          typeof item.to !== "string" ||
          !item.to
        ) {
          invalidOp();
        }
        const text =
          item.text === undefined
            ? undefined
            : checkText(item.text, MOSS_CANVAS_MUTATE_LIMITS.maxTextLength);
        const color = checkColor(item.color);
        return {
          op: "connect",
          from: item.from,
          to: item.to,
          ...(key !== undefined ? { key } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(color !== undefined ? { color } : {}),
        };
      }
      case "update": {
        checkAllowedKeys(item, ["op", "id", "text", "color", "x", "y"]);
        if (typeof item.id !== "string" || !item.id) invalidOp();
        const text =
          item.text === undefined
            ? undefined
            : checkText(item.text, MOSS_CANVAS_MUTATE_LIMITS.maxTextLength);
        const color = checkColor(item.color);
        if ((item.x === undefined) !== (item.y === undefined)) invalidOp();
        if (item.x !== undefined && (!isFiniteCoord(item.x) || !isFiniteCoord(item.y))) invalidOp();
        return {
          op: "update",
          id: item.id,
          ...(text !== undefined ? { text } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(item.x !== undefined ? { x: item.x as number, y: item.y as number } : {}),
        };
      }
      case "delete": {
        checkAllowedKeys(item, ["op", "ids"]);
        if (
          !Array.isArray(item.ids) ||
          item.ids.length === 0 ||
          item.ids.length > MOSS_CANVAS_MUTATE_LIMITS.maxOpsPerCall ||
          item.ids.some((id) => typeof id !== "string" || !id)
        ) {
          invalidOp();
        }
        return { op: "delete", ids: [...item.ids] };
      }
      case "clear": {
        checkAllowedKeys(item, ["op"]);
        return { op: "clear" };
      }
      default:
        invalidOp();
    }
  });
}

function toRichText(text: string): Record<string, unknown> {
  return {
    type: "doc",
    attrs: { dir: "auto" },
    content: text.split("\n").map((line) =>
      line
        ? {
            type: "paragraph",
            attrs: { dir: "auto" },
            content: [{ type: "text", text: line }],
          }
        : {
            type: "paragraph",
            attrs: { dir: "auto" },
          },
    ),
  };
}

function fractionalIntegerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  return 0;
}

function incrementIntegerPart(key: string): string {
  const digits = key.split("");
  const head = digits[0] ?? "a";
  const tail = digits.slice(1);
  let carry = true;
  for (let i = tail.length - 1; carry && i >= 0; i -= 1) {
    const pos = BASE62.indexOf(tail[i]!);
    if (pos < 0 || pos + 1 >= BASE62.length) {
      tail[i] = BASE62[0]!;
    } else {
      tail[i] = BASE62[pos + 1]!;
      carry = false;
    }
  }
  if (!carry) return `${head}${tail.join("")}`;
  if (head === "Z") return `a${BASE62[0]!}`;
  if (head === "z") return `${head}${tail.join("")}1`;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") tail.push(BASE62[0]!);
  else tail.pop();
  return `${nextHead}${tail.join("")}`;
}

export function nextTldrawIndexAbove(maxExisting: string | null): string {
  if (!maxExisting) return "a1";
  const head = maxExisting[0];
  if (!head) return "a1";
  const intLen = fractionalIntegerLength(head);
  if (intLen >= 2 && maxExisting.length >= intLen) {
    const intPart = maxExisting.slice(0, intLen);
    if ([...intPart.slice(1)].every((ch) => BASE62.includes(ch))) {
      const next = incrementIntegerPart(intPart);
      if (next > maxExisting) return next;
    }
  }
  return "z00000000000000000000000000";
}

export function createEmptyMossCanvasSnapshot(
  title = "画布",
  extras?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...(extras ?? {}),
    document: {
      store: {
        "document:document": {
          id: "document:document",
          typeName: "document",
          gridSize: 10,
          name: "",
          meta: {},
        },
        [BOARD_PAGE_ID]: {
          id: BOARD_PAGE_ID,
          typeName: "page",
          name: title || "画布",
          index: "a1",
          meta: {},
        },
      },
      schema: structuredClone(MOSS_CANVAS_TLDRAW_SCHEMA),
    },
    session: {
      version: 0,
      currentPageId: BOARD_PAGE_ID,
      exportBackground: true,
      isFocusMode: false,
      isDebugMode: false,
      isToolLocked: false,
      isGridMode: true,
      pageStates: [
        {
          pageId: BOARD_PAGE_ID,
          camera: { x: 0, y: 0, z: 0.5 },
          selectedShapeIds: [],
          focusedGroupId: null,
        },
      ],
    },
  };
}

function isTldrawProjectSnapshot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const doc = value.document;
  return isRecord(doc) && isRecord(doc.store) && isRecord(doc.schema);
}

function normalizeSnapshotForMutation(
  existing: unknown,
  title: string,
): {
  snapshot: Record<string, unknown>;
  store: Record<string, Record<string, unknown>>;
  pageId: string;
} {
  const extras: Record<string, unknown> = {};
  if (isRecord(existing) && existing.mossConversationMedia !== undefined) {
    extras.mossConversationMedia = structuredClone(existing.mossConversationMedia);
  }
  const base = isTldrawProjectSnapshot(existing)
    ? (structuredClone(existing) as Record<string, unknown>)
    : createEmptyMossCanvasSnapshot(title, extras);
  if (extras.mossConversationMedia !== undefined && base.mossConversationMedia === undefined) {
    base.mossConversationMedia = extras.mossConversationMedia;
  }
  if (!isRecord(base.session)) {
    base.session = createEmptyMossCanvasSnapshot(title).session;
  }
  const doc = base.document as Record<string, unknown>;
  const store = doc.store as Record<string, Record<string, unknown>>;
  if (!store["document:document"]) {
    store["document:document"] = {
      id: "document:document",
      typeName: "document",
      gridSize: 10,
      name: "",
      meta: {},
    };
  }
  const existingPage = Object.values(store).find((record) => record.typeName === "page");
  let pageId = typeof existingPage?.id === "string" ? existingPage.id : BOARD_PAGE_ID;
  if (!existingPage) {
    pageId = BOARD_PAGE_ID;
    store[pageId] = {
      id: pageId,
      typeName: "page",
      name: title || "画布",
      index: "a1",
      meta: {},
    };
  }
  return { snapshot: base, store, pageId };
}

function shapeSize(shape: Record<string, unknown>): { w: number; h: number } {
  const props = isRecord(shape.props) ? shape.props : {};
  const scale = typeof props.scale === "number" && Number.isFinite(props.scale) ? props.scale : 1;
  const growY = typeof props.growY === "number" && Number.isFinite(props.growY) ? props.growY : 0;
  if (shape.type === "note") {
    return { w: NOTE_SIZE * scale, h: (NOTE_SIZE + growY) * scale };
  }
  if (shape.type === "text") {
    const w = typeof props.w === "number" && Number.isFinite(props.w) ? props.w : 160;
    return { w: w * scale, h: TEXT_DEFAULT_H * scale };
  }
  const w = typeof props.w === "number" && Number.isFinite(props.w) ? props.w : 100;
  const h = typeof props.h === "number" && Number.isFinite(props.h) ? props.h : 100;
  return { w: w * scale, h: (h + growY) * scale };
}

function resolvePagePosition(
  store: Readonly<Record<string, Record<string, unknown>>>,
  shape: Record<string, unknown>,
): { x: number; y: number } {
  let x = typeof shape.x === "number" && Number.isFinite(shape.x) ? shape.x : 0;
  let y = typeof shape.y === "number" && Number.isFinite(shape.y) ? shape.y : 0;
  let parentId = typeof shape.parentId === "string" ? shape.parentId : undefined;
  let guard = 0;
  while (parentId && guard < 32) {
    guard += 1;
    const parent = store[parentId];
    if (!parent || parent.typeName !== "shape") break;
    x += typeof parent.x === "number" && Number.isFinite(parent.x) ? parent.x : 0;
    y += typeof parent.y === "number" && Number.isFinite(parent.y) ? parent.y : 0;
    parentId = typeof parent.parentId === "string" ? parent.parentId : undefined;
  }
  return { x, y };
}

function shapesUnderParent(
  store: Readonly<Record<string, Record<string, unknown>>>,
  parentId: string,
): Record<string, unknown>[] {
  return Object.values(store)
    .filter((record) => record.typeName === "shape" && record.parentId === parentId)
    .sort((a, b) => {
      const ia = typeof a.index === "string" ? a.index : "";
      const ib = typeof b.index === "string" ? b.index : "";
      return ia < ib ? -1 : ia > ib ? 1 : String(a.id).localeCompare(String(b.id));
    });
}

function nextIndexForParent(
  store: Readonly<Record<string, Record<string, unknown>>>,
  parentId: string,
): string {
  let maxIndex: string | null = null;
  for (const shape of shapesUnderParent(store, parentId)) {
    const idx = typeof shape.index === "string" ? shape.index : null;
    if (idx && (!maxIndex || idx > maxIndex)) maxIndex = idx;
  }
  return nextTldrawIndexAbove(maxIndex);
}

function fitFrameToChildren(store: Record<string, Record<string, unknown>>, frameId: string): void {
  const frame = store[frameId];
  if (!frame || frame.typeName !== "shape" || frame.type !== "frame" || !isRecord(frame.props)) {
    return;
  }
  let width = typeof frame.props.w === "number" ? frame.props.w : NOTE_SIZE * 3 + GAP * 4;
  let height = typeof frame.props.h === "number" ? frame.props.h : NOTE_SIZE * 2 + GAP * 3 + 20;
  for (const child of shapesUnderParent(store, frameId)) {
    const size = shapeSize(child);
    const x = typeof child.x === "number" ? child.x : 0;
    const y = typeof child.y === "number" ? child.y : 0;
    width = Math.max(width, x + size.w + GAP);
    height = Math.max(height, y + size.h + GAP);
  }
  if (width !== frame.props.w || height !== frame.props.h) {
    store[frameId] = {
      ...frame,
      props: { ...frame.props, w: width, h: height },
    };
  }
}

export function applyMossCanvasOpsToSnapshot(input: {
  readonly existingSnapshot?: unknown;
  readonly ops: readonly MossCanvasMutateOp[];
  readonly title?: string;
}): MossCanvasMutateSnapshotResult {
  const validatedOps = parseMossCanvasMutateOps(input.ops);
  const title = input.title?.trim() || "画布";
  const { snapshot, store, pageId } = normalizeSnapshotForMutation(input.existingSnapshot, title);
  const keyToShapeId = new Map<string, string>();
  const created: Record<string, string> = {};
  let deletedCount = 0;
  let rootRowAnchorX = 0;
  let rootRowAnchorY = 0;
  let rootCursorX = 0;
  let rootCursorY = 0;
  let rootRowHeight = 0;

  // Initialize cursor below/beside pre-existing shapes at root so appended batches don't overlap.
  const initialRoot = shapesUnderParent(store, pageId).filter((s) => s.type !== "arrow");
  if (initialRoot.length > 0) {
    let minX = Infinity;
    let maxY = -Infinity;
    for (const s of initialRoot) {
      const sx = typeof s.x === "number" ? s.x : 0;
      const sy = typeof s.y === "number" ? s.y : 0;
      const size = shapeSize(s);
      minX = Math.min(minX, sx);
      maxY = Math.max(maxY, sy + size.h);
    }
    rootRowAnchorX = Number.isFinite(minX) ? minX : 0;
    rootRowAnchorY = Number.isFinite(maxY) ? maxY + GAP * 2 : 0;
    rootCursorX = rootRowAnchorX;
    rootCursorY = rootRowAnchorY;
  }

  const resolveShape = (ref: string, expectedType?: string): Record<string, unknown> => {
    const id = keyToShapeId.get(ref) ?? ref;
    const shape = store[id];
    if (!shape || shape.typeName !== "shape") invalidOp();
    if (expectedType && shape.type !== expectedType) invalidOp();
    return shape;
  };

  const countShapes = () =>
    Object.values(store).filter((record) => record.typeName === "shape").length;

  const ensureShapeBudget = () => {
    if (countShapes() >= MOSS_CANVAS_MUTATE_LIMITS.maxShapes) {
      throw new MossMediaJobsError("canvas_shape_limit_exceeded", 400);
    }
  };

  const allocatePosition = (
    frame: Record<string, unknown> | null,
    w: number,
    h: number,
    explicitX?: number,
    explicitY?: number,
  ): { x: number; y: number } => {
    if (explicitX !== undefined && explicitY !== undefined) {
      return { x: explicitX, y: explicitY };
    }
    if (frame) {
      const siblings = shapesUnderParent(store, String(frame.id));
      const frameW =
        isRecord(frame.props) && typeof frame.props.w === "number"
          ? frame.props.w
          : NOTE_SIZE * 3 + GAP * 4;
      const cols = Math.max(1, Math.floor((frameW - GAP) / (Math.max(w, NOTE_SIZE) + GAP)));
      const cellW = Math.max(w, NOTE_SIZE);
      const cellH = Math.max(h, NOTE_SIZE);
      const index = siblings.length;
      const x = GAP + (index % cols) * (cellW + GAP);
      const y = GAP + FRAME_HEADER_OFFSET + Math.floor(index / cols) * (cellH + GAP);
      return { x, y };
    }
    if (rootCursorX > rootRowAnchorX && rootCursorX + w > rootRowAnchorX + ROOT_GRID_WRAP_WIDTH) {
      rootCursorX = rootRowAnchorX;
      rootCursorY += rootRowHeight + GAP;
      rootRowHeight = 0;
    }
    const pos = { x: rootCursorX, y: rootCursorY };
    rootCursorX += w + GAP;
    rootRowHeight = Math.max(rootRowHeight, h);
    return pos;
  };

  const rememberKey = (key: string | undefined, shapeId: string) => {
    if (key !== undefined) {
      keyToShapeId.set(key, shapeId);
      created[key] = shapeId;
    }
  };

  const removeShapesCascade = (refs: readonly string[]) => {
    const toDelete = new Set<string>();
    for (const ref of refs) {
      const target = resolveShape(ref);
      toDelete.add(String(target.id));
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of Object.values(store)) {
        if (
          record.typeName === "shape" &&
          typeof record.parentId === "string" &&
          toDelete.has(record.parentId) &&
          typeof record.id === "string" &&
          !toDelete.has(record.id)
        ) {
          toDelete.add(record.id);
          changed = true;
        }
      }
    }
    const bindingIdsToDelete: string[] = [];
    for (const record of Object.values(store)) {
      if (record.typeName === "binding" && typeof record.id === "string") {
        const fromId = typeof record.fromId === "string" ? record.fromId : "";
        const toId = typeof record.toId === "string" ? record.toId : "";
        if (toDelete.has(fromId) || toDelete.has(toId)) {
          bindingIdsToDelete.push(record.id);
          if (fromId && store[fromId]?.type === "arrow") toDelete.add(fromId);
        }
      }
    }
    let count = 0;
    for (const id of toDelete) {
      if (store[id]?.typeName === "shape") count += 1;
      delete store[id];
    }
    for (const id of bindingIdsToDelete) {
      delete store[id];
    }
    for (const [key, id] of keyToShapeId) {
      if (toDelete.has(id)) keyToShapeId.delete(key);
    }
    deletedCount += count;
  };

  for (const op of validatedOps) {
    switch (op.op) {
      case "clear": {
        let count = 0;
        for (const [id, record] of Object.entries(store)) {
          if (record.typeName === "shape") {
            delete store[id];
            count += 1;
          } else if (record.typeName === "binding") {
            delete store[id];
          }
        }
        keyToShapeId.clear();
        for (const k of Object.keys(created)) delete created[k];
        rootRowAnchorX = 0;
        rootRowAnchorY = 0;
        rootCursorX = 0;
        rootCursorY = 0;
        rootRowHeight = 0;
        deletedCount += count;
        break;
      }
      case "addFrame": {
        ensureShapeBudget();
        const w = op.w ?? 3 * NOTE_SIZE + 4 * GAP;
        const h = op.h ?? 2 * NOTE_SIZE + 3 * GAP + FRAME_HEADER_OFFSET;
        const pos =
          op.x !== undefined && op.y !== undefined
            ? { x: op.x, y: op.y }
            : (() => {
                if (rootCursorX > rootRowAnchorX) {
                  rootCursorX = rootRowAnchorX;
                  rootCursorY += rootRowHeight + GAP;
                  rootRowHeight = 0;
                }
                const p = { x: rootCursorX, y: rootCursorY };
                rootCursorY += h + GAP;
                return p;
              })();
        const id = `shape:${randomUUID().slice(0, 12)}`;
        store[id] = {
          id,
          typeName: "shape",
          type: "frame",
          x: pos.x,
          y: pos.y,
          rotation: 0,
          index: nextIndexForParent(store, pageId),
          parentId: pageId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            w,
            h,
            name: op.name,
            color: op.color ?? "black",
          },
        };
        rememberKey(op.key, id);
        break;
      }
      case "addNote": {
        ensureShapeBudget();
        const frame = op.frame !== undefined ? resolveShape(op.frame, "frame") : null;
        const parentId = frame ? String(frame.id) : pageId;
        const pos = allocatePosition(frame, NOTE_SIZE, NOTE_SIZE, op.x, op.y);
        const id = `shape:${randomUUID().slice(0, 12)}`;
        store[id] = {
          id,
          typeName: "shape",
          type: "note",
          x: pos.x,
          y: pos.y,
          rotation: 0,
          index: nextIndexForParent(store, parentId),
          parentId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            color: op.color ?? "yellow",
            labelColor: "black",
            size: "m",
            font: "sans",
            fontSizeAdjustment: null,
            align: "middle",
            verticalAlign: "middle",
            growY: 0,
            url: "",
            richText: toRichText(op.text),
            scale: 1,
            textLastEditedBy: null,
          },
        };
        rememberKey(op.key, id);
        if (frame) fitFrameToChildren(store, parentId);
        break;
      }
      case "addText": {
        ensureShapeBudget();
        const frame = op.frame !== undefined ? resolveShape(op.frame, "frame") : null;
        const parentId = frame ? String(frame.id) : pageId;
        const pos = allocatePosition(frame, TEXT_DEFAULT_W, TEXT_DEFAULT_H, op.x, op.y);
        const id = `shape:${randomUUID().slice(0, 12)}`;
        store[id] = {
          id,
          typeName: "shape",
          type: "text",
          x: pos.x,
          y: pos.y,
          rotation: 0,
          index: nextIndexForParent(store, parentId),
          parentId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            color: op.color ?? "black",
            size: op.size ?? "m",
            font: "sans",
            textAlign: "start",
            w: TEXT_DEFAULT_W,
            richText: toRichText(op.text),
            scale: 1,
            autoSize: true,
          },
        };
        rememberKey(op.key, id);
        if (frame) fitFrameToChildren(store, parentId);
        break;
      }
      case "addShape": {
        ensureShapeBudget();
        const frame = op.frame !== undefined ? resolveShape(op.frame, "frame") : null;
        const parentId = frame ? String(frame.id) : pageId;
        const w = op.w ?? SHAPE_DEFAULT_W;
        const h = op.h ?? SHAPE_DEFAULT_H;
        const pos = allocatePosition(frame, w, h, op.x, op.y);
        const id = `shape:${randomUUID().slice(0, 12)}`;
        store[id] = {
          id,
          typeName: "shape",
          type: "geo",
          x: pos.x,
          y: pos.y,
          rotation: 0,
          index: nextIndexForParent(store, parentId),
          parentId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            geo: op.geo,
            dash: "solid",
            url: "",
            w,
            h,
            growY: 0,
            scale: 1,
            flipX: false,
            flipY: false,
            labelColor: "black",
            color: op.color ?? "blue",
            fill: "fill",
            size: "s",
            font: "sans",
            align: "middle",
            verticalAlign: "middle",
            richText: toRichText(op.text ?? ""),
          },
        };
        rememberKey(op.key, id);
        if (frame) fitFrameToChildren(store, parentId);
        break;
      }
      case "connect": {
        ensureShapeBudget();
        const fromShape = resolveShape(op.from);
        const toShape = resolveShape(op.to);
        if (fromShape.id === toShape.id) invalidOp();
        const centerOf = (s: Record<string, unknown>) => {
          const abs = resolvePagePosition(store, s);
          const sz = shapeSize(s);
          return { x: abs.x + sz.w / 2, y: abs.y + sz.h / 2 };
        };
        const startCenter = centerOf(fromShape);
        const endCenter = centerOf(toShape);
        const arrowId = `shape:${randomUUID().slice(0, 12)}`;
        store[arrowId] = {
          id: arrowId,
          typeName: "shape",
          type: "arrow",
          x: startCenter.x,
          y: startCenter.y,
          rotation: 0,
          index: nextIndexForParent(store, pageId),
          parentId: pageId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            kind: "elbow",
            labelColor: "black",
            color: op.color ?? "black",
            fill: "none",
            dash: "solid",
            size: "s",
            arrowheadStart: "none",
            arrowheadEnd: "arrow",
            font: "sans",
            start: { x: 0, y: 0 },
            end: { x: endCenter.x - startCenter.x, y: endCenter.y - startCenter.y },
            bend: 0,
            richText: toRichText(op.text ?? ""),
            labelPosition: 0.5,
            scale: 1,
            elbowMidPoint: 0.5,
          },
        };
        for (const [terminal, targetShape] of [
          ["start", fromShape],
          ["end", toShape],
        ] as const) {
          const bindingId = `binding:${randomUUID().slice(0, 12)}`;
          store[bindingId] = {
            id: bindingId,
            typeName: "binding",
            type: "arrow",
            fromId: arrowId,
            toId: String(targetShape.id),
            props: {
              terminal,
              normalizedAnchor: { x: 0.5, y: 0.5 },
              isExact: false,
              isPrecise: false,
              snap: "none",
            },
            meta: {},
          };
        }
        rememberKey(op.key, arrowId);
        break;
      }
      case "update": {
        const shape = resolveShape(op.id);
        const props = isRecord(shape.props) ? { ...shape.props } : {};
        if (op.text !== undefined) {
          if (shape.type === "frame") {
            if (op.text.length > MOSS_CANVAS_MUTATE_LIMITS.maxFrameNameLength) invalidOp();
            props.name = op.text;
          } else if (
            "richText" in props ||
            shape.type === "note" ||
            shape.type === "text" ||
            shape.type === "geo" ||
            shape.type === "arrow"
          ) {
            props.richText = toRichText(op.text);
          } else {
            invalidOp();
          }
        }
        if (op.color !== undefined) {
          if (!("color" in props)) invalidOp();
          props.color = op.color;
        }
        store[String(shape.id)] = {
          ...shape,
          x: op.x !== undefined ? op.x : shape.x,
          y: op.y !== undefined ? op.y : shape.y,
          props,
        };
        if (typeof shape.parentId === "string" && store[shape.parentId]?.type === "frame") {
          fitFrameToChildren(store, shape.parentId);
        }
        break;
      }
      case "delete": {
        removeShapesCascade(op.ids);
        break;
      }
    }
  }

  const summary = summarizeMossCanvasSnapshot(snapshot);
  return {
    snapshot,
    created,
    deletedCount,
    ...summary,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Mutates this conversation's Canvas and persists it in hosted storage for the editor to load. */
export async function mutateMossCanvas(input: {
  readonly stateDirectory: string;
  readonly identity: MossMediaIdentity;
  readonly workspace: MossCanvasWorkspace;
  readonly ops: readonly MossCanvasMutateOp[];
  readonly title?: string;
}): Promise<MossCanvasMutateResult> {
  const validatedOps = parseMossCanvasMutateOps(input.ops);
  const existsBefore = await mossCanvasStorageExists(
    input.stateDirectory,
    input.identity,
    input.workspace,
  );
  const store = await mossCanvasStorageFor(input.stateDirectory, input.identity, input.workspace);
  const conversation = existsBefore
    ? recordOf(await store.request("workspace.conversationJobs"))
    : null;
  const active = recordOf(await store.request("projects.active"));
  const activeRelativePath =
    typeof active?.relativePath === "string"
      ? active.relativePath
      : typeof conversation?.relativePath === "string"
        ? conversation.relativePath
        : null;

  const existingProject = activeRelativePath
    ? recordOf(await store.request("projects.read", { relativePath: activeRelativePath }))
    : null;
  const boardTitle =
    input.title?.trim() ||
    (typeof recordOf(existingProject?.entry)?.title === "string"
      ? (recordOf(existingProject?.entry)!.title as string)
      : input.workspace.title || "画布");

  const mutated = applyMossCanvasOpsToSnapshot({
    existingSnapshot: existingProject?.snapshot,
    ops: validatedOps,
    title: boardTitle,
  });

  let updatedEntry: Record<string, unknown> | null = null;
  if (activeRelativePath && existingProject) {
    updatedEntry = recordOf(
      await store.request("projects.write", {
        relativePath: activeRelativePath,
        snapshot: mutated.snapshot,
      }),
    );
    if (!active?.relativePath) {
      await store.request("projects.setActive", { relativePath: activeRelativePath });
    }
  } else {
    const createdEntry = recordOf(
      await store.request("projects.create", {
        title: boardTitle,
        snapshot: mutated.snapshot,
      }),
    );
    const newRel =
      typeof createdEntry?.relativePath === "string" ? createdEntry.relativePath : null;
    if (newRel) {
      updatedEntry = recordOf(await store.request("projects.setActive", { relativePath: newRel }));
    } else {
      updatedEntry = createdEntry;
    }
  }

  const revision =
    typeof updatedEntry?.updatedAt === "string" && updatedEntry.updatedAt
      ? updatedEntry.updatedAt
      : new Date().toISOString();

  return {
    revision,
    created: mutated.created,
    deletedCount: mutated.deletedCount,
    shapeCounts: mutated.shapeCounts,
    shapes: mutated.shapes,
    truncated: mutated.truncated,
  };
}
