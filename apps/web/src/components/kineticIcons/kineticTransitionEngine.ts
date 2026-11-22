// FILE: kineticTransitionEngine.ts
// Purpose: Pure SSR-safe 400-pair SVG morph transition engine aligned with Claude/Moss ease-snap.
// Layer: Web UI kinetic icon engine
// Exports: KINETIC_MORPH_DURATION_MS, MorphPathLayer, MorphRenderGroup, KineticTransitionFrame, buildKineticTransitionFrame

import {
  KINETIC_ICON_SPECS,
  type KineticPathSpec,
  type MossKineticIconId,
} from "./kineticIconDefinitions";

export const KINETIC_MORPH_DURATION_MS = 260;

export interface MorphPathLayer {
  readonly key: string;
  readonly d: string;
  readonly strokeWidth?: number;
  readonly opacity?: number;
  readonly strokeDasharray?: string;
  readonly strokeDashoffset?: string;
}

export interface MorphRenderGroup {
  readonly key: string;
  readonly opacity?: number;
  readonly transform?: string;
  readonly paths: readonly MorphPathLayer[];
}

export interface KineticTransitionFrame {
  readonly viewBox: string;
  readonly groups: readonly MorphRenderGroup[];
}

const CONTOUR_SAMPLES = 96;
const CURVE_SUBDIVISIONS = 16;

type Point2D = readonly [number, number];

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function makeCubicBezier(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (x: number) => number {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u;
  const sampleDerivX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 6; i += 1) {
      const err = sampleX(u) - x;
      const deriv = sampleDerivX(u);
      if (Math.abs(err) < 1e-5 || Math.abs(deriv) < 1e-6) break;
      u = clamp(u - err / deriv, 0, 1);
    }
    return sampleY(u);
  };
}

// Calibrated to Claude/Moss ease-snap token (cubic-bezier(0.32, 0.72, 0, 1)).
const easeMossSnap = makeCubicBezier(0.32, 0.72, 0, 1);

function sampleArcSegment(
  x0: number,
  y0: number,
  rxInput: number,
  ryInput: number,
  xAxisRotationDeg: number,
  largeArcFlag: number,
  sweepFlag: number,
  x: number,
  y: number,
  out: Point2D[],
): void {
  if (rxInput === 0 || ryInput === 0 || (x0 === x && y0 === y)) {
    out.push([x, y]);
    return;
  }

  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const lambda = x1p2 / rx2 + y1p2 / ry2;
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const num = Math.max(0, rxSq * rySq - rxSq * y1p2 - rySq * x1p2);
  const den = rxSq * y1p2 + rySq * x1p2;
  const factor = den === 0 ? 0 : Math.sqrt(num / den);
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const cxp = sign * factor * ((rx * y1p) / ry);
  const cyp = sign * factor * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const vecAngle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const ratio = len === 0 ? 1 : clamp(dot / len, -1, 1);
    const angle = Math.acos(ratio);
    return ux * vy - uy * vx < 0 ? -angle : angle;
  };

  const vx1 = (x1p - cxp) / rx;
  const vy1 = (y1p - cyp) / ry;
  const vx2 = (-x1p - cxp) / rx;
  const vy2 = (-y1p - cyp) / ry;

  const theta1 = vecAngle(1, 0, vx1, vy1);
  let deltaTheta = vecAngle(vx1, vy1, vx2, vy2);
  if (sweepFlag === 0 && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweepFlag === 1 && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  for (let i = 1; i <= CURVE_SUBDIVISIONS; i += 1) {
    const angle = theta1 + (deltaTheta * i) / CURVE_SUBDIVISIONS;
    const ux = rx * Math.cos(angle);
    const uy = ry * Math.sin(angle);
    out.push([cosPhi * ux - sinPhi * uy + cx, sinPhi * ux + cosPhi * uy + cy]);
  }
}

