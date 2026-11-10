// FILE: browserSketch.logic.ts
// Purpose: Marks a reader draws over a frozen browser page (pen, shapes, numbered steps,
//   text) in a chosen colour and stroke width, their undo/redo history, and how they
//   paint onto the page's screenshot. Pure, so the toolbar, overlay and tests share one
//   model.
// Layer: BrowserPanel logic
// Spec: docs/design/annotate-and-comment/SPEC.md, "Browser annotation".

export type BrowserSketchShape = "line" | "arrow" | "rect" | "ellipse" | "step";
export type BrowserSketchTool = "select" | "pen" | BrowserSketchShape | "text";

/** The shapes menu, in its order. The group remembers the last one used. */
export const BROWSER_SKETCH_SHAPES: readonly BrowserSketchShape[] = [
  "line",
  "arrow",
  "rect",
  "ellipse",
  "step",
];

export const DEFAULT_BROWSER_SKETCH_SHAPE: BrowserSketchShape = "rect";

export function isBrowserSketchShape(tool: BrowserSketchTool): tool is BrowserSketchShape {
  return (BROWSER_SKETCH_SHAPES as readonly string[]).includes(tool);
}

/** Shapes drawn by dragging from one point to another (a step is placed by a click). */
export type BrowserSketchDragShape = Exclude<BrowserSketchShape, "step">;

export function isBrowserSketchDragShape(tool: BrowserSketchTool): tool is BrowserSketchDragShape {
  return isBrowserSketchShape(tool) && tool !== "step";
}

/** Tools that draw on the frozen page; Select works on the live page instead. */
export function isBrowserSketchDrawingTool(tool: BrowserSketchTool): boolean {
  return tool !== "select";
}

export type BrowserSketchColor = "red" | "blue" | "green" | "black" | "white";

/** Ink colours, in menu order. Saturated mid tones that read on light and dark pages. */
export const BROWSER_SKETCH_COLORS: Readonly<Record<BrowserSketchColor, string>> = {
  red: "#e03131",
  blue: "#1971c2",
  green: "#2f9e44",
  black: "#141413",
  white: "#ffffff",
};

export const BROWSER_SKETCH_COLOR_ORDER: readonly BrowserSketchColor[] = [
  "red",
  "blue",
  "green",
  "black",
  "white",
];

/** Stroke widths in CSS pixels, thin to extra thick. */
export const BROWSER_SKETCH_STROKE_WIDTHS = [2, 4, 8, 12] as const;
export type BrowserSketchStrokeWidth = (typeof BROWSER_SKETCH_STROKE_WIDTHS)[number];

export interface BrowserSketchStyle {
  readonly color: BrowserSketchColor;
  readonly width: BrowserSketchStrokeWidth;
}

export const DEFAULT_BROWSER_SKETCH_STYLE: BrowserSketchStyle = { color: "red", width: 4 };

export interface BrowserSketchPoint {
  readonly x: number;
  readonly y: number;
}

export type BrowserSketchMark = (
  | { readonly kind: "pen"; readonly points: readonly BrowserSketchPoint[] }
  | {
      readonly kind: BrowserSketchDragShape;
      readonly from: BrowserSketchPoint;
      readonly to: BrowserSketchPoint;
    }
  | { readonly kind: "step"; readonly at: BrowserSketchPoint; readonly value: number }
  | { readonly kind: "text"; readonly at: BrowserSketchPoint; readonly text: string }
) & { readonly style?: BrowserSketchStyle };

export const BROWSER_SKETCH_TEXT_SIZE = 14;
const BROWSER_SKETCH_TEXT_LINE_HEIGHT = 18;
const BROWSER_SKETCH_TEXT_PAD_X = 6;
const BROWSER_SKETCH_TEXT_PAD_Y = 3;
// A press that moves less than this is a click, which draws nothing.
const BROWSER_SKETCH_MIN_DRAG = 3;
const BROWSER_SKETCH_STEP_BASE_DIAMETER = 18;

function distance(a: BrowserSketchPoint, b: BrowserSketchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A finished drag as a mark, or null when it was only a click. */
export function finishBrowserSketchDrag(
  tool: "pen" | BrowserSketchDragShape,
  points: readonly BrowserSketchPoint[],
  style?: BrowserSketchStyle,
): BrowserSketchMark | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const styled = style ? { style } : {};
  if (tool === "pen") {
    const travelled = points.some((point) => distance(point, first) >= BROWSER_SKETCH_MIN_DRAG);
    return travelled ? { kind: "pen", points, ...styled } : null;
  }
  if (distance(first, last) < BROWSER_SKETCH_MIN_DRAG) return null;
  return { kind: tool, from: first, to: last, ...styled };
}

