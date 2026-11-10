// FILE: markup.logic.ts
// Purpose: Marks a reader draws over an image (a frozen browser page or an image
//   attachment): pen, shapes, numbered steps and text in a chosen colour and stroke width,
//   their undo/redo history, and how they paint onto the image. Pure, so the toolbar, the
//   canvas, every host and the tests share one model.
// Layer: Shared markup logic
// Spec: docs/design/annotate-and-comment/SPEC.md, "Browser annotation".

export type MarkupShape = "line" | "arrow" | "rect" | "ellipse" | "step";
export type MarkupTool = "select" | "pen" | MarkupShape | "text";

/** The shapes menu, in its order. The group remembers the last one used. */
export const MARKUP_SHAPES: readonly MarkupShape[] = ["line", "arrow", "rect", "ellipse", "step"];

export const DEFAULT_MARKUP_SHAPE: MarkupShape = "rect";

export function isMarkupShape(tool: MarkupTool): tool is MarkupShape {
  return (MARKUP_SHAPES as readonly string[]).includes(tool);
}

/** Shapes drawn by dragging from one point to another (a step is placed by a click). */
export type MarkupDragShape = Exclude<MarkupShape, "step">;

export function isMarkupDragShape(tool: MarkupTool): tool is MarkupDragShape {
  return isMarkupShape(tool) && tool !== "step";
}

/** Tools that draw on the frozen page; Select works on the live page instead. */
export function isMarkupDrawingTool(tool: MarkupTool): boolean {
  return tool !== "select";
}

export type MarkupColor = "red" | "blue" | "green" | "black" | "white";

/** Ink colours, in menu order. Saturated mid tones that read on light and dark pages. */
export const MARKUP_COLORS: Readonly<Record<MarkupColor, string>> = {
  red: "#e03131",
  blue: "#1971c2",
  green: "#2f9e44",
  black: "#141413",
  white: "#ffffff",
};

export const MARKUP_COLOR_ORDER: readonly MarkupColor[] = [
  "red",
  "blue",
  "green",
  "black",
  "white",
];

/** Stroke widths in CSS pixels, thin to extra thick. */
export const MARKUP_STROKE_WIDTHS = [2, 4, 8, 12] as const;
export type MarkupStrokeWidth = (typeof MARKUP_STROKE_WIDTHS)[number];

export interface MarkupStyle {
  readonly color: MarkupColor;
  readonly width: MarkupStrokeWidth;
}

export const DEFAULT_MARKUP_STYLE: MarkupStyle = { color: "red", width: 4 };

export interface MarkupPoint {
  readonly x: number;
  readonly y: number;
}

export type MarkupMark = (
  | { readonly kind: "pen"; readonly points: readonly MarkupPoint[] }
  | {
      readonly kind: MarkupDragShape;
      readonly from: MarkupPoint;
      readonly to: MarkupPoint;
    }
  | { readonly kind: "step"; readonly at: MarkupPoint; readonly value: number }
  | { readonly kind: "text"; readonly at: MarkupPoint; readonly text: string }
) & { readonly style?: MarkupStyle };

export const MARKUP_TEXT_SIZE = 14;
const MARKUP_TEXT_LINE_HEIGHT = 18;
const MARKUP_TEXT_PAD_X = 6;
const MARKUP_TEXT_PAD_Y = 3;
// A press that moves less than this is a click, which draws nothing.
const MARKUP_MIN_DRAG = 3;
const MARKUP_STEP_BASE_DIAMETER = 18;

function distance(a: MarkupPoint, b: MarkupPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A finished drag as a mark, or null when it was only a click. */
export function finishMarkupDrag(
  tool: "pen" | MarkupDragShape,
  points: readonly MarkupPoint[],
  style?: MarkupStyle,
): MarkupMark | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const styled = style ? { style } : {};
  if (tool === "pen") {
    const travelled = points.some((point) => distance(point, first) >= MARKUP_MIN_DRAG);
    return travelled ? { kind: "pen", points, ...styled } : null;
  }
  if (distance(first, last) < MARKUP_MIN_DRAG) return null;
  return { kind: tool, from: first, to: last, ...styled };
}

export function markupTextMark(
  at: MarkupPoint,
  text: string,
  style?: MarkupStyle,
): MarkupMark | null {
  const trimmed = text.trim();
  return trimmed.length > 0
    ? { kind: "text", at, text: trimmed, ...(style ? { style } : {}) }
    : null;
}

/** The next numbered step at `at`: one more than the highest step already placed. */
export function markupStepMark(
  marks: readonly MarkupMark[],
  at: MarkupPoint,
  style?: MarkupStyle,
): MarkupMark {
  let highest = 0;
  for (const mark of marks) {
    if (mark.kind === "step") highest = Math.max(highest, mark.value);
  }
  return { kind: "step", at, value: highest + 1, ...(style ? { style } : {}) };
}

/** A step marker grows with the stroke width so it matches the lines around it. */
export function markupStepDiameter(width: number): number {
  return Math.round(MARKUP_STEP_BASE_DIAMETER + 2 * width);
}

export interface MarkupPaintStyle {
  /** Plate behind text, so a label reads over any page. */
  readonly plate: string;
  readonly fontFamily: string;
}

function markStyle(mark: MarkupMark): MarkupStyle {
  return mark.style ?? DEFAULT_MARKUP_STYLE;
}