function parsePathPolyline(d: string): readonly Point2D[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return [];

  const points: Point2D[] = [];
  let idx = 0;
  let cmd = "";
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  const nextNum = (): number => {
    const raw = tokens[idx];
    idx += 1;
    const parsed = raw !== undefined ? Number.parseFloat(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const hasNumberNext = (): boolean => idx < tokens.length && !/^[a-zA-Z]$/.test(tokens[idx] ?? "");

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (/^[a-zA-Z]$/.test(tok)) {
      cmd = tok;
      idx += 1;
      if (cmd === "Z" || cmd === "z") {
        if (curX !== startX || curY !== startY) {
          points.push([startX, startY]);
          curX = startX;
          curY = startY;
        }
        continue;
      }
    }

    switch (cmd) {
      case "M":
      case "m": {
        const nx = nextNum();
        const ny = nextNum();
        curX = cmd === "m" ? curX + nx : nx;
        curY = cmd === "m" ? curY + ny : ny;
        startX = curX;
        startY = curY;
        points.push([curX, curY]);
        cmd = cmd === "m" ? "l" : "L";
        break;
      }
      case "L":
      case "l": {
        const nx = nextNum();
        const ny = nextNum();
        curX = cmd === "l" ? curX + nx : nx;
        curY = cmd === "l" ? curY + ny : ny;
        points.push([curX, curY]);
        break;
      }
      case "H":
      case "h": {
        const nx = nextNum();
        curX = cmd === "h" ? curX + nx : nx;
        points.push([curX, curY]);
        break;
      }
      case "V":
      case "v": {
        const ny = nextNum();
        curY = cmd === "v" ? curY + ny : ny;
        points.push([curX, curY]);
        break;
      }
      case "Q":
      case "q": {
        const x0 = curX;
        const y0 = curY;
        const qx = nextNum();
        const qy = nextNum();
        const ex = nextNum();
        const ey = nextNum();
        const cx1 = cmd === "q" ? x0 + qx : qx;
        const cy1 = cmd === "q" ? y0 + qy : qy;
        curX = cmd === "q" ? x0 + ex : ex;
        curY = cmd === "q" ? y0 + ey : ey;
        for (let i = 1; i <= CURVE_SUBDIVISIONS; i += 1) {
          const t = i / CURVE_SUBDIVISIONS;
          const mt = 1 - t;
          points.push([
            mt * mt * x0 + 2 * mt * t * cx1 + t * t * curX,
            mt * mt * y0 + 2 * mt * t * cy1 + t * t * curY,
          ]);
        }
        break;
      }
      case "C":
      case "c": {
        const x0 = curX;
        const y0 = curY;
        const p1x = nextNum();
        const p1y = nextNum();
        const p2x = nextNum();
        const p2y = nextNum();
        const ex = nextNum();
        const ey = nextNum();
        const c1x = cmd === "c" ? x0 + p1x : p1x;
        const c1y = cmd === "c" ? y0 + p1y : p1y;
        const c2x = cmd === "c" ? x0 + p2x : p2x;
        const c2y = cmd === "c" ? y0 + p2y : p2y;
        curX = cmd === "c" ? x0 + ex : ex;
        curY = cmd === "c" ? y0 + ey : ey;
        for (let i = 1; i <= CURVE_SUBDIVISIONS; i += 1) {
          const t = i / CURVE_SUBDIVISIONS;
          const mt = 1 - t;
          points.push([
            mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * curX,
            mt * mt * mt * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * curY,
          ]);
        }
        break;
      }
      case "A":
      case "a": {
        const rx = nextNum();
        const ry = nextNum();
        const rot = nextNum();
        const large = nextNum() ? 1 : 0;
        const sweep = nextNum() ? 1 : 0;
        const ex = nextNum();
        const ey = nextNum();
        const x0 = curX;
        const y0 = curY;
        curX = cmd === "a" ? x0 + ex : ex;
        curY = cmd === "a" ? y0 + ey : ey;
        sampleArcSegment(x0, y0, rx, ry, rot, large, sweep, curX, curY, points);
        break;
      }
      default: {
        if (hasNumberNext()) {
          idx += 1;
        }
        break;
      }
    }

    if (!hasNumberNext()) {
      continue;
    }
  }

  return points;
}

const lengthCache = new Map<string, number>();
const contourCache = new Map<string, readonly Point2D[]>();
const alignmentCache = new Map<
  string,
  { readonly ptsA: readonly Point2D[]; readonly ptsB: readonly Point2D[] }
>();

function getPathLength(d: string): number {
  const cached = lengthCache.get(d);
  if (cached !== undefined) return cached;
  const pts = parsePathPolyline(d);
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  const len = Math.max(total, 0.01);
  lengthCache.set(d, len);
  return len;
}

function sampleClosedContour(d: string): readonly Point2D[] {
  const cached = contourCache.get(d);
  if (cached !== undefined) return cached;

  const rawPts = parsePathPolyline(d);
  if (rawPts.length < 2) {
    const fallback = Array.from({ length: CONTOUR_SAMPLES }, () => [12, 12] as const);
    contourCache.set(d, fallback);
    return fallback;
  }

  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < rawPts.length; i += 1) {
    total += Math.hypot(rawPts[i]![0] - rawPts[i - 1]![0], rawPts[i]![1] - rawPts[i - 1]![1]);
    cumulative.push(total);
  }
  const safeTotal = Math.max(total, 0.01);

  const sampled: Point2D[] = [];
  let segIdx = 0;
  for (let i = 0; i < CONTOUR_SAMPLES; i += 1) {
    const target = (i / CONTOUR_SAMPLES) * safeTotal;
    while (segIdx < cumulative.length - 2 && cumulative[segIdx + 1]! < target) {
      segIdx += 1;
    }
    const segStart = cumulative[segIdx]!;
    const segEnd = cumulative[segIdx + 1] ?? segStart;
    const span = segEnd - segStart;
    const ratio = span > 1e-6 ? clamp((target - segStart) / span) : 0;
    const pA = rawPts[segIdx]!;
    const pB = rawPts[segIdx + 1] ?? pA;
    sampled.push([lerp(pA[0], pB[0], ratio), lerp(pA[1], pB[1], ratio)]);
  }

  let signedArea = 0;
  for (let i = 0; i < CONTOUR_SAMPLES; i += 1) {
    const [x1, y1] = sampled[i]!;
    const [x2, y2] = sampled[(i + 1) % CONTOUR_SAMPLES]!;
    signedArea += (x2 - x1) * (y2 + y1);
  }
  if (signedArea > 0) {
    sampled.reverse();
  }

  contourCache.set(d, sampled);
  return sampled;
}

