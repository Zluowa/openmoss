// FILE: MarkupCanvas.tsx
// Purpose: Moss's one drawing surface: an image (a still of a browser page, or an image
//   attachment) with the reader's marks painted on a canvas above it, and composing the
//   marked image into a PNG. The browser page is frozen while drawing because a native
//   browser view always paints above web content, so nothing could be drawn over it live.
// Layer: Shared markup UI
// Spec: docs/design/annotate-and-comment/SPEC.md, "Drawing tools".

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import {
  MARKUP_COLORS,
  MARKUP_TEXT_SIZE,
  type MarkupMark,
  type MarkupPaintStyle,
  type MarkupPoint,
  type MarkupStyle,
  type MarkupTool,
  DEFAULT_MARKUP_STYLE,
  markupStepMark,
  markupTextMark,
  finishMarkupDrag,
  isMarkupDragShape,
  paintMarkupMarks,
} from "./markup.logic";

export const MARKUP_PAINT_STYLE: MarkupPaintStyle = {
  plate: "rgb(255 255 255 / 0.88)",
  fontFamily: '"Inter Variable", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
};

interface TextDraft {
  readonly at: MarkupPoint;
  readonly value: string;
}

function pointFrom(event: PointerEvent<HTMLElement>): MarkupPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function MarkupCanvas(props: {
  /** The image the marks are drawn on; null while it is being captured. */
  readonly pageImageUrl: string | null;
  /** Classes for the surface; it fills its positioned parent by default. */
  readonly className?: string;
  readonly tool: MarkupTool;
  /** Colour and width for new marks; the default when omitted. */
  readonly style?: MarkupStyle;
  readonly marks: readonly MarkupMark[];
  readonly onAddMark: (mark: MarkupMark) => void;
}) {
  const { t } = useTranslation();
  const style = props.style ?? DEFAULT_MARKUP_STYLE;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ pointerId: number; points: MarkupPoint[] } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draftPoints, setDraftPoints] = useState<readonly MarkupPoint[] | null>(null);
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
      draftPoints && (props.tool === "pen" || isMarkupDragShape(props.tool))
        ? finishMarkupDrag(props.tool, draftPoints, style)
        : null;
    paintMarkupMarks(
      ctx,
      preview ? [...props.marks, preview] : props.marks,
      MARKUP_PAINT_STYLE,
      ratio,
    );
  }, [draftPoints, props.marks, props.tool, size, style]);

  useEffect(() => {
    if (textDraft) textRef.current?.focus();
  }, [textDraft]);

  const commitText = () => {
    if (!textDraft) return;
    const mark = markupTextMark(textDraft.at, textDraft.value, style);
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
      props.onAddMark(markupStepMark(props.marks, point, style));
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
    if (props.tool !== "pen" && !isMarkupDragShape(props.tool)) return;
    const mark = finishMarkupDrag(props.tool, drag.points, style);
    if (mark) props.onAddMark(mark);
  };

  return (
    <div
      ref={hostRef}
      data-markup-canvas=""
      data-sketch-tool={props.tool}
      className={cn(
        "absolute inset-0 z-20 touch-none select-none overflow-hidden bg-background",
        props.className,
      )}
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
          aria-label={t("markup.textInput")}
          rows={1}
          value={textDraft.value}
          placeholder={t("markup.textPlaceholder")}
          className="absolute min-w-32 resize-none rounded-inline border-0 bg-white/90 px-1.5 py-0.5 font-medium outline-none [field-sizing:content] placeholder:font-normal placeholder:text-neutral-400"
          style={{
            left: textDraft.at.x - 6,
            top: textDraft.at.y - 3,
            color: style.color === "white" ? MARKUP_COLORS.black : MARKUP_COLORS[style.color],
            fontSize: MARKUP_TEXT_SIZE,
            lineHeight: "18px",
            fontFamily: MARKUP_PAINT_STYLE.fontFamily,
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

/**
 * The canvas as a PNG. Chromium encodes it in an idle period. Right after the page has
 * painted (a mark, a click) and then gone still, it can get none until another frame, so the
 * encode waits for Chromium's 1 s fallback timer. Asking for one frame lets it start at once.
 * A hidden window runs no frames and keeps the fallback.
 */
function encodePng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const frame = requestAnimationFrame(() => {});
    canvas.toBlob((blob) => {
      cancelAnimationFrame(frame);
      resolve(blob);
    }, "image/png");
  });
}

/** Paints marks over the image at the image's own pixel scale, as a PNG. */
export async function composeMarkupPng(input: {
  /** The image the marks were drawn on (any type the browser decodes). */
  readonly image: Blob;
  readonly marks: readonly MarkupMark[];
  /** Width the image was shown at while drawing, in CSS pixels. */
  readonly drawnWidth: number;
}): Promise<Blob> {
  const bitmap = await createImageBitmap(input.image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The marked image could not be prepared.");
    ctx.drawImage(bitmap, 0, 0);
    paintMarkupMarks(
      ctx,
      input.marks,
      MARKUP_PAINT_STYLE,
      input.drawnWidth > 0 ? bitmap.width / input.drawnWidth : 1,
    );
    const blob = await encodePng(canvas);
    if (!blob) throw new Error("The marked image could not be prepared.");
    return blob;
  } finally {
    bitmap.close();
  }
}
