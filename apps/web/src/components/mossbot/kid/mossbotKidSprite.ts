// FILE: mossbotKidSprite.ts
// Purpose: The pinwheel kid (风车娃) as pixels: a small body carrying the Moss pinwheel on a stick. Draws one pose of
//          any body form in any tone on a 34 × 38 stage. The pinwheel, face, arms and props are shared by every form,
//          so every clip works for every body.
// Layer: Pure drawing math (no DOM). The mascot studio (tools/mascot-studio) draws with the same module.
// Exports: MOSSBOT_KID_STAGE, MOSSBOT_KID_FORMS, MOSSBOT_KID_FORM_KEYS, mossbotKidPose, renderMossbotKidPose,
//          mossbotKidPalette, mossbotKidRestBox, and their types.
import {
  MOSSBOT_KID_INK,
  MOSSBOT_KID_PROP_COLOURS,
  MOSSBOT_KID_TONES,
  type MossbotKidTone,
} from "~/theme/mossbotKid";
import { MOSSBOT_COMPANION_CORAL, MOSSBOT_COMPANION_CORAL_DEEP } from "~/theme/mossbotCompanion";
import { mossbotPinwheelPixels } from "./mossbotPinwheel";

/** The stage every frame is drawn on. `ground` is the lowest row the kid stands on. */
export const MOSSBOT_KID_STAGE = { cols: 34, rows: 38, ground: 35, centerX: 16 } as const;

/**
 * Palette keys. T and U are the body tone and its shade; C and D the Moss corals (the pinwheel); K the ink of the
 * eyes; the rest belong to props.
 */
export type MossbotKidKey = "T" | "U" | "C" | "D" | "K" | keyof typeof MOSSBOT_KID_PROP_COLOURS;
export type MossbotKidGrid = (MossbotKidKey | null)[][];

