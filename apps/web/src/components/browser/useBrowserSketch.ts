// FILE: useBrowserSketch.ts
// Purpose: Owns annotation mode in the browser panel: which tool is armed, the still of the
//   page the marks are drawn on, the marks and their undo, and adding the marked page to chat.
//   Select element hands over to the guest element-pick session (useBrowserAnnotations).
// Layer: BrowserPanel hook
// Spec: docs/design/annotate-and-comment/SPEC.md, "Browser annotation".

import type { BrowserCaptureScreenshotResult } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserAnnotationsController } from "./useBrowserAnnotations";
import {
  addBrowserSketchMark,
  type BrowserSketchHistory,
  type BrowserSketchMark,
  type BrowserSketchStyle,
  type BrowserSketchTool,
  DEFAULT_BROWSER_SKETCH_STYLE,
  EMPTY_BROWSER_SKETCH_HISTORY,
  browserSketchFileName,
  isBrowserSketchDrawingTool,
  redoBrowserSketchMark,
  undoBrowserSketchMark,
} from "./browserSketch.logic";
import { composeBrowserSketchPng } from "./BrowserSketchOverlay";

interface PageStill {
  readonly tabId: string;
  readonly pageUrl: string;
  readonly bytes: Uint8Array;
  readonly objectUrl: string;
}