function getAlignedContours(
  dA: string,
  dB: string,
): { readonly ptsA: readonly Point2D[]; readonly ptsB: readonly Point2D[] } {
  const key = `${dA}__${dB}`;
  const cached = alignmentCache.get(key);
  if (cached !== undefined) return cached;

  const ptsA = sampleClosedContour(dA);
  const ptsB = sampleClosedContour(dB);
  let bestShift = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < CONTOUR_SAMPLES; shift += 1) {
    let cost = 0;
    for (let i = 0; i < CONTOUR_SAMPLES; i += 1) {
      const a = ptsA[i]!;
      const b = ptsB[(i + shift) % CONTOUR_SAMPLES]!;
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }

  const alignedB: Point2D[] = [];
  for (let i = 0; i < CONTOUR_SAMPLES; i += 1) {
    alignedB.push(ptsB[(i + bestShift) % CONTOUR_SAMPLES]!);
  }

  const result = { ptsA, ptsB: alignedB };
  alignmentCache.set(key, result);
  return result;
}

function buildInterpolatedContourPath(dA: string, dB: string, t: number): string {
  if (dA === dB) return dA;
  const { ptsA, ptsB } = getAlignedContours(dA, dB);
  let path = "";
  for (let i = 0; i < CONTOUR_SAMPLES; i += 1) {
    const x = lerp(ptsA[i]![0], ptsB[i]![0], t).toFixed(2);
    const y = lerp(ptsA[i]![1], ptsB[i]![1], t).toFixed(2);
    path += i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
  }
  return `${path}Z`;
}