export function mossbotKidPalette(tone: MossbotKidTone = "coral"): Record<MossbotKidKey, string> {
  const t = MOSSBOT_KID_TONES[tone] ?? MOSSBOT_KID_TONES.coral;
  return {
    T: t.body,
    U: t.shade,
    C: MOSSBOT_COMPANION_CORAL,
    D: MOSSBOT_COMPANION_CORAL_DEEP,
    K: MOSSBOT_KID_INK,
    ...MOSSBOT_KID_PROP_COLOURS,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Body forms, drawn by hand at their resting size. "#" is body (shaded on its lower and right edges), "=" a
// detail in the body's shade, "." empty; any other letter is that palette key (a dark visor, gold caps, a nose). Every form keeps the original block's family: about 15 wide
// and 10 tall, a flat top where the pinwheel's stick goes in, and a reason to carry a pinwheel.

type Feet = "legs" | "nubs" | "none";
interface Form {
  readonly rows: readonly string[];
  readonly feet: Feet;
  /** The row the eyes start on, and how far each eye sits from the centre column. */
  readonly eyeRow: number;
  readonly eyeGap: number;
  /** The colour of the eyes; light where the face is a dark visor. */
  readonly eyeKey: MossbotKidKey;
  /** The row that is repeated or removed when the body stretches or squashes: below the eyes, above any detail. */
  readonly stretchRow: number;
  /** How far above the body's top the pinwheel's hub sits. */
  readonly pinRise: number;
  /** The colour of the feet; the body's shade unless set. */
  readonly footKey?: MossbotKidKey;
}

/** The bodies a Mossbot can choose. `block` is the original kid. */
export const MOSSBOT_KID_FORMS = {
  // The original: a sturdy box on two legs.
  block: {
    rows: [
      "..###########..",
      ".#############.",
      "###############",
      "###############",
      "###############",
      "###############",
      "###############",
      "###############",
      "###############",
      ".#############.",
    ],
    feet: "legs",
    eyeRow: 3,
    eyeGap: 3,
    eyeKey: "K",
    stretchRow: 6,
    pinRise: 9,
  },
  // A little robot with a visor face and ear bolts; the pinwheel is its antenna.
  robot: {
    rows: [
      "..#############..",
      ".###############.",
      ".###NNNNNNNNN###.",
      "=##NNNNNNNNNNN##=",
      "=##NNNNNNNNNNN##=",
      ".###NNNNNNNNN###.",
      ".###############.",
      ".###############.",
      ".###############.",
      "..#############..",
    ],
    feet: "legs",
    eyeRow: 3,
    eyeGap: 3,
    eyeKey: "W",
    stretchRow: 7,
    pinRise: 9,
  },
  // A cat: the block with two ears and a small nose.
  cat: {
    rows: [
      ".#...........#.",
      ".#=.........=#.",
      ".#############.",
      "###############",
      "###############",
      "###############",
      "#######K#######",
      "###############",
      "###############",
      "###############",
      ".#############.",
    ],
    feet: "legs",
    eyeRow: 4,
    eyeGap: 3,
    eyeKey: "K",
    stretchRow: 8,
    pinRise: 9,
  },
  // A chick just out of its egg, still sitting in the shell: every new assistant hatches.
  chick: {
    rows: [
      ".....#####.....",
      "...#########...",
      "..###########..",
      ".#############.",
      ".#############.",
      "#######Y#######",
      "W##W###W###W##W",
      "WW#WW#WWW#WW#WW",
      "WWWWWWWWWWWWWWW",
      "WWWWWWWWWWWWWWW",
      ".WWWWWWWWWWWWW.",
      "..WWWWWWWWWWW..",
      "....WWWWWWW....",
    ],
    feet: "none",
    eyeRow: 3,
    eyeGap: 3,
    eyeKey: "K",
    stretchRow: 2,
    pinRise: 9,
  },
  // A penguin with a white belly, little flippers and yellow feet; the pinwheel is its propeller cap.
  penguin: {
    rows: [
      "....#######....",
      "..###########..",
      "..###########..",
      ".#############.",
      ".####WWYWW####.",
      ".###WWWWWWW###.",
      "=##WWWWWWWWW##=",
      "=##WWWWWWWWW##=",
      ".##WWWWWWWWW##.",
      ".##WWWWWWWWW##.",
      "..##WWWWWWW##..",
      "....#######....",
    ],
    feet: "nubs",
    eyeRow: 2,
    eyeGap: 3,
    eyeKey: "K",
    stretchRow: 8,
    pinRise: 9,
    footKey: "Y",
  },
  // A puppy: floppy ears down the sides of its face, a white muzzle with a black nose and a little tongue.
  dog: {
    rows: [
      "...###########...",
      "..=###########=..",
      ".==###########==.",
      "===###########===",
      "===###########===",
      "===###WWKWW###===",
      ".==###WWWWW###==.",
      "..=#####C#####=..",
      "...###########...",
      "...###########...",
      "....#########....",
    ],
    feet: "legs",
    eyeRow: 3,
    eyeGap: 3,
    eyeKey: "K",
    stretchRow: 9,
    pinRise: 9,
  },
} as const satisfies Record<string, Form>;

export type MossbotKidForm = keyof typeof MOSSBOT_KID_FORMS;
export const MOSSBOT_KID_FORM_KEYS = Object.keys(MOSSBOT_KID_FORMS) as MossbotKidForm[];

const resized = new Map<string, readonly string[]>();

// A form at another size: rows are repeated or removed at its stretch row, columns a quarter in from each side, so
// the outline's corners and details keep their shape.
function resize(formKey: MossbotKidForm, form: Form, w: number, h: number): readonly string[] {
  const cacheKey = `${formKey}:${w}:${h}`;
  const cached = resized.get(cacheKey);
  if (cached) return cached;
  const rows = [...form.rows];
  while (rows.length < h) rows.splice(form.stretchRow, 0, rows[form.stretchRow]!);
  while (rows.length > h && rows.length > 4)
    rows.splice(Math.min(form.stretchRow, rows.length - 2), 1);
  let out = rows;
  let width = out[0]!.length;
  while (width < w) {
    const q = Math.floor(width / 4);
    const m = width - q;
    out = out.map(
      (row) => row.slice(0, q + 1) + row[q] + row.slice(q + 1, m) + row[m - 1] + row.slice(m),
    );
    width += 2;
  }
  while (width > w && width > 5) {
    const q = Math.floor(width / 4);
    out = out.map(
      (row) => row.slice(0, q) + row.slice(q + 1, width - q - 1) + row.slice(width - q),
    );
    width -= 2;
  }
  resized.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Poses.

export type MossbotKidBody = "normal" | "breath" | "squash" | "stretch";
export type MossbotKidEyes =
  | "open"
  | "blink"
  | "closed"
  | "happy"
  | "look-l"
  | "look-r"
  | "look-up"
  | "wide"
  | "sad";
export type MossbotKidFeet = "stand" | "tuck" | "spread" | "step-l" | "step-r";
export type MossbotKidArms = "none" | "wave-up" | "wave-down" | "both-up" | "hold-r" | "reach-r";
export type MossbotKidProp =
  | "laptop"
  | "notebook"
  | "cup"
  | "bulb"
  | "confetti"
  | "zzz"
  | "sweat"
  | "magnifier"
  | "paper"
  | "picture"
  | "terminal"
  | "wrench"
  | "helpers"
  | "easel"
  | "speech"
  | "sign"
  | "hourglass"
  | "egg"
  | "poof"
  | "sparkle";

export interface MossbotKidPose {
  readonly dx: number;
  readonly dy: number;
  readonly body: MossbotKidBody;
  /** Continuous stretch of the body (1 is the form's size), for smooth playback between the four body steps. */
  readonly sx: number;
  readonly sy: number;
  readonly eyes: MossbotKidEyes;
  readonly feet: MossbotKidFeet;
  readonly arms: MossbotKidArms;
  /** The pinwheel's turn in degrees, clockwise. */
  readonly pin: number;
  /** How far the stem droops sideways (sleeping). */
  readonly bend: number;
  readonly props: ReadonlyArray<readonly [MossbotKidProp, number]>;
}

const DEFAULT_POSE: MossbotKidPose = {
  dx: 0,
  dy: 0,
  body: "normal",
  sx: 1,
  sy: 1,
  eyes: "open",
  feet: "stand",
  arms: "none",
  pin: 0,
  bend: 0,
  props: [],
};

export function mossbotKidPose(fields: Partial<MossbotKidPose> = {}): MossbotKidPose {
  return { ...DEFAULT_POSE, ...fields };
}

const BODY_STEP: Record<MossbotKidBody, readonly [number, number]> = {
  normal: [0, 0],
  breath: [0, -1],
  squash: [2, -2],
  stretch: [-2, 1],
};

const LEG_ROWS: Record<Feet, number> = { legs: 2, nubs: 1, none: 0 };

interface Geometry {
  readonly form: Form;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly bx: number;
  readonly by: number;
  /** The body's last row. */
  readonly bottom: number;
  /** The body's first row above its centre column, where the stem starts. */
  readonly top: number;
  /** The first row of the eyes. */
  readonly ey: number;
  readonly gap: number;
  /** The row arms attach to, and the body's outermost columns on that row. */
  readonly ay: number;
  readonly left: number;
  readonly right: number;
  /** The form's mark at a stage pixel: "#", "=", "N" or "." for empty. */
  readonly at: (x: number, y: number) => string;
  readonly inside: (x: number, y: number) => boolean;
}

const odd = (value: number): number => 2 * Math.round((value - 1) / 2) + 1;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function geometry(p: MossbotKidPose, formKey: MossbotKidForm): Geometry {
  const key = formKey in MOSSBOT_KID_FORMS ? formKey : "block";
  const form: Form = MOSSBOT_KID_FORMS[key];
  const [dw, dh] = BODY_STEP[p.body] ?? BODY_STEP.normal;
  const baseW = form.rows[0]!.length;
  const baseH = form.rows.length;
  const w = Math.max(5, odd(baseW * p.sx) + dw);
  const h = Math.max(4, Math.round(baseH * p.sy) + dh);
  const rows = resize(key, form, w, h);
  const cx = MOSSBOT_KID_STAGE.centerX + p.dx;
  const bottom = MOSSBOT_KID_STAGE.ground - LEG_ROWS[form.feet] + p.dy;
  const bx = cx - Math.floor(w / 2);
  const by = bottom - h + 1;
  const at = (x: number, y: number): string => rows[y - by]?.[x - bx] ?? ".";
  const inside = (x: number, y: number): boolean => at(x, y) !== ".";
  let top = by;
  while (top < bottom && !inside(cx, top)) top++;
  const ay = by + Math.round(h * 0.5);
  let left = cx;
  while (inside(left - 1, ay)) left--;
  let right = cx;
  while (inside(right + 1, ay)) right++;
  return {
    form,
    w,
    h,
    cx,
    bx,
    by,
    bottom,
    top,
    ey: by + Math.min(form.eyeRow, h - 3),
    gap: form.eyeGap,
    ay,
    left,
    right,
    at,
    inside,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing.

type Put = (x: number, y: number, key: MossbotKidKey) => void;

function drawBody(put: Put, g: Geometry): void {
  for (let y = g.by; y <= g.bottom; y++) {
    for (let x = g.bx; x < g.bx + g.w; x++) {
      const mark = g.at(x, y);
      if (mark === ".") continue;
      if (mark === "=") put(x, y, "U");
      else if (mark === "W") {
        // White parts (a shell, a belly) are outlined in light grey wherever they meet the outside, so they read
        // on paper.
        const outside =
          !g.inside(x - 1, y) || !g.inside(x + 1, y) || !g.inside(x, y - 1) || !g.inside(x, y + 1);
        put(x, y, outside ? "G" : "W");
      } else if (mark !== "#") put(x, y, mark as MossbotKidKey);
      else {
        // Light from the top left: the lower and right edges take the shade.
        const edge = !g.inside(x + 1, y) || !g.inside(x, y + 1);
        put(x, y, edge ? "U" : "T");
      }
    }
  }
}

// Eye shapes as [dx, dy] from the eye's anchor. Shapes in MIRRORED are drawn as given for the left eye and flipped
// for the right one.
const EYES: Record<MossbotKidEyes, ReadonlyArray<readonly [number, number]>> = {
  open: [
    [0, 0],
    [0, 1],
  ],
  blink: [[0, 1]],
  closed: [
    [-1, 1],
    [0, 1],
    [1, 1],
  ],
  happy: [
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  "look-l": [
    [-1, 0],
    [-1, 1],
  ],
  "look-r": [
    [1, 0],
    [1, 1],
  ],
  "look-up": [
    [0, -1],
    [0, 0],
  ],
  wide: [
    [0, -1],
    [0, 0],
    [0, 1],
  ],
  sad: [
    [0, 0],
    [-1, 1],
  ],
};
const MIRRORED = new Set<MossbotKidEyes>(["sad"]);

function drawEyes(put: Put, g: Geometry, eyes: MossbotKidEyes): void {
  const shape = EYES[eyes] ?? EYES.open;
  for (const side of [-1, 1]) {
    const ex = g.cx + side * g.gap;
    const flip = side === 1 && MIRRORED.has(eyes) ? -1 : 1;
    for (const [dx, dy] of shape) put(ex + dx * flip, g.ey + dy, g.form.eyeKey);
  }
}

function drawFeet(put: Put, g: Geometry, feet: MossbotKidFeet): void {
  const kind = g.form.feet;
  if (kind === "none") return;
  const top = g.bottom + 1;
  const offset = clamp(Math.floor(g.w / 4) + 1, 2, 5);
  const foot = (x: number, rows: number) => {
    for (let r = 0; r < rows; r++) {
      put(x, top + r, g.form.footKey ?? "U");
      put(x + 1, top + r, g.form.footKey ?? "U");
    }
  };
  const tall = kind === "legs" ? 2 : 1;
  switch (feet) {
    case "tuck":
      if (kind === "legs") {
        foot(g.cx - offset + 1, 1);
        foot(g.cx + offset - 2, 1);
      }
      break;
    case "spread":
      foot(g.cx - offset - 1, tall);
      foot(g.cx + offset, tall);
      break;
    case "step-l":
      foot(g.cx - offset, 1);
      foot(g.cx + offset - 1, tall);
      break;
    case "step-r":
      foot(g.cx - offset, tall);
      foot(g.cx + offset - 1, 1);
      break;
    default:
      foot(g.cx - offset, tall);
      foot(g.cx + offset - 1, tall);
  }
}

const ARM_SHAPES: Record<
  Exclude<MossbotKidArms, "none" | "both-up">,
  ReadonlyArray<readonly [number, number]>
> = {
  "wave-up": [
    [1, 0],
    [2, -1],
    [3, -2],
    [3, -3],
  ],
  "wave-down": [
    [1, 0],
    [2, 0],
    [3, -1],
  ],
  "hold-r": [
    [1, 1],
    [2, 1],
  ],
  "reach-r": [
    [1, 0],
    [2, -1],
    [3, -2],
  ],
};

function drawArms(put: Put, g: Geometry, arms: MossbotKidArms): void {
  if (arms === "none") return;
  const shape = ARM_SHAPES[arms === "both-up" ? "wave-up" : arms];
  for (const [dx, dy] of shape) put(g.right + dx, g.ay + dy, "T");
  if (arms === "both-up") for (const [dx, dy] of shape) put(g.left - dx, g.ay + dy, "T");
}

const PIN_SIZE = 11;

function drawPinwheel(put: Put, g: Geometry, p: MossbotKidPose): void {
  const pcx = g.cx + p.bend * 2;
  const pcy = g.top - g.form.pinRise + p.bend;
  const steps = Math.max(Math.abs(pcx - g.cx), Math.abs(pcy - (g.top - 1)));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    put(Math.round(g.cx + (pcx - g.cx) * t), Math.round(g.top - 1 + (pcy - g.top + 1) * t), "U");
  }
  for (const [dx, dy, colour] of mossbotPinwheelPixels(p.pin, PIN_SIZE))
    put(pcx + dx, pcy + dy, colour);
  put(pcx, pcy, "D");
}

// ---------------------------------------------------------------------------------------------------------------------
// Props. Each draws relative to the body, so it moves with the kid; `frame` animates it.

const CONFETTI: ReadonlyArray<readonly [number, number, MossbotKidKey]> = [
  [3, 0, "Y"],
  [7, 9, "B"],
  [11, 4, "E"],
  [14, 13, "C"],
  [18, 2, "Y"],
  [21, 10, "B"],
  [25, 6, "E"],
  [28, 14, "C"],
  [5, 12, "C"],
  [9, 3, "Y"],
  [16, 7, "B"],
  [23, 1, "E"],
  [27, 11, "Y"],
  [1, 8, "B"],
  [30, 4, "E"],
  [12, 15, "Y"],
];

const MAGNIFIER_RING: ReadonlyArray<readonly [number, number]> = [
  [-1, -2],
  [0, -2],
  [1, -2],
  [-2, -1],
  [2, -1],
  [-2, 0],
  [2, 0],
  [-2, 1],
  [2, 1],
  [-1, 2],
  [0, 2],
  [1, 2],
];

const PROPS: Record<MossbotKidProp, (put: Put, g: Geometry, frame: number) => void> = {
  // A laptop seen from behind its lid, hands typing over the top edge. Frames 0 and 1 alternate the hands; 2 rests.
  laptop(put, g, frame) {
    const top = Math.max(g.bottom - 4, g.ey + 2);
    for (let y = top; y <= g.bottom + 1; y++) {
      for (let x = g.cx - 6; x <= g.cx + 6; x++) put(x, y, y === top ? "N" : "S");
    }
    for (let x = g.cx - 7; x <= g.cx + 7; x++) put(x, g.bottom + 2, "N");
    put(g.cx, top + 3, "C");
    for (const [x, up] of [
      [g.cx - 5, frame === 1],
      [g.cx + 4, frame === 0],
    ] as const) {
      put(x, top - (up ? 2 : 1), "U");
      put(x + 1, top - (up ? 2 : 1), "U");
    }
  },

  // An open notebook held in front; the pencil writes one pixel further each frame.
  notebook(put, g, frame) {
    const top = Math.max(g.bottom - 4, g.ey + 2);
    for (let y = top; y <= top + 3; y++) {
      for (let x = g.cx - 5; x <= g.cx + 5; x++) put(x, y, x === g.cx ? "G" : "P");
    }
    for (let x = g.cx - 5; x <= g.cx + 5; x++) put(x, top + 4, "N");
    for (let x = g.cx - 4; x <= g.cx - 1; x++) {
      put(x, top + 1, "S");
      put(x, top + 3, x < g.cx - 2 ? "S" : "P");
    }
    const written = Math.min(frame, 4);
    for (let i = 0; i < written; i++) put(g.cx + 1 + i, top + 1, "S");
    const tip = g.cx + 1 + written;
    put(tip, top + 1, "N");
    put(tip + 1, top, "Y");
    put(tip + 2, top - 1, "Y");
    put(tip + 3, top - 2, "C");
    put(tip + 1, top + 1, "T");
    put(g.cx - 6, top + 2, "T");
  },

  // A cup of coffee. Frames 0–1 hold it at the side with steam; frame 2 lifts it to sip.
  cup(put, g, frame) {
    const sipping = frame >= 2;
    const x0 = sipping ? g.cx + 1 : g.right + 3;
    const y0 = sipping ? g.ay : g.ay - 1;
    for (let y = y0; y <= y0 + 3; y++) {
      for (let x = x0; x <= x0 + 2; x++) put(x, y, y === y0 ? "R" : "W");
    }
    put(x0 + 3, y0 + 1, "G");
    put(x0 + 3, y0 + 2, "G");
    if (sipping) {
      put(x0 - 1, y0 + 2, "T");
      return;
    }
    const sway = frame % 2;
    put(x0 + 1 - sway, y0 - 1, "G");
    put(x0 + sway, y0 - 2, "G");
    put(x0 + 1 - sway, y0 - 3, "G");
  },

  // A light bulb by the pinwheel. Frame 0 is off, 1 is lit, 2 is lit with rays.
  bulb(put, g, frame) {
    const x0 = g.cx + 9;
    const y0 = g.top - 13;
    const glass = frame === 0 ? "G" : "Y";
    [".###.", "#####", "#####", "#####", ".###."].forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === "#") put(x0 + dx, y0 + dy, glass);
    });
    if (frame > 0) put(x0 + 1, y0 + 1, "W");
    for (let dx = 1; dx <= 3; dx++) put(x0 + dx, y0 + 5, "S");
    put(x0 + 2, y0 + 6, "N");
    if (frame === 2) {
      for (const [dx, dy] of [
        [-2, 2],
        [6, 2],
        [2, -2],
        [-1, -1],
        [5, -1],
      ] as const) {
        put(x0 + dx, y0 + dy, "Y");
      }
    }
  },

  // Confetti falling over the whole stage. Sixteen frames make a seamless loop.
  confetti(put, _g, frame) {
    for (const [x, start, colour] of CONFETTI) {
      const y = ((start + frame) % 16) + 1;
      const sway = ((frame + x) >> 2) % 2;
      put(x + sway, y, colour);
      if ((frame + start) % 3 === 0) put(x + sway + 1, y, colour);
    }
  },

  // Sleeping Zs drifting up from the head.
  zzz(put, g, frame) {
    const z = (x: number, y: number, size: number) => {
      for (let i = 0; i < size; i++) {
        put(x + i, y, "S");
        put(x + i, y + size - 1, "S");
        put(x + size - 1 - i, y + i, "S");
      }
    };
    const rise = frame % 4;
    z(g.cx + 11, g.top - 3 - rise, 3);
    if (rise >= 1) z(g.cx + 13, g.top - 8 - rise, 4);
  },

  // A drop of sweat beside the head. Frame 1 has it slid down a pixel.
  sweat(put, g, frame) {
    const x0 = g.right + 1;
    const y0 = g.top + frame;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      put(x0 + dx, y0 + dy, "B");
    }
  },

  // A magnifying glass held up on the right.
  magnifier(put, g, frame) {
    const hx = g.right + 3;
    const hy = g.ay - 3;
    put(hx + 1, hy - 1, "N");
    put(hx + 2, hy - 2, "N");
    const cx = hx + 4;
    const cy = hy - 5;
    for (const [dx, dy] of MAGNIFIER_RING) put(cx + dx, cy + dy, "N");
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(cx + dx, cy + dy, "B");
    put(cx - 1 + (frame % 2), cy - 1, "W");
  },
  // A sheet held in front, read line by line: frames 0–3 move the reading mark down, frame 4 turns the page.
  paper(put, g, frame) {
    const top = Math.max(g.bottom - 5, g.ey + 2);
    const turning = frame % 5 === 4;
    const x0 = g.cx - (turning ? 2 : 3);
    const x1 = g.cx + 3;
    for (let y = top; y <= top + 5; y++) for (let x = x0; x <= x1; x++) put(x, y, "W");
    for (let x = x0; x <= x1; x++) put(x, top + 6, "G");
    if (!turning) {
      [top + 1, top + 2, top + 3, top + 4].forEach((y, i) => {
        const end = i % 2 ? x1 - 2 : x1 - 1;
        for (let x = x0 + 1; x <= end; x++) put(x, y, "S");
      });
      put(x0, top + 1 + (frame % 5), "B");
    }
    put(x0 - 1, top + 2, "T");
    put(x1 + 1, top + 2, "T");
  },

  // A photo held in front: sky, sun and a hill. Frame 1 tilts the sun's glint.
  picture(put, g, frame) {
    const top = Math.max(g.bottom - 5, g.ey + 2);
    for (let y = top; y <= top + 5; y++) {
      for (let x = g.cx - 4; x <= g.cx + 4; x++) {
        const edge = y === top || y === top + 5 || x === g.cx - 4 || x === g.cx + 4;
        const hill = y >= top + 3 && Math.abs(x - g.cx + 1) <= y - top - 1;
        put(x, y, edge ? "W" : hill ? "E" : "B");
      }
    }
    put(g.cx + 2, top + 1 + (frame % 2), "Y");
    put(g.cx - 5, top + 2, "T");
    put(g.cx + 5, top + 2, "T");
  },

  // A terminal window at the kid's side. Frames 0–7 print one more line each; the cursor blinks.
  terminal(put, g, frame) {
    const x0 = g.right + 3;
    const y0 = g.ay - 6;
    for (let y = y0; y <= y0 + 7; y++)
      for (let x = x0; x <= x0 + 9; x++) put(x, y, y === y0 ? "S" : "N");
    put(x0 + 1, y0, "C");
    put(x0 + 2, y0, "Y");
    const lines = frame % 8;
    for (let i = 0; i < Math.min(lines, 5); i++) {
      const length = [6, 4, 7, 3, 5][(i + Math.max(0, lines - 5)) % 5]!;
      for (let x = 0; x < length; x++) put(x0 + 1 + x, y0 + 2 + i, i === lines - 1 ? "W" : "E");
    }
    if (frame % 2 === 0) put(x0 + 1, y0 + 2 + Math.min(lines, 5), "W");
  },

  // A wrench in the raised hand, turning a bolt: frame 0 upright, frame 1 swung flat.
  wrench(put, g, frame) {
    const hx = g.right + 2;
    const hy = g.ay - 3;
    const shapes = [
      ["S.S", "SSS", ".S.", ".S.", ".S."],
      ["...SS", "SSSS.", "...SS"],
    ] as const;
    const shape = shapes[frame % 2]!;
    const y0 = frame % 2 ? hy : hy - 4;
    shape.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === "S") put(hx + dx, y0 + dy, "S");
    });
    put(hx + 6, hy + 1, "N");
    put(hx + 6, hy + 2, "N");
  },

  // Small helpers, each a tiny kid with a coral dot for a pinwheel, flying off to do their part.
  // Twelve frames make a loop.
  helpers(put, g, frame) {
    const tiny = (x: number, y: number) => {
      put(x + 1, y, "C");
      for (const dx of [0, 1, 2]) {
        put(x + dx, y + 1, "T");
        put(x + dx, y + 3, "U");
      }
      put(x, y + 2, "K");
      put(x + 1, y + 2, "T");
      put(x + 2, y + 2, "K");
    };
    const hub = g.top - 9;
    [
      [-1, 0],
      [1, 4],
      [0, 8],
    ].forEach(([side, delay]) => {
      const t = (frame + delay!) % 12;
      const x = side! < 0 ? g.cx - 4 - t : side! > 0 ? g.cx + 2 + t : g.cx - 1;
      const y = side === 0 ? hub - 4 - Math.floor(t / 2) : hub + 2 - Math.floor(t / 2);
      tiny(x, y);
    });
  },

  // An easel at the side; each frame adds a stroke to the picture. Eight frames finish it.
  easel(put, g, frame) {
    const x0 = g.right + 4;
    const y0 = g.ay - 7;
    for (let y = y0; y <= y0 + 6; y++) {
      for (let x = x0; x <= x0 + 7; x++) {
        const edge = y === y0 || y === y0 + 6 || x === x0 || x === x0 + 7;
        put(x, y, edge ? "G" : "W");
      }
    }
    for (let x = x0; x <= x0 + 7; x++) put(x, y0 + 7, "R");
    put(x0 + 1, y0 + 8, "R");
    put(x0, y0 + 9, "R");
    put(x0 + 6, y0 + 8, "R");
    put(x0 + 7, y0 + 9, "R");
    put(x0 + 3, y0 - 1, "R");
    put(x0 + 4, y0 - 1, "R");
    const strokes: ReadonlyArray<readonly [number, number, MossbotKidKey]> = [
      [1, 4, "E"],
      [2, 4, "E"],
      [3, 3, "E"],
      [4, 4, "E"],
      [5, 1, "Y"],
      [6, 4, "E"],
      [2, 1, "B"],
      [3, 1, "B"],
    ];
    strokes.slice(0, (frame % 8) + 1).forEach(([dx, dy, key]) => put(x0 + dx, y0 + dy, key));
    const [bx, by] = strokes[frame % 8]!;
    put(x0 + bx - 1, y0 + by + 1, "R");
    put(x0 + bx - 2, y0 + by + 2, "R");
  },

  // A speech bubble by the head; frames 0–2 light one more dot.
  speech(put, g, frame) {
    const x0 = g.cx + 6;
    const y0 = g.top - 7;
    for (let y = y0; y <= y0 + 4; y++) {
      for (let x = x0; x <= x0 + 8; x++) {
        const corner = (y === y0 || y === y0 + 4) && (x === x0 || x === x0 + 8);
        if (corner) continue;
        const edge = y === y0 || y === y0 + 4 || x === x0 || x === x0 + 8;
        put(x, y, edge ? "G" : "W");
      }
    }
    put(x0 + 1, y0 + 5, "G");
    put(x0, y0 + 6, "G");
    for (let i = 0; i < 3; i++) put(x0 + 2 + i * 2, y0 + 2, i <= frame % 3 ? "N" : "G");
  },

  // A small sign held up on the right, asking: a question mark that sways between frames 0 and 1.
  sign(put, g, frame) {
    const hx = g.right + 3;
    const hy = g.ay - 3;
    put(hx, hy, "R");
    put(hx, hy - 1, "R");
    const x0 = hx - 3 + (frame % 2);
    const y0 = hy - 8;
    for (let y = y0; y <= y0 + 6; y++) {
      for (let x = x0; x <= x0 + 6; x++) {
        const edge = y === y0 || y === y0 + 6 || x === x0 || x === x0 + 6;
        put(x, y, edge ? "G" : "W");
      }
    }
    for (const [dx, dy] of [
      [2, 1],
      [3, 1],
      [4, 2],
      [3, 3],
      [3, 5],
    ] as const) {
      put(x0 + dx, y0 + dy, "B");
    }
  },

  // An hourglass beside the kid, its sand running down: frames 0–3, then it turns over.
  hourglass(put, g, frame) {
    const x0 = g.right + 3;
    const y0 = g.ay - 5;
    for (let x = x0; x <= x0 + 4; x++) {
      put(x, y0, "R");
      put(x, y0 + 7, "R");
    }
    const glass = [
      [1, 3],
      [1, 3],
      [2, 2],
      [2, 2],
      [1, 3],
      [1, 3],
    ];
    const level = frame % 4;
    glass.forEach(([a, b], i) => {
      for (let dx = a!; dx <= b!; dx++) {
        const top = i < 3;
        const sand = top ? i >= level : 5 - i < level;
        put(x0 + dx, y0 + 1 + i, sand ? "Y" : "G");
      }
    });
  },

  // The egg a new kid hatches from: 0 whole, 1 cracked, 2 the top lifting off, 3 only the bottom left.
  egg(put, g, frame) {
    // Wide enough to hide the widest body.
    const cy = MOSSBOT_KID_STAGE.ground - 9;
    const lift = frame === 2 ? 5 : 0;
    const inEgg = (x: number, y: number) => (x / 9) ** 2 + ((y < 0 ? y * 0.85 : y) / 9.5) ** 2 <= 1;
    for (let y = -12; y <= 10; y++) {
      for (let x = -10; x <= 10; x++) {
        if (!inEgg(x, y)) continue;
        // The crack zigzags across the middle.
        const crackY = (Math.abs(x) % 4 < 2 ? 0 : 1) - 1;
        const upper = y < crackY;
        if (frame >= 3 && upper) continue;
        const crack = frame >= 1 && y === crackY;
        const edge = !inEgg(x - 1, y) || !inEgg(x + 1, y) || !inEgg(x, y - 1) || !inEgg(x, y + 1);
        put(g.cx + x, cy + y - (upper ? lift : 0), crack ? "S" : edge ? "G" : "W");
      }
    }
  },

  // A small puff of dust where something appears or goes: frames 0–2 grow and fade.
  poof(put, g, frame) {
    const r = 1 + (frame % 3);
    for (const [x, y] of [
      [g.left - 2, g.ay],
      [g.right + 2, g.ay],
    ] as const) {
      for (const [dx, dy] of [
        [-r, 0],
        [r, 0],
        [0, -r],
        [0, r],
        [-1, -1],
        [1, 1],
      ] as const) {
        put(x + dx, y + dy, frame % 3 === 2 ? "G" : "W");
      }
    }
  },

  // Sparkles around the pinwheel, twinkling between frames 0 and 1.
  sparkle(put, g, frame) {
    const hub = g.top - 9;
    for (const [dx, dy] of frame % 2
      ? ([
          [-7, -3],
          [7, 1],
          [0, -8],
        ] as const)
      : ([
          [-6, 2],
          [6, -4],
          [3, -8],
        ] as const)) {
      put(g.cx + dx, hub + dy, "Y");
      put(g.cx + dx - 1, hub + dy, "Y");
      put(g.cx + dx + 1, hub + dy, "Y");
      put(g.cx + dx, hub + dy - 1, "Y");
      put(g.cx + dx, hub + dy + 1, "Y");
    }
  },
};

/** Draws one pose of one body form; empty pixels are null. Pixels outside the stage are dropped. */
export function renderMossbotKidPose(
  pose: MossbotKidPose,
  form: MossbotKidForm = "block",
): MossbotKidGrid {
  const { cols, rows } = MOSSBOT_KID_STAGE;
  const grid: MossbotKidGrid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );
  const put: Put = (x, y, key) => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) grid[y]![x] = key;
  };
  const g = geometry(pose, form);
  drawPinwheel(put, g, pose);
  drawBody(put, g);
  drawEyes(put, g, pose.eyes);
  drawFeet(put, g, pose.feet);
  drawArms(put, g, pose.arms);
  for (const [name, frame] of pose.props) PROPS[name]?.(put, g, frame);
  return grid;
}

/** Where the kid stands at rest: its body and feet, and the top of its still pinwheel. For guides and framing. */
export function mossbotKidRestBox(form: MossbotKidForm = "block") {
  const g = geometry(DEFAULT_POSE, form);
  return {
    x: g.bx,
    y: g.top,
    w: g.w,
    h: MOSSBOT_KID_STAGE.ground - g.top + 1,
    pinTop: g.top - g.form.pinRise - (PIN_SIZE - 1) / 2,
  };
}