const STILL_CAPTURE_SETTLE_MS = 160;
export interface BrowserSketchController {
  readonly open: boolean;
  readonly tool: BrowserSketchTool;
  /**
   * True while a drawing tool covers the page with its still. Only once the still exists:
   * covering hides the live page, and a hidden page cannot be captured.
   */
  readonly coversPage: boolean;
  readonly pageImageUrl: string | null;
  readonly marks: readonly BrowserSketchMark[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Ink colour and stroke width for the next mark. */
  readonly style: BrowserSketchStyle;
  /**
   * The bar starts compact (select, pen, shapes, text, close); it shows colours, widths,
   * history and Add to chat once a drawing tool has been armed in this session.
   */
  readonly expanded: boolean;
  readonly adding: boolean;
  /** Closing was asked for while marks exist; the bar asks before dropping them. */
  readonly confirmingDiscard: boolean;
  readonly toggle: () => void;
  /** Closes, or asks first when there are marks. */
  readonly requestClose: () => void;
  readonly cancelDiscard: () => void;
  readonly close: () => void;
  readonly setTool: (tool: BrowserSketchTool) => void;
  readonly setStyle: (style: BrowserSketchStyle) => void;
  readonly addMark: (mark: BrowserSketchMark) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly clear: () => void;
  readonly addToChat: () => void;
}

interface UseBrowserSketchInput {
  readonly enabled: boolean;
  /**
   * Whether Select element can run on this page (web pages only). Without it the bar
   * opens on the pen, ready to draw.
   */
  readonly selectAvailable?: boolean;
  readonly activeTabId: string | null;
  readonly pageUrl: string;
  readonly pageTitle: string;
  readonly elementPicker: BrowserAnnotationsController;
  readonly capturePage: (tabId: string) => Promise<BrowserCaptureScreenshotResult | null>;
  /** Width of the page area in CSS pixels, read when the marked page is composed. */
  readonly readPageWidth: () => number;
  readonly attachImage: (file: File) => Promise<void>;
  readonly onError: (message: string | null) => void;
}

export function useBrowserSketch(input: UseBrowserSketchInput): BrowserSketchController {
  const { elementPicker } = input;
  const [open, setOpen] = useState(false);
  const [tool, setToolState] = useState<BrowserSketchTool>("select");
  const [history, setHistory] = useState<BrowserSketchHistory>(EMPTY_BROWSER_SKETCH_HISTORY);
  const [style, setStyle] = useState<BrowserSketchStyle>(DEFAULT_BROWSER_SKETCH_STYLE);
  const [expanded, setExpanded] = useState(false);
  const [still, setStill] = useState<PageStill | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const captureRequestRef = useRef(0);
  // Set while this hook itself ends the pick session, so that is not read as the reader
  // pressing Escape in the page.
  const leavingPickerRef = useRef(false);
  const pickerWasActiveRef = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  const dropStill = useCallback(() => {
    captureRequestRef.current += 1;
    setStill((current) => {
      if (current) URL.revokeObjectURL(current.objectUrl);
      return null;
    });
  }, []);

  const stopPicker = useCallback(() => {
    if (elementPicker.active) {
      leavingPickerRef.current = true;
      elementPicker.toggle();
    }
  }, [elementPicker]);

  const close = useCallback(() => {
    stopPicker();
    setOpen(false);
    setConfirmingDiscard(false);
    setToolState("select");
    setHistory(EMPTY_BROWSER_SKETCH_HISTORY);
    setExpanded(false);
    dropStill();
  }, [dropStill, stopPicker]);

  const setTool = useCallback(
    (next: BrowserSketchTool) => {
      if (next === "select" && inputRef.current.selectAvailable === false) return;
      setToolState(next);
      if (isBrowserSketchDrawingTool(next)) setExpanded(true);
      if (next === "select") {
        if (!elementPicker.active && !elementPicker.starting) elementPicker.toggle();
        return;
      }
      stopPicker();
    },
    [elementPicker, stopPicker],
  );

  const hasMarks = history.marks.length > 0;
  const requestClose = useCallback(() => {
    if (hasMarks) setConfirmingDiscard(true);
    else close();
  }, [close, hasMarks]);
  const cancelDiscard = useCallback(() => setConfirmingDiscard(false), []);

  const toggle = useCallback(() => {
    if (open) {
      requestClose();
      return;
    }
    setOpen(true);
    if (inputRef.current.selectAvailable === false) {
      setToolState("pen");
      setExpanded(true);
      return;
    }
    setToolState("select");
    if (!elementPicker.active && !elementPicker.starting) elementPicker.toggle();
  }, [elementPicker, open, requestClose]);

  // Leaving the pick session from the page (Escape there) leaves annotation mode too.
  useEffect(() => {
    const wasActive = pickerWasActiveRef.current;
    pickerWasActiveRef.current = elementPicker.active;
    if (!wasActive || elementPicker.active) return;
    if (leavingPickerRef.current) {
      leavingPickerRef.current = false;
      return;
    }
    if (open && tool === "select") requestClose();
  }, [elementPicker.active, open, requestClose, tool]);

  // Annotation is per page: another tab, a navigation or the panel losing its page ends it.
  useEffect(() => {
    if (!open) return;
    if (!input.enabled || input.activeTabId === null) {
      close();
      return;
    }
    if (still && (still.tabId !== input.activeTabId || still.pageUrl !== input.pageUrl)) {
      setHistory(EMPTY_BROWSER_SKETCH_HISTORY);
      dropStill();
    }
  }, [close, dropStill, input.activeTabId, input.enabled, input.pageUrl, open, still]);

  // A drawing tool needs a still of the page; take one when there is none.
  const drawing = open && isBrowserSketchDrawingTool(tool);
  useEffect(() => {
    if (!drawing || still || input.activeTabId === null) return;
    const tabId = input.activeTabId;
    const pageUrl = input.pageUrl;
    const request = captureRequestRef.current + 1;
    captureRequestRef.current = request;
    // Opening the bar shrinks the page area by the bar's strip; capture once the page
    // has taken its new size, so the still lines up with what the marks are drawn over.
    const timer = window.setTimeout(() => {
      if (captureRequestRef.current !== request) return;
      void inputRef.current.capturePage(tabId).then((shot) => {
        if (captureRequestRef.current !== request) return;
        if (!shot) {
          setToolState(inputRef.current.selectAvailable === false ? "pen" : "select");
          if (inputRef.current.selectAvailable === false) setOpen(false);
          return;
        }
        const bytes = new Uint8Array(shot.bytes);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setStill({ tabId, pageUrl, bytes, objectUrl });
      });
    }, STILL_CAPTURE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [drawing, input.activeTabId, input.pageUrl, still]);

  useEffect(() => () => dropStill(), [dropStill]);

  // Escape closes annotation while drawing; Select's own session handles it in the page.
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

  const addMark = useCallback((mark: BrowserSketchMark) => {
    setHistory((current) => addBrowserSketchMark(current, mark));
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => undoBrowserSketchMark(current));
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => redoBrowserSketchMark(current));
  }, []);

  const clear = useCallback(() => {
    setHistory(EMPTY_BROWSER_SKETCH_HISTORY);
  }, []);

  const addToChat = useCallback(() => {
    if (!still || history.marks.length === 0 || adding) return;
    const marks = history.marks;
    setAdding(true);
    void (async () => {
      try {
        const blob = await composeBrowserSketchPng({
          pageBytes: still.bytes,
          marks,
          drawnWidth: inputRef.current.readPageWidth(),
        });
        const file = new File([blob], browserSketchFileName(inputRef.current.pageTitle), {
          type: "image/png",
        });
        await inputRef.current.attachImage(file);
        inputRef.current.onError(null);
        // The marks are in the composer now. Back to the live page; the next marks start
        // on a fresh still.
        setHistory(EMPTY_BROWSER_SKETCH_HISTORY);
        dropStill();
        setTool("select");
      } catch (cause) {
        inputRef.current.onError(
          cause instanceof Error ? cause.message : "The marked page could not be added.",
        );
      } finally {
        setAdding(false);
      }
    })();
  }, [adding, dropStill, history.marks, setTool, still]);

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
  };
}
