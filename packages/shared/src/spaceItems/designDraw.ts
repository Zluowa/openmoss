// FILE: designDraw.ts
// Purpose: Geometry of the 设计 drawing tools: pencil strokes (thinned and smoothed into one SVG
//          path), pen paths (corners and curves from anchors with handles), arrow heads, and the
//          inline SVG a drawing becomes inside an artboard.
// Layer: Shared model (web canvas tools; pure functions, tested in shared)
// Why: A drawing is stored as plain SVG data, on the canvas as a shape note or in an artboard as
//      an <svg> element, so it renders, exports and edits like everything else.

export type DrawPoint = { readonly x: number; readonly y: number };
/** A pen anchor; `out` is the handle leaving it (the incoming one mirrors it). */
export type PenAnchor = DrawPoint & { readonly out?: DrawPoint };

const round = (value: number) => Math.round(value * 10) / 10;

function distanceToSegment(point: DrawPoint, a: DrawPoint, b: DrawPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker: drops points closer than `tolerance` to the line they sit on. */
export function simplifyPoints(points: readonly DrawPoint[], tolerance = 1): DrawPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = distanceToSegment(points[i]!, points[start]!, points[end]!);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** A smooth path through pencil points: quadratic curves through the midpoints. */
export function smoothPath(points: readonly DrawPoint[]): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length === 1) return `M${round(first.x)} ${round(first.y)}l0.1 0`;
  if (points.length === 2) {
    const last = points[1]!;
    return `M${round(first.x)} ${round(first.y)}L${round(last.x)} ${round(last.y)}`;
  }
  let d = `M${round(first.x)} ${round(first.y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i]!;
    const next = points[i + 1]!;
    d += `Q${round(point.x)} ${round(point.y)} ${round((point.x + next.x) / 2)} ${round((point.y + next.y) / 2)}`;
  }
  const last = points.at(-1)!;
  return `${d}L${round(last.x)} ${round(last.y)}`;
}

/** A pen path: straight between plain anchors, curved where an anchor has a handle. */
export function penPath(anchors: readonly PenAnchor[], closed = false): string {
  if (anchors.length === 0) return "";
  const first = anchors[0]!;
  let d = `M${round(first.x)} ${round(first.y)}`;
  const segment = (from: PenAnchor, to: PenAnchor) => {
    const c1 = from.out ?? from;
    // The incoming handle mirrors the outgoing one.
    const c2 = to.out ? { x: 2 * to.x - to.out.x, y: 2 * to.y - to.out.y } : to;
    if (!from.out && !to.out) return `L${round(to.x)} ${round(to.y)}`;
    return `C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`;
  };
  for (let i = 1; i < anchors.length; i += 1) d += segment(anchors[i - 1]!, anchors[i]!);
  if (closed && anchors.length > 2) d += `${segment(anchors.at(-1)!, first)}Z`;
  return d;
}

export interface DrawBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function boundsOf(points: readonly DrawPoint[]): DrawBox {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Every point a pen path passes near, so its box includes the handles' pull. */
export function penPoints(anchors: readonly PenAnchor[]): DrawPoint[] {
  return anchors.flatMap((anchor) =>
    anchor.out
      ? [anchor, anchor.out, { x: 2 * anchor.x - anchor.out.x, y: 2 * anchor.y - anchor.out.y }]
      : [anchor],
  );
}

export function translatePoints(points: readonly DrawPoint[], dx: number, dy: number): DrawPoint[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

export function translateAnchors(
  anchors: readonly PenAnchor[],
  dx: number,
  dy: number,
): PenAnchor[] {
  return anchors.map((anchor) => ({
    x: anchor.x + dx,
    y: anchor.y + dy,
    ...(anchor.out ? { out: { x: anchor.out.x + dx, y: anchor.out.y + dy } } : {}),
  }));
}

/** The triangle of an arrow head at (x2, y2), as SVG polygon points. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size = 12): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const a = { x: x2 - size * Math.cos(angle - spread), y: y2 - size * Math.sin(angle - spread) };
  const b = { x: x2 - size * Math.cos(angle + spread), y: y2 - size * Math.sin(angle + spread) };
  return `${round(x2)},${round(y2)} ${round(a.x)},${round(a.y)} ${round(b.x)},${round(b.y)}`;
}

export interface DrawingMarkupInput {
  readonly kind: "line" | "arrow" | "path";
  /** Where the drawing's box sits in the artboard root. */
  readonly box: DrawBox;
  /** Line/arrow ends relative to the box. */
  readonly points?: readonly [number, number, number, number];
  /** Path data relative to the box. */
  readonly d?: string;
  readonly closed?: boolean;
  readonly strokeWidth?: number;
}

/** The <svg> a drawing becomes inside an artboard: placed absolutely, in the design's ink. */
export function drawingMarkup(input: DrawingMarkupInput): string {
  const stroke = input.strokeWidth ?? 2;
  const pad = Math.ceil(stroke / 2 + (input.kind === "arrow" ? 8 : 1));
  const w = Math.max(1, Math.round(input.box.w)) + pad * 2;
  const h = Math.max(1, Math.round(input.box.h)) + pad * 2;
  const place = `position: absolute; left: ${Math.round(input.box.x) - pad}px; top: ${Math.round(input.box.y) - pad}px; width: ${w}px; height: ${h}px; overflow: visible; color: var(--ds-ink, currentColor)`;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" data-name="${
    input.kind === "path" ? "路径" : input.kind === "arrow" ? "箭头" : "线条"
  }" viewBox="${-pad} ${-pad} ${w} ${h}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" style="${place}">`;
  if (input.kind === "path")
    return `${open}<path d="${input.d ?? ""}"${input.closed ? ' fill="none"' : ""}/></svg>`;
  const [x1, y1, x2, y2] = input.points ?? [0, 0, input.box.w, input.box.h];
  const line = `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}"/>`;
  if (input.kind === "line") return `${open}${line}</svg>`;
  return `${open}${line}<polygon points="${arrowHead(x1, y1, x2, y2, 10 + stroke * 2)}" fill="currentColor" stroke="none"/></svg>`;
}
