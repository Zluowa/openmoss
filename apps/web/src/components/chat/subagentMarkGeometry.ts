// FILE: subagentMarkGeometry.ts
// Purpose: The shapes of the subagent marks, generated from parameters. One rule for all
//          eighteen: Mossbot's sprout leaf, split along its midrib into a light face and a fold
//          (the Moss pinwheel's two-tone blade), repeated round the centre like pinwheel blades.
//          Counts, width, arch, tilt and the open centre give each mark its own outline.
// Layer: Chat UI geometry (pure; no DOM)
// Exports: SUBAGENT_MARK_SHAPES, SUBAGENT_MARK_SHAPE_COUNT, SubagentMarkShape, SubagentMarkPart

export interface SubagentMarkPart {
  readonly role: "face" | "fold";
  /** Path in a 32 x 32 viewBox. */
  readonly d: string;
}

export interface SubagentMarkShape {
  readonly name: string;
  readonly parts: readonly SubagentMarkPart[];
}

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

// Mossbot's leaf (LEAF_RIGHT in MossbotCompanion.tsx) turned onto its own chord, length 1.
const LEAF_UPPER: Cubic = [
  [0, 0],
  [0.229, -0.232],
  [0.676, -0.256],
  [1, 0],
];
const LEAF_LOWER: Cubic = [
  [0, 0],
  [0.269, 0.211],
  [0.699, 0.217],
  [1, 0],
];
/** Width of Mossbot's own leaf in the units below. */
const MOSSBOT_LEAF_WIDTH = 0.42;
/** Broader than Mossbot's leaf so a mark fills about 45 % of a 16 px box. */
const WIDTH_GAIN = 1.5;
/** The painted extent fits this square, centred in the 32 viewBox. */
const FIT_BOX = 30.5;

interface WhorlSpec {
  readonly name: string;
  /** Leaves round the centre. */
  readonly count: number;
  readonly length: number;
  /** Leaf width as a fraction of its length (Mossbot's leaf is 0.42). */
  readonly width: number;
  /** How far the leaf arches toward its light side. */
  readonly bend: number;
  /** Degrees off the ray from the centre: what makes the whorl turn. */
  readonly tilt: number;
  /** Distance of the leaf bases from the centre (an open centre when large). */
  readonly hole: number;
  /** Every other leaf this much shorter. */
  readonly alternate: number;
  readonly spin: number;
}

// Order matters: marks are handed out in this order, so the boldest outlines come first.
const SPECS: readonly WhorlSpec[] = [
  whorl("four-turn", 4, 15.0, 0.8, 1.3, 36, 0.6),
  whorl("three-swirl", 3, 14.8, 0.82, 0.9, 18, 0.5),
  whorl("five-swirl", 5, 14.6, 0.66, 1.0, 26, 0.8),
  whorl("six-flower", 6, 14.4, 0.56, 0.35, 4, 0.8),
  whorl("three-turn", 3, 15.0, 0.8, 1.5, 42, 0.5),
  whorl("four-cross", 4, 14.8, 0.66, 0.3, 0, 0.5),
  whorl("eight-cluster", 8, 14.2, 0.5, 0.6, 18, 1.2, 0.3),
  whorl("three-ring", 3, 12.4, 0.95, 0.8, 30, 3.0),
  whorl("six-turn", 6, 14.8, 0.5, 1.4, 40, 1.2),
  whorl("seven-swirl", 7, 14.0, 0.44, 1.0, 30, 1.6),
  whorl("four-ring", 4, 11.6, 0.86, 0.7, 24, 3.8, 0, 45),
  whorl("six-long-short", 6, 15.0, 0.58, 0.5, 10, 0.6, 0.4),
  whorl("five-star", 5, 15.0, 0.5, 0.15, 0, 0.6),
  whorl("three-broad", 3, 14.4, 0.86, 0.4, 6, 0.4, 0, 60),
  whorl("eight-ring", 8, 10.2, 0.7, 0.7, 28, 4.6),
  whorl("four-long-short", 4, 15.2, 0.7, 0.9, 18, 0.5, 0.42),
  whorl("two-broad", 2, 15.0, 0.95, 1.1, 22, 0.4),
  whorl("five-ring", 5, 11.2, 0.86, 0.6, 18, 4.0),
];

