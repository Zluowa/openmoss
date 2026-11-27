// FILE: usePageAppMarkup.ts
// Purpose: Reuses Moss's shared browser markup & element-picker workflow inside AppPageFrame
//          so Page Apps and Dev-Server / Browser previews share one annotation experience.
// Layer: Web pageApps hooks

import type { ThreadId } from "@moss/contracts";
import { PAGE_APP_THUMBNAIL_PROTOCOL } from "@moss/shared/pageAppFrameRuntime";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { browserAnnotationTheme } from "~/components/BrowserPanel.logic";
import {
  DEFAULT_MARKUP_STYLE,
  EMPTY_MARKUP_HISTORY,
  addMarkupMark,
  isMarkupDrawingTool,
  markupFileName,
  redoMarkupMark,
  undoMarkupMark,
  type MarkupHistory,
  type MarkupMark,
  type MarkupStyle,
  type MarkupTool,
} from "~/components/markup/markup.logic";
import { composeMarkupPng } from "~/components/markup/MarkupCanvas";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { BrowserAnnotationDraft } from "~/lib/browserAnnotations";
import { prepareComposerImageAttachmentsFromFiles } from "~/lib/composerSend";

import type { PageAppBroker, PageAppPickedElement } from "./broker";
import { loadPageAppThumbnailRenderer } from "./pageAppThumbnailCapture";

interface PageStill {
  readonly bytes: Uint8Array;
  readonly objectUrl: string;
}

export interface PageAppMarkupController {
  readonly open: boolean;
  readonly tool: MarkupTool;
  readonly coversPage: boolean;
  readonly pageImageUrl: string | null;
  readonly marks: readonly MarkupMark[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly style: MarkupStyle;
  readonly expanded: boolean;
  readonly adding: boolean;
  readonly confirmingDiscard: boolean;
  readonly error: string | null;
  readonly markerCount: number;
  readonly toggle: () => void;
  readonly requestClose: () => void;
  readonly cancelDiscard: () => void;
  readonly close: () => void;
  readonly setTool: (tool: MarkupTool) => void;
  readonly setStyle: (style: MarkupStyle) => void;
  readonly addMark: (mark: MarkupMark) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly clear: () => void;
  readonly addToChat: () => void;
  readonly buttonController: {
    readonly active: boolean;
    readonly starting: boolean;
    readonly toggle: () => void;
  };
  readonly handleElementPicked: (element: PageAppPickedElement) => void;
  readonly handlePickEnded: () => void;
}

interface UsePageAppMarkupInput {
  readonly enabled: boolean;
  readonly appId: string;
  readonly appTitle: string;
  readonly revision: number;
  readonly frameOrigin: string;
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly frameBodyRef: RefObject<HTMLDivElement | null>;
  readonly brokerRef: RefObject<PageAppBroker | null>;
  readonly threadId: ThreadId | null;
  readonly onOpen?: () => void;
  readonly onFallbackRoute?: (input: { quote?: string; label?: string }) => void;
}

function readPickTheme(): {
  readonly accent: string;
  readonly surface: string;
  readonly text: string;
} {
  const theme = browserAnnotationTheme(document.documentElement);
  return {
    accent: theme.accent,
    surface: theme.surface,
    text: theme.text,
  };
}

async function dataUrlToPngBytes(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderFallbackStillPng(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(320, Math.round(width));
  canvas.height = Math.max(200, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const surfaceBg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-background-surface")
        .trim() || "rgb(248, 250, 252)";
    ctx.fillStyle = surfaceBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return new Uint8Array();
  return new Uint8Array(await blob.arrayBuffer());
}

async function captureIframeStill(options: {
  readonly iframe: HTMLIFrameElement | null;
  readonly frameOrigin: string;
  readonly fallbackWidth: number;
  readonly fallbackHeight: number;
}): Promise<Uint8Array> {
  const targetWindow = options.iframe?.contentWindow;
  if (targetWindow) {
    const captured = await new Promise<Uint8Array | null>((resolve) => {
      const nonce = crypto.randomUUID();
      let settled = false;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
      };
      const finish = (bytes: Uint8Array | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(bytes);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== targetWindow || event.origin !== options.frameOrigin) return;
        const msg = event.data as {
          protocol?: string;
          kind?: string;
          nonce?: string;
          thumbnail?: unknown;
        } | null;
        if (
          !msg ||
          msg.protocol !== PAGE_APP_THUMBNAIL_PROTOCOL ||
          msg.kind !== "result" ||
          msg.nonce !== nonce ||
          typeof msg.thumbnail !== "string"
        ) {
          return;
        }
        void dataUrlToPngBytes(msg.thumbnail).then(finish, () => finish(null));
      };
      const timer = window.setTimeout(() => finish(null), 900);
      window.addEventListener("message", onMessage);
      void loadPageAppThumbnailRenderer()
        .then((renderer) => {
          targetWindow.postMessage(
            { protocol: PAGE_APP_THUMBNAIL_PROTOCOL, nonce, kind: "capture", renderer },
            options.frameOrigin === "null" ? "*" : options.frameOrigin,
          );
        })
        .catch(() => finish(null));
    });
    if (captured && captured.length > 0) return captured;
  }
  return renderFallbackStillPng(options.fallbackWidth, options.fallbackHeight);
}

export function usePageAppMarkup(input: UsePageAppMarkupInput): PageAppMarkupController {
  const [open, setOpen] = useState(false);
  const [tool, setToolState] = useState<MarkupTool>("select");
  const [history, setHistory] = useState<MarkupHistory>(EMPTY_MARKUP_HISTORY);
  const [style, setStyle] = useState<MarkupStyle>(DEFAULT_MARKUP_STYLE);
  const [expanded, setExpanded] = useState(false);
  const [still, setStill] = useState<PageStill | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMarkers, setLocalMarkers] = useState<
    Array<{ readonly id: string; readonly ordinal: number; readonly selector: string }>
  >([]);
  const captureSeqRef = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;

