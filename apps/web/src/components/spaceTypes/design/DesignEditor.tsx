// FILE: DesignEditor.tsx
// Purpose: The 设计 editor: tool row (pages, tools, undo/redo, zoom, play, comments, 让 Moss 修改,
//          导出, panel), the canvas, the right panel, keyboard shortcuts, the context menu, the
//          empty state, comments with @Moss, image upload, play and the agent turns.
// Layer: 资料空间 设计 (web). SpaceTypedItemView renders it for `design` items and saves its changes.

import type { PagesReadResult, PageTypedItem, SpaceId } from "@moss/contracts";
import {
  applyDesignOpsLeniently,
  boardsInReadingOrder,
  diffDesignCanvas,
  type DesignBoard,
  type DesignCanvas,
  type DesignNote,
  type DesignPaper,
} from "@moss/shared/spaceItems/designCanvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { downloadBlob } from "~/lib/browserDownload";
import { uploadLibraryFiles } from "~/lib/libraryUpload";
import { cn } from "~/lib/utils";
import { openSpacePage, spacePageIdOfLink } from "~/lib/spacePageLink";
import { ensureNativeApi } from "~/nativeApi";
import {
  ArtboardToolIcon,
  ChevronDownIcon,
  DownloadIcon,
  HandToolIcon,
  ExpandArrowsIcon,
  PageCommentIcon,
  PanelRightOpenIcon,
  PenToolIcon,
  PictureIcon,
  PlayIcon,
  PointerIcon,
  Redo2Icon,
  SketchArrowIcon,
  SketchEllipseIcon,
  SketchLineIcon,
  SketchPenIcon,
  SketchRectangleIcon,
  SketchTextIcon,
  SparklesIcon,
  StickyNoteIcon,
  Undo2Icon,
  type LucideIcon,
} from "~/lib/icons";
import {
  usePageComments,
  usePageCommentsStore,
  type PageComment,
  type PageCommentAuthor,
} from "~/pageCommentsStore";
import { CommentPin, NewCommentCard, ThreadCard } from "../../chat/pageComments/PageComments";
import {
  pageCommentInitials,
  pageCommentMentionsAgent,
} from "../../chat/pageComments/pageComments.logic";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import {
  SpaceSidePanel,
  SpaceToolbarButton,
  SpaceToolbarDivider,
} from "../shared/SpaceEditorChrome";
import { DeckCommentAgentReplies, postDeckComment } from "../slides/deckComments";
import {
  designChangePrompt,
  designGeneratePrompt,
  takeDesignGeneration,
  type DesignViewContext,
} from "./designAiPrompt";
import { DesignCanvasView, noteRect, type DesignCommentTarget } from "./DesignCanvasView";
import { elementAt, layerLabel } from "./designDocument";
import {
  boardRoot,
  frameRect,
  isPositioned,
  nudge,
  siblingOf,
  firstChild,
  parentOf,
} from "./designEdits";
import {
  boardSvg,
  copyBoardPng,
  copyHtml,
  copySvg,
  elementSvg,
  exportBoardPng,
  exportBoardSvg,
  exportBoardsHtmlZip,
  exportBoardsPdf,
  exportBoardsPngZip,
  exportName,
  type DesignExportScale,
} from "./designExport";
import { instanceRoot } from "./designComponents";
import { DesignLinkDialog } from "./DesignLinkDialog";
import {
  DesignRoomClient,
  designRoomUrl,
  peerColor,
  type DesignPeer,
  type DesignRoomStatus,
} from "./designRoom";
import { DesignInspector, type DesignPanelTab } from "./DesignInspector";
import { DesignPlayer } from "./DesignPlayer";
import {
  clampZoom,
  EMPTY_SELECTION,
  useDesignEditor,
  ZOOM_STEPS,
  type DesignTool,
} from "./useDesignEditor";

const RUN_TIMEOUT_MS = 10 * 60_000;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

interface ToolEntry {
  readonly tool: DesignTool;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly key: string;
  /** The shortcut needs Shift (Shift+L arrow, Shift+P pen). */
  readonly shift?: boolean;
}
const TOOLS: readonly ToolEntry[] = [
  { tool: "select", icon: PointerIcon, label: "选择", key: "V" },
  { tool: "hand", icon: HandToolIcon, label: "抓手（或按住空格）", key: "H" },
  { tool: "frame", icon: ArtboardToolIcon, label: "画板", key: "A" },
  { tool: "text", icon: SketchTextIcon, label: "文字", key: "T" },
  { tool: "rect", icon: SketchRectangleIcon, label: "矩形", key: "R" },
  { tool: "oval", icon: SketchEllipseIcon, label: "椭圆", key: "O" },
  { tool: "arrow", icon: SketchArrowIcon, label: "箭头", key: "L", shift: true },
  { tool: "line", icon: SketchLineIcon, label: "线条", key: "L" },
  { tool: "pencil", icon: SketchPenIcon, label: "铅笔", key: "P" },
  { tool: "pen", icon: PenToolIcon, label: "钢笔", key: "P", shift: true },
  { tool: "scale", icon: ExpandArrowsIcon, label: "等比缩放（连同文字和间距）", key: "K" },
  { tool: "image", icon: PictureIcon, label: "图片", key: "I" },
  { tool: "note", icon: StickyNoteIcon, label: "便签", key: "N" },
  { tool: "comment", icon: PageCommentIcon, label: "评论", key: "C" },
];
const TOOL_KEYS: Record<string, DesignTool> = Object.fromEntries(
  TOOLS.filter((entry) => !entry.shift).map((entry) => [entry.key.toLowerCase(), entry.tool]),
);
const SHIFT_TOOL_KEYS: Record<string, DesignTool> = Object.fromEntries(
  TOOLS.filter((entry) => entry.shift).map((entry) => [entry.key.toLowerCase(), entry.tool]),
);
const toolEntry = (tool: DesignTool) => TOOLS.find((entry) => entry.tool === tool)!;
const shortcutOf = (entry: ToolEntry) => (entry.shift ? `⇧${entry.key}` : entry.key);
/** Tools that share one toolbar button, which remembers the last one used. */
const SHAPE_TOOLS: readonly DesignTool[] = ["rect", "oval", "arrow", "line"];
const DRAW_TOOLS: readonly DesignTool[] = ["pencil", "pen"];

/** One toolbar button for a group of tools, with a menu of the others. */
function ToolGroupButton(props: {
  tools: readonly DesignTool[];
  last: DesignTool;
  current: DesignTool;
  label: string;
  onPick: (tool: DesignTool) => void;
}) {
  const active = props.tools.includes(props.current) ? props.current : props.last;
  const entry = toolEntry(active);
  return (
    <span className="flex items-center" data-design-tool-group={props.label}>
      <SpaceToolbarButton
        icon={entry.icon}
        label={entry.label}
        shortcut={shortcutOf(entry)}
        pressed={props.tools.includes(props.current)}
        testId={`design-tool-${entry.tool}`}
        onClick={() => props.onPick(active)}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              className="h-7 w-3.5 min-w-0 px-0 text-muted-foreground"
              aria-label={`${props.label}：选择工具`}
            >
              <ChevronDownIcon className="size-3" />
            </Button>
          }
        />
        <ComposerPickerMenuPopup align="start" className="w-44 min-w-44">
          <MenuGroup>
            {props.tools.map((tool) => {
              const item = toolEntry(tool);
              const Icon = item.icon;
              return (
                <MenuItem
                  key={tool}
                  data-design-tool-option={tool}
                  onClick={() => props.onPick(tool)}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  <MenuShortcut>{shortcutOf(item)}</MenuShortcut>
                </MenuItem>
              );
            })}
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
    </span>
  );
}

interface DesignRun {
  readonly requestId: string;
  readonly startedAt: number;
}

const commentsKey = (pageId: string) => `design:${pageId}`;
/** A comment is pinned to an artboard element (`board/2.0.1`), an artboard, or a canvas point. */
const anchorOf = (comment: PageComment) => {
  const [boardId = "", elementId = ""] = comment.anchor.selector.split("/");
  return { boardId, elementId };
};

