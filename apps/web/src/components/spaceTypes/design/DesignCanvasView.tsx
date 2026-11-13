// FILE: DesignCanvasView.tsx
// Purpose: The 设计 canvas: an infinite plane with pan and zoom, the page's artboards (live
//          frames) and notes, name strips, hover and selection outlines, resize handles,
//          marquee selection, dragging artboards, notes and elements (free pieces move, pieces in
//          a layout reorder), inline text editing, and the insert tools.
// Layer: 资料空间 设计 (web)
// Why: Pointer input is handled once, on the plane, against the artboards' geometry and the
//      frames' own hit testing, so every tool and modifier behaves the same everywhere.

import type {
  DesignBoard,
  DesignNote,
  DesignNoteColor,
} from "@moss/shared/spaceItems/designCanvas";
import {
  boundsOf,
  drawingMarkup,
  penPath,
  penPoints,
  simplifyPoints,
  smoothPath,
  translateAnchors,
  translatePoints,
  type PenAnchor,
} from "@moss/shared/spaceItems/designDraw";
import { insertMarkup, type DesignInsertKind } from "@moss/shared/spaceItems/designMarkup";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { PlayIcon, StopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { toastManager } from "../../ui/toast";
import { DesignBoardFrame } from "./DesignBoardFrame";
import { elementAt, elementPath, layerKind, type DesignElementPath } from "./designDocument";
import type { DesignPeer } from "./designRoom";
import {
  CanvasLinkCard,
  CanvasShape,
  canvasNoteRect,
  PeerOverlay,
  SelectionBar,
  SHAPE_HIT_PAD,
} from "./DesignShapes";
import { snapEdge, snapRect, type SnapGap, type SnapLine } from "./designSnap";
import {
  applyScale,
  cropOf,
  fullImageRect,
  readCrop,
  scaleSnapshot,
  writeCrop,
  type ScaleSnapshot,
} from "./designTransforms";
import {
  boardRoot,
  computed,
  elementAtPoint,
  frameRect,
  isPositioned,
  moveToIndex,
  pathsOf,
  setStyle,
} from "./designEdits";
import { clampZoom, EMPTY_SELECTION, type DesignEditorState } from "./useDesignEditor";
import { observeSize } from "./designSize";

export const NOTE_FILLS: Record<DesignNoteColor, string> = {
  yellow: "oklch(0.95 0.08 95)",
  gray: "oklch(0.94 0 0)",
  red: "oklch(0.92 0.05 25)",
  orange: "oklch(0.93 0.07 60)",
  green: "oklch(0.93 0.06 150)",
  teal: "oklch(0.93 0.05 190)",
  blue: "oklch(0.92 0.05 245)",
  purple: "oklch(0.92 0.05 300)",
  pink: "oklch(0.93 0.05 350)",
};
const NOTE_INK = "oklch(0.24 0 0)";
const STRIP_HEIGHT = 24;
const DRAG_THRESHOLD = 3;
/** Snap distance in screen pixels. */
const SNAP_PX = 6;

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Drag =
  | { kind: "pan"; start: Point; origin: { x: number; y: number } }
  | { kind: "marquee"; start: Point; current: Point; deep: boolean }
  | {
      kind: "draw";
      shape: "rect" | "oval" | "line" | "arrow";
      boardId: string | null;
      start: Point;
      current: Point;
    }
  | { kind: "pencil"; boardId: string | null; points: Point[] }
  | { kind: "pen-handle" }
  | {
      kind: "shape-resize";
      id: string;
      handle: Handle | "p1" | "p2";
      start: Point;
      origin: DesignNote;
    }
  | { kind: "crop"; handle: Handle | "move"; start: Point; origin: Rect }
  | {
      kind: "scale-element";
      boardId: string;
      element: HTMLElement;
      handle: Handle;
      start: Point;
      origin: Rect;
      snapshot: ScaleSnapshot;
      left: number;
      top: number;
      free: boolean;
    }
  | { kind: "create-board"; start: Point; current: Point }
  | {
      kind: "move";
      start: Point;
      boards: Map<string, Point>;
      notes: Map<string, Point>;
      moved: boolean;
    }
  | {
      kind: "element";
      boardId: string;
      start: Point;
      elements: { element: HTMLElement; left: number; top: number }[];
      /** Where the dragged elements were when the drag began (artboard coordinates). */
      box: Rect;
      mode: "free" | "flow";
      moved: boolean;
      flowIndex: number | null;
    }
  | { kind: "resize-board"; id: string; handle: Handle; start: Point; origin: Rect }
  | {
      kind: "resize-element";
      boardId: string;
      element: HTMLElement;
      handle: Handle;
      start: Point;
      origin: Rect;
      free: boolean;
      left: number;
      top: number;
    };

export interface DesignCommentTarget {
  readonly boardId: string | null;
  readonly path: DesignElementPath | null;
  readonly world: Point;
  readonly label: string;
}

/** Keeps a drag's pointer events on its element; a pointer the browser no longer knows is fine. */
function capture(event: { target: EventTarget; pointerId: number }) {
  try {
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  } catch {
    // The pointer went away before the drag began.
  }
}

interface CropSession {
  readonly boardId: string;
  readonly path: DesignElementPath;
  readonly element: HTMLElement;
  readonly before: string | null;
  readonly full: Rect;
  readonly rect: Rect;
  readonly origin: { box: Rect; left: number; top: number; free: boolean };
}

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
    h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
  };
}

/** A guide drawn in an artboard's coordinates, moved onto the canvas. */
const lineOnCanvas = (line: SnapLine, board: Point): SnapLine =>
  line.axis === "x"
    ? { ...line, at: line.at + board.x, from: line.from + board.y, to: line.to + board.y }
    : { ...line, at: line.at + board.y, from: line.from + board.x, to: line.to + board.x };
const gapOnCanvas = (gap: SnapGap, board: Point): SnapGap =>
  gap.axis === "x"
    ? { ...gap, start: gap.start + board.x, end: gap.end + board.x, cross: gap.cross + board.y }
    : { ...gap, start: gap.start + board.y, end: gap.end + board.y, cross: gap.cross + board.x };

/** Shift keeps a drawn line at 45° steps and a drawn box square. */
function constrain(start: Point, current: Point, shape: "rect" | "oval" | "line" | "arrow"): Point {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (shape === "rect" || shape === "oval") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * side, y: start.y + Math.sign(dy || 1) * side };
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

