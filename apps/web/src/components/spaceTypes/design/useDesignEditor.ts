// FILE: useDesignEditor.ts
// Purpose: The state and commands of the 设计 editor: the canvas with undo/redo, the current page,
//          the view (pan/zoom), the tool, the selection, the frame registry, and every edit the
//          toolbar, keyboard, menus and panels call.
// Layer: 资料空间 设计 (web)
// Why: One place owns history and selection, so the canvas view, the panels and the keyboard
//      can never disagree about what an edit did or what is selected.

import {
  applyDesignOps,
  applyDesignOpsLeniently,
  DESIGN_LIMITS,
  designOpKey,
  diffDesignCanvas,
  nextBoardPosition,
  parseDesignCanvas,
  uniqueDesignId,
  type DesignBoard,
  type DesignCanvas,
  type DesignComponent,
  type DesignNote,
  type DesignOp,
} from "@moss/shared/spaceItems/designCanvas";
import {
  emptyBoardHtml,
  insertMarkup,
  type DesignInsertKind,
} from "@moss/shared/spaceItems/designMarkup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toastManager } from "../../ui/toast";
import {
  boardFragment,
  elementAt,
  sanitizeFragment,
  serializeBody,
  type DesignElementPath,
} from "./designDocument";
import {
  boardRoot,
  duplicate,
  flip,
  frameRect,
  insertInto,
  pasteAfter,
  pathsOf,
  remove,
  reorder,
  resolve,
  setStyle,
  ungroup,
  wrap,
  type DesignWrapKind,
} from "./designEdits";
import type { DesignFrameHandle } from "./DesignBoardFrame";
import {
  componentFromElement,
  detachInstance,
  instanceMarkup,
  instanceRoot,
  syncInstances,
} from "./designComponents";
import { applyScale, scaleSnapshot } from "./designTransforms";

export type DesignTool =
  | "select"
  | "hand"
  | "text"
  | "frame"
  | "note"
  | "rect"
  | "oval"
  | "line"
  | "arrow"
  | "pencil"
  | "pen"
  | "scale"
  | "image"
  | "comment";

export interface DesignSelection {
  readonly boards: readonly string[];
  readonly notes: readonly string[];
  readonly element: {
    readonly boardId: string;
    readonly paths: readonly DesignElementPath[];
  } | null;
}
export const EMPTY_SELECTION: DesignSelection = { boards: [], notes: [], element: null };

export interface DesignView {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const ZOOM_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8,
] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

const HISTORY_LIMIT = 100;
const COALESCE_MS = 900;

interface Clipboard {
  readonly kind: "elements" | "boards";
  readonly html?: string;
  readonly boards?: readonly DesignBoard[];
  readonly notes?: readonly DesignNote[];
}

export interface DesignEditorOptions {
  readonly initial: DesignCanvas;
  /** Bumped when the payload was replaced from outside (an agent's write, a conflict reload). */
  readonly epoch: number;
  readonly readOnly: boolean;
  /** This person changed the canvas from `previous` to `canvas`. */
  readonly onChange: (canvas: DesignCanvas, previous: DesignCanvas) => void;
}

/** One undo step: the canvas before and after this person's edit. */
interface Step {
  readonly before: DesignCanvas;
  after: DesignCanvas;
}

/** What a step touched, so undo puts back only those things (others' edits stay). */
const stepKeys = (step: Step) =>
  new Set(diffDesignCanvas(step.before, step.after).map(designOpKey));

/** The ops that move `current` to `target` for the things `keys` names only. */
function towards(current: DesignCanvas, target: DesignCanvas, keys: ReadonlySet<string>) {
  const ops = diffDesignCanvas(current, target).filter((op) => keys.has(designOpKey(op)));
  return applyDesignOpsLeniently(current, ops).canvas;
}

