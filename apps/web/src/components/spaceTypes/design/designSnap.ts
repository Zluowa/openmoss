// FILE: designSnap.ts
// Purpose: Snap and spacing guides while dragging in the 设计 editor: a moving box snaps its
//          edges and centre to the edges and centres of the boxes around it, and to an equal gap
//          between neighbours; the guides say what it lined up with.
// Layer: 资料空间 设计 (web, pure geometry)
// Why: Alignment and spacing guides while moving artboards and pieces; Moss draws
//      the same lines, computed here once for artboards, canvas notes and free elements.

export type SnapRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** A guide line: vertical (`x`) or horizontal (`y`) at `at`, drawn from `from` to `to`. */
export interface SnapLine {
  readonly axis: "x" | "y";
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** An equal gap marker: the space between two boxes along an axis. */
export interface SnapGap {
  readonly axis: "x" | "y";
  /** Start and end of the gap along the axis. */
  readonly start: number;
  readonly end: number;
  /** Where across the other axis the marker sits. */
  readonly cross: number;
}

export interface SnapResult {
  readonly dx: number;
  readonly dy: number;
  readonly lines: readonly SnapLine[];
  readonly gaps: readonly SnapGap[];
}

const edges = (rect: SnapRect, axis: "x" | "y") =>
  axis === "x"
    ? [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
    : [rect.y, rect.y + rect.h / 2, rect.y + rect.h];

const overlaps = (a: SnapRect, b: SnapRect, axis: "x" | "y") =>
  axis === "x" ? a.y < b.y + b.h && a.y + a.h > b.y : a.x < b.x + b.w && a.x + a.w > b.x;

function alignAxis(
  moving: SnapRect,
  others: readonly SnapRect[],
  axis: "x" | "y",
  threshold: number,
): { delta: number; at: number | null } {
  let best = { delta: 0, distance: threshold + 1, at: null as number | null };
  const mine = edges(moving, axis);
  for (const other of others) {
    for (const target of edges(other, axis)) {
      for (const edge of mine) {
        const distance = Math.abs(target - edge);
        if (distance < best.distance) best = { delta: target - edge, distance, at: target };
      }
    }
  }
  return best.distance <= threshold ? { delta: best.delta, at: best.at } : { delta: 0, at: null };
}

/** Equal spacing: the moving box sits between two neighbours with the same gap on each side, or
 * repeats a gap two other neighbours already have. */
function spaceAxis(
  moving: SnapRect,
  others: readonly SnapRect[],
  axis: "x" | "y",
  threshold: number,
): { delta: number; gaps: SnapGap[] } | null {
  const start = (rect: SnapRect) => (axis === "x" ? rect.x : rect.y);
  const size = (rect: SnapRect) => (axis === "x" ? rect.w : rect.h);
  const end = (rect: SnapRect) => start(rect) + size(rect);
  const crossOf = (a: SnapRect, b: SnapRect) =>
    axis === "x"
      ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2
      : (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
  const row = others.filter((other) => overlaps(moving, other, axis));
  const before = row
    .filter((other) => end(other) <= start(moving) + threshold)
    .sort((a, b) => end(b) - end(a))[0];
  const after = row
    .filter((other) => start(other) >= end(moving) - threshold)
    .sort((a, b) => start(a) - start(b))[0];
  if (before && after) {
    const room = start(after) - end(before) - size(moving);
    if (room >= 0) {
      const target = end(before) + room / 2;
      const delta = target - start(moving);
      if (Math.abs(delta) <= threshold) {
        const placed = { ...moving, [axis]: target } as SnapRect;
        return {
          delta,
          gaps: [
            { axis, start: end(before), end: target, cross: crossOf(placed, before) },
            {
              axis,
              start: target + size(moving),
              end: start(after),
              cross: crossOf(placed, after),
            },
          ],
        };
      }
    }
  }
  // Repeat a gap that two neighbours in the row already have.
  const sorted = [...row].sort((a, b) => start(a) - start(b));
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const gap = start(b) - end(a);
    if (gap <= 0) continue;
    for (const [neighbour, side] of [
      [before, "after"],
      [after, "before"],
    ] as const) {
      if (!neighbour) continue;
      const target =
        side === "after" ? end(neighbour) + gap : start(neighbour) - gap - size(moving);
      const delta = target - start(moving);
      if (Math.abs(delta) > threshold) continue;
      const placed = { ...moving, [axis]: target } as SnapRect;
      return {
        delta,
        gaps: [
          { axis, start: end(a), end: start(b), cross: crossOf(a, b) },
          side === "after"
            ? { axis, start: end(neighbour), end: target, cross: crossOf(placed, neighbour) }
            : {
                axis,
                start: target + size(moving),
                end: start(neighbour),
                cross: crossOf(placed, neighbour),
              },
        ],
      };
    }
  }
  return null;
}

/**
 * Where `moving` should go to line up with `others`: alignment wins over spacing on an axis.
 * `threshold` is in the same units as the rects (pass screen pixels ÷ zoom).
 */
export function snapRect(
  moving: SnapRect,
  others: readonly SnapRect[],
  threshold: number,
): SnapResult {
  const nearby = others.filter(
    (other) =>
      other.x < moving.x + moving.w + 4_000 &&
      other.x + other.w > moving.x - 4_000 &&
      other.y < moving.y + moving.h + 4_000 &&
      other.y + other.h > moving.y - 4_000,
  );
  const gaps: SnapGap[] = [];
  const x = alignAxis(moving, nearby, "x", threshold);
  const y = alignAxis(moving, nearby, "y", threshold);
  let dx = x.delta;
  let dy = y.delta;
  if (x.at === null) {
    const spaced = spaceAxis(moving, nearby, "x", threshold);
    if (spaced) {
      dx = spaced.delta;
      gaps.push(...spaced.gaps);
    }
  }
  if (y.at === null) {
    const spaced = spaceAxis(moving, nearby, "y", threshold);
    if (spaced) {
      dy = spaced.delta;
      gaps.push(...spaced.gaps);
    }
  }
  const placed = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const lines: SnapLine[] = [];
  for (const [axis, at] of [
    ["x", x.at],
    ["y", y.at],
  ] as const) {
    if (at === null) continue;
    const touching = nearby.filter((other) =>
      edges(other, axis).some((edge) => Math.abs(edge - at) < 0.5),
    );
    const span = [placed, ...touching];
    lines.push(
      axis === "x"
        ? {
            axis,
            at,
            from: Math.min(...span.map((rect) => rect.y)),
            to: Math.max(...span.map((rect) => rect.y + rect.h)),
          }
        : {
            axis,
            at,
            from: Math.min(...span.map((rect) => rect.x)),
            to: Math.max(...span.map((rect) => rect.x + rect.w)),
          },
    );
  }
  return { dx, dy, lines, gaps };
}

/** Snaps one moving edge (a resize) to the others' edges and centres. */
export function snapEdge(
  value: number,
  axis: "x" | "y",
  others: readonly SnapRect[],
  threshold: number,
): { value: number; line: SnapLine | null } {
  let best: { target: number; distance: number; rect: SnapRect } | null = null;
  for (const other of others)
    for (const target of edges(other, axis)) {
      const distance = Math.abs(target - value);
      if (distance <= threshold && (!best || distance < best.distance))
        best = { target, distance, rect: other };
    }
  if (!best) return { value, line: null };
  const rect = best.rect;
  return {
    value: best.target,
    line:
      axis === "x"
        ? { axis, at: best.target, from: rect.y, to: rect.y + rect.h }
        : { axis, at: best.target, from: rect.x, to: rect.x + rect.w },
  };
}