/** Small video files go into the artboard itself; anything larger plays from its web address. */
const VIDEO_INLINE_BYTES = 300_000;

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读不出这个文件"));
    reader.readAsDataURL(file);
  });

/** Reads an image file, scaled to at most `maxSide` px and re-encoded so the design stays small. */
async function imageDataUrl(file: File, maxSide = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = window.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const png = file.type === "image/png" || file.type === "image/svg+xml";
  return canvas.toDataURL(png ? "image/webp" : "image/jpeg", 0.82);
}
const pickFile = (accept: string) =>
  new Promise<File | null>((resolve) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });

export function DesignEditor(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  item: PageTypedItem;
  canvas: DesignCanvas;
  title: string;
  readOnly: boolean;
  epoch: number;
  onChange: (canvas: DesignCanvas) => void;
  flush: () => Promise<boolean>;
  revision: () => number;
  reloadIfChanged?: () => Promise<boolean>;
}) {
  // Live room: everyone with this design open edits one canvas; the server saves it.
  const room = useRef<DesignRoomClient | null>(null);
  const [roomStatus, setRoomStatus] = useState<DesignRoomStatus | "none">("none");
  const [peers, setPeers] = useState<readonly DesignPeer[]>([]);
  const live = roomStatus === "live";
  const liveRef = useRef(false);
  liveRef.current = live;
  const editor = useDesignEditor({
    initial: props.canvas,
    epoch: props.epoch,
    readOnly: props.readOnly,
    onChange: (next, previous) => {
      const client = room.current;
      if (client?.status === "live" && client.edit(previous, next)) return;
      props.onChange(next);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const { canvas, selection, view } = editor;
  const page = props.item.page;
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<DesignPanelTab>("properties");
  const [playing, setPlaying] = useState<{ boardId: string; surface: "canvas" | "full" } | null>(
    null,
  );
  const [showComments, setShowComments] = useState(true);
  const [draftComment, setDraftComment] = useState<{
    target: DesignCommentTarget;
    at: { left: number; top: number };
  } | null>(null);
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askText, setAskText] = useState("");
  const [generateText, setGenerateText] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [runs, setRuns] = useState<DesignRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const canvasElement = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const startAccount = useRef(props.account);
  const agent = threads.describePageAgent({ page, content: "" } as PagesReadResult);
  const canAsk = agent !== null && !props.readOnly;
  const [linkDialog, setLinkDialog] = useState<{ x: number; y: number } | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [lastShape, setLastShape] = useState<DesignTool>("rect");
  const [lastDraw, setLastDraw] = useState<DesignTool>("pencil");
  useEffect(() => {
    if (SHAPE_TOOLS.includes(editor.tool)) setLastShape(editor.tool);
    if (DRAW_TOOLS.includes(editor.tool)) setLastDraw(editor.tool);
  }, [editor.tool]);

  /** The revision the server has: the room's while live, else this window's last save. */
  const savedRevision = useCallback(() => {
    const live = liveRef.current ? room.current?.revision : undefined;
    return live ?? latest.current.revision();
  }, []);
  /** Saves everything first (through the room while live). */
  const flushAll = useCallback(async () => {
    if (liveRef.current && room.current) return (await room.current.flush()) !== null;
    return latest.current.flush();
  }, []);

  // ─── View ──────────────────────────────────────────────────────────────────────────────

  const zoomToRect = useCallback(
    (rect: { x: number; y: number; w: number; h: number } | null, maxZoom = 1) => {
      const element = canvasElement.current;
      if (!element) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!rect || rect.w <= 0 || rect.h <= 0) {
        editor.setView({ x: width / 2, y: height / 2, zoom: Math.min(1, view.zoom) });
        return;
      }
      const zoom = clampZoom(Math.min(maxZoom, (width - 160) / rect.w, (height - 160) / rect.h));
      editor.setView({
        zoom,
        x: width / 2 - (rect.x + rect.w / 2) * zoom,
        y: height / 2 - (rect.y + rect.h / 2) * zoom,
      });
    },
    [editor, view.zoom],
  );
  const pageBounds = useCallback(() => {
    const rects = [
      ...editor.pageBoards.map((board) => ({
        x: board.x,
        y: board.y - 28,
        w: board.w,
        h: board.h + 28,
      })),
      ...editor.pageNotes.map(noteRect),
    ];
    if (!rects.length) return null;
    const x = Math.min(...rects.map((rect) => rect.x));
    const y = Math.min(...rects.map((rect) => rect.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
      h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
    };
  }, [editor.pageBoards, editor.pageNotes]);
  const fit = useCallback(() => zoomToRect(pageBounds()), [pageBounds, zoomToRect]);
  const selectionBounds = useCallback(() => {
    const current = editor.selectedElements();
    if (current) {
      const board = editor.boardById(current.boardId)!;
      const rects = current.elements.map(frameRect);
      const x = Math.min(...rects.map((rect) => rect.x));
      const y = Math.min(...rects.map((rect) => rect.y));
      return {
        x: board.x + x,
        y: board.y + y,
        w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
        h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
      };
    }
    const rects = [
      ...editor.pageBoards.filter((board) => selection.boards.includes(board.id)),
      ...editor.pageNotes.filter((note) => selection.notes.includes(note.id)).map(noteRect),
    ];
    if (!rects.length) return null;
    const x = Math.min(...rects.map((rect) => rect.x));
    const y = Math.min(...rects.map((rect) => rect.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x,
      h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y,
    };
  }, [editor, selection.boards, selection.notes]);
  const zoomToSelection = useCallback(() => {
    const rect = selectionBounds();
    if (!rect) return void toastManager.add({ type: "info", title: "先选中要放大查看的内容" });
    zoomToRect(rect, 4);
  }, [selectionBounds, zoomToRect]);
  const zoomStep = useCallback(
    (direction: 1 | -1) => {
      const element = canvasElement.current;
      const current = view.zoom;
      const next =
        direction > 0
          ? (ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS.at(-1)!)
          : ([...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0]);
      const cx = (element?.clientWidth ?? 0) / 2;
      const cy = (element?.clientHeight ?? 0) / 2;
      if (next === current)
        toastManager.add({ type: "info", title: direction > 0 ? "已经放到最大" : "已经缩到最小" });
      editor.setView({
        zoom: next,
        x: cx - ((cx - view.x) / current) * next,
        y: cy - ((cy - view.y) / current) * next,
      });
    },
    [editor, view],
  );
  const setZoom = useCallback(
    (zoom: number) => {
      const element = canvasElement.current;
      const cx = (element?.clientWidth ?? 0) / 2;
      const cy = (element?.clientHeight ?? 0) / 2;
      editor.setView({
        zoom,
        x: cx - ((cx - view.x) / view.zoom) * zoom,
        y: cy - ((cy - view.y) / view.zoom) * zoom,
      });
    },
    [editor, view],
  );

  // Fit the page once the canvas has a size, and whenever the page changes.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === editor.pageId) return;
    const id = requestAnimationFrame(() => {
      if (!canvasElement.current?.clientWidth) return;
      fitted.current = editor.pageId;
      fit();
    });
    return () => cancelAnimationFrame(id);
  });

  // Launch into a focused prototype when the design says so.
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    const launch = canvas.launch;
    if (launch?.view === "focused") {
      const board =
        launch.boardId ?? boardsInReadingOrder(canvas, launch.pageId ?? editor.pageId)[0]?.id;
      if (board) setPlaying({ boardId: board, surface: "full" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Agent turns ───────────────────────────────────────────────────────────────────────

  const viewContext = useCallback((): DesignViewContext => {
    const element = canvasElement.current;
    const visible = element
      ? {
          x: -view.x / view.zoom,
          y: -view.y / view.zoom,
          w: element.clientWidth / view.zoom,
          h: element.clientHeight / view.zoom,
        }
      : null;
    const current = editor.selectedElements();
    return {
      pageId: editor.pageId,
      visibleBoardIds: boardsInReadingOrder(canvas, editor.pageId)
        .filter(
          (board) =>
            !visible ||
            (board.x < visible.x + visible.w &&
              board.x + board.w > visible.x &&
              board.y < visible.y + visible.h &&
              board.y + board.h > visible.y),
        )
        .map((board) => board.id),
      selectedBoardIds: selection.element ? [selection.element.boardId] : [...selection.boards],
      selectedElements: current
        ? current.elements.map((entry, index) => ({
            boardId: current.boardId,
            path: selection.element!.paths[index] ?? "",
            label: layerLabel(entry),
          }))
        : [],
      dirty: false,
    };
  }, [canvas, editor, selection, view]);

  const startRun = useCallback(
    async (build: () => ReturnType<typeof designChangePrompt>): Promise<string | null> => {
      const requestId = crypto.randomUUID();
      setRuns((current) => [...current, { requestId, startedAt: Date.now() }]);
      try {
        if (!(await flushAll())) throw new Error("请先保存设计，再交给 Moss。");
        const saved: PagesReadResult = {
          page: { ...latest.current.item.page, revision: savedRevision() },
          content: "",
        };
        return await threadsRef.current.startPageAiTurn(
          saved,
          build(),
          () => latest.current.account === startAccount.current,
        );
      } catch (cause) {
        setRuns((current) => current.filter((run) => run.requestId !== requestId));
        toastManager.add({
          type: "error",
          title: "没有交给 Moss",
          description: cause instanceof Error ? cause.message : undefined,
        });
        return null;
      }
    },
    [flushAll, savedRevision],
  );
  const ask = useCallback(
    (instruction: string) => {
      const text = instruction.trim();
      if (!text) return Promise.resolve(null);
      const context = viewContext();
      return startRun(() =>
        designChangePrompt({
          page: { ...latest.current.item.page, revision: savedRevision() },
          canvas: editor.latest.current,
          instruction: text,
          view: context,
          mode: /[?？]\s*$/u.test(text) ? "ask" : "change",
        }),
      );
    },
    [editor.latest, savedRevision, startRun, viewContext],
  );
  const generate = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      void startRun(() =>
        designGeneratePrompt({
          page: { ...latest.current.item.page, revision: savedRevision() },
          prompt: text,
        }),
      );
      setGenerateText("");
    },
    [savedRevision, startRun],
  );
  useEffect(() => {
    const prompt = takeDesignGeneration(page.id);
    if (prompt) generate(prompt);
    // Once per opened design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // While Moss works, newer revisions it saves stream into the canvas.
  const running = runs.length > 0;
  useEffect(() => {
    if (!running) return;
    let changedAt = Date.now();
    const timer = setInterval(async () => {
      // In a live room the server pushes Moss's writes; nothing to poll.
      if (liveRef.current) {
        changedAt = Date.now();
        return;
      }
      const changed = await latest.current.reloadIfChanged?.().catch(() => false);
      if (changed) changedAt = Date.now();
      else if (Date.now() - changedAt > 45_000)
        setRuns((current) =>
          current.filter(
            (run) => Date.now() - run.startedAt < RUN_TIMEOUT_MS && Date.now() - changedAt < 45_000,
          ),
        );
    }, 2_500);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const focus = () => {
      if (!liveRef.current) void latest.current.reloadIfChanged?.().catch(() => false);
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  // ─── Live room ─────────────────────────────────────────────────────────────────────────

  // What this window loaded, so edits made before the room answered can be offered to it.
  const loaded = useRef(props.canvas);
  useEffect(() => {
    loaded.current = props.canvas;
  }, [props.canvas]);
  const meRef = useRef({ name: "我" });
  useEffect(() => {
    if (props.readOnly || typeof WebSocket === "undefined") return;
    const client: DesignRoomClient = new DesignRoomClient(
      (peer) => designRoomUrl(page.id, props.scopeSpaceId, peer),
      () => ({ name: meRef.current.name, color: peerColor(client.peer) }),
      {
        onCanvas: (next, reason) => {
          const current = editorRef.current;
          if (reason === "welcome") {
            // Edits made here before the room answered go on top of the room's canvas.
            const mine = diffDesignCanvas(loaded.current, current.latest.current);
            if (mine.length) {
              const merged = applyDesignOpsLeniently(next, mine).canvas;
              current.receive(merged);
              client.edit(next, merged);
              return;
            }
          }
          current.receive(next);
        },
        onPeers: setPeers,
        onStatus: (status) => {
          setRoomStatus(status);
          // Saving falls back to this window; start from what the server has now.
          if (status === "offline") void latest.current.reloadIfChanged?.().catch(() => false);
        },
        onSaved: () => undefined,
        onRejected: (message) =>
          toastManager.add({ type: "error", title: "这个修改没有生效", description: message }),
      },
    );
    room.current = client;
    setRoomStatus("connecting");
    return () => {
      client.close();
      room.current = null;
      setRoomStatus("none");
      setPeers([]);
    };
  }, [page.id, props.readOnly, props.scopeSpaceId]);

  // Presence: page, selection and view; the cursor is sent as it moves.
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const sharePresence = useCallback(() => {
    const client = room.current;
    const element = canvasElement.current;
    if (!client || client.status !== "live") return;
    const current = editorRef.current;
    const at = current.view;
    client.setPresence({
      page: current.pageId,
      cursor: cursor.current,
      boards: current.selection.boards,
      notes: current.selection.notes,
      element: current.selection.element,
      view: {
        x: -at.x / at.zoom,
        y: -at.y / at.zoom,
        w: (element?.clientWidth ?? 0) / at.zoom,
        h: (element?.clientHeight ?? 0) / at.zoom,
      },
    });
  }, []);
  useEffect(sharePresence, [sharePresence, editor.pageId, selection, view, live]);

  // Following someone: the view goes where they look until this person pans or zooms.
  const followed = follow ? peers.find((peer) => peer.id === follow) : undefined;
  useEffect(() => {
    if (!follow) return;
    if (!followed) return setFollow(null);
    const presence = followed.presence;
    if (!presence) return;
    if (presence.page !== editor.pageId) editor.selectPage(presence.page);
    zoomToRect(presence.view, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, followed?.presence?.view, followed?.presence?.page]);
  const others = peers.filter((peer) => !peer.self);

  // ─── Comments ──────────────────────────────────────────────────────────────────────────

  const pageKey = commentsKey(page.id);
  const comments = usePageComments(pageKey);
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () =>
      identity.kind === "authenticated" || identity.kind === "saved"
        ? { name: identity.label, initials: identity.initials }
        : { name: "我", initials: pageCommentInitials("我") },
    [identity],
  );
  meRef.current = { name: me.name.slice(0, 40) };
  const askFromComment = useCallback(
    (body: string, anchor: { slideId: string; elementId?: string }) => {
      const board = canvas.boards.find((entry) => entry.id === anchor.slideId);
      const where = board
        ? `（评论在画板“${board.name}”(${board.id})${anchor.elementId ? ` 的元素 ${anchor.elementId}` : ""} 上）`
        : "（评论在画布上）";
      return ask(`${body}\n${where}`);
    },
    [ask, canvas.boards],
  );
  const commentPoint = useCallback(
    (
      comment: PageComment,
      toScreen: (point: { x: number; y: number }) => { x: number; y: number },
    ) => {
      const { boardId, elementId } = anchorOf(comment);
      if (boardId === "~canvas") {
        const [x = "0", y = "0"] = elementId.split("_");
        return toScreen({ x: Number(x), y: Number(y) });
      }
      const board = canvas.boards.find((entry) => entry.id === boardId);
      if (!board || board.page !== editor.pageId) return null;
      if (elementId) {
        const body = editor.frames.current.get(boardId)?.body();
        const element = body ? elementAt(body, elementId) : null;
        if (element) {
          const rect = frameRect(element);
          return toScreen({ x: board.x + rect.x + rect.w, y: board.y + rect.y });
        }
      }
      return toScreen({ x: board.x + board.w, y: board.y });
    },
    [canvas.boards, editor.frames, editor.pageId],
  );

  // ─── Export ────────────────────────────────────────────────────────────────────────────

  const exportTargets = useCallback((): DesignBoard[] => {
    const chosen = selection.element ? [selection.element.boardId] : selection.boards;
    const boards = chosen.length
      ? canvas.boards.filter((board) => chosen.includes(board.id))
      : boardsInReadingOrder(canvas, editor.pageId);
    return boards.filter((board) => !board.hidden);
  }, [canvas, editor.pageId, selection.boards, selection.element]);
  const runExport = useCallback(
    async (label: string, work: () => Promise<{ blob: Blob; filename: string } | void>) => {
      if (busy) return void toastManager.add({ type: "info", title: "上一个导出还没完成" });
      setBusy(label);
      try {
        const result = await work();
        if (result) {
          downloadBlob(result.blob, result.filename);
          toastManager.add({ type: "success", title: `已导出 ${result.filename}` });
        }
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "导出失败",
          description: cause instanceof Error ? cause.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );
  const exportPng = (scale: DesignExportScale) => {
    const boards = exportTargets();
    if (!boards.length)
      return void toastManager.add({ type: "info", title: "这一页没有可以导出的画板" });
    void runExport("PNG", () =>
      boards.length === 1
        ? exportBoardPng(boards[0]!, canvas, scale)
        : exportBoardsPngZip(boards, canvas, scale, props.title),
    );
  };
  const exportPdf = (flow?: DesignPaper) => {
    const boards = exportTargets();
    if (!boards.length)
      return void toastManager.add({ type: "info", title: "这一页没有可以导出的画板" });
    void runExport("PDF", () => exportBoardsPdf(boards, canvas, props.title, flow));
  };
  const exportSvg = () => {
    const boards = exportTargets();
    if (!boards.length)
      return void toastManager.add({ type: "info", title: "这一页没有可以导出的画板" });
    void runExport("SVG", async () => {
      if (boards.length === 1) return exportBoardSvg(boards[0]!, canvas);
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const used = new Set<string>();
      for (const board of boards) {
        let name = `${exportName(board.name, board.id)}.svg`;
        for (let n = 2; used.has(name); n += 1)
          name = `${exportName(board.name, board.id)} ${n}.svg`;
        used.add(name);
        zip.file(name, await boardSvg(board, canvas));
      }
      return {
        blob: await zip.generateAsync({ type: "blob" }),
        filename: `${exportName(props.title)} SVG.zip`,
      };
    });
  };
  const copyAsSvg = () => {
    const current = editor.selectedElements();
    const boards = exportTargets();
    if (!current && boards.length !== 1)
      return void toastManager.add({ type: "info", title: "只选中一个画板或元素，才能复制为 SVG" });
    void runExport("复制", async () => {
      const svg =
        current && current.elements.length === 1 && current.elements[0] !== boardRoot(current.body)
          ? await elementSvg(current.elements[0]!)
          : await boardSvg(boards[0]!, canvas);
      await copySvg(svg);
      toastManager.add({ type: "success", title: "已复制为 SVG" });
    });
  };
  /** 发送到对话: a new chat about this design, which Moss reads with its design tools. */
  const sendToChat = () =>
    void (async () => {
      try {
        if (!(await flushAll())) throw new Error("请先保存设计。");
        await threadsRef.current.startPageConversation(
          {
            page: { ...latest.current.item.page, revision: savedRevision() },
            content: "",
          } as PagesReadResult,
          () => undefined,
          () => latest.current.account === startAccount.current,
        );
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "没有发送到对话",
          description: cause instanceof Error ? cause.message : undefined,
        });
      }
    })();
  /** 发送到资料库: the artboards as PNG pictures in 资料库. */
  const saveToLibrary = () => {
    const boards = exportTargets();
    if (!boards.length)
      return void toastManager.add({ type: "info", title: "这一页没有可以存的画板" });
    void runExport("资料库", async () => {
      const files = [];
      for (const board of boards) {
        const { blob, filename } = await exportBoardPng(board, canvas, 2);
        files.push({ name: filename, mimeType: "image/png", data: blob });
      }
      // Raw bytes over HTTP: the WebSocket's 2 MiB message cap stops base64 files of ~1.5 MB.
      const result = await uploadLibraryFiles(files);
      toastManager.add({ type: "success", title: `已存到资料库：${result.imported} 张图片` });
    });
  };
  const exportHtml = () => {
    const boards = exportTargets();
    if (!boards.length)
      return void toastManager.add({ type: "info", title: "这一页没有可以导出的画板" });
    void runExport("HTML", () => exportBoardsHtmlZip(boards, canvas, props.title));
  };
  const copyAsPng = () => {
    const boards = exportTargets();
    if (boards.length !== 1)
      return void toastManager.add({ type: "info", title: "只选中一个画板，才能复制为图片" });
    void runExport("复制", async () => {
      await copyBoardPng(boards[0]!, canvas);
      toastManager.add({ type: "success", title: "已复制为图片" });
    });
  };
  const copyAsHtml = () => {
    const current = editor.selectedElements();
    const html = current
      ? current.elements.map((element) => element.outerHTML).join("\n")
      : exportTargets().length === 1
        ? exportTargets()[0]!.html
        : null;
    if (html === null)
      return void toastManager.add({ type: "info", title: "只选中一个画板或元素，才能复制 HTML" });
    void copyHtml(html).then(
      () => toastManager.add({ type: "success", title: "已复制 HTML" }),
      () => toastManager.add({ type: "error", title: "浏览器不允许在这里复制" }),
    );
  };

  // ─── Images ────────────────────────────────────────────────────────────────────────────

  const addImage = useCallback(
    async (boardId: string | null, at: { x: number; y: number }, dropped?: File) => {
      const file =
        dropped ?? (await pickFile("image/png,image/jpeg,image/webp,image/gif,image/svg+xml"));
      if (!file) return;
      try {
        if (boardId) {
          editor.insert(boardId, "image", at, await imageDataUrl(file));
          return;
        }
        // A picture on the bare canvas: a little smaller, so the design stays light.
        const src = await imageDataUrl(file, 1200);
        const size = await new Promise<{ w: number; h: number }>((resolve) => {
          const image = new Image();
          image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
          image.onerror = () => resolve({ w: 320, h: 240 });
          image.src = src;
        });
        const scale = Math.min(1, 480 / Math.max(size.w, size.h));
        editor.addCanvasNote({
          kind: "shape",
          shape: "image",
          x: Math.round(at.x),
          y: Math.round(at.y),
          w: Math.round(size.w * scale),
          h: Math.round(size.h * scale),
          src,
          text: file.name.slice(0, 80),
        });
      } catch {
        toastManager.add({ type: "error", title: "这张图片读不出来，或者太大了" });
      }
    },
    [editor],
  );
  const addVideo = useCallback(
    async (boardId: string, at: { x: number; y: number }, file?: File) => {
      const small = file && file.size <= VIDEO_INLINE_BYTES ? file : null;
      if (file && !small)
        toastManager.add({
          type: "info",
          title: "视频太大，不能放进设计里",
          description: "已放好一个视频框，请在属性的“视频”里填写它的网址。",
        });
      const src = small ? await readDataUrl(small).catch(() => "") : "";
      editor.insert(boardId, "video", at, src);
      setPanelOpen(true);
      setPanelTab("properties");
    },
    [editor],
  );
  const openLink = useCallback((note: DesignNote) => {
    const href = note.href ?? "";
    const pageId = spacePageIdOfLink(href);
    if (pageId) return openSpacePage(pageId);
    if (/^https?:\/\//iu.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  }, []);
  const replaceImage = useCallback(
    async (boardId: string, path: string) => {
      const file = await pickFile("image/png,image/jpeg,image/webp,image/gif,image/svg+xml");
      if (!file) return;
      try {
        const src = await imageDataUrl(file);
        editor.editBoard(boardId, (body) => {
          elementAt(body, path)?.setAttribute("src", src);
          return undefined;
        });
      } catch {
        toastManager.add({ type: "error", title: "这张图片读不出来" });
      }
    },
    [editor],
  );

  // ─── Keyboard ──────────────────────────────────────────────────────────────────────────

  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (playing?.surface === "full" || editor.editingText) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target?.tagName ?? ""))
        return;
      if (!root.current?.contains(target) && target !== window.document.body) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const lower = event.key.toLowerCase();
      const done = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (mod && lower === "z") return (done(), event.shiftKey ? editor.redo() : editor.undo());
      if (mod && lower === "y") return (done(), editor.redo());
      if (mod && lower === "\\") return (done(), setPanelOpen((open) => !open));
      if (mod && (lower === "=" || lower === "+")) return (done(), zoomStep(1));
      if (mod && lower === "-") return (done(), zoomStep(-1));
      if (mod && lower === "0") return (done(), fit());
      if (event.shiftKey && event.code === "Digit1") return (done(), fit());
      if (event.shiftKey && event.code === "Digit2") return (done(), zoomToSelection());
      if (mod && event.altKey && event.code === "KeyC") return (done(), editor.copyProperties());
      if (mod && event.altKey && event.code === "KeyV") return (done(), editor.pasteProperties());
      if (mod && lower === "c") return (done(), editor.copySelection());
      if (mod && lower === "x") return (done(), editor.copySelection(true));
      // Ctrl+V is handled by the paste event, which also carries copied pictures.
      if (mod && lower === "v") return;
      if (mod && lower === "d") return (done(), editor.duplicateSelection());
      if (mod && lower === "a") return (done(), editor.selectAll());
      if (mod && lower === "g")
        return (done(), event.shiftKey ? editor.ungroupSelection() : editor.wrapSelection("group"));
      if (!mod && !event.altKey && event.shiftKey && SHIFT_TOOL_KEYS[lower])
        return (done(), editor.setTool(SHIFT_TOOL_KEYS[lower]!));
      if (!mod && event.shiftKey && lower === "a")
        return (done(), editor.wrapSelection("flex-column"));
      if (!mod && event.shiftKey && lower === "h") return (done(), editor.flipSelection("x"));
      if (!mod && event.shiftKey && lower === "v") return (done(), editor.flipSelection("y"));
      if (!mod && event.shiftKey && lower === "g") {
        done();
        const boards = editor.pageBoards.filter((board) => board.guides?.length);
        const anyShown = boards.some((board) => board.guides!.some((guide) => !guide.hidden));
        if (!boards.length)
          return void toastManager.add({ type: "info", title: "这一页的画板还没有布局网格" });
        editor.apply(
          boards.map((board) => ({
            op: "upsertBoard" as const,
            board: {
              id: board.id,
              guides: board.guides!.map((guide) => ({ ...guide, hidden: anyShown })),
            },
          })),
        );
        return;
      }
      if (event.key === "]") return (done(), editor.reorderSelection(mod ? "forward" : "front"));
      if (event.key === "[") return (done(), editor.reorderSelection(mod ? "backward" : "back"));
      if (event.key === "Delete" || event.key === "Backspace")
        return (done(), editor.deleteSelection());
      if (event.key === "Escape") {
        done();
        if (editor.tool !== "select") return editor.setTool("select");
        const element = selection.element;
        const body = element ? editor.frames.current.get(element.boardId)?.body() : null;
        if (element && body) {
          const parent = parentOf(body, element.paths[0]!);
          const root = boardRoot(body);
          if (parent && elementAt(body, parent) !== root)
            return editor.setSelection({
              boards: [],
              notes: [],
              element: { boardId: element.boardId, paths: [parent] },
            });
          return editor.setSelection({ boards: [element.boardId], notes: [], element: null });
        }
        return editor.setSelection(EMPTY_SELECTION);
      }
      if (event.key === "Enter" && selection.element) {
        done();
        const body = editor.frames.current.get(selection.element.boardId)?.body();
        const path = selection.element.paths[0]!;
        if (!body) return;
        const next = event.shiftKey ? parentOf(body, path) : firstChild(body, path);
        if (next)
          editor.setSelection({
            boards: [],
            notes: [],
            element: { boardId: selection.element.boardId, paths: [next] },
          });
        return;
      }
      if (event.key === "Enter" && selection.boards.length === 1) {
        done();
        const body = editor.frames.current.get(selection.boards[0]!)?.body();
        const root = body ? boardRoot(body) : null;
        if (body && root) {
          const path = Array.prototype.indexOf.call(body.children, root);
          const first = firstChild(body, String(path));
          editor.setSelection({
            boards: [],
            notes: [],
            element: { boardId: selection.boards[0]!, paths: [first ?? String(path)] },
          });
        }
        return;
      }
      if (event.key === "Tab" && selection.element) {
        done();
        const body = editor.frames.current.get(selection.element.boardId)?.body();
        const next = body
          ? siblingOf(body, selection.element.paths.at(-1)!, event.shiftKey ? -1 : 1)
          : null;
        if (next)
          editor.setSelection({
            boards: [],
            notes: [],
            element: { boardId: selection.element.boardId, paths: [next] },
          });
        return;
      }
      if (event.key.startsWith("Arrow")) {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        const current = editor.selectedElements();
        if (current) {
          const free = current.elements.filter(isPositioned);
          if (!free.length)
            return void toastManager.add({
              type: "info",
              title: "这个元素随布局排列；在属性里改成“自由放置”后才能用方向键移动",
            });
          done();
          editor.editBoard(
            current.boardId,
            () => void free.forEach((element) => nudge(element, dx, dy)),
            `nudge:${current.boardId}`,
          );
          return;
        }
        if (selection.boards.length || selection.notes.length) {
          done();
          editor.apply(
            [
              ...selection.boards.map((id) => {
                const board = editor.boardById(id)!;
                return { op: "moveBoard" as const, id, x: board.x + dx, y: board.y + dy };
              }),
              ...selection.notes.flatMap((id) => {
                const note = canvas.notes.find((entry) => entry.id === id);
                return note
                  ? [
                      {
                        op: "upsertNote" as const,
                        note: { ...note, x: note.x + dx, y: note.y + dy },
                      },
                    ]
                  : [];
              }),
            ],
            "nudge-frames",
          );
        }
        return;
      }
      if (!mod && !event.altKey && !event.shiftKey && TOOL_KEYS[lower]) {
        done();
        const tool = TOOL_KEYS[lower]!;
        if (tool === "comment") setShowComments(true);
        editor.setTool(tool);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [canvas.notes, editor, fit, playing, selection, zoomStep, zoomToSelection]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (playing?.surface === "full" || editor.editingText || editor.readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(target?.tagName ?? ""))
        return;
      if (!root.current?.contains(target) && target !== window.document.body) return;
      event.preventDefault();
      const file = [...(event.clipboardData?.files ?? [])].find((entry) =>
        entry.type.startsWith("image/"),
      );
      if (!file) return editor.paste();
      const boardId = selection.element?.boardId ?? selection.boards[0];
      const board = boardId ? editor.boardById(boardId) : undefined;
      if (!board) {
        // Nothing selected: the picture goes on the canvas, in the middle of the view.
        const element = canvasElement.current;
        const at = editor.view;
        return void addImage(
          null,
          {
            x: ((element?.clientWidth ?? 0) / 2 - at.x) / at.zoom,
            y: ((element?.clientHeight ?? 0) / 2 - at.y) / at.zoom,
          },
          file,
        );
      }
      void addImage(
        board.id,
        { x: Math.max(0, board.w / 2 - 120), y: Math.max(0, board.h / 2 - 90) },
        file,
      );
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [addImage, editor, playing, selection]);

  // ─── Rendering ─────────────────────────────────────────────────────────────────────────

  const empty = editor.pageBoards.length === 0 && editor.pageNotes.length === 0;
  const elementSelected = selection.element !== null;
  const playable = editor.pageBoards.filter((board) => board.interactive && !board.hidden);
  const playTarget =
    selection.boards.length === 1
      ? selection.boards[0]!
      : (selection.element?.boardId ??
        playable[0]?.id ??
        boardsInReadingOrder(canvas, editor.pageId)[0]?.id);

  const selectedImage =
    selection.element && selection.element.paths.length === 1
      ? (() => {
          const body = editor.frames.current.get(selection.element!.boardId)?.body();
          const found = body ? elementAt(body, selection.element!.paths[0]!) : null;
          return found?.tagName === "IMG"
            ? { boardId: selection.element!.boardId, path: selection.element!.paths[0]! }
            : null;
        })()
      : null;
  const selectedInstance = (() => {
    const current = editor.selectedElements();
    return current?.elements[0] ? instanceRoot(current.elements[0]) : null;
  })();
  const menuBoard = editor.boardById(selection.element?.boardId ?? selection.boards[0] ?? "");
  const renderTool = (tool: DesignTool) => {
    const entry = toolEntry(tool);
    return (
      <SpaceToolbarButton
        key={tool}
        icon={entry.icon}
        label={entry.label}
        shortcut={shortcutOf(entry)}
        pressed={editor.tool === tool}
        testId={`design-tool-${tool}`}
        onClick={() => {
          if (tool === "comment") setShowComments(true);
          editor.setTool(tool);
        }}
      />
    );
  };

  const contextItems = (
    <>
      <MenuGroup>
        <MenuItem onClick={() => editor.copySelection(true)} disabled={editor.readOnly}>
          剪切 <MenuShortcut>{MOD}X</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => editor.copySelection()}>
          复制 <MenuShortcut>{MOD}C</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={editor.paste} disabled={editor.readOnly}>
          粘贴 <MenuShortcut>{MOD}V</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={editor.duplicateSelection} disabled={editor.readOnly}>
          复制一份 <MenuShortcut>{MOD}D</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={editor.deleteSelection} disabled={editor.readOnly}>
          删除 <MenuShortcut>⌫</MenuShortcut>
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuItem onClick={editor.copyProperties} disabled={!elementSelected}>
          复制属性 <MenuShortcut>{isMac ? "⌥⌘C" : "Ctrl+Alt+C"}</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={editor.pasteProperties} disabled={!elementSelected || editor.readOnly}>
          粘贴属性 <MenuShortcut>{isMac ? "⌥⌘V" : "Ctrl+Alt+V"}</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={copyAsPng}>复制为图片</MenuItem>
        <MenuItem onClick={copyAsSvg}>复制为 SVG</MenuItem>
        <MenuItem onClick={copyAsHtml}>复制 HTML</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        {selectedImage ? (
          <MenuItem onClick={() => editor.setCropping(selectedImage)} disabled={editor.readOnly}>
            裁切图片
          </MenuItem>
        ) : null}
        {selectedInstance ? (
          <MenuItem onClick={editor.detachSelection} disabled={editor.readOnly}>
            分离实例
          </MenuItem>
        ) : elementSelected ? (
          <MenuItem onClick={() => editor.createComponent()} disabled={editor.readOnly}>
            做成组件
          </MenuItem>
        ) : null}
        {menuBoard ? (
          <MenuItem
            onClick={() =>
              void addVideo(menuBoard.id, {
                x: Math.max(0, menuBoard.w / 2 - 160),
                y: Math.max(0, menuBoard.h / 2 - 90),
              })
            }
            disabled={editor.readOnly}
          >
            插入视频
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            const element = canvasElement.current;
            const rect = element?.getBoundingClientRect();
            const at =
              menu && rect ? { x: menu.x - rect.left, y: menu.y - rect.top } : { x: 0, y: 0 };
            setLinkDialog({ x: (at.x - view.x) / view.zoom, y: (at.y - view.y) / view.zoom });
          }}
          disabled={editor.readOnly}
        >
          添加链接卡片…
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuItem onClick={() => editor.reorderSelection("front")} disabled={editor.readOnly}>
          移到最前 <MenuShortcut>]</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => editor.reorderSelection("back")} disabled={editor.readOnly}>
          移到最后 <MenuShortcut>[</MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => editor.wrapSelection("group")}
          disabled={!elementSelected || editor.readOnly}
        >
          编组 <MenuShortcut>{MOD}G</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={editor.ungroupSelection} disabled={!elementSelected || editor.readOnly}>
          取消编组 <MenuShortcut>{isMac ? "⇧⌘G" : "Ctrl+Shift+G"}</MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => editor.wrapSelection("flex-row")}
          disabled={!elementSelected || editor.readOnly}
        >
          放进横向排列
        </MenuItem>
        <MenuItem
          onClick={() => editor.wrapSelection("flex-column")}
          disabled={!elementSelected || editor.readOnly}
        >
          放进纵向排列 <MenuShortcut>⇧A</MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => editor.wrapSelection("grid")}
          disabled={!elementSelected || editor.readOnly}
        >
          放进网格
        </MenuItem>
        <MenuItem
          onClick={() => editor.flipSelection("x")}
          disabled={!elementSelected || editor.readOnly}
        >
          水平翻转 <MenuShortcut>⇧H</MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => editor.flipSelection("y")}
          disabled={!elementSelected || editor.readOnly}
        >
          垂直翻转 <MenuShortcut>⇧V</MenuShortcut>
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuItem
          onClick={() => {
            setPanelOpen(true);
            setAsking(true);
          }}
          disabled={!canAsk}
        >
          让 Moss 修改这里
        </MenuItem>
        <MenuItem
          onClick={() => {
            const rect = selectionBounds();
            if (!rect) return;
            setShowComments(true);
            const at = {
              left: view.x + (rect.x + rect.w) * view.zoom + 8,
              top: view.y + rect.y * view.zoom,
            };
            const boardId = selection.element?.boardId ?? selection.boards[0] ?? null;
            const path = selection.element?.paths[0] ?? null;
            setDraftComment({
              target: {
                boardId,
                path,
                world: { x: rect.x + rect.w, y: rect.y },
                label:
                  viewContext().selectedElements[0]?.label ??
                  canvas.boards.find((board) => board.id === boardId)?.name ??
                  "画布",
              },
              at,
            });
          }}
        >
          评论
        </MenuItem>
        {selection.boards.length === 1 && !elementSelected ? (
          <>
            <MenuItem
              onClick={() => editor.fitBoardHeight(selection.boards[0]!)}
              disabled={editor.readOnly}
            >
              高度适应内容
            </MenuItem>
            <MenuItem
              onClick={() => editor.apply([{ op: "setThumbnail", id: selection.boards[0]! }])}
              disabled={editor.readOnly}
            >
              设为封面
            </MenuItem>
          </>
        ) : null}
        <MenuItem onClick={() => exportPng(2)}>导出 PNG</MenuItem>
      </MenuGroup>
    </>
  );

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-design-editor="">
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
        role="toolbar"
        aria-label="设计工具"
      >
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="max-w-40 gap-1 px-2 font-normal"
                aria-label="页面：切换、新建、重命名或删除页面"
              >
                <span className="truncate">{editor.page.name}</span>
                {canvas.pages.length > 1 ? (
                  <span className="text-muted-foreground">{canvas.pages.length}</span>
                ) : null}
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </Button>
            }
          />
          <ComposerPickerMenuPopup align="start" className="w-56 min-w-56">
            <MenuGroup>
              <MenuGroupLabel>页面</MenuGroupLabel>
              {canvas.pages.map((entry) => (
                <MenuItem
                  key={entry.id}
                  data-design-page={entry.id}
                  onClick={() => editor.selectPage(entry.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.id === editor.pageId ? (
                    <span className="text-ui-xs text-muted-foreground">当前</span>
                  ) : null}
                </MenuItem>
              ))}
            </MenuGroup>
            {!editor.readOnly ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuItem onClick={editor.addPage}>新建页面</MenuItem>
                  <MenuItem
                    onClick={() => {
                      setPanelOpen(true);
                      setPanelTab("properties");
                      editor.setSelection(EMPTY_SELECTION);
                    }}
                  >
                    重命名当前页面
                  </MenuItem>
                  <MenuItem
                    disabled={canvas.pages.length <= 1}
                    onClick={() => editor.deletePage(editor.pageId)}
                  >
                    删除当前页面
                  </MenuItem>
                </MenuGroup>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        <SpaceToolbarDivider />
        {(editor.readOnly
          ? (["select", "hand"] as const)
          : (["select", "hand", "frame", "text"] as const)
        ).map((tool) => renderTool(tool))}
        {!editor.readOnly ? (
          <>
            <ToolGroupButton
              tools={SHAPE_TOOLS}
              last={lastShape}
              current={editor.tool}
              label="形状"
              onPick={editor.setTool}
            />
            <ToolGroupButton
              tools={DRAW_TOOLS}
              last={lastDraw}
              current={editor.tool}
              label="绘制"
              onPick={editor.setTool}
            />
            {(["scale", "image", "note"] as const).map((tool) => renderTool(tool))}
          </>
        ) : null}
        {renderTool("comment")}
        <SpaceToolbarDivider />
        <SpaceToolbarButton
          icon={Undo2Icon}
          label="撤销"
          shortcut={`${MOD}Z`}
          disabled={!editor.canUndo}
          onClick={editor.undo}
          testId="design-undo"
        />
        <SpaceToolbarButton
          icon={Redo2Icon}
          label="重做"
          shortcut={isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"}
          disabled={!editor.canRedo}
          onClick={editor.redo}
          testId="design-redo"
        />
        <div className="min-w-2 flex-1" />
        {others.length ? (
          <span className="flex items-center -space-x-1" data-design-peers={others.length}>
            {others.slice(0, 4).map((peer) => (
              <Button
                key={peer.id}
                size="icon-xs"
                variant="ghost"
                aria-label={follow === peer.id ? `停止跟随${peer.name}` : `跟随${peer.name}`}
                title={
                  follow === peer.id
                    ? `正在跟随${peer.name}（点击停止）`
                    : `${peer.name} · 点击跟随`
                }
                aria-pressed={follow === peer.id}
                className={cn(
                  "size-6 rounded-full border-2 border-background p-0 text-ui-xs text-white",
                  follow === peer.id && "ring-2 ring-[var(--color-text-accent)]",
                )}
                style={{ background: peer.color }}
                onClick={() => setFollow((current) => (current === peer.id ? null : peer.id))}
              >
                {peer.name.slice(0, 1)}
              </Button>
            ))}
            {others.length > 4 ? (
              <span className="pl-2 text-ui-xs text-muted-foreground">+{others.length - 4}</span>
            ) : null}
          </span>
        ) : null}
        {roomStatus === "offline" ? (
          <span role="status" className="text-ui-xs text-muted-foreground">
            实时连接已断开，改动先存在本机
          </span>
        ) : null}
        {running ? (
          <span
            role="status"
            className="flex items-center gap-1.5 text-ui-sm text-muted-foreground"
          >
            <span className="size-1.5 rounded-full bg-[var(--color-text-accent)] motion-safe:animate-pulse" />
            Moss 正在设计…
          </span>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="w-16 justify-center gap-0.5 px-1 font-normal tabular-nums"
                aria-label={`缩放 ${Math.round(view.zoom * 100)}%`}
                data-design-zoom=""
              >
                {Math.round(view.zoom * 100)}%
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </Button>
            }
          />
          <ComposerPickerMenuPopup align="end" className="w-52 min-w-52">
            <MenuGroup>
              <MenuItem onClick={() => zoomStep(1)}>
                放大 <MenuShortcut>{MOD}+</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={() => zoomStep(-1)}>
                缩小 <MenuShortcut>{MOD}-</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={fit}>
                显示全部 <MenuShortcut>⇧1</MenuShortcut>
              </MenuItem>
              <MenuItem onClick={zoomToSelection}>
                缩放到选中 <MenuShortcut>⇧2</MenuShortcut>
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              {[0.25, 0.5, 0.75, 1, 1.5, 2].map((zoom) => (
                <MenuItem key={zoom} onClick={() => setZoom(zoom)}>
                  {zoom * 100}%
                </MenuItem>
              ))}
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        <SpaceToolbarButton
          icon={PlayIcon}
          label="播放原型"
          tooltip={playTarget ? "全屏播放原型" : "这一页还没有画板"}
          disabled={!playTarget}
          onClick={() => playTarget && setPlaying({ boardId: playTarget, surface: "full" })}
          testId="design-play"
        />
        <SpaceToolbarButton
          icon={PageCommentIcon}
          label={showComments ? "隐藏评论" : "显示评论"}
          pressed={showComments}
          attention={comments.some((comment) => !comment.read)}
          onClick={() => setShowComments((shown) => !shown)}
          testId="design-comments"
        />
        <SpaceToolbarButton
          icon={SparklesIcon}
          label="让 Moss 修改"
          tooltip={
            canAsk ? "让 Moss 修改（会带上你选中的内容）" : "这个资料空间还没有可用的 Moss 智能体"
          }
          disabled={!canAsk}
          pressed={asking}
          busy={running}
          onClick={() => setAsking((open) => !open)}
          testId="design-ask"
        />
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="gap-1 px-2 font-normal"
                disabled={busy !== null}
                data-design-export=""
              >
                <DownloadIcon className="size-4" />
                {busy ? `正在导出 ${busy}…` : "导出"}
              </Button>
            }
          />
          <ComposerPickerMenuPopup align="end" className="w-60 min-w-60">
            <MenuGroup>
              <MenuGroupLabel>
                {selection.boards.length || selection.element ? "选中的画板" : "这一页的全部画板"}
              </MenuGroupLabel>
              <MenuItem onClick={() => exportPng(1)}>PNG 1×</MenuItem>
              <MenuItem onClick={() => exportPng(2)}>PNG 2×</MenuItem>
              <MenuItem onClick={() => exportPng(3)}>PNG 3×</MenuItem>
              <MenuItem onClick={exportSvg}>SVG</MenuItem>
              <MenuItem onClick={() => exportPdf()}>PDF（每个画板一页）</MenuItem>
              <MenuItem onClick={() => exportPdf("a4")}>PDF（按 A4 分页）</MenuItem>
              <MenuItem onClick={() => exportPdf("letter")}>PDF（按 Letter 分页）</MenuItem>
              <MenuItem onClick={exportHtml}>HTML 网页（.zip）</MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem onClick={copyAsPng}>复制为图片</MenuItem>
              <MenuItem onClick={copyAsSvg}>复制为 SVG</MenuItem>
              <MenuItem onClick={copyAsHtml}>复制 HTML</MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>发送到</MenuGroupLabel>
              <MenuItem onClick={sendToChat} disabled={editor.readOnly}>
                对话（让 Moss 接着做）
              </MenuItem>
              <MenuItem onClick={saveToLibrary}>资料库（PNG 图片）</MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        <SpaceToolbarButton
          icon={PanelRightOpenIcon}
          label={panelOpen ? "隐藏属性面板" : "显示属性面板"}
          shortcut={`${MOD}\\`}
          pressed={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
          testId="design-panel-toggle"
        />
      </div>

      <div
        className="relative flex min-h-0 flex-1"
        onPointerDownCapture={() => follow && setFollow(null)}
        onWheelCapture={() => follow && setFollow(null)}
      >
        <DesignCanvasView
          editor={editor}
          playing={playing?.surface === "canvas" ? playing.boardId : null}
          onPlay={(boardId) => setPlaying(boardId ? { boardId, surface: "canvas" } : null)}
          onNavigate={(_from, target) => {
            if (target.url) return void window.open(target.url, "_blank", "noopener,noreferrer");
            const board = canvas.boards.find((entry) => entry.id === target.board);
            if (!board)
              return void toastManager.add({
                type: "info",
                title: "这个链接指向的画板不在这份设计里",
              });
            setPlaying({ boardId: board.id, surface: "canvas" });
            if (board.page !== editor.pageId) editor.selectPage(board.page);
            zoomToRect(board, view.zoom);
          }}
          onRequestImage={(boardId, at, file) => void addImage(boardId, at, file)}
          onRequestVideo={(boardId, at, file) => void addVideo(boardId, at, file)}
          onOpenLink={openLink}
          peers={peers}
          onCursor={(point) => {
            cursor.current = point;
            sharePresence();
          }}
          onComment={(target, screen) => {
            const rect = canvasElement.current?.getBoundingClientRect();
            setDraftComment({
              target,
              at: { left: screen.x - (rect?.left ?? 0) + 12, top: screen.y - (rect?.top ?? 0) },
            });
            editor.setTool("select");
          }}
          onContextMenu={(screen) => setMenu(screen)}
          rootRef={(element) => {
            canvasElement.current = element;
          }}
          overlay={(toScreen) =>
            showComments ? (
              <>
                {comments.map((comment) => {
                  const at = commentPoint(comment, toScreen);
                  if (!at) return null;
                  return (
                    <span key={comment.id} className="pointer-events-auto">
                      <CommentPin
                        comment={comment}
                        left={at.x}
                        top={at.y}
                        side="above"
                        open={openComment === comment.id}
                        pulse={false}
                        onOpen={() => {
                          setOpenComment(comment.id);
                          usePageCommentsStore.getState().markPageRead(pageKey);
                        }}
                      />
                      {openComment === comment.id ? (
                        <ThreadCard
                          comment={comment}
                          position={{ left: at.x + 16, top: at.y }}
                          pulse={false}
                          author={me}
                          onReply={(body) =>
                            postDeckComment({
                              pageKey,
                              author: me,
                              threadId: comment.id,
                              anchor: null,
                              label: comment.anchor.label,
                              body,
                              sendToAgent:
                                canAsk &&
                                (comment.sentToAgentAt !== null || pageCommentMentionsAgent(body)),
                              ask: askFromComment,
                            })
                          }
                          onDelete={() => {
                            usePageCommentsStore.getState().deleteComment(pageKey, comment.id);
                            setOpenComment(null);
                          }}
                          onClose={() => setOpenComment(null)}
                        />
                      ) : null}
                    </span>
                  );
                })}
                {draftComment ? (
                  <NewCommentCard
                    threadId={page.sourceThreadId ?? ""}
                    pageTitle={props.title}
                    anchor={{ selector: "", label: draftComment.target.label, text: "" }}
                    position={draftComment.at}
                    onCancel={() => setDraftComment(null)}
                    onPost={(body, sendToAgent) => {
                      const target = draftComment.target;
                      postDeckComment({
                        pageKey,
                        author: me,
                        threadId: null,
                        anchor: target.boardId
                          ? {
                              slideId: target.boardId,
                              ...(target.path ? { elementId: target.path } : {}),
                            }
                          : {
                              slideId: "~canvas",
                              elementId: `${Math.round(target.world.x)}_${Math.round(target.world.y)}`,
                            },
                        label: target.label,
                        body,
                        sendToAgent: sendToAgent && canAsk,
                        ask: askFromComment,
                      });
                      if (sendToAgent && !canAsk)
                        toastManager.add({
                          type: "info",
                          title: "评论已保存；这个资料空间还没有可用的 Moss 智能体",
                        });
                      setDraftComment(null);
                    }}
                  />
                ) : null}
              </>
            ) : null
          }
        />
        <DeckCommentAgentReplies pageKey={pageKey} comments={comments} />

        {empty ? (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            data-design-empty=""
          >
            <div className="pointer-events-auto flex w-[420px] max-w-[calc(100%-32px)] flex-col gap-3 rounded-card border border-border bg-background p-5 shadow-sm">
              <h2 className="text-ui-lg font-medium">这一页还没有画板</h2>
              <p className="text-ui-sm text-muted-foreground">
                添加一个画板开始设计，或者告诉 Moss 你想要什么，让它来做。
              </p>
              {!editor.readOnly ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => editor.addBoard({ x: 0, y: 0, w: 1440, h: 900 }, "网页")}
                    >
                      网页 1440×900
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => editor.addBoard({ x: 0, y: 0, w: 390, h: 844 }, "手机")}
                    >
                      手机 390×844
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => editor.addBoard({ x: 0, y: 0, w: 1080, h: 1350 }, "海报")}
                    >
                      海报 1080×1350
                    </Button>
                  </div>
                  <textarea
                    aria-label="描述你想要的设计"
                    rows={3}
                    value={generateText}
                    disabled={!canAsk}
                    placeholder={
                      canAsk
                        ? "比如：一个咖啡店的手机点餐应用，三屏，温暖的配色"
                        : "这个资料空间还没有可用的 Moss 智能体"
                    }
                    className="w-full resize-none rounded-control border border-border bg-transparent p-2 text-ui text-foreground outline-none focus:border-[var(--color-text-accent)]"
                    onChange={(event) => setGenerateText(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        generate(generateText);
                      }
                    }}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!canAsk || !generateText.trim() || running}
                      onClick={() => generate(generateText)}
                    >
                      <SparklesIcon className="size-4" /> 让 Moss 来做
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {asking ? (
          <div
            className="absolute top-2 right-2 z-20 flex w-80 flex-col gap-2 rounded-popover border border-border bg-popover p-3 shadow-xl"
            data-design-ask=""
            style={panelOpen ? { right: 328 } : undefined}
          >
            <span className="text-ui-sm text-muted-foreground">
              {selection.element
                ? `针对选中的 ${selection.element.paths.length} 个元素`
                : selection.boards.length
                  ? `针对选中的 ${selection.boards.length} 个画板`
                  : "针对你现在看到的画板"}
            </span>
            <textarea
              autoFocus
              aria-label="告诉 Moss 要怎么改"
              rows={3}
              value={askText}
              placeholder="比如：把按钮改成圆角，主色换成深绿"
              className="w-full resize-none rounded-control border border-border bg-transparent p-2 text-ui text-foreground outline-none focus:border-[var(--color-text-accent)]"
              onChange={(event) => setAskText(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") setAsking(false);
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (askText.trim()) {
                    void ask(askText);
                    setAskText("");
                    setAsking(false);
                  }
                }
              }}
            />
            <div className="flex justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={() => setAsking(false)}>
                取消
              </Button>
              <Button
                size="xs"
                disabled={!askText.trim()}
                onClick={() => {
                  void ask(askText);
                  setAskText("");
                  setAsking(false);
                }}
              >
                发送给 Moss
              </Button>
            </div>
          </div>
        ) : null}

        {linkDialog ? (
          <DesignLinkDialog
            scopeSpaceId={props.scopeSpaceId}
            selfPageId={page.id}
            {...(panelOpen ? { style: { right: 328 } } : {})}
            onClose={() => setLinkDialog(null)}
            onAdd={(card) => {
              editor.addCanvasNote({
                kind: "link",
                x: Math.round(linkDialog.x),
                y: Math.round(linkDialog.y),
                w: 640,
                h: 112,
                text: card.text.slice(0, 200),
                href: card.href,
                ...(card.subtitle ? { subtitle: card.subtitle } : {}),
              });
              setLinkDialog(null);
            }}
          />
        ) : null}

        {panelOpen ? (
          <SpaceSidePanel
            title="设计"
            onClose={() => setPanelOpen(false)}
            closeLabel="关闭面板"
            testId="design-panel"
          >
            <DesignInspector
              editor={editor}
              tab={panelTab}
              onTab={setPanelTab}
              scopeSpaceId={props.scopeSpaceId}
              selfPageId={page.id}
              onAsk={() => setAsking(true)}
              onExportBoard={(board) =>
                void runExport("PNG", () => exportBoardPng(board, canvas, 2))
              }
              onReplaceImage={(boardId, path) => void replaceImage(boardId, path)}
              onOpenLink={openLink}
            />
          </SpaceSidePanel>
        ) : null}
      </div>

      <Menu open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
        <ComposerPickerMenuPopup
          align="start"
          className="w-60 min-w-60"
          anchor={
            menu
              ? {
                  getBoundingClientRect: () =>
                    DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
                }
              : undefined
          }
        >
          {contextItems}
        </ComposerPickerMenuPopup>
      </Menu>

      {playing?.surface === "full" ? (
        <DesignPlayer
          canvas={canvas}
          boardId={playing.boardId}
          onBoard={(boardId) => setPlaying({ boardId, surface: "full" })}
          onClose={() => setPlaying(null)}
          {...(canAsk
            ? {
                onFix: (boardId: string, message: string) => {
                  const board = canvas.boards.find((entry) => entry.id === boardId);
                  setPlaying(null);
                  void ask(
                    `画板“${board?.name ?? boardId}”(${boardId}) 播放时脚本出错：${message}\n请修好它，其它不要改。`,
                  );
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