export function useDesignEditor(options: DesignEditorOptions) {
  const [canvas, setCanvas] = useState(options.initial);
  const [pageId, setPageId] = useState(
    options.initial.launch?.pageId ?? options.initial.pages[0]!.id,
  );
  const [view, setView] = useState<DesignView>({ x: 80, y: 80, zoom: 0.5 });
  const [tool, setTool] = useState<DesignTool>("select");
  const [selection, setSelectionState] = useState<DesignSelection>(EMPTY_SELECTION);
  const [hover, setHover] = useState<{ boardId: string; path: DesignElementPath } | null>(null);
  const [editingText, setEditingText] = useState<{
    boardId: string;
    path: DesignElementPath;
  } | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  /** A picture being cropped on the canvas (double-click it, or 裁切 in the bar or panel). */
  const [cropping, setCropping] = useState<{ boardId: string; path: DesignElementPath } | null>(
    null,
  );
  const [history, setHistory] = useState({ past: 0, future: 0 });
  const past = useRef<Step[]>([]);
  const future = useRef<Step[]>([]);
  const coalesce = useRef<{ key: string; at: number } | null>(null);
  const frames = useRef(new Map<string, DesignFrameHandle>());
  const clipboard = useRef<Clipboard | null>(null);
  const propsClipboard = useRef<string | null>(null);
  const latest = useRef(canvas);
  latest.current = canvas;
  const onChange = useRef(options.onChange);
  onChange.current = options.onChange;

  // An outside replacement (agent write, conflict reload) is one undo step of its own.
  const epoch = useRef(options.epoch);
  useEffect(() => {
    if (options.epoch === epoch.current) return;
    epoch.current = options.epoch;
    const previous = latest.current;
    if (JSON.stringify(previous) === JSON.stringify(options.initial)) return;
    past.current = [...past.current, { before: previous, after: options.initial }].slice(
      -HISTORY_LIMIT,
    );
    future.current = [];
    coalesce.current = null;
    latest.current = options.initial;
    setCanvas(options.initial);
    setHistory({ past: past.current.length, future: 0 });
    if (!options.initial.pages.some((page) => page.id === pageId))
      setPageId(options.initial.pages[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.epoch]);

  const bump = useCallback(() => setLayoutTick((tick) => tick + 1), []);

  /** Records `next` as the canvas: one undo step (or merged into the last one with the same key). */
  const commit = useCallback(
    (next: DesignCanvas, coalesceKey?: string) => {
      if (options.readOnly) return;
      const previous = latest.current;
      if (next === previous) return;
      const now = Date.now();
      const merge =
        coalesceKey !== undefined &&
        coalesce.current?.key === coalesceKey &&
        now - coalesce.current.at < COALESCE_MS &&
        past.current.length > 0;
      if (merge) past.current.at(-1)!.after = next;
      else
        past.current = [...past.current, { before: previous, after: next }].slice(-HISTORY_LIMIT);
      future.current = [];
      coalesce.current = coalesceKey === undefined ? null : { key: coalesceKey, at: now };
      latest.current = next;
      setCanvas(next);
      setHistory({ past: past.current.length, future: 0 });
      onChange.current(next, previous);
    },
    [options.readOnly],
  );

  const apply = useCallback(
    (ops: readonly DesignOp[], coalesceKey?: string): boolean => {
      try {
        commit(applyDesignOps(latest.current, ops), coalesceKey);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "这个修改没有生效",
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      }
    },
    [commit],
  );

  const restore = useCallback((target: DesignCanvas) => {
    const previous = latest.current;
    latest.current = target;
    setCanvas(target);
    coalesce.current = null;
    setHistory({ past: past.current.length, future: future.current.length });
    onChange.current(target, previous);
    setSelectionState((current) => validSelection(target, current, frames.current));
    setEditingText(null);
  }, []);
  // Undo puts back only what this person's step changed; edits others made since stay.
  const undo = useCallback(() => {
    const step = past.current.pop();
    if (!step) return;
    future.current = [step, ...future.current];
    restore(towards(latest.current, step.before, stepKeys(step)));
  }, [restore]);
  const redo = useCallback(() => {
    const [step, ...rest] = future.current;
    if (!step) return;
    future.current = rest;
    past.current = [...past.current, step];
    restore(towards(latest.current, step.after, stepKeys(step)));
  }, [restore]);

  /** The live room changed the canvas (someone else's edit): shown, never an undo step. */
  const receive = useCallback((next: DesignCanvas) => {
    latest.current = next;
    setCanvas(next);
    coalesce.current = null;
    setSelectionState((current) => validSelection(next, current, frames.current));
    setPageId((current) =>
      next.pages.some((page) => page.id === current) ? current : next.pages[0]!.id,
    );
  }, []);

  const setSelection = useCallback((next: DesignSelection) => {
    setSelectionState(next);
    setEditingText(null);
  }, []);

  const register = useCallback((boardId: string, handle: DesignFrameHandle | null) => {
    if (handle) frames.current.set(boardId, handle);
    else frames.current.delete(boardId);
  }, []);

  const boardById = useCallback(
    (id: string) => latest.current.boards.find((board) => board.id === id),
    [],
  );

  /**
   * Runs a DOM edit on one artboard's frame and records the serialized result. `edit` returns
   * the element paths to select afterwards (or undefined to keep the selection).
   */
  const editBoard = useCallback(
    (
      boardId: string,
      edit: (body: HTMLElement) => DesignElementPath[] | undefined | void,
      coalesceKey?: string,
    ): boolean => {
      if (options.readOnly) return false;
      const handle = frames.current.get(boardId);
      const body = handle?.body();
      const board = latest.current.boards.find((entry) => entry.id === boardId);
      if (!handle || !body || !board) {
        toastManager.add({ type: "info", title: "画板还在载入，请稍后再试" });
        return false;
      }
      const select = edit(body);
      const html = serializeBody(body);
      if (html.length > DESIGN_LIMITS.boardHtml) {
        toastManager.add({
          type: "error",
          title: "这个画板太大了，改动没有保存",
          description: "请把图片换成更小的，或把内容拆到另一个画板。",
        });
        // Put the stored source back on screen; the oversized DOM is dropped.
        body.innerHTML = sanitizeFragment(boardFragment(board.html), "edit");
        handle.written = board.html;
        bump();
        return false;
      }
      handle.written = html;
      if (html !== board.html) {
        commit(
          {
            ...latest.current,
            boards: latest.current.boards.map((entry) =>
              entry.id === boardId ? { ...entry, html } : entry,
            ),
          },
          coalesceKey,
        );
      }
      if (select)
        setSelectionState({
          boards: [],
          notes: [],
          element: select.length ? { boardId, paths: select } : null,
        });
      bump();
      return true;
    },
    [bump, commit, options.readOnly],
  );

  const pageBoards = useMemo(
    () => canvas.boards.filter((board) => board.page === pageId),
    [canvas.boards, pageId],
  );
  const pageNotes = useMemo(
    () => canvas.notes.filter((note) => note.page === pageId),
    [canvas.notes, pageId],
  );

  // ─── Artboards and notes ───────────────────────────────────────────────────────────────

  const addBoard = useCallback(
    (frame?: { x: number; y: number; w: number; h: number }, name = "画板") => {
      const size = frame ?? { w: 1280, h: 800 };
      const at = frame ?? { ...nextBoardPosition(latest.current, pageId, size), ...size };
      const id = uniqueDesignId(latest.current, "board");
      const count = latest.current.boards.length + 1;
      const ok = apply([
        {
          op: "upsertBoard",
          board: {
            id,
            name: `${name} ${count}`,
            page: pageId,
            x: Math.round(at.x),
            y: Math.round(at.y),
            w: Math.round(size.w),
            h: Math.round(size.h),
            html: emptyBoardHtml(Math.round(size.w), Math.round(size.h)),
          },
        },
      ]);
      if (ok) setSelection({ boards: [id], notes: [], element: null });
      return ok ? id : null;
    },
    [apply, pageId, setSelection],
  );

  const addNote = useCallback(
    (at: { x: number; y: number }, kind: DesignNote["kind"] = "sticky") => {
      const id = uniqueDesignId(latest.current, kind === "title" ? "title" : "note");
      const ok = apply([
        {
          op: "upsertNote",
          note: {
            id,
            page: pageId,
            kind,
            x: Math.round(at.x),
            y: Math.round(at.y),
            ...(kind === "sticky" ? { w: 240, color: "yellow" as const } : { w: 1200 }),
            text: "",
          },
        },
      ]);
      if (ok) setSelection({ boards: [], notes: [id], element: null });
      return ok ? id : null;
    },
    [apply, pageId, setSelection],
  );

  /** Fits an artboard's height to its content (the root's scroll height). */
  const fitBoardHeight = useCallback(
    (boardId: string) => {
      const body = frames.current.get(boardId)?.body();
      const board = boardById(boardId);
      if (!body || !board) return;
      const root = boardRoot(body);
      const height = Math.ceil(Math.max(root?.scrollHeight ?? 0, body.scrollHeight));
      if (height < 40 || height === board.h) {
        toastManager.add({ type: "info", title: "画板已经和内容一样高" });
        return;
      }
      apply([{ op: "moveBoard", id: boardId, h: Math.min(DESIGN_LIMITS.frameMax, height) }]);
    },
    [apply, boardById],
  );

  // ─── Element commands ──────────────────────────────────────────────────────────────────

  const selectedElements = useCallback((): {
    boardId: string;
    body: HTMLElement;
    elements: HTMLElement[];
  } | null => {
    const element = selection.element;
    if (!element) return null;
    const body = frames.current.get(element.boardId)?.body();
    if (!body) return null;
    const elements = resolve(body, element.paths);
    return elements.length ? { boardId: element.boardId, body, elements } : null;
  }, [selection.element]);

  const insert = useCallback(
    (boardId: string, kind: DesignInsertKind, at: { x: number; y: number }, src?: string) => {
      let inserted: HTMLElement | null = null;
      editBoard(boardId, (body) => {
        const root = boardRoot(body);
        if (!root) return [];
        const rootRect = frameRect(root);
        inserted = insertInto(
          root,
          insertMarkup(kind, { x: at.x - rootRect.x, y: at.y - rootRect.y }, src),
        );
        return inserted ? pathsOf(body, [inserted]) : [];
      });
      setTool("select");
      return inserted;
    },
    [editBoard],
  );

  /** Places ready markup (a drawing, a video, a component instance) in an artboard's root. */
  const insertHtml = useCallback(
    (boardId: string, html: string) => {
      let inserted: HTMLElement | null = null;
      editBoard(boardId, (body) => {
        const root = boardRoot(body);
        if (!root || !html) return [];
        inserted = insertInto(root, html);
        return inserted ? pathsOf(body, [inserted]) : [];
      });
      setTool("select");
      return inserted as HTMLElement | null;
    },
    [editBoard],
  );

  /** A loose shape, picture or link card on the canvas (outside any artboard). */
  const addCanvasNote = useCallback(
    (note: Omit<DesignNote, "id" | "page"> & { id?: string }) => {
      const base = note.kind === "link" ? "link" : note.shape === "image" ? "picture" : "shape";
      const id = note.id ?? uniqueDesignId(latest.current, base);
      const ok = apply([{ op: "upsertNote", note: { ...note, id, page: pageId } }]);
      if (ok) setSelection({ boards: [], notes: [id], element: null });
      setTool("select");
      return ok ? id : null;
    },
    [apply, pageId, setSelection],
  );

  // ─── Components ────────────────────────────────────────────────────────────────────────

  /** Every component this design can place: its own, then its design system's. */
  const components = useMemo(
    () => [...(canvas.components ?? []), ...(canvas.system?.components ?? [])],
    [canvas.components, canvas.system],
  );

  /** Writes `component` into every instance on every artboard, as one undo step. */
  const syncComponent = useCallback(
    (component: DesignComponent, extra: readonly DesignOp[] = []) => {
      const doc = window.document.implementation.createHTMLDocument("");
      let changed = 0;
      const boards = latest.current.boards.map((board) => {
        if (!board.html.includes(component.id)) return board;
        // Parsed inert (no frame, no scripts run); the stored source keeps its own scripts.
        doc.body.innerHTML = boardFragment(board.html);
        const count = syncInstances(doc.body, component);
        if (!count) return board;
        changed += count;
        return { ...board, html: serializeBody(doc.body) };
      });
      if (!changed && !extra.length) return 0;
      commit(applyDesignOps({ ...latest.current, boards }, extra));
      return changed;
    },
    [commit],
  );

  const createComponent = useCallback(
    (name?: string) => {
      const current = selectedElements();
      if (!current || current.elements.length !== 1) {
        toastManager.add({ type: "info", title: "只选中一个元素，才能做成组件" });
        return null;
      }
      const element = current.elements[0]!;
      if (element === boardRoot(current.body)) {
        toastManager.add({ type: "info", title: "画板的根元素不能做成组件，请选中里面的内容" });
        return null;
      }
      const id = uniqueDesignId(latest.current, `component-${layerName(element)}`);
      // Marks the element as the first instance; the edit below stores that mark.
      const component = componentFromElement(element, id, name?.trim() || layerName(element));
      // One undo step: the mark and the component share a coalescing key.
      const key = `component:${id}`;
      if (!editBoard(current.boardId, (body) => pathsOf(body, [element]), key)) return null;
      if (!apply([{ op: "upsertComponent", component }], key)) return null;
      toastManager.add({ type: "success", title: `已做成组件“${component.name}”` });
      return id;
    },
    [apply, editBoard, selectedElements],
  );

  const placeComponent = useCallback(
    (componentId: string, boardId: string, at?: { x: number; y: number }) => {
      // The current design, not the last render: a component made a moment ago is placeable.
      const current = latest.current;
      const component = [...(current.components ?? []), ...(current.system?.components ?? [])].find(
        (entry) => entry.id === componentId,
      );
      const doc = frames.current.get(boardId)?.doc();
      if (!component || !doc) {
        toastManager.add({ type: "info", title: "先在画布上选中一个画板，再放组件" });
        return null;
      }
      return insertHtml(boardId, instanceMarkup(doc, component, at));
    },
    [insertHtml],
  );

  /** Makes the selected instance the component's master and updates every other instance. */
  const pushInstanceToComponent = useCallback(() => {
    const current = selectedElements();
    const instance = current?.elements[0] ? instanceRoot(current.elements[0]) : null;
    const id = instance?.getAttribute("data-design-component");
    const own = latest.current.components?.find((entry) => entry.id === id);
    if (!instance || !own) {
      toastManager.add({ type: "info", title: "选中这份设计里某个组件的实例，才能用它更新组件" });
      return;
    }
    const component = componentFromElement(instance, own.id, own.name);
    const updated = { ...own, html: component.html };
    const count = syncComponent(updated, [{ op: "upsertComponent", component: updated }]);
    toastManager.add({ type: "success", title: `已更新组件，${count} 个实例跟着变了` });
  }, [selectedElements, syncComponent]);

  const detachSelection = useCallback(() => {
    const current = selectedElements();
    const instance = current?.elements[0] ? instanceRoot(current.elements[0]) : null;
    if (!current || !instance) {
      toastManager.add({ type: "info", title: "选中的不是组件实例" });
      return;
    }
    editBoard(current.boardId, () => void detachInstance(instance));
  }, [editBoard, selectedElements]);

  /** Scales the selected elements and everything inside them by `factor`. */
  const scaleSelection = useCallback(
    (factor: number) => {
      const current = selectedElements();
      if (!current || !Number.isFinite(factor) || factor <= 0) return;
      const root = boardRoot(current.body);
      const elements = current.elements.filter((element) => element !== root);
      if (!elements.length) {
        toastManager.add({ type: "info", title: "选中画板里的内容再缩放；画板请改尺寸" });
        return;
      }
      editBoard(current.boardId, () => {
        for (const element of elements) applyScale(scaleSnapshot(element), factor);
        return undefined;
      });
    },
    [editBoard, selectedElements],
  );

  const deleteSelection = useCallback(() => {
    const current = selectedElements();
    if (current) {
      const root = boardRoot(current.body);
      const removable = current.elements.filter((element) => element !== root);
      if (!removable.length) {
        toastManager.add({ type: "info", title: "画板的根元素不能删除，可以删除整个画板" });
        return;
      }
      editBoard(current.boardId, () => {
        remove(removable);
        return [];
      });
      return;
    }
    if (selection.boards.length || selection.notes.length) {
      apply([
        ...selection.boards.map((id) => ({ op: "deleteBoard", id }) as const),
        ...selection.notes.map((id) => ({ op: "deleteNote", id }) as const),
      ]);
      setSelection(EMPTY_SELECTION);
    }
  }, [apply, editBoard, selectedElements, selection.boards, selection.notes, setSelection]);

  const duplicateSelection = useCallback(() => {
    const current = selectedElements();
    if (current) {
      const root = boardRoot(current.body);
      if (current.elements.includes(root!)) return duplicateBoards([current.boardId]);
      editBoard(current.boardId, (body) => pathsOf(body, duplicate(current.elements)));
      return;
    }
    if (selection.boards.length) duplicateBoards(selection.boards);
    else if (selection.notes.length) {
      const ids: string[] = [];
      const ops: DesignOp[] = [];
      let working = latest.current;
      for (const id of selection.notes) {
        const note = working.notes.find((entry) => entry.id === id);
        if (!note) continue;
        const copy = uniqueDesignId(working, note.id);
        ids.push(copy);
        ops.push({ op: "upsertNote", note: { ...note, id: copy, x: note.x + 24, y: note.y + 24 } });
        working = { ...working, notes: [...working.notes, { ...note, id: copy }] };
      }
      if (apply(ops)) setSelection({ boards: [], notes: ids, element: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, editBoard, selectedElements, selection.boards, selection.notes, setSelection]);

  const duplicateBoards = useCallback(
    (ids: readonly string[]) => {
      const ops: DesignOp[] = [];
      const made: string[] = [];
      let working = latest.current;
      for (const id of ids) {
        const board = working.boards.find((entry) => entry.id === id);
        if (!board) continue;
        const copy = uniqueDesignId(working, board.id);
        const at = nextBoardPosition(working, board.page, board);
        const next = { ...board, id: copy, name: `${board.name} 副本`, x: at.x, y: at.y };
        ops.push({ op: "upsertBoard", board: next });
        working = { ...working, boards: [...working.boards, next] };
        made.push(copy);
      }
      if (ops.length && apply(ops)) setSelection({ boards: made, notes: [], element: null });
    },
    [apply, setSelection],
  );

  const wrapSelection = useCallback(
    (kind: DesignWrapKind) => {
      const current = selectedElements();
      if (!current) return;
      const root = boardRoot(current.body);
      if (current.elements.includes(root!)) {
        toastManager.add({ type: "info", title: "画板的根元素不能再放进分组" });
        return;
      }
      editBoard(current.boardId, (body) => {
        const box = wrap(current.elements, kind);
        if (!box) {
          toastManager.add({ type: "info", title: "只能把同一层的元素放进一个分组" });
          return undefined;
        }
        return pathsOf(body, [box]);
      });
    },
    [editBoard, selectedElements],
  );

  const ungroupSelection = useCallback(() => {
    const current = selectedElements();
    if (!current || current.elements.length !== 1) return;
    const root = boardRoot(current.body);
    if (current.elements[0] === root) {
      toastManager.add({ type: "info", title: "画板的根元素不能取消分组" });
      return;
    }
    editBoard(current.boardId, (body) => {
      const children = ungroup(current.elements[0]!);
      if (!children) {
        toastManager.add({ type: "info", title: "这个元素不是分组，不能取消分组" });
        return undefined;
      }
      return pathsOf(body, children);
    });
  }, [editBoard, selectedElements]);

  const reorderSelection = useCallback(
    (to: "front" | "back" | "forward" | "backward") => {
      const current = selectedElements();
      if (current) {
        editBoard(current.boardId, (body) => {
          reorder(current.elements, to);
          return pathsOf(body, current.elements);
        });
        return;
      }
      if (selection.boards.length)
        apply(
          selection.boards.map((id) => {
            const index = latest.current.boards.findIndex((board) => board.id === id);
            return {
              op: "reorderBoard" as const,
              id,
              to:
                to === "front"
                  ? ("front" as const)
                  : to === "back"
                    ? ("back" as const)
                    : index + (to === "forward" ? 1 : -1),
            };
          }),
        );
    },
    [apply, editBoard, selectedElements, selection.boards],
  );

  const flipSelection = useCallback(
    (axis: "x" | "y") => {
      const current = selectedElements();
      if (!current) {
        if (selection.boards.length)
          toastManager.add({ type: "info", title: "画板不能翻转，请选中画板里的内容" });
        return;
      }
      editBoard(current.boardId, () => {
        for (const element of current.elements) flip(element, axis);
        return undefined;
      });
    },
    [editBoard, selectedElements, selection.boards.length],
  );

  const copySelection = useCallback(
    (cut = false) => {
      const current = selectedElements();
      if (current) {
        const html = current.elements.map((element) => element.outerHTML).join("\n");
        clipboard.current = { kind: "elements", html };
        void navigator.clipboard?.writeText(html).catch(() => undefined);
        if (cut) deleteSelection();
        return;
      }
      const boards = latest.current.boards.filter((board) => selection.boards.includes(board.id));
      const notes = latest.current.notes.filter((note) => selection.notes.includes(note.id));
      if (!boards.length && !notes.length) return;
      clipboard.current = { kind: "boards", boards, notes };
      if (cut) deleteSelection();
    },
    [deleteSelection, selectedElements, selection.boards, selection.notes],
  );

  const paste = useCallback(() => {
    const copied = clipboard.current;
    if (!copied) {
      toastManager.add({ type: "info", title: "还没有复制任何内容" });
      return;
    }
    if (copied.kind === "elements") {
      const target = selection.element?.boardId ?? selection.boards[0];
      if (!target) {
        toastManager.add({ type: "info", title: "先选中一个画板或元素，再粘贴" });
        return;
      }
      const current = selectedElements();
      editBoard(target, (body) => {
        const after = current?.elements.at(-1) ?? null;
        const root = boardRoot(body);
        return pathsOf(body, pasteAfter(body, after === root ? null : after, copied.html ?? ""));
      });
      return;
    }
    const ops: DesignOp[] = [];
    const boards: string[] = [];
    const notes: string[] = [];
    let working = latest.current;
    for (const board of copied.boards ?? []) {
      const id = uniqueDesignId(working, board.id);
      const at = nextBoardPosition(working, pageId, board);
      const next = { ...board, id, page: pageId, x: at.x, y: at.y };
      ops.push({ op: "upsertBoard", board: next });
      working = { ...working, boards: [...working.boards, next] };
      boards.push(id);
    }
    for (const note of copied.notes ?? []) {
      const id = uniqueDesignId(working, note.id);
      const next = { ...note, id, page: pageId, x: note.x + 40, y: note.y + 40 };
      ops.push({ op: "upsertNote", note: next });
      working = { ...working, notes: [...working.notes, next] };
      notes.push(id);
    }
    if (ops.length && apply(ops)) setSelection({ boards, notes, element: null });
  }, [
    apply,
    editBoard,
    pageId,
    selectedElements,
    selection.boards,
    selection.element,
    setSelection,
  ]);

  const copyProperties = useCallback(() => {
    const current = selectedElements();
    if (!current || current.elements.length !== 1) {
      toastManager.add({ type: "info", title: "只选中一个元素，才能复制它的属性" });
      return;
    }
    propsClipboard.current = current.elements[0]!.getAttribute("style") ?? "";
    toastManager.add({ type: "success", title: "已复制属性" });
  }, [selectedElements]);

  const pasteProperties = useCallback(() => {
    const current = selectedElements();
    if (propsClipboard.current === null) {
      toastManager.add({ type: "info", title: "先复制一个元素的属性" });
      return;
    }
    if (!current) {
      toastManager.add({ type: "info", title: "先选中要粘贴属性的元素" });
      return;
    }
    const style = propsClipboard.current;
    editBoard(current.boardId, () => {
      for (const element of current.elements) {
        // Keep where it sits; take how it looks.
        const keep = ["position", "left", "top", "right", "bottom"].map(
          (name) => [name, element.style.getPropertyValue(name)] as const,
        );
        element.setAttribute("style", style);
        for (const [name, value] of keep) setStyle(element, name, value);
      }
      return undefined;
    });
  }, [editBoard, selectedElements]);

  const selectAll = useCallback(() => {
    const current = selectedElements();
    if (current) {
      const parent = current.elements[0]!.parentElement;
      if (parent && parent !== current.body) {
        setSelection({
          boards: [],
          notes: [],
          element: { boardId: current.boardId, paths: pathsOf(current.body, [...parent.children]) },
        });
        return;
      }
    }
    setSelection({
      boards: pageBoards.map((board) => board.id),
      notes: pageNotes.map((note) => note.id),
      element: null,
    });
  }, [pageBoards, pageNotes, selectedElements, setSelection]);

  // ─── Pages ─────────────────────────────────────────────────────────────────────────────

  const addPage = useCallback(() => {
    if (latest.current.pages.length >= DESIGN_LIMITS.pages) {
      toastManager.add({ type: "info", title: `一份设计最多 ${DESIGN_LIMITS.pages} 页` });
      return;
    }
    const id = uniqueDesignId(latest.current, "page");
    if (
      apply([{ op: "upsertPage", page: { id, name: `页面 ${latest.current.pages.length + 1}` } }])
    ) {
      setPageId(id);
      setSelection(EMPTY_SELECTION);
    }
  }, [apply, setSelection]);
  const renamePage = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim().slice(0, 60);
      if (trimmed) apply([{ op: "upsertPage", page: { id, name: trimmed } }]);
    },
    [apply],
  );
  const deletePage = useCallback(
    (id: string) => {
      if (latest.current.pages.length <= 1) {
        toastManager.add({ type: "info", title: "设计里至少要有一页" });
        return;
      }
      const remaining = latest.current.pages.filter((page) => page.id !== id);
      if (apply([{ op: "deletePage", id }])) {
        if (pageId === id) setPageId(remaining[0]!.id);
        setSelection(EMPTY_SELECTION);
        toastManager.add({ type: "info", title: "已删除页面，按 Ctrl+Z 可以撤销" });
      }
    },
    [apply, pageId, setSelection],
  );

  const selectPage = useCallback(
    (id: string) => {
      setPageId(id);
      setSelection(EMPTY_SELECTION);
    },
    [setSelection],
  );

  return {
    canvas,
    pageId,
    page: canvas.pages.find((page) => page.id === pageId) ?? canvas.pages[0]!,
    pageBoards,
    pageNotes,
    view,
    setView,
    tool,
    setTool,
    selection,
    setSelection,
    hover,
    setHover,
    editingText,
    setEditingText,
    cropping,
    setCropping,
    layoutTick,
    bump,
    frames,
    register,
    readOnly: options.readOnly,
    canUndo: history.past > 0,
    canRedo: history.future > 0,
    commit,
    apply,
    undo,
    redo,
    editBoard,
    boardById,
    selectedElements,
    insert,
    addBoard,
    addNote,
    fitBoardHeight,
    insertHtml,
    addCanvasNote,
    components,
    syncComponent,
    createComponent,
    placeComponent,
    pushInstanceToComponent,
    detachSelection,
    scaleSelection,
    receive,
    deleteSelection,
    duplicateSelection,
    wrapSelection,
    ungroupSelection,
    reorderSelection,
    flipSelection,
    copySelection,
    paste,
    copyProperties,
    pasteProperties,
    selectAll,
    addPage,
    renamePage,
    deletePage,
    selectPage,
    latest,
  };
}

export type DesignEditorState = ReturnType<typeof useDesignEditor>;

/** Drops selected things that no longer exist after an undo/redo or an outside change. */
function validSelection(
  canvas: DesignCanvas,
  selection: DesignSelection,
  frames: ReadonlyMap<string, DesignFrameHandle>,
): DesignSelection {
  const boards = selection.boards.filter((id) => canvas.boards.some((board) => board.id === id));
  const notes = selection.notes.filter((id) => canvas.notes.some((note) => note.id === id));
  let element = selection.element;
  if (element && !canvas.boards.some((board) => board.id === element!.boardId)) element = null;
  if (element) {
    const body = frames.get(element.boardId)?.body();
    // The frame reloads after an undo; keep paths, they are checked again on the next edit.
    if (body && element.paths.some((path) => !elementAt(body, path))) element = null;
  }
  return { boards, notes, element };
}

/** A short slug-friendly name for an element (for ids and default component names). */
function layerName(element: HTMLElement): string {
  return (
    element.getAttribute("data-name") ??
    element.getAttribute("aria-label") ??
    ((element.textContent ?? "").trim().slice(0, 12) || element.tagName.toLowerCase())
  );
}

export function parseCanvasOrNull(data: string): DesignCanvas | null {
  try {
    return parseDesignCanvas(data);
  } catch {
    return null;
  }
}