  const pageTabId = `page-app:${input.appId}`;
  const threadAnnotations = useComposerDraftStore((store) => {
    if (!input.threadId) return null;
    return store.draftsByThreadId[input.threadId]?.browserAnnotations ?? null;
  });

  const dropStill = useCallback(() => {
    captureSeqRef.current += 1;
    setStill((current) => {
      if (current) URL.revokeObjectURL(current.objectUrl);
      return null;
    });
  }, []);

  const close = useCallback(() => {
    inputRef.current.brokerRef.current?.setPickMode(false);
    setOpen(false);
    setConfirmingDiscard(false);
    setToolState("select");
    setHistory(EMPTY_MARKUP_HISTORY);
    setExpanded(false);
    setError(null);
    dropStill();
  }, [dropStill]);

  const hasMarks = history.marks.length > 0;
  const requestClose = useCallback(() => {
    if (hasMarks) setConfirmingDiscard(true);
    else close();
  }, [close, hasMarks]);
  const cancelDiscard = useCallback(() => setConfirmingDiscard(false), []);

  const setTool = useCallback((next: MarkupTool) => {
    setToolState(next);
    if (isMarkupDrawingTool(next)) {
      setExpanded(true);
      inputRef.current.brokerRef.current?.setPickMode(false);
    } else if (next === "select") {
      inputRef.current.brokerRef.current?.setPickMode(true, readPickTheme());
    }
  }, []);

  const toggle = useCallback(() => {
    if (!inputRef.current.enabled) return;
    if (open) {
      requestClose();
      return;
    }
    inputRef.current.onOpen?.();
    setOpen(true);
    setToolState("select");
    setError(null);
    inputRef.current.brokerRef.current?.setPickMode(true, readPickTheme());
  }, [open, requestClose]);

  useEffect(() => {
    if (!input.enabled && open) {
      close();
    }
  }, [close, input.enabled, open]);

  useEffect(() => {
    const activePick = open && tool === "select";
    if (activePick) {
      inputRef.current.brokerRef.current?.setPickMode(true, readPickTheme());
    } else {
      inputRef.current.brokerRef.current?.setPickMode(false);
    }
  }, [open, tool]);

  // Keep iframe ordinal badges synchronized with composer draft annotations when bound to a thread.
  useEffect(() => {
    if (!input.threadId || !threadAnnotations) return;
    const synced = threadAnnotations
      .filter((entry) => entry.tabId === pageTabId)
      .map((entry) => ({ id: entry.id, ordinal: entry.ordinal, selector: entry.selector }));
    setLocalMarkers(synced);
    inputRef.current.brokerRef.current?.syncMarkers(
      synced.map(({ ordinal, selector }) => ({ ordinal, selector })),
    );
  }, [input.threadId, pageTabId, threadAnnotations]);

  // Capture a still frame whenever a drawing tool is armed and no still exists yet.
  const drawing = open && isMarkupDrawingTool(tool);
  useEffect(() => {
    if (!drawing || still) return;
    const seq = ++captureSeqRef.current;
    const bodyEl = inputRef.current.frameBodyRef.current;
    const width = bodyEl?.clientWidth ?? 800;
    const height = bodyEl?.clientHeight ?? 500;
    void captureIframeStill({
      iframe: inputRef.current.iframeRef.current,
      frameOrigin: inputRef.current.frameOrigin,
      fallbackWidth: width,
      fallbackHeight: height,
    }).then((bytes) => {
      if (captureSeqRef.current !== seq) return;
      const copy = new Uint8Array(bytes);
      const objectUrl = URL.createObjectURL(new Blob([copy], { type: "image/png" }));
      setStill({ bytes: copy, objectUrl });
    });
  }, [drawing, still]);