function strokePath(ctx: CanvasRenderingContext2D, mark: MarkupMark): void {
  ctx.beginPath();
  switch (mark.kind) {
    case "pen": {
      const [first, ...rest] = mark.points;
      if (!first) return;
      ctx.moveTo(first.x, first.y);
      if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      break;
    }
    case "rect": {
      const x = Math.min(mark.from.x, mark.to.x);
      const y = Math.min(mark.from.y, mark.to.y);
      ctx.roundRect(x, y, Math.abs(mark.to.x - mark.from.x), Math.abs(mark.to.y - mark.from.y), 4);
      break;
    }
    case "ellipse": {
      const rx = Math.abs(mark.to.x - mark.from.x) / 2;
      const ry = Math.abs(mark.to.y - mark.from.y) / 2;
      ctx.ellipse(
        Math.min(mark.from.x, mark.to.x) + rx,
        Math.min(mark.from.y, mark.to.y) + ry,
        Math.max(rx, 0.5),
        Math.max(ry, 0.5),
        0,
        0,
        Math.PI * 2,
      );
      break;
    }
    case "line":
    case "arrow": {
      ctx.moveTo(mark.from.x, mark.from.y);
      ctx.lineTo(mark.to.x, mark.to.y);
      if (mark.kind === "arrow") {
        // The head grows with the stroke so a thick arrow still reads as one.
        const head = 10 + markStyle(mark).width * 2;
        const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
        for (const side of [-1, 1]) {
          ctx.moveTo(mark.to.x, mark.to.y);
          ctx.lineTo(
            mark.to.x - head * Math.cos(angle + (side * Math.PI) / 6),
            mark.to.y - head * Math.sin(angle + (side * Math.PI) / 6),
          );
        }
      }
      break;
    }
    case "step":
    case "text":
      break;
  }
}

function paintText(
  ctx: CanvasRenderingContext2D,
  mark: Extract<MarkupMark, { kind: "text" }>,
  style: MarkupPaintStyle,
): void {
  const { color } = markStyle(mark);
  ctx.font = `600 ${MARKUP_TEXT_SIZE}px ${style.fontFamily}`;
  ctx.textBaseline = "top";
  const lines = mark.text.split("\n");
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  // White ink gets a dark plate so it stays legible.
  ctx.fillStyle = color === "white" ? "rgb(20 20 19 / 0.82)" : style.plate;
  ctx.beginPath();
  ctx.roundRect(
    mark.at.x - MARKUP_TEXT_PAD_X,
    mark.at.y - MARKUP_TEXT_PAD_Y,
    width + MARKUP_TEXT_PAD_X * 2,
    lines.length * MARKUP_TEXT_LINE_HEIGHT + MARKUP_TEXT_PAD_Y * 2,
    4,
  );
  ctx.fill();
  ctx.fillStyle = MARKUP_COLORS[color];
  lines.forEach((line, index) => {
    ctx.fillText(line, mark.at.x, mark.at.y + index * MARKUP_TEXT_LINE_HEIGHT + 2);
  });
}

function paintStep(
  ctx: CanvasRenderingContext2D,
  mark: Extract<MarkupMark, { kind: "step" }>,
  style: MarkupPaintStyle,
): void {
  const { color, width } = markStyle(mark);
  const diameter = markupStepDiameter(width);
  ctx.beginPath();
  ctx.arc(mark.at.x, mark.at.y, diameter / 2, 0, Math.PI * 2);
  ctx.fillStyle = MARKUP_COLORS[color];
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color === "white" ? "rgb(20 20 19 / 0.35)" : "rgb(255 255 255 / 0.9)";
  ctx.stroke();
  ctx.fillStyle = color === "white" ? MARKUP_COLORS.black : "#ffffff";
  ctx.font = `600 ${Math.round(diameter * 0.55)}px ${style.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(mark.value), mark.at.x, mark.at.y + 0.5);
  ctx.textAlign = "start";
}

/**
 * Paints marks given in page-area CSS pixels. `scale` maps them onto the target, so the
 * same marks paint the live overlay (device pixel ratio) and the captured PNG (capture
 * width over page-area width).
 */
export function paintMarkupMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly MarkupMark[],
  style: MarkupPaintStyle,
  scale: number,
): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const mark of marks) {
    if (mark.kind === "text") {
      paintText(ctx, mark, style);
      continue;
    }
    if (mark.kind === "step") {
      paintStep(ctx, mark, style);
      continue;
    }
    const { color, width } = markStyle(mark);
    ctx.lineWidth = width;
    ctx.strokeStyle = MARKUP_COLORS[color];
    strokePath(ctx, mark);
    ctx.stroke();
  }
  ctx.restore();
}

/** Undo history as two stacks: undo moves the last mark onto the redo side. */
export interface MarkupHistory {
  readonly marks: readonly MarkupMark[];
  readonly undone: readonly MarkupMark[];
}

export const EMPTY_MARKUP_HISTORY: MarkupHistory = { marks: [], undone: [] };

export function addMarkupMark(history: MarkupHistory, mark: MarkupMark): MarkupHistory {
  return { marks: [...history.marks, mark], undone: [] };
}

export function undoMarkupMark(history: MarkupHistory): MarkupHistory {
  const last = history.marks.at(-1);
  if (!last) return history;
  return { marks: history.marks.slice(0, -1), undone: [...history.undone, last] };
}

export function redoMarkupMark(history: MarkupHistory): MarkupHistory {
  const next = history.undone.at(-1);
  if (!next) return history;
  return { marks: [...history.marks, next], undone: history.undone.slice(0, -1) };
}

export function markupFileName(pageTitle: string, now = new Date()): string {
  const stem =
    pageTitle
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "page";
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${stem} marked ${stamp}.png`;
}