function whorl(
  name: string,
  count: number,
  length: number,
  width: number,
  bend: number,
  tilt: number,
  hole: number,
  alternate = 0,
  spin = 0,
): WhorlSpec {
  return { name, count, length, width, bend, tilt, hole, alternate, spin };
}

function leafEdges(length: number, width: number, bend: number): [Cubic, Cubic, Cubic] {
  const scale = width / MOSSBOT_LEAF_WIDTH;
  const edge = (template: Cubic): Cubic =>
    template.map(
      ([x, y]) => [x * length, (y * scale - bend * 0.22 * Math.sin(Math.PI * x)) * length] as const,
    ) as unknown as Cubic;
  const upper = edge(LEAF_UPPER);
  const lower = edge(LEAF_LOWER);
  // The midrib runs between the edges, nudged toward the fold so the face reads larger.
  const midrib = upper.map((point, index) => {
    const other = lower[index]!;
    const nudge = index > 0 && index < 3 ? 0.06 * scale * length : 0;
    return [(point[0] + other[0]) / 2, (point[1] + other[1]) / 2 + nudge] as const;
  }) as unknown as Cubic;
  return [upper, midrib, lower];
}

function place(curve: Cubic, baseX: number, baseY: number, degrees: number): Cubic {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return curve.map(
    ([x, y]) => [baseX + x * cos - y * sin, baseY + x * sin + y * cos] as const,
  ) as unknown as Cubic;
}

interface LeafHalf {
  readonly role: "face" | "fold";
  readonly edge: Cubic;
  readonly midrib: Cubic;
}

function whorlHalves(spec: WhorlSpec): LeafHalf[] {
  const halves: LeafHalf[] = [];
  for (let index = 0; index < spec.count; index += 1) {
    const theta = spec.spin + (360 * index) / spec.count;
    const ray = ((theta - 90) * Math.PI) / 180;
    const baseX = spec.hole * Math.cos(ray);
    const baseY = spec.hole * Math.sin(ray);
    const length =
      spec.alternate && index % 2 === 1 ? spec.length * (1 - spec.alternate) : spec.length;
    const [upper, midrib, lower] = leafEdges(length, spec.width * WIDTH_GAIN, spec.bend);
    const angle = theta - 90 + spec.tilt;
    const placedMidrib = place(midrib, baseX, baseY, angle);
    halves.push({ role: "face", edge: place(upper, baseX, baseY, angle), midrib: placedMidrib });
    halves.push({ role: "fold", edge: place(lower, baseX, baseY, angle), midrib: placedMidrib });
  }
  return halves;
}

function pointOn(curve: Cubic, t: number): Point {
  const u = 1 - t;
  const [p0, p1, p2, p3] = curve;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

/** Largest distance from the centre along either axis, sampled on the painted edges. */
function extent(halves: readonly LeafHalf[]): number {
  let max = 0;
  for (const half of halves) {
    for (let step = 0; step <= 32; step += 1) {
      const [x, y] = pointOn(half.edge, step / 32);
      max = Math.max(max, Math.abs(x), Math.abs(y));
    }
  }
  return max;
}

function format(value: number): string {
  const text = value.toFixed(2).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

function buildShape(spec: WhorlSpec): SubagentMarkShape {
  const halves = whorlHalves(spec);
  const scale = FIT_BOX / 2 / extent(halves);
  const at = ([x, y]: Point) => `${format(16 + x * scale)} ${format(16 + y * scale)}`;
  return {
    name: spec.name,
    parts: halves.map(({ role, edge, midrib }) => ({
      role,
      // Out along the edge to the tip, back along the midrib to the base.
      d: `M${at(edge[0])}C${at(edge[1])} ${at(edge[2])} ${at(edge[3])}C${at(midrib[2])} ${at(midrib[1])} ${at(midrib[0])}Z`,
    })),
  };
}

export const SUBAGENT_MARK_SHAPES: readonly SubagentMarkShape[] = SPECS.map(buildShape);
export const SUBAGENT_MARK_SHAPE_COUNT = SUBAGENT_MARK_SHAPES.length;