export function browserSketchTextMark(
  at: BrowserSketchPoint,
  text: string,
  style?: BrowserSketchStyle,
): BrowserSketchMark | null {
  const trimmed = text.trim();
  return trimmed.length > 0
    ? { kind: "text", at, text: trimmed, ...(style ? { style } : {}) }
    : null;
}

/** The next numbered step at `at`: one more than the highest step already placed. */
export function browserSketchStepMark(
  marks: readonly BrowserSketchMark[],
  at: BrowserSketchPoint,
  style?: BrowserSketchStyle,
): BrowserSketchMark {
  let highest = 0;
  for (const mark of marks) {
    if (mark.kind === "step") highest = Math.max(highest, mark.value);
  }
  return { kind: "step", at, value: highest + 1, ...(style ? { style } : {}) };
}

/** A step marker grows with the stroke width so it matches the lines around it. */
export function browserSketchStepDiameter(width: number): number {
  return Math.round(BROWSER_SKETCH_STEP_BASE_DIAMETER + 2 * width);
}

export interface BrowserSketchPaintStyle {
  /** Plate behind text, so a label reads over any page. */
  readonly plate: string;
  readonly fontFamily: string;
}

function markStyle(mark: BrowserSketchMark): BrowserSketchStyle {
  return mark.style ?? DEFAULT_BROWSER_SKETCH_STYLE;
}

function strokePath(ctx: CanvasRenderingContext2D, mark: BrowserSketchMark): void {
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
  mark: Extract<BrowserSketchMark, { kind: "text" }>,
  style: BrowserSketchPaintStyle,
): void {
  const { color } = markStyle(mark);
  ctx.font = `600 ${BROWSER_SKETCH_TEXT_SIZE}px ${style.fontFamily}`;
  ctx.textBaseline = "top";
  const lines = mark.text.split("\n");
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  // White ink gets a dark plate so it stays legible.
  ctx.fillStyle = color === "white" ? "rgb(20 20 19 / 0.82)" : style.plate;
  ctx.beginPath();
  ctx.roundRect(
    mark.at.x - BROWSER_SKETCH_TEXT_PAD_X,
    mark.at.y - BROWSER_SKETCH_TEXT_PAD_Y,
    width + BROWSER_SKETCH_TEXT_PAD_X * 2,
    lines.length * BROWSER_SKETCH_TEXT_LINE_HEIGHT + BROWSER_SKETCH_TEXT_PAD_Y * 2,
    4,
  );
  ctx.fill();
  ctx.fillStyle = BROWSER_SKETCH_COLORS[color];
  lines.forEach((line, index) => {
    ctx.fillText(line, mark.at.x, mark.at.y + index * BROWSER_SKETCH_TEXT_LINE_HEIGHT + 2);
  });
}

function paintStep(
  ctx: CanvasRenderingContext2D,
  mark: Extract<BrowserSketchMark, { kind: "step" }>,
  style: BrowserSketchPaintStyle,
): void {
  const { color, width } = markStyle(mark);
  const diameter = browserSketchStepDiameter(width);
  ctx.beginPath();
  ctx.arc(mark.at.x, mark.at.y, diameter / 2, 0, Math.PI * 2);
  ctx.fillStyle = BROWSER_SKETCH_COLORS[color];
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color === "white" ? "rgb(20 20 19 / 0.35)" : "rgb(255 255 255 / 0.9)";
  ctx.stroke();
  ctx.fillStyle = color === "white" ? BROWSER_SKETCH_COLORS.black : "#ffffff";
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
export function paintBrowserSketchMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly BrowserSketchMark[],
  style: BrowserSketchPaintStyle,
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
    ctx.strokeStyle = BROWSER_SKETCH_COLORS[color];
    strokePath(ctx, mark);
    ctx.stroke();
  }
  ctx.restore();
}

/** Undo history as two stacks: undo moves the last mark onto the redo side. */
export interface BrowserSketchHistory {
  readonly marks: readonly BrowserSketchMark[];
  readonly undone: readonly BrowserSketchMark[];
}

export const EMPTY_BROWSER_SKETCH_HISTORY: BrowserSketchHistory = { marks: [], undone: [] };

export function addBrowserSketchMark(
  history: BrowserSketchHistory,
  mark: BrowserSketchMark,
): BrowserSketchHistory {
  return { marks: [...history.marks, mark], undone: [] };
}

export function undoBrowserSketchMark(history: BrowserSketchHistory): BrowserSketchHistory {
  const last = history.marks.at(-1);
  if (!last) return history;
  return { marks: history.marks.slice(0, -1), undone: [...history.undone, last] };
}

export function redoBrowserSketchMark(history: BrowserSketchHistory): BrowserSketchHistory {
  const next = history.undone.at(-1);
  if (!next) return history;
  return { marks: [...history.marks, next], undone: history.undone.slice(0, -1) };
}

export function browserSketchFileName(pageTitle: string, now = new Date()): string {
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