function renderStrokePath(
  key: string,
  item: KineticPathSpec,
  rawProgress: number,
  mode: "draw" | "retract",
  easingFn: (x: number) => number,
): MorphPathLayer | null {
  const len = getPathLength(item.d);
  const dashLen = (len + 0.5).toFixed(2);
  const p = easingFn(clamp(rawProgress));
  const baseOp = item.opacity ?? 1;

  if (mode === "retract") {
    if (p >= 0.995) return null;
    const offset = (len * p).toFixed(2);
    const fade = p > 0.78 ? clamp(1 - (p - 0.78) / 0.22) : 1;
    return {
      key,
      d: item.d,
      ...(item.strokeWidth !== undefined ? { strokeWidth: item.strokeWidth } : {}),
      strokeDasharray: dashLen,
      strokeDashoffset: offset,
      opacity: Number((fade * baseOp).toFixed(3)),
    };
  }

  if (p <= 0.005) return null;
  const offset = (len * (1 - p)).toFixed(2);
  const fade = p < 0.14 ? clamp(p / 0.14) : 1;
  return {
    key,
    d: item.d,
    ...(item.strokeWidth !== undefined ? { strokeWidth: item.strokeWidth } : {}),
    strokeDasharray: dashLen,
    strokeDashoffset: offset,
    opacity: Number((fade * baseOp).toFixed(3)),
  };
}

function compactLayers(items: Array<MorphPathLayer | null>): MorphPathLayer[] {
  const out: MorphPathLayer[] = [];
  for (const item of items) {
    if (item !== null) out.push(item);
  }
  return out;
}