/** The elements inside `area` (artboard coordinates): whole ones, the outermost that fit. */
function elementsInside(root: HTMLElement, area: Rect): HTMLElement[] {
  const picked: HTMLElement[] = [];
  const visit = (parent: Element, depth: number) => {
    for (const child of parent.children) {
      if (!(child instanceof (child.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)))
        continue;
      if (/^(STYLE|SCRIPT|LINK|META|TEMPLATE|BR)$/u.test(child.tagName)) continue;
      const rect = frameRect(child as HTMLElement);
      if (rect.w <= 0 && rect.h <= 0) continue;
      const within =
        rect.x >= area.x &&
        rect.y >= area.y &&
        rect.x + rect.w <= area.x + area.w &&
        rect.y + rect.h <= area.y + area.h;
      if (within) picked.push(child as HTMLElement);
      else if (depth < 8 && intersects(rect, area)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return picked;
}

function inside(point: Point, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}
function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function normalized(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
function resized(origin: Rect, handle: Handle, dx: number, dy: number, min = 8): Rect {
  let { x, y, w, h } = origin;
  if (handle.includes("e")) w = Math.max(min, origin.w + dx);
  if (handle.includes("s")) h = Math.max(min, origin.h + dy);
  if (handle.includes("w")) {
    w = Math.max(min, origin.w - dx);
    x = origin.x + origin.w - w;
  }
  if (handle.includes("n")) {
    h = Math.max(min, origin.h - dy);
    y = origin.y + origin.h - h;
  }
  return { x, y, w, h };
}
const handleCursor: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export function noteRect(note: DesignNote): Rect {
  if (note.kind === "shape" || note.kind === "link") return canvasNoteRect(note);
  if (note.kind === "title") return { x: note.x, y: note.y, w: note.w ?? 1200, h: 88 };
  const w = note.w ?? 240;
  const lines = Math.max(
    3,
    Math.ceil((note.text.length * 15) / Math.max(80, w - 32)) + note.text.split("\n").length - 1,
  );
  return { x: note.x, y: note.y, w, h: Math.min((w * 4) / 3, 32 + lines * 21) };
}

export function DesignCanvasView(props: {
  editor: DesignEditorState;
  playing: string | null;
  onPlay: (boardId: string | null) => void;
  onNavigate: (from: string, target: { board?: string; url?: string }) => void;
  /** A picture for an artboard (at its local point), or for the bare canvas (boardId null). */
  onRequestImage: (boardId: string | null, at: Point, file?: File) => void;
  onRequestVideo: (boardId: string, at: Point, file: File) => void;
  onOpenLink: (note: DesignNote) => void;
  /** Other people in the live room. */
  peers?: readonly DesignPeer[];
  /** This person's pointer on the canvas (world), for the live room. */
  onCursor?: (point: Point | null) => void;
  onComment: (target: DesignCommentTarget, screen: Point) => void;
  onContextMenu: (screen: Point) => void;
  /** Screen-space overlay drawn above the canvas (comment pins). */
  overlay?: (toScreen: (point: Point) => Point) => ReactNode;
  rootRef?: (element: HTMLDivElement | null) => void;
}) {
  const { editor } = props;
  const { view, canvas } = editor;
  const root = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const [offset, setOffsetState] = useState<Point>({ x: 0, y: 0 });
  const offsetRef = useRef<Point>({ x: 0, y: 0 });
  const setOffset = (next: Point) => {
    offsetRef.current = next;
    setOffsetState(next);
  };
  const [boardResize, setBoardResizeState] = useState<{ id: string; rect: Rect } | null>(null);
  const boardResizeRef = useRef<{ id: string; rect: Rect } | null>(null);
  const setBoardResize = (next: { id: string; rect: Rect } | null) => {
    boardResizeRef.current = next;
    setBoardResizeState(next);
  };
  const [flowMarker, setFlowMarker] = useState<Rect | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [guides, setGuides] = useState<{
    lines: readonly SnapLine[];
    gaps: readonly SnapGap[];
  } | null>(null);
  const [pencil, setPencil] = useState<Point[] | null>(null);
  const [pen, setPenState] = useState<{ boardId: string | null; anchors: PenAnchor[] } | null>(
    null,
  );
  const penRef = useRef<typeof pen>(null);
  const setPen = (next: typeof pen) => {
    penRef.current = next;
    setPenState(next);
  };
  const [pointer, setPointer] = useState<Point | null>(null);
  const [shapeDraft, setShapeDraftState] = useState<DesignNote | null>(null);
  const shapeDraftRef = useRef<DesignNote | null>(null);
  const setShapeDraft = (next: DesignNote | null) => {
    shapeDraftRef.current = next;
    setShapeDraftState(next);
  };
  const [crop, setCropState] = useState<CropSession | null>(null);
  const cropRef = useRef<CropSession | null>(null);
  const setCrop = (next: CropSession | null) => {
    cropRef.current = next;
    setCropState(next);
  };
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = observeSize(element, setSize);
    return () => observer.disconnect();
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = root.current!.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (clientX - rect.left - current.x) / current.zoom,
      y: (clientY - rect.top - current.y) / current.zoom,
    };
  }, []);
  const toScreen = useCallback(
    (point: Point): Point => ({ x: view.x + point.x * view.zoom, y: view.y + point.y * view.zoom }),
    [view],
  );

  // Wheel: scroll pans, Ctrl/⌘ (or a pinch) zooms around the pointer.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-design-scrollable]")) return;
      event.preventDefault();
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * 0.0075));
        editor.setView({
          zoom,
          x: px - ((px - current.x) / current.zoom) * zoom,
          y: py - ((py - current.y) / current.zoom) * zoom,
        });
      } else {
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
        editor.setView({ ...current, x: current.x - dx, y: current.y - dy });
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [editor]);

  // Holding Space pans with any tool.
  useEffect(() => {
    const typing = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      return target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target?.tagName ?? "");
    };
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !typing(event) && !editor.editingText) {
        event.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [editor.editingText]);

  const visibleRect = useMemo<Rect>(
    () => ({
      x: -view.x / view.zoom,
      y: -view.y / view.zoom,
      w: size.width / view.zoom,
      h: size.height / view.zoom,
    }),
    [size, view],
  );
  const selectedBoards = new Set(editor.selection.boards);
  const selectedNotes = new Set(editor.selection.notes);
  const movingBoards = drag?.kind === "move" ? drag.boards : null;
  const movingNotes = drag?.kind === "move" ? drag.notes : null;
  const frameOf = (board: DesignBoard): Rect => {
    if (boardResize?.id === board.id) return boardResize.rect;
    const moving = movingBoards?.get(board.id);
    return moving
      ? { x: moving.x + offset.x, y: moving.y + offset.y, w: board.w, h: board.h }
      : { x: board.x, y: board.y, w: board.w, h: board.h };
  };

  const boardAt = useCallback(
    (point: Point): DesignBoard | null => {
      for (let index = editor.pageBoards.length - 1; index >= 0; index -= 1) {
        const board = editor.pageBoards[index]!;
        if (!board.hidden && inside(point, board)) return board;
      }
      return null;
    },
    [editor.pageBoards],
  );

  const hitElement = useCallback(
    (board: DesignBoard, point: Point): HTMLElement | null => {
      const doc = editor.frames.current.get(board.id)?.doc();
      if (!doc) return null;
      return elementAtPoint(doc, point.x - board.x, point.y - board.y);
    },
    [editor.frames],
  );

  const finishTextEdit = useCallback(() => {
    const editing = editor.editingText;
    if (!editing) return;
    const body = editor.frames.current.get(editing.boardId)?.body();
    const element = body ? elementAt(body, editing.path) : null;
    element?.removeAttribute("contenteditable");
    editor.editBoard(editing.boardId, () => [editing.path]);
    editor.setEditingText(null);
  }, [editor]);

  const startTextEdit = useCallback(
    (board: DesignBoard, element: HTMLElement) => {
      if (editor.readOnly) return;
      const body = editor.frames.current.get(board.id)?.body();
      const doc = editor.frames.current.get(board.id)?.doc();
      const path = body ? elementPath(element, body) : null;
      if (!body || !doc || !path) return;
      if (layerKind(element) !== "text" && !(element.textContent ?? "").trim()) return;
      element.setAttribute("contenteditable", "true");
      editor.setSelection({ boards: [], notes: [], element: { boardId: board.id, paths: [path] } });
      editor.setEditingText({ boardId: board.id, path });
      requestAnimationFrame(() => {
        element.focus();
        const range = doc.createRange();
        range.selectNodeContents(element);
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    },
    [editor],
  );

  // Escape or a click elsewhere finishes typing; the frame's own keys stay inside it.
  useEffect(() => {
    const editing = editor.editingText;
    if (!editing) return;
    const doc = editor.frames.current.get(editing.boardId)?.doc();
    if (!doc) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        finishTextEdit();
      }
    };
    const blur = () => finishTextEdit();
    doc.addEventListener("keydown", key);
    const element = elementAt(doc.body, editing.path);
    element?.addEventListener("blur", blur);
    return () => {
      doc.removeEventListener("keydown", key);
      element?.removeEventListener("blur", blur);
    };
  }, [editor.editingText, editor.frames, finishTextEdit]);

  const select = (next: Parameters<DesignEditorState["setSelection"]>[0]) =>
    editor.setSelection(next);

  // ─── Drawing ───────────────────────────────────────────────────────────────────────────

  /** Where an artboard's root element starts, in the artboard's coordinates. */
  const rootOffset = (boardId: string): Point => {
    const body = editor.frames.current.get(boardId)?.body();
    const rootElement = body ? boardRoot(body) : null;
    return rootElement ? frameRect(rootElement) : { x: 0, y: 0 };
  };
  /** A world point in an artboard root's own coordinates (where inserted markup is placed). */
  const inRoot = (board: DesignBoard, point: Point): Point => {
    const offset = rootOffset(board.id);
    return { x: point.x - board.x - offset.x, y: point.y - board.y - offset.y };
  };

  /** A rectangle or oval markup at a drawn size, inside an artboard's root. */
  const sizedMarkup = (board: DesignBoard, kind: "rect" | "oval", area: Rect): string => {
    const doc = editor.frames.current.get(board.id)?.doc();
    if (!doc) return "";
    const at = inRoot(board, area);
    const template = doc.createElement("template");
    template.innerHTML = insertMarkup(kind, at);
    const element = template.content.firstElementChild as HTMLElement | null;
    if (!element) return "";
    element.style.setProperty("width", `${Math.max(1, Math.round(area.w))}px`);
    element.style.setProperty("height", `${Math.max(1, Math.round(area.h))}px`);
    return element.outerHTML;
  };

  /** Puts a drawn path (world points) into the artboard it began on, or on the canvas. */
  const placePath = (
    boardId: string | null,
    points: readonly Point[],
    build: (dx: number, dy: number) => string,
    keepTool: "pencil" | "pen",
  ) => {
    const box = boundsOf(points);
    const d = build(-box.x, -box.y);
    const board = boardId ? editor.boardById(boardId) : null;
    if (board) {
      const at = inRoot(board, box);
      editor.insertHtml(
        board.id,
        drawingMarkup({ kind: "path", box: { ...at, w: box.w, h: box.h }, d }),
      );
    } else
      editor.addCanvasNote({
        kind: "shape",
        shape: "path",
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.max(1, Math.round(box.w)),
        h: Math.max(1, Math.round(box.h)),
        vw: Math.max(0.01, box.w),
        vh: Math.max(0.01, box.h),
        d,
        text: "",
      });
    editor.setTool(keepTool);
  };

  const finishPen = useCallback(
    (closed: boolean) => {
      const current = penRef.current;
      penRef.current = null;
      setPenState(null);
      if (!current || current.anchors.length < 2) return;
      placePath(
        current.boardId,
        penPoints(current.anchors),
        (dx, dy) => penPath(translateAnchors(current.anchors, dx, dy), closed),
        "pen",
      );
    },
    // placePath reads the editor through `editor`, which is stable for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  const penDown = (point: Point, board: DesignBoard | null, detail: number) => {
    const current = penRef.current;
    if (!current) {
      setPen({ boardId: board?.id ?? null, anchors: [point] });
      setDrag({ kind: "pen-handle" });
      return;
    }
    if (detail >= 2) return finishPen(false);
    const first = current.anchors[0]!;
    if (
      current.anchors.length >= 3 &&
      Math.hypot(point.x - first.x, point.y - first.y) * view.zoom < 8
    )
      return finishPen(true);
    setPen({ ...current, anchors: [...current.anchors, point] });
    setDrag({ kind: "pen-handle" });
  };

  // A pen path ends with Enter (open), a click on its first point (closed) or a double-click;
  // Escape drops it. Leaving the pen tool keeps what was drawn.
  useEffect(() => {
    if (!pen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") finishPen(false);
      else setPen(null);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pen !== null, finishPen]);
  useEffect(() => {
    if (editor.tool !== "pen" && penRef.current) finishPen(false);
  }, [editor.tool, finishPen]);

  // ─── Crop ──────────────────────────────────────────────────────────────────────────────

  const endCrop = useCallback(
    (keep: boolean) => {
      const session = cropRef.current;
      cropRef.current = null;
      setCropState(null);
      editor.setCropping(null);
      if (!session) return;
      if (keep) editor.editBoard(session.boardId, () => [session.path]);
      else {
        if (session.before === null) session.element.removeAttribute("style");
        else session.element.setAttribute("style", session.before);
        editor.bump();
      }
    },
    [editor],
  );
  useEffect(() => {
    const request = editor.cropping;
    if (!request || cropRef.current) return;
    const body = editor.frames.current.get(request.boardId)?.body();
    const element = body ? elementAt(body, request.path) : null;
    if (!element || element.tagName !== "IMG" || editor.readOnly) {
      if (element && element.tagName !== "IMG")
        toastManager.add({ type: "info", title: "只有图片可以裁切" });
      editor.setCropping(null);
      return;
    }
    const box = frameRect(element);
    setCrop({
      boardId: request.boardId,
      path: request.path,
      element,
      before: element.getAttribute("style"),
      full: fullImageRect(box, readCrop(element)),
      rect: box,
      origin: {
        box,
        left: element.offsetLeft,
        top: element.offsetTop,
        free: isPositioned(element),
      },
    });
  }, [editor, editor.cropping]);
  useEffect(() => {
    if (!crop) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endCrop(event.key === "Enter");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [crop, endCrop]);

  /** Selects the element under a world point (what a plain click would select). */
  const pickElementAt = (point: Point) => {
    const board = boardAt(point);
    if (!board) return select(EMPTY_SELECTION);
    const found = hitElement(board, point);
    const body = editor.frames.current.get(board.id)?.body();
    const path = found && body ? elementPath(found, body) : null;
    select(
      path
        ? { boards: [], notes: [], element: { boardId: board.id, paths: [path] } }
        : { boards: [board.id], notes: [], element: null },
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) return;
    if (editor.editingText) finishTextEdit();
    // A click outside the crop box keeps the crop.
    if (cropRef.current) endCrop(true);
    root.current?.focus({ preventScroll: true });
    const point = toWorld(event.clientX, event.clientY);
    const screen = { x: event.clientX, y: event.clientY };
    const panning = event.button === 1 || spaceDown || editor.tool === "hand";
    capture(event);
    if (panning) {
      setDrag({ kind: "pan", start: screen, origin: { x: view.x, y: view.y } });
      return;
    }
    const board = boardAt(point);
    const local = board ? { x: point.x - board.x, y: point.y - board.y } : null;
    if (editor.tool === "comment") {
      const element = board ? hitElement(board, point) : null;
      const body = board ? editor.frames.current.get(board.id)?.body() : null;
      props.onComment(
        {
          boardId: board?.id ?? null,
          path: element && body ? elementPath(element, body) : null,
          world: point,
          label: element
            ? (element.textContent ?? "").trim().slice(0, 40) || board!.name
            : (board?.name ?? "画布"),
        },
        screen,
      );
      return;
    }
    if (editor.readOnly && editor.tool !== "select") editor.setTool("select");
    if (!editor.readOnly && editor.tool !== "select" && editor.tool !== "scale") {
      const tool = editor.tool;
      if (tool === "rect" || tool === "oval" || tool === "line" || tool === "arrow") {
        setDrag({
          kind: "draw",
          shape: tool,
          boardId: board?.id ?? null,
          start: point,
          current: point,
        });
        return;
      }
      if (tool === "pencil") {
        setPencil([point]);
        setDrag({ kind: "pencil", boardId: board?.id ?? null, points: [point] });
        return;
      }
      if (tool === "pen") {
        penDown(point, board, event.detail);
        return;
      }
      if (tool === "text" && !board) {
        // Text on the bare canvas is a canvas title.
        const id = editor.addNote(point, "title");
        if (id) setEditingNote(id);
        editor.setTool("select");
        return;
      }
      const insertKind: Partial<Record<typeof editor.tool, DesignInsertKind>> = {
        text: "text",
      };
      if (editor.tool === "note") {
        editor.addNote(point);
        editor.setTool("select");
        return;
      }
      if (editor.tool === "frame") {
        if (board && local) editor.insert(board.id, "frame", local);
        else setDrag({ kind: "create-board", start: point, current: point });
        return;
      }
      if (editor.tool === "image") {
        if (board && local) props.onRequestImage(board.id, local);
        else props.onRequestImage(null, point);
        return;
      }
      const kind = insertKind[editor.tool];
      if (kind) {
        if (board && local) {
          const element = editor.insert(board.id, kind, local);
          if (element && kind === "text")
            requestAnimationFrame(() => startTextEdit(board, element));
        } else toastManager.add({ type: "info", title: "在画板里点一下，放置这个元素" });
        return;
      }
    }
    // Ctrl/⌘-drag frames elements inside artboards (it may start outside them).
    const deep = (event.ctrlKey || event.metaKey) && !editor.readOnly;
    if (!board || deep) {
      if (!event.shiftKey) select({ boards: [], notes: [], element: null });
      setDrag({ kind: "marquee", start: point, current: point, deep });
      return;
    }
    if (props.playing === board.id) return;
    const element = hitElement(board, point);
    const body = editor.frames.current.get(board.id)?.body();
    if (!element || !body) {
      select({ boards: [board.id], notes: [], element: null });
      startMove(point, [board.id], []);
      return;
    }
    const path = elementPath(element, body);
    if (!path) return;
    if (event.detail >= 2) {
      if (element.tagName === "IMG") editor.setCropping({ boardId: board.id, path });
      else startTextEdit(board, element);
      return;
    }
    const current = editor.selection.element;
    let paths: DesignElementPath[];
    if (current?.boardId === board.id && current.paths.includes(path)) {
      paths = event.shiftKey ? current.paths.filter((entry) => entry !== path) : [...current.paths];
    } else if (event.shiftKey && current?.boardId === board.id) paths = [...current.paths, path];
    else paths = [path];
    select({ boards: [], notes: [], element: paths.length ? { boardId: board.id, paths } : null });
    if (editor.readOnly || !paths.length) return;
    const elements = paths.flatMap((entry) => {
      const found = elementAt(body, entry);
      return found && found !== boardRoot(body) ? [found] : [];
    });
    if (!elements.length) {
      startMove(point, [board.id], []);
      return;
    }
    const free = elements.every(isPositioned);
    setDrag({
      kind: "element",
      boardId: board.id,
      start: point,
      elements: elements.map((entry) => ({
        element: entry,
        left: entry.offsetLeft,
        top: entry.offsetTop,
      })),
      box: union(elements.map(frameRect)),
      mode: free ? "free" : "flow",
      moved: false,
      flowIndex: null,
    });
  };

  const startMove = (point: Point, boards: readonly string[], notes: readonly string[]) => {
    if (editor.readOnly) return;
    const boardOrigins = new Map<string, Point>();
    for (const id of boards) {
      const board = editor.boardById(id);
      if (board) boardOrigins.set(id, { x: board.x, y: board.y });
    }
    const noteOrigins = new Map<string, Point>();
    for (const id of notes) {
      const note = editor.canvas.notes.find((entry) => entry.id === id);
      if (note) noteOrigins.set(id, { x: note.x, y: note.y });
    }
    setOffset({ x: 0, y: 0 });
    setDrag({ kind: "move", start: point, boards: boardOrigins, notes: noteOrigins, moved: false });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    const point = toWorld(event.clientX, event.clientY);
    props.onCursor?.(point);
    if (penRef.current) setPointer(point);
    const snapping = !(event.ctrlKey || event.metaKey);
    const threshold = SNAP_PX / view.zoom;
    if (!current) {
      if ((editor.tool !== "select" && editor.tool !== "scale") || editor.editingText) return;
      const board = boardAt(point);
      const element = board && props.playing !== board.id ? hitElement(board, point) : null;
      const body = board ? editor.frames.current.get(board.id)?.body() : null;
      const path = element && body ? elementPath(element, body) : null;
      const next = board && path ? { boardId: board.id, path } : null;
      if (next?.path !== editor.hover?.path || next?.boardId !== editor.hover?.boardId)
        editor.setHover(next);
      return;
    }
    switch (current.kind) {
      case "pan":
        editor.setView({
          ...view,
          x: current.origin.x + event.clientX - current.start.x,
          y: current.origin.y + event.clientY - current.start.y,
        });
        return;
      case "marquee":
      case "create-board":
        setDrag({ ...current, current: point });
        return;
      case "draw":
        setDrag({
          ...current,
          current: event.shiftKey ? constrain(current.start, point, current.shape) : point,
        });
        return;
      case "pencil": {
        const last = current.points.at(-1)!;
        if (Math.hypot(point.x - last.x, point.y - last.y) * view.zoom < 1.5) return;
        const points = [...current.points, point];
        dragRef.current = { ...current, points };
        setPencil(points);
        return;
      }
      case "pen-handle": {
        const drawing = penRef.current;
        const last = drawing?.anchors.at(-1);
        if (!drawing || !last) return;
        if (Math.hypot(point.x - last.x, point.y - last.y) * view.zoom < 3) return;
        setPen({
          ...drawing,
          anchors: [...drawing.anchors.slice(0, -1), { x: last.x, y: last.y, out: point }],
        });
        return;
      }
      case "shape-resize": {
        const origin = current.origin;
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        if (current.handle === "p1" || current.handle === "p2") {
          const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = origin.points ?? [];
          let a = { x: origin.x + x1, y: origin.y + y1 };
          let b = { x: origin.x + x2, y: origin.y + y2 };
          if (current.handle === "p1") {
            a = { x: a.x + dx, y: a.y + dy };
            if (event.shiftKey) a = constrain(b, a, "line");
          } else {
            b = { x: b.x + dx, y: b.y + dy };
            if (event.shiftKey) b = constrain(a, b, "line");
          }
          const box = boundsOf([a, b]);
          setShapeDraft({
            ...origin,
            x: Math.round(box.x),
            y: Math.round(box.y),
            w: Math.round(box.w),
            h: Math.round(box.h),
            points: [
              Math.round(a.x - box.x),
              Math.round(a.y - box.y),
              Math.round(b.x - box.x),
              Math.round(b.y - box.y),
            ],
          });
          return;
        }
        let rect = resized(canvasNoteRect(origin), current.handle, dx, dy, 4);
        if (event.shiftKey || origin.shape === "image") {
          // Pictures keep their proportions (Shift does it for any shape).
          const base = canvasNoteRect(origin);
          const ratio = base.w / Math.max(1, base.h);
          const h = rect.w / ratio;
          rect = { ...rect, h, y: current.handle.includes("n") ? base.y + base.h - h : rect.y };
        }
        setShapeDraft({
          ...origin,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.w),
          h: Math.round(rect.h),
        });
        return;
      }
      case "crop": {
        const session = cropRef.current;
        if (!session) return;
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        const full = session.full;
        let rect =
          current.handle === "move"
            ? {
                ...current.origin,
                x: Math.min(
                  full.x + full.w - current.origin.w,
                  Math.max(full.x, current.origin.x + dx),
                ),
                y: Math.min(
                  full.y + full.h - current.origin.h,
                  Math.max(full.y, current.origin.y + dy),
                ),
              }
            : resized(current.origin, current.handle, dx, dy, 8);
        // The crop never reaches past the picture.
        const x = Math.max(full.x, rect.x);
        const y = Math.max(full.y, rect.y);
        rect = {
          x,
          y,
          w: Math.min(full.x + full.w, rect.x + rect.w) - x,
          h: Math.min(full.y + full.h, rect.y + rect.h) - y,
        };
        writeCrop(session.element, cropOf(full, rect), rect, session.origin);
        setCrop({ ...session, rect });
        editor.bump();
        return;
      }
      case "scale-element": {
        const dx = point.x - current.start.x;
        const grows = current.handle.includes("w") ? -dx : dx;
        const factor = Math.max(0.05, (current.origin.w + grows) / Math.max(1, current.origin.w));
        applyScale(current.snapshot, factor);
        if (current.free) {
          // The opposite corner stays put.
          if (current.handle.includes("w"))
            setStyle(
              current.element,
              "left",
              `${Math.round(current.left + current.origin.w * (1 - factor))}px`,
            );
          if (current.handle.includes("n"))
            setStyle(
              current.element,
              "top",
              `${Math.round(current.top + current.origin.h * (1 - factor))}px`,
            );
        }
        editor.bump();
        return;
      }
      case "move": {
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        if (!current.moved && Math.hypot(dx, dy) * view.zoom < DRAG_THRESHOLD) return;
        dragRef.current = { ...current, moved: true };
        let ox = dx;
        let oy = dy;
        const moving: Rect[] = [];
        for (const [id, origin] of current.boards) {
          const board = editor.boardById(id);
          if (board) moving.push({ x: origin.x + dx, y: origin.y + dy, w: board.w, h: board.h });
        }
        for (const [id, origin] of current.notes) {
          const note = editor.canvas.notes.find((entry) => entry.id === id);
          if (!note) continue;
          const rect = noteRect(note);
          moving.push({
            ...rect,
            x: rect.x - note.x + origin.x + dx,
            y: rect.y - note.y + origin.y + dy,
          });
        }
        if (snapping && moving.length) {
          const others = [
            ...editor.pageBoards
              .filter((board) => !current.boards.has(board.id) && !board.hidden)
              .map((board) => ({ x: board.x, y: board.y, w: board.w, h: board.h })),
            ...editor.pageNotes.filter((note) => !current.notes.has(note.id)).map(noteRect),
          ];
          const snap = snapRect(union(moving), others, threshold);
          ox += snap.dx;
          oy += snap.dy;
          setGuides(snap.lines.length || snap.gaps.length ? snap : null);
        } else setGuides(null);
        setOffset({ x: Math.round(ox), y: Math.round(oy) });
        return;
      }
      case "element": {
        const dx = point.x - current.start.x;
        const dy = point.y - current.start.y;
        if (!current.moved && Math.hypot(dx, dy) * view.zoom < DRAG_THRESHOLD) return;
        dragRef.current = { ...current, moved: true };
        if (current.mode === "free") {
          let mx = dx;
          let my = dy;
          const board = editor.boardById(current.boardId);
          const parent = current.elements[0]!.element.parentElement;
          if (snapping && board && parent) {
            const dragged = new Set<Element>(current.elements.map((entry) => entry.element));
            const others = [
              frameRect(parent),
              ...[...parent.children]
                .filter((child) => !dragged.has(child))
                .map((child) => frameRect(child as HTMLElement))
                .filter((rect) => rect.w > 0 || rect.h > 0),
            ];
            const snap = snapRect(
              { ...current.box, x: current.box.x + dx, y: current.box.y + dy },
              others,
              threshold,
            );
            mx += snap.dx;
            my += snap.dy;
            setGuides(
              snap.lines.length || snap.gaps.length
                ? {
                    lines: snap.lines.map((line) => lineOnCanvas(line, board)),
                    gaps: snap.gaps.map((gap) => gapOnCanvas(gap, board)),
                  }
                : null,
            );
          } else setGuides(null);
          for (const entry of current.elements) {
            setStyle(entry.element, "left", `${Math.round(entry.left + mx)}px`);
            setStyle(entry.element, "top", `${Math.round(entry.top + my)}px`);
          }
          editor.bump();
          return;
        }
        // In a layout: the drop place among the siblings, along the parent's main axis.
        const first = current.elements[0]!.element;
        const parent = first.parentElement;
        const board = editor.boardById(current.boardId);
        if (!parent || !board) return;
        const style = computed(parent);
        const horizontal =
          (style?.display ?? "").includes("flex") && (style?.flexDirection ?? "").startsWith("row");
        const local = { x: point.x - board.x, y: point.y - board.y };
        const siblings = [...parent.children].filter((child) => child !== first) as HTMLElement[];
        let index = siblings.length;
        for (let i = 0; i < siblings.length; i += 1) {
          const rect = frameRect(siblings[i]!);
          const middle = horizontal ? rect.x + rect.w / 2 : rect.y + rect.h / 2;
          if ((horizontal ? local.x : local.y) < middle) {
            index = i;
            break;
          }
        }
        dragRef.current = { ...current, moved: true, flowIndex: index };
        const parentRect = frameRect(parent);
        const anchor = siblings[index];
        const anchorRect = anchor ? frameRect(anchor) : null;
        const last = siblings.at(-1);
        const lastRect = last ? frameRect(last) : parentRect;
        const marker = horizontal
          ? {
              x: anchorRect ? anchorRect.x - 1 : lastRect.x + lastRect.w + 1,
              y: parentRect.y,
              w: 2,
              h: parentRect.h,
            }
          : {
              x: parentRect.x,
              y: anchorRect ? anchorRect.y - 1 : lastRect.y + lastRect.h + 1,
              w: parentRect.w,
              h: 2,
            };
        setFlowMarker({ x: board.x + marker.x, y: board.y + marker.y, w: marker.w, h: marker.h });
        return;
      }
      case "resize-board": {
        let rect = resized(
          current.origin,
          current.handle,
          point.x - current.start.x,
          point.y - current.start.y,
          40,
        );
        if (snapping) {
          const others = editor.pageBoards
            .filter((board) => board.id !== current.id && !board.hidden)
            .map((board) => ({ x: board.x, y: board.y, w: board.w, h: board.h }));
          const lines: SnapLine[] = [];
          if (current.handle.includes("e")) {
            const edge = snapEdge(rect.x + rect.w, "x", others, threshold);
            rect = { ...rect, w: Math.max(40, edge.value - rect.x) };
            if (edge.line) lines.push(edge.line);
          }
          if (current.handle.includes("w")) {
            const edge = snapEdge(rect.x, "x", others, threshold);
            rect = { ...rect, x: edge.value, w: Math.max(40, rect.x + rect.w - edge.value) };
            if (edge.line) lines.push(edge.line);
          }
          if (current.handle.includes("s")) {
            const edge = snapEdge(rect.y + rect.h, "y", others, threshold);
            rect = { ...rect, h: Math.max(40, edge.value - rect.y) };
            if (edge.line) lines.push(edge.line);
          }
          if (current.handle.includes("n")) {
            const edge = snapEdge(rect.y, "y", others, threshold);
            rect = { ...rect, y: edge.value, h: Math.max(40, rect.y + rect.h - edge.value) };
            if (edge.line) lines.push(edge.line);
          }
          setGuides(lines.length ? { lines, gaps: [] } : null);
        }
        setBoardResize({
          id: current.id,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.w),
            h: Math.round(rect.h),
          },
        });
        return;
      }
      case "resize-element": {
        const rect = resized(
          current.origin,
          current.handle,
          point.x - current.start.x,
          point.y - current.start.y,
          1,
        );
        setStyle(current.element, "width", `${Math.round(rect.w)}px`);
        setStyle(current.element, "height", `${Math.round(rect.h)}px`);
        if (current.free) {
          setStyle(
            current.element,
            "left",
            `${Math.round(current.left + rect.x - current.origin.x)}px`,
          );
          setStyle(
            current.element,
            "top",
            `${Math.round(current.top + rect.y - current.origin.y)}px`,
          );
        }
        editor.bump();
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    setDrag(null);
    setFlowMarker(null);
    setGuides(null);
    if (!current) return;
    switch (current.kind) {
      case "draw": {
        finishDraw(current);
        return;
      }
      case "pencil": {
        setPencil(null);
        const points = simplifyPoints(current.points, 1 / view.zoom);
        if (points.length < 2) return;
        placePath(
          current.boardId,
          points,
          (dx, dy) => smoothPath(translatePoints(points, dx, dy)),
          "pencil",
        );
        return;
      }
      case "pen-handle":
        return;
      case "shape-resize": {
        const draft = shapeDraftRef.current;
        setShapeDraft(null);
        if (draft) editor.apply([{ op: "upsertNote", note: draft, replace: true }]);
        return;
      }
      case "crop":
        return;
      case "scale-element":
        editor.editBoard(current.boardId, () => undefined);
        return;
      case "marquee": {
        const area = normalized(current.start, current.current);
        if (current.deep) {
          if (area.w * view.zoom < 3 && area.h * view.zoom < 3) return pickElementAt(current.start);
          // Elements inside the frame, in the artboard where most of them are.
          let best: { boardId: string; paths: DesignElementPath[] } | null = null;
          for (const board of editor.pageBoards) {
            if (board.hidden || !intersects(area, board)) continue;
            const body = editor.frames.current.get(board.id)?.body();
            const rootElement = body ? boardRoot(body) : null;
            if (!body || !rootElement) continue;
            const picked = elementsInside(rootElement, {
              x: area.x - board.x,
              y: area.y - board.y,
              w: area.w,
              h: area.h,
            });
            if (picked.length > (best?.paths.length ?? 0))
              best = { boardId: board.id, paths: pathsOf(body, picked) };
          }
          select({ boards: [], notes: [], element: best?.paths.length ? best : null });
          return;
        }
        if (area.w * view.zoom < 3 && area.h * view.zoom < 3) return;
        const boards = editor.pageBoards
          .filter((board) => intersects(area, board))
          .map((board) => board.id);
        const notes = editor.pageNotes
          .filter((note) => intersects(area, noteRect(note)))
          .map((note) => note.id);
        const keep = event.shiftKey ? editor.selection : { boards: [], notes: [] };
        select({
          boards: [...new Set([...keep.boards, ...boards])],
          notes: [...new Set([...keep.notes, ...notes])],
          element: null,
        });
        return;
      }
      case "create-board": {
        const area = normalized(current.start, current.current);
        const frame =
          area.w < 40 || area.h < 40
            ? { x: current.start.x, y: current.start.y, w: 1280, h: 800 }
            : area;
        editor.addBoard(frame);
        editor.setTool("select");
        return;
      }
      case "move": {
        if (!current.moved) return;
        const offset = offsetRef.current;
        editor.apply([
          ...[...current.boards].map(([id, origin]) => ({
            op: "moveBoard" as const,
            id,
            x: origin.x + offset.x,
            y: origin.y + offset.y,
          })),
          ...[...current.notes].flatMap(([id, origin]) => {
            const note = editor.canvas.notes.find((entry) => entry.id === id);
            return note
              ? [
                  {
                    op: "upsertNote" as const,
                    note: { ...note, x: origin.x + offset.x, y: origin.y + offset.y },
                  },
                ]
              : [];
          }),
        ]);
        setOffset({ x: 0, y: 0 });
        return;
      }
      case "element": {
        if (!current.moved) return;
        if (current.mode === "flow" && current.flowIndex !== null) {
          const element = current.elements[0]!.element;
          editor.editBoard(current.boardId, (body) => {
            moveToIndex(element, current.flowIndex!);
            const path = elementPath(element, body);
            return path ? [path] : [];
          });
        } else
          editor.editBoard(current.boardId, (body) =>
            current.elements.flatMap((entry) => {
              const path = elementPath(entry.element, body);
              return path ? [path] : [];
            }),
          );
        return;
      }
      case "resize-board": {
        const resizing = boardResizeRef.current;
        const rect = resizing?.id === current.id ? resizing.rect : null;
        setBoardResize(null);
        if (rect) editor.apply([{ op: "moveBoard", id: current.id, ...rect }]);
        return;
      }
      case "resize-element":
        editor.editBoard(current.boardId, () => undefined);
        return;
      case "pan":
        return;
    }
  };

  /** A drawn rectangle, oval, line or arrow: into the artboard it began on, or on the canvas. */
  const finishDraw = (current: Extract<Drag, { kind: "draw" }>) => {
    const area = normalized(current.start, current.current);
    const tiny = area.w * view.zoom < 4 && area.h * view.zoom < 4;
    const board = current.boardId ? editor.boardById(current.boardId) : null;
    const box = current.shape === "line" || current.shape === "arrow";
    const end = tiny ? { x: current.start.x + 160, y: current.start.y } : current.current;
    if (board) {
      if (!box) {
        const kind = current.shape as "rect" | "oval";
        if (tiny)
          editor.insert(board.id, kind, {
            x: current.start.x - board.x,
            y: current.start.y - board.y,
          });
        else editor.insertHtml(board.id, sizedMarkup(board, kind, area));
        return;
      }
      const a = inRoot(board, current.start);
      const b = inRoot(board, end);
      const bounds = boundsOf([a, b]);
      editor.insertHtml(
        board.id,
        drawingMarkup({
          kind: current.shape as "line" | "arrow",
          box: bounds,
          points: [a.x - bounds.x, a.y - bounds.y, b.x - bounds.x, b.y - bounds.y],
        }),
      );
      return;
    }
    if (!box) {
      const side = current.shape === "oval" ? 96 : 120;
      const rect = tiny ? { x: current.start.x, y: current.start.y, w: side, h: side } : area;
      editor.addCanvasNote({
        kind: "shape",
        shape: current.shape,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
        text: "",
      });
      return;
    }
    const bounds = boundsOf([current.start, end]);
    editor.addCanvasNote({
      kind: "shape",
      shape: current.shape,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      points: [
        Math.round(current.start.x - bounds.x),
        Math.round(current.start.y - bounds.y),
        Math.round(end.x - bounds.x),
        Math.round(end.y - bounds.y),
      ],
      text: "",
    });
  };

  const startShapeResize = (
    event: ReactPointerEvent,
    note: DesignNote,
    handle: Handle | "p1" | "p2",
  ) => {
    event.stopPropagation();
    if (editor.readOnly) return;
    capture(event);
    setDrag({
      kind: "shape-resize",
      id: note.id,
      handle,
      start: toWorld(event.clientX, event.clientY),
      origin: note,
    });
  };
  const startCropDrag = (event: ReactPointerEvent, handle: Handle | "move") => {
    event.stopPropagation();
    const session = cropRef.current;
    if (!session) return;
    capture(event);
    setDrag({
      kind: "crop",
      handle,
      start: toWorld(event.clientX, event.clientY),
      origin: session.rect,
    });
  };
  const startElementScale = (
    event: ReactPointerEvent,
    boardId: string,
    element: HTMLElement,
    handle: Handle,
  ) => {
    event.stopPropagation();
    if (editor.readOnly) return;
    capture(event);
    setDrag({
      kind: "scale-element",
      boardId,
      element,
      handle,
      start: toWorld(event.clientX, event.clientY),
      origin: frameRect(element),
      snapshot: scaleSnapshot(element),
      left: element.offsetLeft,
      top: element.offsetTop,
      free: isPositioned(element),
    });
  };

  const startBoardResize = (event: ReactPointerEvent, board: DesignBoard, handle: Handle) => {
    event.stopPropagation();
    if (editor.readOnly) return;
    capture(event);
    setDrag({
      kind: "resize-board",
      id: board.id,
      handle,
      start: toWorld(event.clientX, event.clientY),
      origin: { x: board.x, y: board.y, w: board.w, h: board.h },
    });
  };
  const startElementResize = (
    event: ReactPointerEvent,
    boardId: string,
    element: HTMLElement,
    handle: Handle,
  ) => {
    event.stopPropagation();
    if (editor.readOnly) return;
    capture(event);
    const rect = frameRect(element);
    setDrag({
      kind: "resize-element",
      boardId,
      element,
      handle,
      start: toWorld(event.clientX, event.clientY),
      origin: rect,
      free: isPositioned(element),
      left: element.offsetLeft,
      top: element.offsetTop,
    });
  };

  // ─── Rendering ─────────────────────────────────────────────────────────────────────────

  const margin = 400;
  const shown = editor.pageBoards.filter(
    (board) =>
      intersects(frameOf(board), {
        x: visibleRect.x - margin,
        y: visibleRect.y - margin,
        w: visibleRect.w + margin * 2,
        h: visibleRect.h + margin * 2,
      }) ||
      selectedBoards.has(board.id) ||
      editor.selection.element?.boardId === board.id,
  );
  const elementOutlines: { key: string; rect: Rect; element: HTMLElement; boardId: string }[] = [];
  const element = editor.selection.element;
  if (element) {
    const board = editor.boardById(element.boardId);
    const body = editor.frames.current.get(element.boardId)?.body();
    if (board && body)
      for (const path of element.paths) {
        const found = elementAt(body, path);
        if (!found) continue;
        const rect = frameRect(found);
        elementOutlines.push({
          key: path,
          rect: { x: board.x + rect.x, y: board.y + rect.y, w: rect.w, h: rect.h },
          element: found,
          boardId: board.id,
        });
      }
  }
  let hoverRect: Rect | null = null;
  if (
    editor.hover &&
    !drag &&
    !elementOutlines.some(
      (entry) => entry.key === editor.hover?.path && entry.boardId === editor.hover?.boardId,
    )
  ) {
    const board = editor.boardById(editor.hover.boardId);
    const body = editor.frames.current.get(editor.hover.boardId)?.body();
    const found = body ? elementAt(body, editor.hover.path) : null;
    if (board && found) {
      const rect = frameRect(found);
      hoverRect = { x: board.x + rect.x, y: board.y + rect.y, w: rect.w, h: rect.h };
    }
  }
  const screenRect = (rect: Rect) => {
    const at = toScreen(rect);
    return { left: at.x, top: at.y, width: rect.w * view.zoom, height: rect.h * view.zoom };
  };
  const dots = Math.max(8, 24 * view.zoom);
  const cursor =
    drag?.kind === "pan"
      ? "grabbing"
      : spaceDown || editor.tool === "hand"
        ? "grab"
        : editor.tool === "select"
          ? "default"
          : "crosshair";
  const singleBoard =
    editor.selection.boards.length === 1 && !editor.selection.notes.length
      ? editor.boardById(editor.selection.boards[0]!)
      : null;
  const singleNote =
    editor.selection.notes.length === 1 && !editor.selection.boards.length
      ? (editor.pageNotes.find((note) => note.id === editor.selection.notes[0]) ?? null)
      : null;
  const singleShape = singleNote?.kind === "shape" ? singleNote : null;
  const shapeHandles = (note: DesignNote): { handle: Handle | "p1" | "p2"; at: Point }[] => {
    if (note.shape === "line" || note.shape === "arrow") {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = note.points ?? [];
      return [
        { handle: "p1", at: toScreen({ x: note.x + x1, y: note.y + y1 }) },
        { handle: "p2", at: toScreen({ x: note.x + x2, y: note.y + y2 }) },
      ];
    }
    const box = screenRect(noteRect(note));
    return HANDLES.map((handle) => ({
      handle,
      at: {
        x: handle.includes("w")
          ? box.left
          : handle.includes("e")
            ? box.left + box.width
            : box.left + box.width / 2,
        y: handle.includes("n")
          ? box.top
          : handle.includes("s")
            ? box.top + box.height
            : box.top + box.height / 2,
      },
    }));
  };

  // The quick-action bar above a selection (not while dragging, typing or cropping).
  let selectionBar: ReactNode = null;
  if (!drag && !editor.editingText && !crop && !editingNote) {
    const outline = elementOutlines.length === 1 ? elementOutlines[0]! : null;
    if (outline && !editor.readOnly) {
      const box = screenRect(outline.rect);
      const image = outline.element.tagName === "IMG";
      selectionBar = (
        <SelectionBar
          left={box.left + box.width / 2}
          top={box.top}
          {...(image
            ? {
                onCrop: () =>
                  editor.setCropping({
                    boardId: outline.boardId,
                    path: outline.key,
                  }),
              }
            : {})}
          onDuplicate={editor.duplicateSelection}
          onDelete={editor.deleteSelection}
        />
      );
    } else if (singleNote) {
      const box = screenRect(noteRect(singleNote));
      const sticky = singleNote.kind === "sticky" || singleNote.kind === "title";
      selectionBar = (
        <SelectionBar
          left={box.left + box.width / 2}
          top={box.top}
          {...(singleNote.kind === "link" ? { onOpen: () => props.onOpenLink(singleNote) } : {})}
          {...(sticky && !editor.readOnly
            ? {
                bold: singleNote.bold === true,
                onBold: () =>
                  editor.apply([
                    {
                      op: "upsertNote",
                      note: { id: singleNote.id, bold: !singleNote.bold },
                    },
                  ]),
              }
            : {})}
          {...(!editor.readOnly
            ? { onDuplicate: editor.duplicateSelection, onDelete: editor.deleteSelection }
            : {})}
        />
      );
    }
  }

  /** Where another person's selection is, on this page. */
  const peerRects = (peer: DesignPeer): Rect[] => {
    const presence = peer.presence;
    if (!presence) return [];
    const rects: Rect[] = [];
    for (const id of presence.boards) {
      const board = editor.pageBoards.find((entry) => entry.id === id);
      if (board) rects.push({ x: board.x, y: board.y, w: board.w, h: board.h });
    }
    for (const id of presence.notes) {
      const note = editor.pageNotes.find((entry) => entry.id === id);
      if (note) rects.push(noteRect(note));
    }
    if (presence.element) {
      const board = editor.pageBoards.find((entry) => entry.id === presence.element!.boardId);
      const body = board ? editor.frames.current.get(board.id)?.body() : null;
      if (board && body)
        for (const path of presence.element.paths) {
          const found = elementAt(body, path);
          if (!found) continue;
          const rect = frameRect(found);
          rects.push({ x: board.x + rect.x, y: board.y + rect.y, w: rect.w, h: rect.h });
        }
    }
    return rects;
  };

  return (
    <div
      ref={(node) => {
        root.current = node;
        props.rootRef?.(node);
      }}
      tabIndex={-1}
      data-design-canvas=""
      className="relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-[var(--color-background-elevated-secondary)] outline-none select-none"
      style={{
        cursor,
        backgroundImage:
          "radial-gradient(color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px)",
        backgroundSize: `${dots}px ${dots}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        editor.setHover(null);
        props.onCursor?.(null);
        setPointer(null);
      }}
      onDragOver={(event) => {
        if (!editor.readOnly && [...event.dataTransfer.items].some((item) => item.kind === "file"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        const image = files.find((entry) => entry.type.startsWith("image/"));
        const video = files.find((entry) => entry.type.startsWith("video/"));
        if ((!image && !video) || editor.readOnly) return;
        event.preventDefault();
        const point = toWorld(event.clientX, event.clientY);
        const board = boardAt(point);
        const local = board ? { x: point.x - board.x, y: point.y - board.y } : null;
        if (image) return props.onRequestImage(board?.id ?? null, local ?? point, image);
        if (!board || !local || !video)
          return void toastManager.add({ type: "info", title: "把视频放到一个画板上" });
        props.onRequestVideo(board.id, local, video);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const point = toWorld(event.clientX, event.clientY);
        const board = boardAt(point);
        if (board) {
          const found = hitElement(board, point);
          const body = editor.frames.current.get(board.id)?.body();
          const path = found && body ? elementPath(found, body) : null;
          const already =
            editor.selection.element?.boardId === board.id &&
            path &&
            editor.selection.element.paths.includes(path);
          if (path && !already)
            select({ boards: [], notes: [], element: { boardId: board.id, paths: [path] } });
          else if (!path && !editor.selection.boards.includes(board.id))
            select({ boards: [board.id], notes: [], element: null });
        }
        props.onContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {shown.map((board) => {
          const frame = frameOf(board);
          const playing = props.playing === board.id;
          const editingHere = editor.editingText?.boardId === board.id;
          return (
            <div
              key={board.id}
              data-design-board={board.id}
              className={cn("absolute bg-white shadow-sm", board.hidden && "opacity-40")}
              style={{
                left: frame.x,
                top: frame.y,
                width: frame.w,
                height: frame.h,
                borderRadius: board.radius ?? 0,
              }}
            >
              <DesignBoardFrame
                board={boardResize?.id === board.id ? { ...board, w: frame.w, h: frame.h } : board}
                canvas={canvas}
                mode={playing ? "play" : "edit"}
                interactive={playing || editingHere}
                register={editor.register}
                onLoad={editor.bump}
                onNavigate={playing ? (target) => props.onNavigate(board.id, target) : undefined}
              />
              {!playing && board.guides?.some((guide) => !guide.hidden) ? (
                <BoardGuides board={board} />
              ) : null}
            </div>
          );
        })}
        {editor.pageNotes.map((original) => {
          if (original.kind !== "shape" && original.kind !== "link") return null;
          const note = shapeDraft?.id === original.id ? shapeDraft : original;
          const moving = movingNotes?.get(note.id);
          const dx = moving ? moving.x + offset.x - note.x : 0;
          const dy = moving ? moving.y + offset.y - note.y : 0;
          const rect = noteRect(note);
          const line = note.kind === "shape" && (note.shape === "line" || note.shape === "arrow");
          const pad = line ? SHAPE_HIT_PAD : 0;
          const editing = editingNote === note.id;
          return (
            <div
              key={note.id}
              data-design-note={note.id}
              data-design-shape={note.kind === "shape" ? note.shape : "link"}
              className={cn(
                "pointer-events-auto absolute",
                selectedNotes.has(note.id) &&
                  !line &&
                  "outline-2 outline-[var(--color-text-accent)]",
              )}
              style={{
                left: rect.x + dx - pad,
                top: rect.y + dy - pad,
                width: rect.w + pad * 2,
                height: rect.h + pad * 2,
              }}
              onPointerDown={(event) => {
                if (editing || editor.tool !== "select") return;
                event.stopPropagation();
                root.current?.focus({ preventScroll: true });
                capture(event);
                const notes = event.shiftKey
                  ? [...new Set([...editor.selection.notes, note.id])]
                  : selectedNotes.has(note.id)
                    ? editor.selection.notes
                    : [note.id];
                const boards =
                  event.shiftKey || selectedNotes.has(note.id) ? editor.selection.boards : [];
                select({ boards, notes, element: null });
                startMove(toWorld(event.clientX, event.clientY), boards, notes);
              }}
              onPointerMove={(event) => {
                if (dragRef.current) {
                  event.stopPropagation();
                  onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>);
                }
              }}
              onPointerUp={(event) => {
                if (dragRef.current) {
                  event.stopPropagation();
                  onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>);
                }
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (note.kind === "link") props.onOpenLink(note);
                else if (!editor.readOnly && (note.shape === "rect" || note.shape === "oval"))
                  setEditingNote(note.id);
              }}
            >
              {note.kind === "link" ? (
                <CanvasLinkCard note={note} />
              ) : editing ? (
                <textarea
                  autoFocus
                  aria-label="形状里的文字"
                  defaultValue={note.text}
                  maxLength={4_000}
                  className="block size-full resize-none bg-transparent p-2 text-center text-ui text-foreground outline-none"
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") (event.target as HTMLTextAreaElement).blur();
                  }}
                  onBlur={(event) => {
                    setEditingNote(null);
                    const text = event.target.value;
                    if (text !== note.text)
                      editor.apply([{ op: "upsertNote", note: { ...note, text } }]);
                  }}
                />
              ) : (
                <CanvasShape note={note} />
              )}
            </div>
          );
        })}
        {editor.pageNotes.map((note) => {
          if (note.kind === "shape" || note.kind === "link") return null;
          const moving = movingNotes?.get(note.id);
          const x = moving ? moving.x + offset.x : note.x;
          const y = moving ? moving.y + offset.y : note.y;
          const rect = noteRect(note);
          const editing = editingNote === note.id;
          return (
            <div
              key={note.id}
              data-design-note={note.id}
              className={cn(
                "pointer-events-auto absolute whitespace-pre-wrap",
                note.kind === "sticky" && "rounded-control-xs p-4 shadow-sm",
                selectedNotes.has(note.id) && "outline-2 outline-[var(--color-text-accent)]",
              )}
              style={{
                left: x,
                top: y,
                width: rect.w,
                ...(note.kind === "sticky"
                  ? {
                      background: NOTE_FILLS[note.color ?? "yellow"],
                      color: NOTE_INK,
                      fontSize: 15,
                      lineHeight: "21px",
                      minHeight: 96,
                      maxHeight: rect.h + 400,
                      overflow: "auto",
                    }
                  : {
                      fontSize: 72,
                      lineHeight: "88px",
                      fontWeight: 500,
                      color: "var(--foreground)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }),
                fontWeight: note.bold ? 600 : note.kind === "title" ? 500 : 400,
              }}
              onPointerDown={(event) => {
                if (editing || editor.tool !== "select") return;
                event.stopPropagation();
                root.current?.focus({ preventScroll: true });
                capture(event);
                const notes = event.shiftKey
                  ? [...new Set([...editor.selection.notes, note.id])]
                  : selectedNotes.has(note.id)
                    ? editor.selection.notes
                    : [note.id];
                const boards =
                  event.shiftKey || selectedNotes.has(note.id) ? editor.selection.boards : [];
                select({ boards, notes, element: null });
                startMove(toWorld(event.clientX, event.clientY), boards, notes);
              }}
              onPointerMove={(event) => {
                if (dragRef.current) {
                  event.stopPropagation();
                  onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>);
                }
              }}
              onPointerUp={(event) => {
                if (dragRef.current) {
                  event.stopPropagation();
                  onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>);
                }
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (!editor.readOnly) setEditingNote(note.id);
              }}
            >
              {editing ? (
                <textarea
                  autoFocus
                  aria-label={note.kind === "title" ? "标题文字" : "便签文字"}
                  defaultValue={note.text}
                  maxLength={4_000}
                  className="block h-full min-h-20 w-full resize-none bg-transparent outline-none"
                  style={{ font: "inherit", color: "inherit" }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") (event.target as HTMLTextAreaElement).blur();
                  }}
                  onBlur={(event) => {
                    setEditingNote(null);
                    const text = event.target.value;
                    if (text !== note.text)
                      editor.apply([{ op: "upsertNote", note: { ...note, text } }]);
                  }}
                />
              ) : note.text ? (
                note.text
              ) : (
                <span className="opacity-50">{note.kind === "title" ? "标题" : "双击输入"}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Screen-space chrome: name strips, outlines, handles. */}
      <div className="pointer-events-none absolute inset-0">
        {shown.map((board) => {
          const frame = frameOf(board);
          const at = toScreen(frame);
          const width = frame.w * view.zoom;
          const selected = selectedBoards.has(board.id);
          const playing = props.playing === board.id;
          return (
            <div key={board.id}>
              <div
                data-design-strip={board.id}
                className={cn(
                  "group/strip pointer-events-auto absolute flex items-center gap-1 truncate text-ui-xs",
                  selected
                    ? "text-[var(--color-text-accent)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                style={{
                  left: at.x,
                  top: at.y - STRIP_HEIGHT,
                  height: STRIP_HEIGHT,
                  maxWidth: Math.max(48, width),
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.button !== 0) return;
                  root.current?.focus({ preventScroll: true });
                  capture(event);
                  const boards = event.shiftKey
                    ? [...new Set([...editor.selection.boards, board.id])]
                    : selected
                      ? editor.selection.boards
                      : [board.id];
                  const notes = event.shiftKey || selected ? editor.selection.notes : [];
                  select({ boards, notes, element: null });
                  startMove(toWorld(event.clientX, event.clientY), boards, notes);
                }}
                onPointerMove={(event) =>
                  onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>)
                }
                onPointerUp={(event) =>
                  onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>)
                }
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!editor.readOnly) setRenaming(board.id);
                }}
              >
                {renaming === board.id ? (
                  <input
                    autoFocus
                    aria-label="画板名称"
                    defaultValue={board.name}
                    maxLength={120}
                    className="h-5 min-w-24 rounded-control-xs border border-border bg-background px-1 text-ui-xs text-foreground outline-none"
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter" || event.key === "Escape")
                        (event.target as HTMLInputElement).blur();
                    }}
                    onBlur={(event) => {
                      setRenaming(null);
                      const name = event.target.value.trim();
                      if (name && name !== board.name)
                        editor.apply([{ op: "upsertBoard", board: { id: board.id, name } }]);
                    }}
                  />
                ) : (
                  <span className="truncate">{board.name}</span>
                )}
                {board.interactive ? (
                  <IconButton
                    size="icon-xs"
                    variant="ghost"
                    label={playing ? `停止播放“${board.name}”` : `在画布上播放“${board.name}”`}
                    tooltip={playing ? "停止播放" : "播放原型"}
                    className="pointer-events-auto size-5 shrink-0 text-muted-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => props.onPlay(playing ? null : board.id)}
                  >
                    {playing ? <StopIcon className="size-3" /> : <PlayIcon className="size-3" />}
                  </IconButton>
                ) : null}
              </div>
              {selected || playing ? (
                <div
                  className={cn(
                    "absolute border-2",
                    playing
                      ? "border-[var(--color-text-success)]"
                      : "border-[var(--color-text-accent)]",
                  )}
                  style={{
                    left: at.x - 1,
                    top: at.y - 1,
                    width: width + 2,
                    height: frame.h * view.zoom + 2,
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {singleBoard && !editor.readOnly
          ? HANDLES.map((handle) => {
              const frame = frameOf(singleBoard);
              const at = toScreen(frame);
              const w = frame.w * view.zoom;
              const h = frame.h * view.zoom;
              const x = handle.includes("w")
                ? at.x
                : handle.includes("e")
                  ? at.x + w
                  : at.x + w / 2;
              const y = handle.includes("n")
                ? at.y
                : handle.includes("s")
                  ? at.y + h
                  : at.y + h / 2;
              return (
                <span
                  key={handle}
                  data-design-handle={handle}
                  className="pointer-events-auto absolute size-2 -translate-x-1/2 -translate-y-1/2 border border-[var(--color-text-accent)] bg-background"
                  style={{ left: x, top: y, cursor: handleCursor[handle] }}
                  onPointerDown={(event) => startBoardResize(event, singleBoard, handle)}
                  onPointerMove={(event) =>
                    onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>)
                  }
                  onPointerUp={(event) =>
                    onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>)
                  }
                />
              );
            })
          : null}
        {hoverRect ? (
          <div
            className="absolute border border-[var(--color-text-accent)] opacity-60"
            style={screenRect(hoverRect)}
          />
        ) : null}
        {elementOutlines.map((outline) => (
          <div
            key={outline.key}
            data-design-selected={outline.key}
            className="absolute border-2 border-[var(--color-text-accent)]"
            style={screenRect(outline.rect)}
          />
        ))}
        {elementOutlines.length === 1 && !editor.readOnly && !editor.editingText && !crop
          ? (editor.tool === "scale"
              ? (["nw", "ne", "se", "sw"] as Handle[])
              : isPositioned(elementOutlines[0]!.element)
                ? HANDLES
                : (["e", "s", "se"] as Handle[])
            ).map((handle) => {
              const outline = elementOutlines[0]!;
              const box = screenRect(outline.rect);
              const x = handle.includes("w")
                ? box.left
                : handle.includes("e")
                  ? box.left + box.width
                  : box.left + box.width / 2;
              const y = handle.includes("n")
                ? box.top
                : handle.includes("s")
                  ? box.top + box.height
                  : box.top + box.height / 2;
              return (
                <span
                  key={handle}
                  data-design-element-handle={handle}
                  className="pointer-events-auto absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-text-accent)] bg-background"
                  style={{ left: x, top: y, cursor: handleCursor[handle] }}
                  onPointerDown={(event) =>
                    editor.tool === "scale"
                      ? startElementScale(event, outline.boardId, outline.element, handle)
                      : startElementResize(event, outline.boardId, outline.element, handle)
                  }
                  onPointerMove={(event) =>
                    onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>)
                  }
                  onPointerUp={(event) =>
                    onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>)
                  }
                />
              );
            })
          : null}
        {elementOutlines.length === 1 && !drag ? (
          <span
            className="absolute rounded-inline bg-[var(--color-text-accent)] px-1 text-ui-xs text-white"
            style={{
              left: screenRect(elementOutlines[0]!.rect).left,
              top:
                screenRect(elementOutlines[0]!.rect).top +
                screenRect(elementOutlines[0]!.rect).height +
                4,
            }}
          >
            {Math.round(elementOutlines[0]!.rect.w)} × {Math.round(elementOutlines[0]!.rect.h)}
          </span>
        ) : null}
        {flowMarker ? (
          <div className="absolute bg-[var(--color-text-accent)]" style={screenRect(flowMarker)} />
        ) : null}
        {drag?.kind === "marquee" || drag?.kind === "create-board" ? (
          <div
            className={cn(
              "absolute border border-[var(--color-text-accent)]",
              drag.kind === "marquee"
                ? "bg-[color-mix(in_srgb,var(--color-text-accent)_8%,transparent)]"
                : "bg-background/60",
            )}
            style={screenRect(normalized(drag.start, drag.current))}
          />
        ) : null}
        {singleShape && !editor.readOnly && !drag
          ? shapeHandles(singleShape).map((entry) => (
              <span
                key={entry.handle}
                data-design-shape-handle={entry.handle}
                className="pointer-events-auto absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-text-accent)] bg-background"
                style={{
                  left: entry.at.x,
                  top: entry.at.y,
                  cursor:
                    entry.handle === "p1" || entry.handle === "p2"
                      ? "move"
                      : handleCursor[entry.handle],
                }}
                onPointerDown={(event) => startShapeResize(event, singleShape, entry.handle)}
                onPointerMove={(event) =>
                  onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>)
                }
                onPointerUp={(event) =>
                  onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>)
                }
              />
            ))
          : null}
        {singleShape && drag?.kind === "shape-resize" && shapeDraft ? (
          <div
            className="absolute border border-[var(--color-text-accent)]"
            style={screenRect(noteRect(shapeDraft))}
          />
        ) : null}
        {guides ? <SnapGuides guides={guides} toScreen={toScreen} zoom={view.zoom} /> : null}
        {drag?.kind === "draw" ? (
          <DrawPreview drag={drag} toScreen={toScreen} zoom={view.zoom} />
        ) : null}
        {pencil && pencil.length > 1 ? (
          <svg className="absolute inset-0 size-full overflow-visible" aria-hidden>
            <path
              d={smoothPath(pencil.map(toScreen))}
              fill="none"
              stroke="var(--color-text-accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
        {pen ? (
          <svg
            className="absolute inset-0 size-full overflow-visible"
            aria-hidden
            data-design-pen={pen.anchors.length}
          >
            <path
              d={penPath(
                [
                  ...pen.anchors.map((anchor) => ({
                    ...toScreen(anchor),
                    ...(anchor.out ? { out: toScreen(anchor.out) } : {}),
                  })),
                  ...(pointer && drag?.kind !== "pen-handle" ? [toScreen(pointer)] : []),
                ],
                false,
              )}
              fill="none"
              stroke="var(--color-text-accent)"
              strokeWidth={1.5}
            />
            {pen.anchors.map((anchor, index) => {
              const at = toScreen(anchor);
              return (
                <rect
                  key={index}
                  x={at.x - 3}
                  y={at.y - 3}
                  width={6}
                  height={6}
                  fill="var(--background)"
                  stroke="var(--color-text-accent)"
                />
              );
            })}
          </svg>
        ) : null}
        {crop ? (
          <CropOverlay
            session={crop}
            board={editor.boardById(crop.boardId)}
            toScreen={toScreen}
            zoom={view.zoom}
            onDrag={startCropDrag}
            onPointerMove={(event) =>
              onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>)
            }
            onPointerUp={(event) =>
              onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>)
            }
            onDone={() => endCrop(true)}
            onCancel={() => endCrop(false)}
          />
        ) : null}
        {selectionBar}
        {props.peers?.length ? (
          <PeerOverlay
            peers={props.peers}
            pageId={editor.pageId}
            toScreen={toScreen}
            zoom={view.zoom}
            rectOf={peerRects}
          />
        ) : null}
        {props.overlay?.(toScreen)}
      </div>
    </div>
  );
}

/** Layout guides drawn over an artboard (never in play or exports): columns, rows, a pixel grid. */
function BoardGuides(props: { board: DesignBoard }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-design-guides={props.board.id}
      aria-hidden
    >
      {(props.board.guides ?? []).map((guide, index) => {
        if (guide.hidden) return null;
        const color =
          guide.color ?? "color-mix(in srgb, var(--color-text-danger) 10%, transparent)";
        if (guide.kind === "grid")
          return (
            <div
              key={index}
              className="absolute inset-0"
              style={{
                backgroundImage: `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`,
                backgroundSize: `${guide.size}px ${guide.size}px`,
              }}
            />
          );
        const columns = guide.kind === "columns";
        return (
          <div
            key={index}
            className="absolute inset-0 grid"
            style={
              columns
                ? {
                    gridTemplateColumns: `repeat(${guide.count}, minmax(0, 1fr))`,
                    columnGap: guide.gutter,
                    paddingInline: guide.margin,
                  }
                : {
                    gridTemplateRows: `repeat(${guide.count}, minmax(0, 1fr))`,
                    rowGap: guide.gutter,
                    paddingBlock: guide.margin,
                  }
            }
          >
            {Array.from({ length: guide.count }, (_, track) => (
              <span key={track} style={{ background: color }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Snap lines and equal-gap markers while dragging (danger colour, like a measuring guide). */
function SnapGuides(props: {
  guides: { lines: readonly SnapLine[]; gaps: readonly SnapGap[] };
  toScreen: (point: Point) => Point;
  zoom: number;
}) {
  const { toScreen, zoom } = props;
  return (
    <div className="absolute inset-0" data-design-snap="" aria-hidden>
      {props.guides.lines.map((line, index) => {
        const start = toScreen(
          line.axis === "x" ? { x: line.at, y: line.from } : { x: line.from, y: line.at },
        );
        const length = (line.to - line.from) * zoom;
        return (
          <div
            key={`l${index}`}
            className="absolute bg-[var(--color-text-danger)]"
            style={
              line.axis === "x"
                ? { left: start.x, top: start.y, width: 1, height: Math.max(1, length) }
                : { left: start.x, top: start.y, width: Math.max(1, length), height: 1 }
            }
          />
        );
      })}
      {props.guides.gaps.map((gap, index) => {
        const start = toScreen(
          gap.axis === "x" ? { x: gap.start, y: gap.cross } : { x: gap.cross, y: gap.start },
        );
        const length = (gap.end - gap.start) * zoom;
        return (
          <div
            key={`g${index}`}
            className="absolute flex items-center justify-center bg-[var(--color-text-danger)]"
            style={
              gap.axis === "x"
                ? { left: start.x, top: start.y, width: Math.max(1, length), height: 1 }
                : { left: start.x, top: start.y, width: 1, height: Math.max(1, length) }
            }
          >
            <span className="rounded-inline bg-[var(--color-text-danger)] px-1 text-ui-xs whitespace-nowrap text-white">
              {Math.round(gap.end - gap.start)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The shape being drawn, before it is placed. */
function DrawPreview(props: {
  drag: Extract<Drag, { kind: "draw" }>;
  toScreen: (point: Point) => Point;
  zoom: number;
}) {
  const { drag, toScreen } = props;
  if (drag.shape === "line" || drag.shape === "arrow") {
    const a = toScreen(drag.start);
    const b = toScreen(drag.current);
    return (
      <svg className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="var(--color-text-accent)"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {drag.shape === "arrow" ? (
          <polygon points={arrowHeadPoints(a, b)} fill="var(--color-text-accent)" />
        ) : null}
      </svg>
    );
  }
  const area = normalized(drag.start, drag.current);
  const at = toScreen(area);
  return (
    <div
      className="absolute border border-[var(--color-text-accent)] bg-[color-mix(in_srgb,var(--color-text-accent)_8%,transparent)]"
      style={{
        left: at.x,
        top: at.y,
        width: area.w * props.zoom,
        height: area.h * props.zoom,
        borderRadius: drag.shape === "oval" ? "50%" : 4,
      }}
    />
  );
}

function arrowHeadPoints(a: Point, b: Point): string {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const size = 12;
  const left = {
    x: b.x - size * Math.cos(angle - Math.PI / 7),
    y: b.y - size * Math.sin(angle - Math.PI / 7),
  };
  const right = {
    x: b.x - size * Math.cos(angle + Math.PI / 7),
    y: b.y - size * Math.sin(angle + Math.PI / 7),
  };
  return `${b.x},${b.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

/** Cropping a picture: the whole picture faint behind, the kept part with handles. */
function CropOverlay(props: {
  session: CropSession;
  board: DesignBoard | undefined;
  toScreen: (point: Point) => Point;
  zoom: number;
  onDrag: (event: ReactPointerEvent, handle: Handle | "move") => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { session, board, toScreen, zoom } = props;
  if (!board) return null;
  const world = (rect: Rect) => ({
    x: board.x + rect.x,
    y: board.y + rect.y,
    w: rect.w,
    h: rect.h,
  });
  const full = world(session.full);
  const kept = world(session.rect);
  const fullAt = toScreen(full);
  const keptAt = toScreen(kept);
  const src = session.element.getAttribute("src") ?? "";
  return (
    <div className="absolute inset-0" data-design-crop="">
      <img
        alt=""
        src={src}
        draggable={false}
        className="pointer-events-none absolute opacity-35"
        style={{ left: fullAt.x, top: fullAt.y, width: full.w * zoom, height: full.h * zoom }}
      />
      <div
        className="pointer-events-auto absolute cursor-move border-2 border-[var(--color-text-accent)]"
        style={{ left: keptAt.x, top: keptAt.y, width: kept.w * zoom, height: kept.h * zoom }}
        onPointerDown={(event) => props.onDrag(event, "move")}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
      >
        {HANDLES.map((handle) => (
          <span
            key={handle}
            data-design-crop-handle={handle}
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 border border-[var(--color-text-accent)] bg-background"
            style={{
              left: handle.includes("w") ? 0 : handle.includes("e") ? "100%" : "50%",
              top: handle.includes("n") ? 0 : handle.includes("s") ? "100%" : "50%",
              cursor: handleCursor[handle],
            }}
            onPointerDown={(event) => props.onDrag(event, handle)}
            onPointerMove={props.onPointerMove}
            onPointerUp={props.onPointerUp}
          />
        ))}
      </div>
      <div
        className="pointer-events-auto absolute flex -translate-x-1/2 gap-1 rounded-control border border-border bg-popover p-0.5 shadow-md"
        style={{ left: keptAt.x + (kept.w * zoom) / 2, top: keptAt.y + kept.h * zoom + 8 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          取消
        </Button>
        <Button size="xs" onClick={props.onDone}>
          完成裁切
        </Button>
      </div>
    </div>
  );
}