  useEffect(() => () => dropStill(), [dropStill]);

  useEffect(() => {
    if (!drawing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (confirmingDiscard) setConfirmingDiscard(false);
      else requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingDiscard, drawing, requestClose]);

  const addMark = useCallback((mark: MarkupMark) => {
    setHistory((current) => addMarkupMark(current, mark));
  }, []);
  const undo = useCallback(() => setHistory((current) => undoMarkupMark(current)), []);
  const redo = useCallback(() => setHistory((current) => redoMarkupMark(current)), []);
  const clear = useCallback(() => setHistory(EMPTY_MARKUP_HISTORY), []);

  const addToChat = useCallback(() => {
    if (!still || history.marks.length === 0 || adding) return;
    setAdding(true);
    const marks = history.marks;
    void (async () => {
      try {
        const blob = await composeMarkupPng({
          image: new Blob([new Uint8Array(still.bytes)], { type: "image/png" }),
          marks,
          drawnWidth: inputRef.current.frameBodyRef.current?.clientWidth ?? 800,
        });
        const file = new File([blob], markupFileName(inputRef.current.appTitle), {
          type: "image/png",
        });
        const threadId = inputRef.current.threadId;
        if (threadId) {
          const prepared = await prepareComposerImageAttachmentsFromFiles({
            files: [file],
            existingAttachmentCount:
              useComposerDraftStore.getState().draftsByThreadId[threadId]?.images.length ?? 0,
          });
          if (prepared.images.length > 0) {
            useComposerDraftStore.getState().addImages(threadId, prepared.images);
          }
          if (prepared.error) setError(prepared.error);
          else setError(null);
        } else {
          inputRef.current.onFallbackRoute?.({
            quote: `已批注应用截图 (${marks.length} 处标注)`,
            label: inputRef.current.appTitle,
          });
        }
        setHistory(EMPTY_MARKUP_HISTORY);
        dropStill();
        setToolState("select");
        inputRef.current.brokerRef.current?.setPickMode(true, readPickTheme());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "标注截图发送失败。");
      } finally {
        setAdding(false);
      }
    })();
  }, [adding, dropStill, history.marks, still]);

  const handleElementPicked = useCallback((element: PageAppPickedElement) => {
    const current = inputRef.current;
    const id = crypto.randomUUID();
    const tabId = `page-app:${current.appId}`;
    const draft: Omit<BrowserAnnotationDraft, "ordinal"> = {
      id,
      tabId,
      documentKey: `${tabId}@v${current.revision}`,
      source: {
        url: `https://moss-app.local/${current.appId}`,
        pageTitle: current.appTitle,
      },
      selector: element.selector,
      tagName: element.tagName,
      role: element.role,
      name: element.name,
      text: element.text,
      html: element.html,
      fingerprint: `${element.tagName}:${element.selector}`.slice(0, 128),
      comment: null,
      capturedAt: new Date().toISOString(),
    };

    if (current.threadId) {
      useComposerDraftStore.getState().addBrowserAnnotation(current.threadId, draft);
    } else {
      current.onFallbackRoute?.({
        quote: element.text ?? element.selector,
        label: element.name ?? element.tagName,
      });
    }

    setLocalMarkers((prev) => {
      const nextOrdinal = prev.reduce((max, item) => Math.max(max, item.ordinal), 0) + 1;
      const next = [...prev, { id, ordinal: nextOrdinal, selector: element.selector }];
      current.brokerRef.current?.syncMarkers(
        next.map(({ ordinal, selector }) => ({ ordinal, selector })),
      );
      return next;
    });
  }, []);

  const handlePickEnded = useCallback(() => {
    if (open && tool === "select") {
      requestClose();
    }
  }, [open, requestClose, tool]);

  return {
    open,
    tool,
    coversPage: drawing && still !== null,
    pageImageUrl: still?.objectUrl ?? null,
    marks: history.marks,
    canUndo: history.marks.length > 0,
    canRedo: history.undone.length > 0,
    style,
    expanded,
    adding,
    confirmingDiscard,
    error,
    markerCount: localMarkers.length,
    toggle,
    requestClose,
    cancelDiscard,
    close,
    setTool,
    setStyle,
    addMark,
    undo,
    redo,
    clear,
    addToChat,
    buttonController: {
      active: open,
      starting: false,
      toggle,
    },
    handleElementPicked,
    handlePickEnded,
  };
}
