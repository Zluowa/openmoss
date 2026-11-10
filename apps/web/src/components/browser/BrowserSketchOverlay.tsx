// FILE: BrowserSketchOverlay.tsx
// Purpose: The drawing surface over the browser page: a still of the page with the reader's
//   marks painted on a canvas above it. The page is frozen while drawing because a native
//   browser view always paints above web content, so nothing could be drawn over it live.
// Layer: BrowserPanel UI
// Spec: docs/design/annotate-and-comment/SPEC.md, "Drawing tools".

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import {
  BROWSER_SKETCH_COLORS,
  BROWSER_SKETCH_TEXT_SIZE,
  type BrowserSketchMark,
  type BrowserSketchPaintStyle,
  type BrowserSketchPoint,
  type BrowserSketchStyle,
  type BrowserSketchTool,
  DEFAULT_BROWSER_SKETCH_STYLE,
  browserSketchStepMark,
  browserSketchTextMark,
  finishBrowserSketchDrag,
  isBrowserSketchDragShape,
  paintBrowserSketchMarks,
} from "./browserSketch.logic";

export const BROWSER_SKETCH_PAINT_STYLE: BrowserSketchPaintStyle = {
  plate: "rgb(255 255 255 / 0.88)",
  fontFamily: '"Inter Variable", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
};

interface TextDraft {
  readonly at: BrowserSketchPoint;
  readonly value: string;
}

function pointFrom(event: PointerEvent<HTMLElement>): BrowserSketchPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function BrowserSketchOverlay(props: {
  /** Still of the page the marks are drawn on; null while it is being captured. */
  readonly pageImageUrl: string | null;
  readonly tool: BrowserSketchTool;
  /** Colour and width for new marks; the default when omitted. */
  readonly style?: BrowserSketchStyle;
  readonly marks: readonly BrowserSketchMark[];
  readonly onAddMark: (mark: BrowserSketchMark) => void;
}) {
  const style = props.style ?? DEFAULT_BROWSER_SKETCH_STYLE;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ pointerId: number; points: BrowserSketchPoint[] } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draftPoints, setDraftPoints] = useState<readonly BrowserSketchPoint[] | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Repaint everything on each change; a page has at most a few dozen marks.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const preview =
      draftPoints && (props.tool === "pen" || isBrowserSketchDragShape(props.tool))
        ? finishBrowserSketchDrag(props.tool, draftPoints, style)
        : null;
    paintBrowserSketchMarks(
      ctx,
      preview ? [...props.marks, preview] : props.marks,
      BROWSER_SKETCH_PAINT_STYLE,
      ratio,
    );
  }, [draftPoints, props.marks, props.tool, size, style]);

  useEffect(() => {
    if (textDraft) textRef.current?.focus();
  }, [textDraft]);

  const commitText = () => {
    if (!textDraft) return;
    const mark = browserSketchTextMark(textDraft.at, textDraft.value, style);
    setTextDraft(null);
    if (mark) props.onAddMark(mark);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    const point = pointFrom(event);
    if (props.tool === "text") {
      event.preventDefault();
      if (textDraft) commitText();
      setTextDraft({ at: point, value: "" });
      return;
    }
    if (props.tool === "select") return;
    if (props.tool === "step") {
      event.preventDefault();
      props.onAddMark(browserSketchStepMark(props.marks, point, style));
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks; the drag still works inside the page area.
    }
    dragRef.current = { pointerId: event.pointerId, points: [point] };
    setDraftPoints([point]);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointFrom(event);
    // Shapes only need their two corners; the pen keeps the whole path.
    drag.points = props.tool === "pen" ? [...drag.points, point] : [drag.points[0]!, point];
    setDraftPoints(drag.points);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraftPoints(null);
    if (props.tool !== "pen" && !isBrowserSketchDragShape(props.tool)) return;
    const mark = finishBrowserSketchDrag(props.tool, drag.points, style);
    if (mark) props.onAddMark(mark);
  };

  return (
    <div
      ref={hostRef}
      data-browser-sketch-overlay=""
      data-sketch-tool={props.tool}
      className="absolute inset-0 z-20 touch-none select-none overflow-hidden bg-background"
      style={{ cursor: props.tool === "text" ? "text" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {props.pageImageUrl ? (
        <img
          src={props.pageImageUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full object-fill"
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 animate-pulse bg-muted/30" />
      )}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
        style={{ width: size.width, height: size.height }}
      />
      {textDraft ? (
        <textarea
          ref={textRef}
          aria-label="Annotation text"
          rows={1}
          value={textDraft.value}
          placeholder="Type, then Enter"
          className="absolute min-w-32 resize-none rounded-[4px] border-0 bg-white/90 px-1.5 py-0.5 font-semibold outline-none [field-sizing:content] placeholder:font-normal placeholder:text-neutral-400"
          style={{
            left: textDraft.at.x - 6,
            top: textDraft.at.y - 3,
            color:
              style.color === "white"
                ? BROWSER_SKETCH_COLORS.black
                : BROWSER_SKETCH_COLORS[style.color],
            fontSize: BROWSER_SKETCH_TEXT_SIZE,
            lineHeight: "18px",
            fontFamily: BROWSER_SKETCH_PAINT_STYLE.fontFamily,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commitText();
            } else if (event.key === "Escape") {
              // The bar's own Escape closes annotation; here it only drops the text.
              event.preventDefault();
              event.stopPropagation();
              setTextDraft(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** Paints marks over the captured page at the capture's own pixel scale. */
export async function composeBrowserSketchPng(input: {
  readonly pageBytes: Uint8Array;
  readonly marks: readonly BrowserSketchMark[];
  /** Width of the page area the marks were drawn in, in CSS pixels. */
  readonly drawnWidth: number;
}): Promise<Blob> {
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(input.pageBytes)], { type: "image/png" }),
  );
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The marked page could not be prepared.");
    ctx.drawImage(bitmap, 0, 0);
    paintBrowserSketchMarks(
      ctx,
      input.marks,
      BROWSER_SKETCH_PAINT_STYLE,
      input.drawnWidth > 0 ? bitmap.width / input.drawnWidth : 1,
    );
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The marked page could not be prepared.");
    return blob;
  } finally {
    bitmap.close();
  }
}