export function buildKineticTransitionFrame(
  fromId: MossKineticIconId,
  toId: MossKineticIconId,
  progress: number,
): KineticTransitionFrame {
  const from = KINETIC_ICON_SPECS[fromId];
  const to = KINETIC_ICON_SPECS[toId];
  const tc = clamp(progress, 0, 1);

  if (fromId === toId) {
    const ev = easeMossSnap(tc);
    const scale = lerp(0.94, 1, ev).toFixed(3);
    const frameParts = to.framePaths.map((p, i) => {
      const stagger = to.framePaths.length > 1 ? i * 0.06 : 0;
      const rawProg = clamp((tc - stagger) / 0.56);
      const prog = i === 0 ? Math.max(0.02, rawProg) : rawProg;
      return renderStrokePath(`same-frame-${i}`, p, prog, "draw", easeMossSnap);
    });
    const innerParts = to.innerPaths.map((p, i) => {
      const prog = clamp((tc - 0.36 - i * 0.07) / 0.5);
      return renderStrokePath(`same-inner-${i}`, p, prog, "draw", easeMossSnap);
    });
    return {
      viewBox: "0 0 24 24",
      groups: [
        {
          key: "same",
          transform: `scale(${scale})`,
          paths: compactLayers([...frameParts, ...innerParts]),
        },
      ],
    };
  }

  if (from.frameGroup === to.frameGroup && from.frameGroup !== "free") {
    const e = easeMossSnap(tc);
    const breath = (1 - 0.03 * Math.sin(Math.PI * tc)).toFixed(3);
    const anchorLayers: MorphPathLayer[] = [];

    if (from.frameGroup === "git") {
      const x = lerp(from.gitAnchorX ?? 6.5, to.gitAnchorX ?? 6.5, e).toFixed(2);
      const nx = Number(x);
      anchorLayers.push(
        { key: "git-stem", d: `M${x} 8.25V15.75` },
        {
          key: "git-top",
          d: `M${(nx + 2.25).toFixed(2)} 6A2.25 2.25 0 1 1 ${(nx - 2.25).toFixed(2)} 6A2.25 2.25 0 1 1 ${(nx + 2.25).toFixed(2)} 6Z`,
        },
        {
          key: "git-bottom",
          d: `M${(nx + 2.25).toFixed(2)} 18A2.25 2.25 0 1 1 ${(nx - 2.25).toFixed(2)} 18A2.25 2.25 0 1 1 ${(nx + 2.25).toFixed(2)} 18Z`,
        },
      );
    } else if (from.framePaths[0] && to.framePaths[0]) {
      anchorLayers.push({
        key: "morph-contour-anchor",
        d: buildInterpolatedContourPath(from.framePaths[0].d, to.framePaths[0].d, e),
      });
    }

    const outInner =
      tc < 0.44
        ? from.innerPaths.map((p, i) => {
            const stagger = from.innerPaths.length > 1 ? i * 0.028 : 0;
            const span = Math.max(0.42 - stagger, 0.22);
            const prog = clamp((tc - stagger) / span);
            return renderStrokePath(`morph-out-inner-${i}`, p, prog, "retract", easeMossSnap);
          })
        : [];

    const inInner =
      tc > 0.4
        ? to.innerPaths.map((p, i) => {
            const step = to.innerPaths.length > 4 ? 0.03 : 0.042;
            const stagger = to.innerPaths.length > 1 ? i * step : 0;
            const span = Math.max(0.52 - stagger, 0.28);
            const prog = clamp((tc - 0.42 - stagger) / span);
            return renderStrokePath(`morph-in-inner-${i}`, p, prog, "draw", easeMossSnap);
          })
        : [];

    return {
      viewBox: "0 0 24 24",
      groups: [
        {
          key: "morph",
          transform: `scale(${breath})`,
          paths: compactLayers([...anchorLayers, ...outInner, ...inInner]),
        },
      ],
    };
  }

  const groups: MorphRenderGroup[] = [];

  if (tc < 0.54) {
    const u = clamp(tc / 0.53);
    const eu = easeMossSnap(u);
    const scale = lerp(1, 0.9, eu).toFixed(3);
    const rot = lerp(0, -4, eu).toFixed(2);
    const op = tc <= 0.24 ? 1 : Number(clamp(1 - (tc - 0.24) / 0.3).toFixed(3));

    const outInners = from.innerPaths.map((p, i) => {
      const stagger = from.innerPaths.length > 1 ? i * 0.022 : 0;
      const span = Math.max(0.3 - stagger, 0.18);
      const pIn = clamp((tc - stagger) / span);
      return renderStrokePath(`exit-inner-${i}`, p, pIn, "retract", easeMossSnap);
    });

    const outFrames = from.framePaths.map((p, i) => {
      const stagger = from.framePaths.length > 1 ? i * 0.022 : 0;
      const span = Math.max(0.42 - stagger, 0.24);
      const pFr = clamp((tc - 0.08 - stagger) / span);
      return renderStrokePath(`exit-frame-${i}`, p, pFr, "retract", easeMossSnap);
    });

    groups.push({
      key: "exit",
      opacity: op,
      transform: `scale(${scale}) rotate(${rot}deg)`,
      paths: compactLayers([...outFrames, ...outInners]),
    });
  }

  if (tc > 0.28) {
    const v = clamp((tc - 0.29) / 0.71);
    const ev = easeMossSnap(v);
    const scale = lerp(0.91, 1, ev).toFixed(3);
    const rot = lerp(3.5, 0, ev).toFixed(2);
    const op = Number(clamp((tc - 0.29) / 0.12).toFixed(3));

    const inFrames = to.framePaths.map((p, i) => {
      const stagger = to.framePaths.length > 1 ? i * 0.032 : 0;
      const span = Math.max(0.44 - stagger, 0.26);
      const pFr = clamp((tc - 0.29 - stagger) / span);
      return renderStrokePath(`enter-frame-${i}`, p, pFr, "draw", easeMossSnap);
    });

    const inInners = to.innerPaths.map((p, i) => {
      const step = to.innerPaths.length > 4 ? 0.028 : 0.04;
      const stagger = to.innerPaths.length > 1 ? i * step : 0;
      const span = Math.max(0.42 - stagger, 0.22);
      const pIn = clamp((tc - 0.5 - stagger) / span);
      return renderStrokePath(`enter-inner-${i}`, p, pIn, "draw", easeMossSnap);
    });

    groups.push({
      key: "enter",
      opacity: op,
      transform: `scale(${scale}) rotate(${rot}deg)`,
      paths: compactLayers([...inFrames, ...inInners]),
    });
  }

  return {
    viewBox: "0 0 24 24",
    groups,
  };
}
