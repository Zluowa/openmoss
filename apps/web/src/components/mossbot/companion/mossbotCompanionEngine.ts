// @ts-nocheck -- hand-tuned animation code ported as is from the Mossbot brand board; its public surface is
// typed in MossbotCompanion.tsx (MossbotCompanionHandle).
// FILE: mossbotCompanionEngine.ts
// Purpose: The animated Mossbot companion: a moss-green ball with a sprout, drawn in SVG and moved by hand-keyed
//          clips (anticipation, overshoot, shuffled decks, bridges between poses, face morphs, blinks). Our own motion
//          language grows out of the sprout: 发芽 spawn · 呼吸 idle · 向光 listening · 冒孢子 thinking · 转风车 working ·
//          化作风车 busy · 朝你弯 waiting · 起风 notify · 长新叶 done · 垂叶 error · 合叶 sleeping · 挥叶 greeting.
// Layer: Web component internals. Browser only: load it with import() from MossbotCompanion.
// Exports: createMossbotCompanion(host, {size, tone, state, gaze, interactive, still, label}),
//          MOSSBOT_COMPANION_STATE_NAMES.
// Notes: Proportions follow measurements published by bloub (MIT); the code, clips, sprout, pinwheel and colours are
//        Moss's own. Still companions draw one settled frame and never join the animation loop; live ones share a
//        single requestAnimationFrame loop that stops when none are left and skips companions scrolled out of view.
import {
  MOSSBOT_COMPANION_CORAL,
  MOSSBOT_COMPANION_CORAL_DEEP,
  MOSSBOT_COMPANION_EYE,
  MOSSBOT_COMPANION_TONES,
} from "~/theme/mossbotCompanion";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const reduce =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const R = 44; // ball radius in viewBox units

const TONES = MOSSBOT_COMPANION_TONES;
const EYE = MOSSBOT_COMPANION_EYE;
const CORAL = MOSSBOT_COMPANION_CORAL,
  CORAL_DEEP = MOSSBOT_COMPANION_CORAL_DEEP;
const LOGO_A =
  "M-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -41.5A6 6 0 0 0 -5.5 -47.5L-34.96 -47.5A6 6 0 0 0 -39.21 -37.26ZM3.53 -5.47A3.5 3.5 0 0 0 6 0.5L41.5 0.5A6 6 0 0 0 47.5 -5.5L47.5 -34.96A6 6 0 0 0 37.26 -39.21ZM5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 41.5A6 6 0 0 0 5.5 47.5L34.96 47.5A6 6 0 0 0 39.21 37.26ZM-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-41.5 -0.5A6 6 0 0 0 -47.5 5.5L-47.5 34.96A6 6 0 0 0 -37.26 39.21Z";
const LOGO_B =
  "M-24.47 -22.53L-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -41.5A6 6 0 0 0 -1.26 -45.74ZM22.53 -24.47L3.53 -5.47A3.5 3.5 0 0 0 6 0.5L41.5 0.5A6 6 0 0 0 45.74 -1.26ZM24.47 22.53L5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 41.5A6 6 0 0 0 1.26 45.74ZM-22.53 24.47L-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-41.5 -0.5A6 6 0 0 0 -45.74 1.26Z";

// ---------- small math ----------
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smooth = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const easeOut = (t) => 1 - (1 - clamp(t)) ** 3;
const easeOutBack = (t) => {
  t = clamp(t);
  const c = 1.6;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};
const bump = (t) => (t > 0 && t < 1 ? Math.sin(t * Math.PI) : 0);
const bump2 = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);
const loopNoise = (t, period, seed) => {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
};
const spin = (u, v, a) => {
  const c = Math.cos(a),
    s = Math.sin(a);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
};
const r2 = (v) => Math.round(v * 100) / 100;
// twice the signed area of a closed polygon (its sign tells the winding)
function signedArea(pts) {
  return pts.reduce((sum, q, i) => {
    const r = pts[(i + 1) % pts.length];
    return sum + q[0] * r[1] - r[0] * q[1];
  }, 0);
}
// cubic-bezier easing (x1, y1, x2, y2), solved for x by Newton steps
const bx = (u, a, b) => {
  const v = 1 - u;
  return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
};
const dx = (u, a, b) => {
  const v = 1 - u;
  return 3 * v * v * a + 6 * v * u * (b - a) + 3 * u * u * (1 - b);
};
function bezier(t, e) {
  const [x1, y1, x2, y2] = e;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const f = bx(u, x1, x2) - t,
      d = dx(u, x1, x2);
    if (Math.abs(f) < 1e-6 || Math.abs(d) < 1e-6) break;
    u = clamp(u - f / d);
  }
  return bx(u, y1, y2);
}
// ease vocabulary for hand-keyed clips
const E = {
  io: [0.42, 0, 0.58, 1], // plain in-out
  soft: [0.4, 0.06, 0.18, 1], // quick start, long settle
  out: [0.18, 0.62, 0.3, 1], // fast out
  in: [0.62, 0, 0.88, 0.5], // accelerate (falling)
  back: [0.42, -0.32, 0.3, 1], // anticipation: dips the other way first
  over: [0.28, 0.12, 0.2, 1.32], // overshoot, then settles on the next key
  snap: [0.78, 0, 0.18, 1], // hold, then snap
  land: [0.2, 0.9, 0.35, 1], // decelerate hard (landing)
};

// ---------- silhouettes as radial profiles ----------
const N = 96;
const ANG = Array.from({ length: N }, (_, i) => (i / N) * TAU);
const prof = (fn) => ANG.map(fn);
const PROFILES = {
  round: prof(() => 1),
  pebble: prof((a) => 1 + 0.035 * Math.cos(2 * a) - 0.045 * Math.max(0, Math.sin(a)) ** 4),
  seed: prof((a) => {
    const x = Math.cos(a) * 0.86,
      y = Math.sin(a) * (Math.sin(a) < 0 ? 1.1 : 1.0);
    return Math.hypot(x * (1 - 0.1 * Math.max(0, -Math.sin(a))), y);
  }),
  cushion: prof(
    (a) =>
      1.04 +
      0.07 * Math.cos(2 * a) -
      0.12 * Math.max(0, Math.sin(a)) ** 3 +
      0.012 * Math.cos(7 * a) * Math.max(0, -Math.sin(a)),
  ),
  dot: prof(() => 0.165),
};
PROFILES.pinwheel = (function () {
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", LOGO_A);
  const svg = document.createElementNS(NS, "svg");
  svg.style.cssText = "position:absolute;width:0;height:0";
  svg.appendChild(p);
  document.documentElement.appendChild(svg);
  const L = p.getTotalLength(),
    bins = Array.from({ length: N }, () => 0);
  for (let i = 0; i < 2400; i++) {
    const q = p.getPointAtLength((L * i) / 2400);
    const a = (Math.atan2(q.y, q.x) + TAU) % TAU,
      r = (Math.hypot(q.x, q.y) / 47.5) * 1.16;
    const k = Math.round((a / TAU) * N) % N;
    bins[k] = Math.max(bins[k], r);
  }
  svg.remove();
  for (let i = 0; i < N; i++)
    if (!bins[i]) bins[i] = (bins[(i + N - 1) % N] + bins[(i + 1) % N]) / 2 || 0.2;
  return bins;
})();
const FORMS = {
  round: { label: "圆团" },
  pebble: { label: "卵石" },
  seed: { label: "种子" },
  cushion: { label: "扁豆" },
};
function radiusAt(radii, a) {
  const f = ((((a % TAU) + TAU) % TAU) / TAU) * N,
    i = Math.floor(f) % N,
    j = (i + 1) % N;
  return lerp(radii[i], radii[j], f - Math.floor(f));
}
function bodyPath(radii, cx, cy, sx, sy, rot) {
  const pts = radii.map((r, i) => {
    const a = ANG[i] + rot;
    return [cx + Math.cos(a) * r * R * sx, cy + Math.sin(a) * r * R * sy];
  });
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i + N - 1) % N],
      p1 = pts[i],
      p2 = pts[(i + 1) % N],
      p3 = pts[(i + 2) % N];
    d += `C${r2(p1[0] + (p2[0] - p0[0]) / 6)} ${r2(p1[1] + (p2[1] - p0[1]) / 6)} ${r2(p2[0] - (p3[0] - p1[0]) / 6)} ${r2(p2[1] - (p3[1] - p1[1]) / 6)} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return d + "Z";
}

// ---------- face ----------
// Measured frame by frame on a reference avatar engine (337 px, front pose): neutral eyes are
// pills about 0.25 x 0.55 of the radius, centres 0.62 apart at mid height; happy eyes are thick crescents
// (0.53 x 0.40), shut eyes fat lenses (0.44 x 0.29), surprised eyes nearly round (0.5).
const REST = { yaw: 0, pitch: 2, roll: 0 };
const SPLIT = 18;
const eye = (w, h, tilt = 0, bend = 0, open = 1) => ({ w, h, tilt, bend, open });
const pair = (w, h, tilt = 0, bend = 0, open = 1) => [
  eye(w, h, tilt, bend, open),
  eye(w, h, -tilt, -bend, open),
];
const twin = (w, h, tilt = 0, bend = 0, open = 1) => [
  eye(w, h, tilt, bend, open),
  eye(w, h, tilt, bend, open),
];
const EXPRESSIONS = {
  neutral: { label: "平常", gaze: REST, split: SPLIT, eyes: twin(0.25, 0.55) },
  attentive: {
    label: "专心听",
    gaze: { yaw: 3, pitch: 6, roll: -2 },
    split: 19,
    eyes: twin(0.38, 0.5),
  },
  happy: {
    label: "开心",
    gaze: { yaw: 0, pitch: 2, roll: 0 },
    split: 19,
    eyes: twin(0.25, 0.57, 90, -0.27),
  },
  joyful: {
    label: "大笑",
    gaze: { yaw: 0, pitch: 4, roll: 0 },
    split: 19.5,
    eyes: [eye(0.26, 0.6, 86, -0.27), eye(0.26, 0.6, 94, -0.27)],
  },
  surprised: {
    label: "惊讶",
    gaze: { yaw: 0, pitch: 4, roll: 0 },
    split: 19.5,
    eyes: twin(0.46, 0.5),
  },
  wide: {
    label: "瞪大眼",
    gaze: { yaw: 6, pitch: -14, roll: 8 },
    split: 19,
    eyes: twin(0.36, 0.85),
  },
  curious: {
    label: "好奇",
    gaze: { yaw: 14, pitch: -6, roll: -14 },
    split: 18,
    eyes: [eye(0.27, 0.58, -8), eye(0.22, 0.46, -8)],
  },
  pondering: {
    label: "琢磨",
    gaze: { yaw: -14, pitch: 26, roll: 8 },
    split: 17,
    eyes: twin(0.22, 0.46, -10),
  },
  focused: {
    label: "专注",
    gaze: { yaw: 0, pitch: -6, roll: 0 },
    split: 18,
    eyes: pair(0.24, 0.36, 10),
  },
  proud: {
    label: "得意",
    gaze: { yaw: 0, pitch: 16, roll: 0 },
    split: 19,
    eyes: twin(0.23, 0.53, 90, -0.26),
  },
  sleepy: {
    label: "犯困",
    gaze: { yaw: 0, pitch: -8, roll: -3 },
    split: 18,
    eyes: twin(0.25, 0.55, 0, 0, 0.45),
  },
  sad: {
    label: "失落",
    gaze: { yaw: 0, pitch: -16, roll: 0 },
    split: 18,
    eyes: pair(0.24, 0.5, -30),
  },
  shy: { label: "害羞", gaze: { yaw: -18, pitch: -12, roll: -6 }, split: 16, eyes: twin(0.2, 0.4) },
  wink: {
    label: "眨眼",
    gaze: { yaw: -4, pitch: 4, roll: 6 },
    split: 18,
    eyes: [eye(0.25, 0.55), eye(0.11, 0.48, 90, 0.2)],
  },
  squint: {
    label: "使劲",
    gaze: { yaw: 0, pitch: 4, roll: 0 },
    split: 19,
    eyes: [eye(0.14, 0.4, 0, 0.45), eye(0.14, 0.4, 0, -0.45)],
  },
  closed: {
    label: "睡着",
    gaze: { yaw: 0, pitch: 3, roll: -2 },
    split: 18,
    eyes: twin(0.11, 0.48, 90, 0.22),
  },
};
const EXPR_EASE = [0.4, 0.06, 0.18, 1],
  EXPR_DUR = 0.28;
const BLINK_DUR = 0.26,
  BRIDGE_DUR = 0.35;

// ---------- clips: hand-keyed timelines ----------
// Each track is a list of keys [t, value, ease]; the ease shapes the segment that STARTS at that key.
// pos [x, y] (ball radii, y down) · rot [pitch, yaw, roll] (deg; pitch + looks up, yaw + turns right) ·
// sq [sx, sy] · spin [deg of extra turn] · lid [closure 0..1] · expr [[t, name|null, cut?]] (null = the state's face).
const Z2 = [0, 0],
  Z3 = [0, 0, 0],
  ONE = [1, 1];
const CLIPS = {
  // 呼吸 — idle
  idleRest: {
    dur: 3.7,
    rot: [
      [0, Z3, E.io],
      [1.9, [1.6, 3.2, -1.2], E.io],
      [3.7, Z3],
    ],
    sq: [
      [0, ONE, E.io],
      [1.85, [0.99, 1.012], E.io],
      [3.7, ONE],
    ],
  },
  idleLook: {
    dur: 5.3,
    rot: [
      [0, Z3, E.soft],
      [0.82, [-3, -17, -4], E.io],
      [2.05, [-2.2, -15.5, -3], E.back],
      [2.93, [5, 13, 6], E.over],
      [3.62, [4.2, 11.5, 5], E.io],
      [5.3, Z3],
    ],
    pos: [
      [0, Z2, E.soft],
      [0.82, [-0.03, 0.008], E.io],
      [2.05, [-0.028, 0.006], E.back],
      [2.93, [0.034, -0.012], E.over],
      [3.62, [0.03, -0.01], E.io],
      [5.3, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [2.62, ONE, E.out],
      [2.84, [1.035, 0.97], E.io],
      [3.1, [0.985, 1.015], E.io],
      [3.4, ONE],
    ],
    lid: [
      [2.36, [0], E.io],
      [2.44, [1], E.io],
      [2.56, [0]],
    ],
  },
  idleTilt: {
    dur: 4.6,
    rot: [
      [0, Z3, E.back],
      [0.74, [-7, 9, -15], E.over],
      [1.32, [-6, 8, -13], E.io],
      [2.75, [-5, 7, -12.5], E.soft],
      [3.35, Z3],
    ],
    pos: [
      [0, Z2, E.back],
      [0.74, [0.02, -0.01], E.io],
      [2.75, [0.018, -0.008], E.soft],
      [3.35, Z2],
    ],
    expr: [
      [0.5, "curious"],
      [3.1, null],
    ],
  },
  idleUp: {
    dur: 5.0,
    rot: [
      [0, Z3, E.soft],
      [0.96, [15, -7, 6], E.over],
      [1.62, [13, -6, 5], E.io],
      [2.9, [12, -5, 4.5], E.soft],
      [3.52, Z3],
    ],
    pos: [
      [0, Z2, E.soft],
      [0.96, [-0.012, -0.02], E.io],
      [2.9, [-0.01, -0.018], E.soft],
      [3.52, Z2],
    ],
    lid: [
      [1.26, [0], E.io],
      [1.34, [1], E.io],
      [1.46, [0], E.io],
      [1.6, [1], E.io],
      [1.72, [0]],
    ],
  },
  idleHop: {
    dur: 3.6,
    pos: [
      [0, Z2, E.io],
      [0.32, [0, 0.025], E.out],
      [0.58, [0.07, -0.2], E.in],
      [0.84, [0.12, 0], E.land],
      [0.98, [0.12, -0.045], E.in],
      [1.1, [0.12, 0], E.io],
      [2.2, [0.12, 0], E.soft],
      [3.0, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.3, [1.12, 0.87], E.out],
      [0.46, [0.92, 1.1], E.io],
      [0.8, ONE, E.out],
      [0.88, [1.13, 0.88], E.out],
      [1.06, [0.98, 1.02], E.io],
      [1.3, ONE],
    ],
    rot: [
      [0, Z3, E.io],
      [0.32, [-6, 0, 0], E.out],
      [0.6, [5, 10, 4], E.io],
      [0.9, [-3, 8, 2], E.soft],
      [2.2, [0, 6, 2], E.soft],
      [3.0, Z3],
    ],
  },
  idleSpin: {
    dur: 4.2,
    pos: [
      [0, Z2, E.io],
      [0.42, [0, 0.03], E.out],
      [0.78, [0, -0.26], E.in],
      [1.32, Z2, E.land],
      [1.46, [0, -0.04], E.in],
      [1.6, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.4, [1.13, 0.86], E.out],
      [0.58, [0.9, 1.12], E.io],
      [1.28, ONE, E.out],
      [1.36, [1.14, 0.87], E.out],
      [1.6, [0.98, 1.02], E.io],
      [1.85, ONE],
    ],
    spin: [
      [0, [0], E.io],
      [0.52, [0], E.soft],
      [1.5, [360]],
    ],
    rot: [
      [0, Z3, E.io],
      [0.42, [-8, 0, 0], E.out],
      [0.8, [8, 0, 0], E.io],
      [1.4, [-4, 0, 0], E.soft],
      [2.0, Z3],
    ],
    expr: [
      [0.5, "happy"],
      [1.6, null],
    ],
  },
  // 开心 — the smile moment: a small hop, the head tips back and sways, the arch eyes show while it looks up
  beam: {
    dur: 3.4,
    pos: [
      [0, Z2, E.io],
      [0.14, [0, 0.02], E.out],
      [0.36, [0, -0.13], E.in],
      [0.58, Z2, E.land],
      [0.8, Z2, E.out],
      [0.92, [0, -0.06], E.in],
      [1.06, Z2, E.land],
      [3.4, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.14, [1.09, 0.93], E.out],
      [0.27, [0.95, 1.08], E.io],
      [0.56, ONE, E.out],
      [0.62, [1.08, 0.93], E.out],
      [0.8, [1, 1.04], E.io],
      [1.03, [1.05, 0.95], E.out],
      [1.2, [1, 1.03], E.io],
      [1.5, ONE],
    ],
    rot: [
      [0, Z3, E.back],
      [0.56, [28, 0, 12], E.over],
      [1.1, [22, 5, -18], E.io],
      [1.7, [10, 2, -6], E.soft],
      [2.5, Z3],
    ],
    expr: [
      [0.46, "happy"],
      [1.3, null],
    ],
  },
  beamBig: {
    dur: 3.4,
    expr: [
      [0.46, "joyful"],
      [1.4, null],
    ],
  },
  // 向光 — listening
  listenNod: {
    dur: 3.3,
    rot: [
      [0, Z3, E.out],
      [0.32, [-10, 0, -2], E.soft],
      [0.66, [1.5, 0, 0], E.out],
      [0.98, [-7, 0, -1], E.soft],
      [1.42, Z3, E.io],
      [3.3, Z3],
    ],
    pos: [
      [0, Z2, E.out],
      [0.32, [0, 0.022], E.soft],
      [0.66, Z2, E.out],
      [0.98, [0, 0.015], E.soft],
      [1.42, Z2],
    ],
  },
  listenTilt: {
    dur: 3.6,
    rot: [
      [0, Z3, E.back],
      [0.62, [-3, 5, -14], E.over],
      [1.16, [-2.5, 4.5, -12], E.io],
      [2.6, [-2, 4, -11], E.soft],
      [3.2, Z3],
    ],
    expr: [
      [0.4, "curious"],
      [2.9, null],
    ],
  },
  listenStill: {
    dur: 2.8,
    rot: [
      [0, Z3, E.io],
      [1.4, [-1.5, -2.4, 1], E.io],
      [2.8, Z3],
    ],
  },
  listenLook: {
    dur: 4.6,
    rot: [
      [0, Z3, E.snap],
      [0.34, [8, -20, -4], E.over],
      [0.62, [7, -18, -4], E.io],
      [1.7, [7, -17, -4], E.snap],
      [2.02, [10, 17, 5], E.over],
      [2.3, [9, 15, 4], E.io],
      [3.5, [9, 14, 4], E.soft],
      [4.1, Z3],
    ],
    pos: [
      [0, Z2, E.snap],
      [0.34, [-0.02, -0.01], E.io],
      [1.7, [-0.02, -0.01], E.snap],
      [2.02, [0.02, -0.012], E.io],
      [3.5, [0.02, -0.012], E.soft],
      [4.1, Z2],
    ],
    lid: [
      [1.78, [0], E.io],
      [1.86, [1], E.io],
      [1.98, [0]],
    ],
  },
  // 冒孢子 — thinking
  ponder: {
    dur: 5.2,
    rot: [
      [0, Z3, E.soft],
      [1.25, [5, -6, 7], E.io],
      [2.7, [4, 3, -4], E.io],
      [4.05, [6, -4, 6], E.io],
      [5.2, Z3],
    ],
    pos: [
      [0, Z2, E.io],
      [2.6, [0.012, 0], E.io],
      [5.2, Z2],
    ],
    lid: [
      [3.3, [0], E.io],
      [3.38, [1], E.io],
      [3.5, [0]],
    ],
  },
  // 转风车 — working
  workBob: {
    dur: 2.4,
    pos: [
      [0, Z2, E.snap],
      [0.16, [0, 0.03], E.over],
      [0.42, Z2, E.io],
      [1.2, Z2, E.snap],
      [1.36, [0, 0.03], E.over],
      [1.62, Z2],
    ],
    rot: [
      [0, Z3, E.snap],
      [0.16, [-7, 0, 0], E.over],
      [0.42, [1, 0, 0], E.io],
      [1.2, [1, 0, 0], E.snap],
      [1.36, [-7, 0, 0], E.over],
      [1.62, Z3],
    ],
    sq: [
      [0, ONE, E.snap],
      [0.16, [1.06, 0.94], E.over],
      [0.42, ONE, E.io],
      [1.2, ONE, E.snap],
      [1.36, [1.06, 0.94], E.over],
      [1.62, ONE],
    ],
  },
  workFocus: {
    dur: 3.4,
    zoom: [
      [0, [1], E.back],
      [0.42, [0.72], E.io],
      [1.7, [0.7], E.back],
      [2.02, [1.1], E.over],
      [2.5, [1]],
    ],
    sq: [
      [0, ONE, E.back],
      [0.42, [1.04, 0.96], E.io],
      [1.7, [1.05, 0.95], E.back],
      [2.02, [0.94, 1.07], E.over],
      [2.4, ONE],
    ],
    rot: [
      [0, Z3, E.back],
      [0.42, [-8, 0, 0], E.io],
      [1.7, [-8, 2, 0], E.back],
      [2.02, [4, 0, 0], E.over],
      [2.5, Z3],
    ],
    expr: [
      [0.3, "squint", true],
      [1.95, "wide", true],
      [2.9, null],
    ],
  },
  workCheck: {
    dur: 3.1,
    rot: [
      [0, Z3, E.snap],
      [0.3, [-2, 24, 3], E.io],
      [1.16, [-2.5, 21, 2], E.back],
      [1.52, [1, -3, 0], E.over],
      [1.88, Z3],
    ],
    pos: [
      [0, Z2, E.snap],
      [0.3, [0.022, 0], E.io],
      [1.16, [0.02, 0], E.back],
      [1.52, [-0.004, 0], E.soft],
      [1.88, Z2],
    ],
    expr: [
      [0.2, "neutral", true],
      [1.5, null, true],
    ],
  },
  workStrain: {
    dur: 2.6,
    sq: [
      [0, ONE, E.back],
      [0.42, [1.075, 0.92], E.io],
      [1.58, [1.07, 0.925], E.over],
      [1.96, ONE],
    ],
    rot: [
      [0, Z3, E.back],
      [0.42, [-6, 0, 0], E.io],
      [1.58, [-5, 0, 0], E.over],
      [1.96, Z3],
    ],
    expr: [
      [0.32, "squint"],
      [1.7, null],
    ],
  },
  // 朝你弯 — waiting
  waitWatch: {
    dur: 3.2,
    rot: [
      [0, Z3, E.io],
      [0.9, [1, -6, 2], E.io],
      [2.1, [1, 6, -2], E.io],
      [3.2, Z3],
    ],
    lid: [
      [1.4, [0], E.io],
      [1.48, [1], E.io],
      [1.6, [0]],
    ],
  },
  waitHop: {
    dur: 3.3,
    pos: [
      [0, Z2, E.io],
      [0.26, [0, 0.03], E.out],
      [0.54, [0, -0.3], E.in],
      [0.82, Z2, E.land],
      [0.94, [0, -0.07], E.in],
      [1.08, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.26, [1.14, 0.86], E.out],
      [0.42, [0.9, 1.13], E.io],
      [0.78, ONE, E.out],
      [0.86, [1.16, 0.85], E.out],
      [1.02, [0.97, 1.03], E.io],
      [1.24, ONE],
    ],
    rot: [
      [0, Z3, E.io],
      [0.26, [-7, 0, 0], E.out],
      [0.56, [6, 0, 0], E.io],
      [0.9, [-4, 0, 0], E.soft],
      [1.4, Z3],
    ],
    expr: [
      [0.3, "surprised"],
      [2.1, null],
    ],
  },
  // 起风 — notify (one gust per clip; the sprout reads the same clock)
  gust: {
    dur: 2.8,
    rot: [
      [0, Z3, E.snap],
      [0.16, [0, -18, -3], E.soft],
      [0.62, [2, -14, 7], E.io],
      [1.2, [1, -6, 2], E.soft],
      [1.6, Z3],
    ],
    pos: [
      [0, Z2, E.out],
      [0.2, [-0.01, 0], E.soft],
      [0.62, [0.045, 0], E.io],
      [1.25, [0.01, 0], E.soft],
      [1.6, Z2],
    ],
    sq: [
      [0, ONE, E.out],
      [0.2, [0.96, 1.04], E.soft],
      [0.62, [1.03, 0.975], E.io],
      [1.1, ONE],
    ],
    expr: [
      [0.08, "surprised", true],
      [1.15, null],
    ],
  },
  // 长新叶 — done
  cheer: {
    dur: 3.0,
    pos: [
      [0, Z2, E.io],
      [0.3, [0, 0.035], E.out],
      [0.72, [-0.12, -0.36], E.in],
      [1.26, [-0.2, 0], E.land],
      [1.42, [-0.2, -0.08], E.in],
      [1.6, [-0.2, 0], E.io],
      [2.4, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.3, [1.17, 0.83], E.out],
      [0.5, [0.88, 1.15], E.io],
      [1.22, ONE, E.out],
      [1.3, [1.15, 0.86], E.out],
      [1.52, [0.97, 1.04], E.io],
      [1.8, ONE],
    ],
    spin: [
      [0, [0], E.io],
      [0.42, [0], E.soft],
      [1.32, [360]],
    ],
    rot: [
      [0, Z3, E.io],
      [0.3, [-9, 0, 0], E.out],
      [0.74, [10, -6, -8], E.io],
      [1.4, [-3, 0, 0], E.soft],
      [2.0, Z3],
    ],
    expr: [[0.18, "joyful", true]],
  },
  // 垂叶 — error
  sigh: {
    dur: 4.4,
    pos: [
      [0, Z2, E.soft],
      [0.5, [0, 0.03], E.io],
      [1.9, [0, 0.03], E.snap],
      [2.3, [-0.11, 0.04], E.soft],
      [4.4, [-0.11, 0.04]],
    ],
    sq: [
      [0, ONE, E.soft],
      [0.5, [1.04, 0.955], E.io],
      [4.4, [1.045, 0.95]],
    ],
    rot: [
      [0, Z3, E.out],
      [0.62, [-6, 16, 0], E.out],
      [0.86, [-6, -15, 0], E.out],
      [1.1, [-6, 11, 0], E.out],
      [1.34, [-6, -6, 0], E.soft],
      [1.8, [-6, 0, 0], E.snap],
      [2.3, [-9, -8, -10], E.soft],
      [4.4, [-9, -8, -10]],
    ],
  },
  // 合叶 — sleeping
  snooze: {
    dur: 5.2,
    sq: [
      [0, ONE, E.io],
      [2.6, [0.998, 1.006], E.io],
      [5.2, ONE],
    ],
    rot: [
      [0, Z3, E.io],
      [2.6, [-0.6, 0, 0.3], E.io],
      [5.2, Z3],
    ],
  },
  // 挥叶 — greeting
  wave: {
    dur: 3.0,
    pos: [
      [0, Z2, E.io],
      [0.2, [0, 0.025], E.out],
      [0.46, [0.1, -0.22], E.in],
      [0.72, [0.16, 0], E.land],
      [0.9, [0.16, 0], E.out],
      [1.1, [0.06, -0.14], E.in],
      [1.32, [0, 0], E.land],
      [3.0, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [0.2, [1.12, 0.87], E.out],
      [0.36, [0.9, 1.1], E.io],
      [0.7, ONE, E.out],
      [0.78, [1.1, 0.9], E.out],
      [0.98, ONE, E.io],
      [1.28, ONE, E.out],
      [1.36, [1.1, 0.9], E.out],
      [1.56, ONE],
    ],
    rot: [
      [0, Z3, E.io],
      [0.6, [3, 8, 13], E.io],
      [0.92, [3, 6, -12], E.io],
      [1.24, [2, -4, 10], E.io],
      [1.56, [1, 0, -6], E.soft],
      [2.0, Z3],
    ],
    expr: [
      [0.12, "joyful", true],
      [2.4, null],
    ],
  },
  // 发芽 — spawn (the seed and the sprout's growth read the state clock; this clip carries the hop and the face)
  sprouting: {
    dur: 2.9,
    pos: [
      [0, Z2, E.io],
      [1.52, Z2, E.out],
      [1.68, [0, 0.022], E.out],
      [1.9, [0, -0.18], E.in],
      [2.1, Z2, E.land],
      [2.3, Z2],
    ],
    sq: [
      [0, ONE, E.io],
      [1.52, ONE, E.out],
      [1.68, [1.1, 0.9], E.out],
      [1.84, [0.93, 1.07], E.io],
      [2.08, [1.08, 0.92], E.out],
      [2.26, ONE],
    ],
    lid: [
      [0.6, [1], E.io],
      [0.72, [0]],
    ],
    expr: [
      [1.5, "happy"],
      [2.7, null],
    ],
  },
};
Object.assign(CLIPS.beamBig, { pos: CLIPS.beam.pos, sq: CLIPS.beam.sq, rot: CLIPS.beam.rot });
// bridge: from the pose on screen to a clip's first pose
function makeBridge(from, to) {
  const k = (a, b) => [
    [0, a, E.io],
    [BRIDGE_DUR, b],
  ];
  return {
    dur: BRIDGE_DUR,
    bridge: true,
    pos: k(from.pos, to.pos),
    rot: k(from.rot, to.rot),
    sq: k(from.sq, to.sq),
    lid: k([from.lid], [to.lid]),
    zoom: k([from.zoom], [to.zoom]),
  };
}
function sampleKeys(keys, t, fallback) {
  if (!keys || !keys.length) return fallback;
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= t) i++;
  const [t0, v0, e] = keys[i],
    [t1, v1] = keys[i + 1];
  const k = bezier((t - t0) / Math.max(1e-6, t1 - t0), e || E.io);
  return v0.map((v, j) => v + (v1[j] - v) * k);
}
function samplePose(clip, t) {
  if (!clip) return { pos: Z2, rot: Z3, sq: ONE, lid: 0, spin: 0, zoom: 1 };
  return {
    pos: sampleKeys(clip.pos, t, Z2),
    rot: sampleKeys(clip.rot, t, Z3),
    sq: sampleKeys(clip.sq, t, ONE),
    lid: clamp(sampleKeys(clip.lid, t, [0])[0]),
    spin: sampleKeys(clip.spin, t, [0])[0],
    zoom: sampleKeys(clip.zoom, t, [1])[0],
  };
}
const poseClose = (a, b) =>
  Math.abs(a.zoom - b.zoom) < 0.02 &&
  Math.abs(a.pos[0] - b.pos[0]) < 0.015 &&
  Math.abs(a.pos[1] - b.pos[1]) < 0.015 &&
  a.rot.every((v, i) => Math.abs(v - b.rot[i]) < 3) &&
  Math.abs(a.sq[0] - b.sq[0]) < 0.02 &&
  Math.abs(a.sq[1] - b.sq[1]) < 0.02;

// ---------- states: our motion language ----------
// face: expression pool [name, weight]; cadence: seconds between face swaps; clips: dealt from a shuffled deck;
// rare: sometimes slipped into a round; look: how much the pointer turns the head; wander: resting drift;
// morph: body shape override; sprout: {lean, toward, fold, droop, wheel, grow, sway, flap, spores, gust}.
const STATES = {
  idle: {
    label: "空闲",
    motion: "呼吸",
    desc: "正面看着你，摆个姿势停一停，偶尔眨两下眼",
    face: [
      ["neutral", 6],
      ["curious", 1],
    ],
    cadence: [6, 11],
    clips: ["idleRest", "idleLook", "idleRest", "idleTilt", "idleUp", "idleRest", "idleHop"],
    rare: ["idleSpin", "beam"],
    look: 0.65,
    wander: 1,
    sprout: {},
  },
  spawn: {
    label: "新建",
    motion: "发芽",
    desc: "一粒种子鼓成圆团，睁眼，头顶冒出嫩芽",
    face: [["neutral", 1]],
    clips: ["sprouting"],
    look: 0.3,
    wander: 0.4,
    spawn: true,
    sprout: {},
    next: "idle",
    hold: 0.1,
  },
  listening: {
    label: "在听",
    motion: "向光",
    desc: "嫩芽像植物向着光一样，朝你的方向弯过去",
    face: [["attentive", 1]],
    clips: ["listenLook", "listenNod", "listenTilt", "listenLook"],
    look: 1,
    wander: 0.6,
    sprout: { toward: 0.75 },
  },
  thinking: {
    label: "思考",
    motion: "冒孢子",
    desc: "抬眼琢磨，嫩芽慢慢摇，一粒粒孢子飘上去",
    face: [["pondering", 1]],
    clips: ["ponder"],
    look: 0,
    wander: 0.4,
    sprout: { sway: 0.22, spores: true },
  },
  working: {
    label: "工作中",
    motion: "转风车",
    desc: "两片叶子转成风车叶，再长出两片，一起转起来",
    face: [
      ["focused", 3],
      ["neutral", 1],
    ],
    cadence: [3, 6],
    clips: ["workBob", "workFocus", "workCheck", "workBob", "workStrain"],
    look: 0.15,
    wander: 0.4,
    sprout: { wheel: true },
  },
  busy: {
    label: "用电脑",
    motion: "化作风车",
    desc: "身体裂成四瓣，展开成 Moss 风车转起来",
    face: [["focused", 1]],
    morph: "pinwheel",
    clips: ["idleRest"],
    look: 0,
    wander: 0,
    sprout: {},
  },
  waiting: {
    label: "等你确认",
    motion: "朝你弯",
    desc: "嫩芽朝你弯下来，时不时轻跳一下",
    face: [
      ["attentive", 3],
      ["surprised", 1],
    ],
    cadence: [2.5, 4],
    gaze: { yaw: 0, pitch: 4, roll: 0 },
    clips: ["waitWatch", "waitHop", "waitWatch"],
    look: 1,
    wander: 0.5,
    sprout: { lean: 0.55 },
  },
  notify: {
    label: "来消息",
    motion: "起风",
    desc: "一阵风从左边吹过，叶子被吹得摆动",
    face: [["neutral", 1]],
    clips: ["gust"],
    look: 0.2,
    wander: 0.4,
    sprout: { gust: true },
  },
  done: {
    label: "完成",
    motion: "长新叶",
    desc: "转一圈跳起来，嫩芽中间长出一片新叶",
    face: [["happy", 1]],
    clips: ["cheer"],
    look: 0.3,
    wander: 0.5,
    sprout: { grow: true },
    next: "idle",
    hold: 1.4,
  },
  error: {
    label: "出错",
    motion: "垂叶",
    desc: "叶子耷拉下来，摇摇头",
    face: [["sad", 1]],
    clips: ["sigh"],
    look: 0.2,
    wander: 0.3,
    sprout: { droop: 1 },
  },
  sleeping: {
    label: "休息",
    motion: "合叶",
    desc: "两片叶子像夜里的植物一样合拢，慢慢呼吸",
    face: [["closed", 1]],
    clips: ["snooze"],
    look: 0,
    wander: 0,
    zzz: true,
    blinkOff: true,
    sprout: { fold: 1 },
  },
  greeting: {
    label: "打招呼",
    motion: "挥叶",
    desc: "跳起来，两片叶子像手一样挥一挥",
    face: [["joyful", 1]],
    clips: ["wave"],
    look: 0.5,
    wander: 0.4,
    sprout: { flap: true },
    next: "idle",
    hold: 0.4,
  },
};

const shuffle = (a) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const pick = (pool) => {
  const tot = pool.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * tot;
  for (const [n, w] of pool) {
    if ((r -= w) <= 0) return n;
  }
  return pool[0][0];
};
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
// An eye is a centreline (K points, local units of the ball radius) stroked with round caps, plus how open it is.
// Two straight pills morph as a stadium: the shorter rotation, length and width; anything with a curve morphs point
// by point along the centreline, so a pill bends into a crescent instead of spinning round.
const K = 13;
function buildEye(c) {
  const L = Math.max(0.001, c.h - c.w),
    sag = c.bend * c.h,
    phi = c.tilt * D2R,
    cs = Math.cos(phi),
    sn = Math.sin(phi);
  const pts = [];
  for (let i = 0; i < K; i++) {
    const u = i / (K - 1) - 0.5; // -0.5 .. 0.5 along the chord (top to bottom)
    let x = 0,
      y = u * L;
    if (Math.abs(sag) > 1e-4) {
      const a = Math.abs(sag),
        r = (L * L) / 4 / (2 * a) + a / 2,
        h0 = Math.asin(clamp(L / 2 / r, -1, 1)),
        half = a > L / 2 ? Math.PI - h0 : h0,
        th = u * 2 * half;
      x = Math.sign(sag) * (r * Math.cos(th) - (r - a));
      y = r * Math.sin(th);
    }
    pts.push([x * cs - y * sn, x * sn + y * cs]);
  }
  return { pts, w: c.w, open: c.open, straight: Math.abs(sag) < 1e-4, ang: phi, half: L / 2 };
}
function morphEye(A, B, t) {
  if (t <= 0) return A;
  if (t >= 1) return B;
  const w = lerp(A.w, B.w, t),
    open = lerp(A.open, B.open, t);
  if (A.straight && B.straight) {
    let d = (B.ang - A.ang) % Math.PI;
    if (d > Math.PI / 2) d -= Math.PI;
    if (d < -Math.PI / 2) d += Math.PI;
    const ang = A.ang + d * t,
      half = lerp(A.half, B.half, t),
      cx = lerp((A.pts[0][0] + A.pts[K - 1][0]) / 2, (B.pts[0][0] + B.pts[K - 1][0]) / 2, t),
      cy = lerp((A.pts[0][1] + A.pts[K - 1][1]) / 2, (B.pts[0][1] + B.pts[K - 1][1]) / 2, t);
    const pts = [];
    for (let i = 0; i < K; i++) {
      const u = (i / (K - 1) - 0.5) * 2 * half;
      pts.push([cx - u * Math.sin(ang), cy + u * Math.cos(ang)]);
    }
    return { pts, w, open, straight: true, ang, half };
  }
  let fwd = 0,
    rev = 0;
  for (let i = 0; i < K; i++) {
    const a = A.pts[i],
      b = B.pts[i],
      c = B.pts[K - 1 - i];
    fwd += Math.hypot(a[0] - b[0], a[1] - b[1]);
    rev += Math.hypot(a[0] - c[0], a[1] - c[1]);
  }
  const pts = A.pts.map((a, i) => {
    const b = rev < fwd ? B.pts[K - 1 - i] : B.pts[i];
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  });
  return {
    pts,
    w,
    open,
    straight: false,
    ang: lerp(A.ang, B.ang, t),
    half: lerp(A.half, B.half, t),
  };
}
// The lid closes from the top toward a point 40 % down the eye; fully shut, the eye is a flat dot 0.42 of its width.
function eyePath(eyeG, scale, closure) {
  const c = clamp(closure, -0.08, 1),
    w = eyeG.w * scale;
  let top = Infinity,
    bot = -Infinity;
  for (const q of eyeG.pts) {
    top = Math.min(top, q[1] * scale);
    bot = Math.max(bot, q[1] * scale);
  }
  top -= w / 2;
  bot += w / 2;
  const piv = top + 0.4 * (bot - top);
  const pts = eyeG.pts.map((q) => [
    q[0] * scale * R,
    (piv + (q[1] * scale - piv) * (1 - Math.max(c, -0.08))) * R,
  ]);
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    d += `Q${r2(pts[i][0])} ${r2(pts[i][1])} ${r2(m[0])} ${r2(m[1])}`;
  }
  d += `L${r2(pts[K - 1][0])} ${r2(pts[K - 1][1])}`;
  return { d, w: w * R, kv: 1 - 0.58 * Math.max(0, c), piv: piv * R };
}
const EYE_GEO = Object.fromEntries(
  Object.entries(EXPRESSIONS).map(([k, e]) => [k, e.eyes.map(buildEye)]),
);

// colour moves through OKLCH, so moss green turns to coral by way of ochre, never through mud
function hexToOklch(hex) {
  const n = parseInt(hex.slice(1), 16),
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]),
    m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]),
    q = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q,
    a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q,
    b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q;
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}
function oklchToHex([L, C, H]) {
  const a = C * Math.cos(H),
    b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q,
  ];
  return (
    "#" +
    rgb
      .map((v) => {
        v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return Math.round(clamp(v) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
function mixColor(h1, h2, t) {
  if (t <= 0) return h1;
  if (t >= 1) return h2;
  const a = hexToOklch(h1),
    b = hexToOklch(h2);
  let dh = b[2] - a[2];
  if (dh > Math.PI) dh -= TAU;
  if (dh < -Math.PI) dh += TAU;
  return oklchToHex([lerp(a[0], b[0], t), lerp(a[1], b[1], t), a[2] + dh * t]);
}

// ---------- the Moss pinwheel, grown out of the body itself ----------
// The ball is cut into four quarter slices that tile it exactly; each slice reshapes, point for point, into one blade
// of the Moss mark while the whole spins up. At the start it IS the ball; at the end it IS the mark.
const BLADE_N = 56,
  PIN_SCALE = 1.1 / 47.5;
const PIE_Q = (() => {
  // top-left quarter: centre → left edge → arc → top edge
  const per = 2 + Math.PI / 2,
    pts = [];
  for (let i = 0; i < BLADE_N; i++) {
    const u = (i / BLADE_N) * per;
    if (u < 1) pts.push([-u, 0]);
    else if (u < 1 + Math.PI / 2) {
      const a = Math.PI + (u - 1);
      pts.push([Math.cos(a), Math.sin(a)]);
    } else {
      const v = u - 1 - Math.PI / 2;
      pts.push([0, -(1 - v)]);
    }
  }
  return pts;
})();
const BLADE_Q = (() => {
  const svgEl = document.createElementNS(NS, "svg");
  svgEl.style.cssText = "position:absolute;width:0;height:0";
  document.documentElement.appendChild(svgEl);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", LOGO_A.split("Z")[0] + "Z");
  svgEl.appendChild(path);
  const Lp = path.getTotalLength(),
    raw = [];
  for (let i = 0; i < 400; i++) {
    const q = path.getPointAtLength((Lp * i) / 400);
    raw.push([q.x * PIN_SCALE, q.y * PIN_SCALE]);
  }
  svgEl.remove();
  let k0 = 0,
    best = Infinity;
  raw.forEach((q, i) => {
    const d = Math.hypot(q[0], q[1]);
    if (d < best) {
      best = d;
      k0 = i;
    }
  });
  let ring = raw.slice(k0).concat(raw.slice(0, k0));
  if (Math.sign(signedArea(ring)) !== Math.sign(signedArea(PIE_Q)))
    ring = [ring[0]].concat(ring.slice(1).toReversed());
  const out = [];
  for (let i = 0; i < BLADE_N; i++)
    out.push(ring[Math.round((i / BLADE_N) * ring.length) % ring.length]);
  return out;
})();
const rotPts = (pts, a) => {
  const c = Math.cos(a),
    s2 = Math.sin(a);
  return pts.map((q) => [q[0] * c - q[1] * s2, q[0] * s2 + q[1] * c]);
};
const PIES = [0, 1, 2, 3].map((k) => rotPts(PIE_Q, (k * Math.PI) / 2));
const BLADES = [0, 1, 2, 3].map((k) => rotPts(BLADE_Q, (k * Math.PI) / 2));
const polyD = (pts) => "M" + pts.map((q) => `${r2(q[0])} ${r2(q[1])}`).join("L") + "Z";

function eyeFrames(gaze, split) {
  let f = [0, 0, 1],
    right = [1, 0, 0],
    down = [0, 1, 0];
  [f, right] = spin(f, right, gaze.yaw * D2R);
  [down, f] = spin(down, f, gaze.pitch * D2R);
  [right, down] = spin(right, down, gaze.roll * D2R);
  return [-1, 1].map((side) => {
    const [ef, er] = spin(f, right, split * side * D2R);
    return { x: ef[0], y: ef[1], depth: ef[2], a: er[0], b: er[1], c: down[0], d: down[1] };
  });
}
// blink: close with smoothstep, hold about two frames shut, reopen to 106 % and settle
function blinkOpen(t) {
  const hold = Math.min(0.28, 2 / 60 / BLINK_DUR),
    u1 = (1 - hold) * 0.42,
    u2 = u1 + hold;
  if (t < u1) return 1 - smooth(t / u1);
  if (t <= u2) return 0;
  const q = (t - u2) / (1 - u2);
  if (q < 0.7) {
    const e = q / 0.7;
    return (1 - (1 - e) * (1 - e)) * 1.06;
  }
  return 1.06 - 0.06 * smooth((q - 0.7) / 0.3);
}

const LEAF_L = "M0 0C-1.2 -4.6 -6.6 -8.2 -12.6 -7.4C-10.4 -2.4 -5 0.6 0 0Z";
const LEAF_R = "M0 0C1.4 -5.4 7.8 -9.6 14.8 -8.6C12.2 -2.8 5.8 0.8 0 0Z";
const LEAF_C = "M0 0C-3.2 -3.6 -3.4 -9.4 0 -13.2C3.4 -9.4 3.2 -3.6 0 0Z";

let uid = 0;
const bots = new Set();
let pointer = null;
let watchingPointer = false;
function watchPointer() {
  if (watchingPointer) return;
  watchingPointer = true;
  addEventListener(
    "pointermove",
    (e) => {
      pointer = [e.clientX, e.clientY];
    },
    { passive: true },
  );
}

function create(host, opts = {}) {
  let calm = reduce || !!opts.still;
  if (!calm && opts.gaze !== 0) watchPointer();
  const id = "mb" + ++uid;
  const size = opts.size || 160;
  const compact = size <= 40;
  const eyeBoost = compact ? 1.15 : 1;
  let tone = TONES[opts.tone] ? opts.tone : "moss";
  let form = FORMS[opts.form] ? opts.form : "round";
  const seed = Math.random() * 100;

  const svg = el("svg", {
    viewBox: compact ? "-53 -62 106 106" : "-64 -76 128 128",
    width: size,
    height: size,
    role: "img",
    "aria-label": opts.label || "Moss 助手",
  });
  svg.style.cssText =
    "overflow:visible;display:block;width:100%;height:100%" +
    (opts.interactive === false ? "" : ";cursor:pointer");
  host.appendChild(svg);
  const defs = el("defs", {}, svg);
  const clip = el("clipPath", { id: id + "c" }, defs);
  const clipBody = el("path", {}, clip);
  const fx = el(
    "g",
    { fill: "none", stroke: "currentColor", "stroke-linecap": "round", opacity: 0.4 },
    svg,
  );
  const streaks = [0, 1, 2].map(() => el("path", { "stroke-width": 2, opacity: 0 }, fx));
  const sprout = el("g", {}, svg);
  const stem = el(
    "path",
    { fill: "none", "stroke-width": compact ? 3.4 : 2.6, "stroke-linecap": "round" },
    sprout,
  );
  const leaves = el("g", {}, sprout);
  const leafC = el("path", { d: LEAF_C }, leaves);
  const leafL = el("path", { d: LEAF_L }, leaves);
  const leafR = el("path", { d: LEAF_R }, leaves);
  // working: the two leaves turn into blades and two more open between them
  const bladeEls = [0, 1, 2].map(() => el("path", { d: LEAF_R, opacity: 0 }, leaves));
  const mini = el("g", { opacity: 0 }, sprout);
  const miniSpin = el("g", {}, mini);
  el("path", { d: LOGO_A, fill: CORAL, transform: "scale(.22)" }, miniSpin);
  el("path", { d: LOGO_B, fill: CORAL_DEEP, transform: "scale(.22)" }, miniSpin);
  const sporeLayer = el("g", {}, svg);
  const body = el("path", {}, svg);
  const sliceG = el("g", { opacity: 0 }, svg);
  const sliceEls = [0, 1, 2, 3].map(() =>
    el("path", { "stroke-width": 0.9, "stroke-linejoin": "round" }, sliceG),
  );
  const shadeG = el("g", { opacity: 0 }, svg);
  el("path", { d: LOGO_B, fill: CORAL_DEEP }, shadeG);
  const logo = el("g", { opacity: 0 }, svg);
  const logoSpin = el("g", {}, logo);
  el("path", { d: LOGO_A, fill: CORAL }, logoSpin);
  el("path", { d: LOGO_B, fill: CORAL_DEEP }, logoSpin);
  const face = el("g", { "clip-path": `url(#${id}c)` }, svg);
  const eyeEls = [0, 1].map(() =>
    el("path", { fill: "none", stroke: EYE, "stroke-linecap": "round" }, face),
  );
  const zLayer = el(
    "g",
    { fill: "currentColor", "font-family": "Inter, sans-serif", "font-weight": 500 },
    svg,
  );

  function paint() {
    const c = TONES[tone].body;
    stem.setAttribute("stroke", c);
    [leafL, leafR, leafC].forEach((l) => l.setAttribute("fill", c));
    sporeLayer.setAttribute("fill", c);
  }
  paint();

  const cur = {
    radii: PROFILES[form].slice(),
    split: SPLIT,
    gaze: { ...REST },
    gazeV: { yaw: 0, pitch: 0, roll: 0 },
    gx: 0,
    gy: 0,
    eyeAlpha: 1,
    sproutAmt: 1,
    wheel: 0,
    mini: 0,
    spinAngle: 0,
    spinVel: 0,
    miniAngle: 0,
    miniVel: 0,
    leafA: 0,
    leafV: 0,
    spr: 0,
    sprV: 0,
    fold: 0,
    droop: 0,
    grow: 0,
    lean: 0,
    shown: null,
    popT: 1,
    vx: 0,
    vy: 0,
  };
  // face: the eyes on screen are a morph from `from` to the target expression
  const F = { name: "neutral", from: EYE_GEO.neutral, t: 1, pending: null };
  const S = {
    state: "idle",
    deck: [],
    last: null,
    clip: null,
    clipT: 0,
    queued: null,
    face: "neutral",
    override: null,
    clipFace: null,
    nextFace: 4,
    nextBlink: 1.4 + Math.random() * 0.6,
    stateT: 0,
    blinkT: -1,
    doubleBlink: false,
    pendingBlink: 0,
    time: 0,
    holdLeft: 0,
    hold: false,
    fired: new Set(),
    zTimer: 0,
    zs: [],
    sporeT: 0,
    spores: [],
    pokes: [],
    firstLoad: true,
  };

  const eyesNow = () => {
    const target = EYE_GEO[F.name],
      k = bezier(clamp(F.t), EXPR_EASE);
    return [morphEye(F.from[0], target[0], k), morphEye(F.from[1], target[1], k)];
  };
  function morphTo(name) {
    if (!EXPRESSIONS[name] || name === F.name) return;
    F.from = eyesNow();
    F.name = name;
    F.t = 0;
  }
  // a cut waits for the eyes to be shut, so the change is never seen
  function cutTo(name) {
    if (!EXPRESSIONS[name] || name === F.name) return;
    F.pending = name;
    blink();
  }
  function blink() {
    if (S.blinkT < 0) S.blinkT = 0;
  }
  function wantFace() {
    return S.override || S.clipFace || S.face;
  }
  function applyFace(cut) {
    const n = wantFace();
    if (n !== F.name && n !== F.pending) (cut ? cutTo : morphTo)(n);
  }
  function smile(big) {
    if (STATES[S.state].morph) return;
    S.override = null;
    S.clipFace = null;
    S.hold = false;
    loadClip(big ? "beamBig" : "beam", 0);
  }
  function setExpression(name) {
    if ((name === "happy" || name === "joyful") && !STATES[S.state].morph) {
      smile(name === "joyful");
      return;
    }
    if (EXPRESSIONS[name]) {
      S.override = name;
      applyFace(false);
    }
  }

  function currentPose() {
    return samplePose(S.clip, S.clipT);
  }
  function dealClip() {
    const st = STATES[S.state];
    if (!S.deck.length) {
      let d = st.clips.length > 1 ? shuffle(st.clips) : st.clips.slice();
      if (st.rare && Math.random() < 0.35)
        d.splice(1 + Math.floor(Math.random() * d.length), 0, ...st.rare);
      if (d.length > 1 && d[0] === S.last) d.push(d.shift()); // never the same clip twice in a row
      S.deck = d;
    }
    return S.deck.shift();
  }
  function loadClip(name, phase) {
    const next = CLIPS[name],
      from = currentPose(),
      start = samplePose(next, phase * next.dur);
    S.last = name;
    S.fired = new Set();
    if (S.clip && !poseClose(from, start) && !calm) {
      S.clip = makeBridge(from, start);
      S.clipT = 0;
      S.queued = { clip: next, t: phase * next.dur };
    } else {
      S.clip = next;
      S.clipT = phase * next.dur;
      S.queued = null;
    }
  }
  function setState(name) {
    const st = STATES[name] || STATES.idle;
    const prevMorph = STATES[S.state] && STATES[S.state].morph;
    if ((st.morph || null) !== (prevMorph || null)) blink();
    S.state = STATES[name] ? name : "idle";
    S.stateT = 0;
    S.deck = [];
    S.hold = false;
    S.override = null;
    S.clipFace = null;
    S.face = pick(st.face);
    S.nextFace = st.cadence ? lerp(st.cadence[0], st.cadence[1], Math.random()) : 1e9;
    const phase = S.firstLoad && S.state === "idle" && !calm ? Math.random() * 0.8 : 0; // bots side by side never move in step
    S.firstLoad = false;
    loadClip(dealClip(), phase);
    applyFace(false); // a new state morphs the face; only clip cues cut through a blink
  }
  function clipEnded() {
    const st = STATES[S.state];
    if (st.next) {
      S.hold = true;
      S.holdLeft = st.hold || 0.6;
      return;
    }
    loadClip(dealClip(), 0);
  }
  function poke(name) {
    if (["spin", "nod", "bounce"].includes(name)) S.pokes.push({ kind: name, t: 0 });
    if (name === "shake") S.pokes.push({ kind: "shake", t: 0 });
  }
  const POKE_DUR = { spin: 1.1, nod: 0.62, bounce: 0.72, shake: 0.8 };
  function pokeSum() {
    let pitch = 0,
      yaw = 0,
      lift = 0,
      sx = 1,
      sy = 1;
    for (const p of S.pokes) {
      const e = Math.min(1, p.t / POKE_DUR[p.kind]);
      if (p.kind === "spin") yaw += 180 * (1 - Math.cos(Math.PI * e));
      if (p.kind === "nod") pitch -= 11 * bump2(e, 0, 0.5) + 7 * bump2(e, 0.5, 1);
      if (p.kind === "shake") yaw += 20 * Math.sin(e * Math.PI * 4) * (1 - e);
      if (p.kind === "bounce") {
        const ends = bump2(e, 0, 0.18) + bump2(e, 0.82, 1),
          mid = bump2(e, 0.18, 0.82);
        lift += 0.22 * Math.sin(Math.PI * clamp((e - 0.14) / 0.72));
        sx *= 1 + 0.1 * ends - 0.05 * mid;
        sy *= 1 - 0.12 * ends + 0.07 * mid;
      }
    }
    return { pitch, yaw, lift, sx, sy };
  }

  function step(dt) {
    S.time += dt;
    S.stateT += dt;
    const st = STATES[S.state],
      sp = st.sprout || {};
    // --- clip timeline ---
    if (S.hold) {
      S.holdLeft -= dt;
      if (S.holdLeft <= 0) {
        setState(st.next);
        return;
      }
    } else if (S.clip && !calm) {
      S.clipT += dt;
      if (!S.clip.bridge)
        (S.clip.expr || []).forEach(([t, n, cut], i) => {
          if (S.clipT >= t && !S.fired.has(i)) {
            S.fired.add(i);
            S.clipFace = n;
            applyFace(!!cut);
          }
        });
      if (S.clipT >= S.clip.dur) {
        if (S.clip.bridge && S.queued) {
          S.clip = S.queued.clip;
          S.clipT = S.queued.t;
          S.queued = null;
        } else {
          S.clipFace = null;
          applyFace(false);
          clipEnded();
        }
      }
    }
    S.pokes.forEach((p) => (p.t += dt));
    S.pokes = S.pokes.filter((p) => p.t < POKE_DUR[p.kind]);
    S.nextFace -= dt;
    if (S.nextFace <= 0 && st.cadence) {
      S.face = pick(st.face);
      S.nextFace = lerp(st.cadence[0], st.cadence[1], Math.random());
      applyFace(true);
    }
    // --- blinks and expression morph ---
    if (!st.blinkOff && !calm) {
      S.nextBlink -= dt;
      if (S.nextBlink <= 0) {
        blink();
        S.doubleBlink = Math.random() < 0.12;
        S.nextBlink = 3.6 + Math.random() * 4.2;
      }
    }
    let openness = 1;
    if (S.blinkT >= 0) {
      S.blinkT += dt;
      const k = S.blinkT / BLINK_DUR;
      openness = blinkOpen(clamp(k));
      if (F.pending && openness < 0.05) {
        F.from = EYE_GEO[F.pending];
        F.name = F.pending;
        F.t = 1;
        F.pending = null;
      }
      if (k >= 1) {
        S.blinkT = -1;
        if (S.doubleBlink) {
          S.doubleBlink = false;
          S.pendingBlink = 0.06;
        }
      }
    }
    if (S.pendingBlink > 0) {
      S.pendingBlink -= dt;
      if (S.pendingBlink <= 0) {
        S.pendingBlink = 0;
        S.blinkT = 0;
      }
    }
    F.t = Math.min(1, F.t + dt / EXPR_DUR);
    const expr = EXPRESSIONS[F.name];
    const eyes = eyesNow();
    cur.split = approach(cur.split, expr.split, 12, dt);
    // --- pose: clip + pokes ---
    const P = calm ? samplePose(null, 0) : currentPose();
    const pk = pokeSum();
    // --- body shape; the pinwheel amount rides a critically damped spring (no overshoot, no stall) ---
    const morph = st.morph || null;
    for (let i = 0; i < N; i++) cur.radii[i] = approach(cur.radii[i], PROFILES[form][i], 10, dt);
    cur.popT += dt;
    {
      const kP = 38,
        dP = 2 * Math.sqrt(kP);
      cur.pinV =
        (cur.pinV || 0) +
        (((morph === "pinwheel" ? 1 : 0) - (cur.pin || 0)) * kP - (cur.pinV || 0) * dP) * dt;
      cur.pin = clamp((cur.pin || 0) + cur.pinV * dt, 0, 1.02);
      if (morph !== "pinwheel" && cur.pin < 0.004 && Math.abs(cur.pinV) < 0.05) {
        cur.pin = 0;
        cur.pinV = 0;
      }
    }
    cur.eyeAlpha = approach(cur.eyeAlpha, morph ? 0 : 1, morph ? 18 : 8, dt);
    cur.sproutAmt = approach(cur.sproutAmt, morph ? 0 : 1, 12, dt);
    cur.mini = approach(cur.mini, sp.wheel && !morph ? 1 : 0, 5, dt);
    cur.fold = approach(cur.fold, sp.fold || 0, 2.4, dt);
    cur.droop = approach(cur.droop, sp.droop || 0, 3, dt);
    cur.grow = approach(cur.grow, sp.grow ? 1 : 0, sp.grow ? 5 : 0.5, dt);
    // --- gaze: pointer turns the head and slides the body a touch; drift after the mix ---
    const base = st.gaze || expr.gaze;
    let pdx = 0,
      tgx = 0,
      tgy = 0;
    const lookW = (opts.gaze ?? 1) * (st.look || 0) * (calm ? 0 : 1);
    if (pointer) {
      const r = svg.getBoundingClientRect();
      if (r.width > 0) {
        const span = Math.max(r.width, 1) * 2;
        const dx = (pointer[0] - (r.left + r.width / 2)) / span,
          dy = -(pointer[1] - (r.top + r.height * 0.58)) / span;
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          pdx = clamp(dx, -1, 1);
          tgx = pdx * lookW;
          tgy = clamp(dy, -1, 1) * lookW;
        }
      }
    }
    const sm = 1 - 0.86 ** (dt * 60);
    cur.gx += (tgx - cur.gx) * sm;
    cur.gy += (tgy - cur.gy) * sm;
    const wander = calm ? 0 : (st.wander ?? 1) * (compact ? 0.5 : 1);
    const amp = compact ? 0.6 : 1;
    const tgt = {
      yaw:
        lerp(base.yaw, 0, Math.abs(cur.gx) * 0.6) +
        cur.gx * 22 +
        (loopNoise(S.time, 11.3, seed) * 5.5 + loopNoise(S.time, 3.7, seed + 2) * 1.6) * wander,
      pitch:
        lerp(base.pitch, 0, Math.abs(cur.gy) * 0.4) +
        cur.gy * 16 +
        (loopNoise(S.time, 9.1, seed + 1) * 4.2 + loopNoise(S.time, 4.3, seed + 3) * 1.3) * wander,
      roll: base.roll + loopNoise(S.time, 13.7, seed + 4) * 2.2 * wander,
    };
    for (const k of ["yaw", "pitch", "roll"]) {
      // expression gaze changes settle on a critically damped spring
      const kStiff = 64,
        damp = 2 * Math.sqrt(kStiff);
      cur.gazeV[k] += ((tgt[k] - cur.gaze[k]) * kStiff - cur.gazeV[k] * damp) * dt;
      cur.gaze[k] += cur.gazeV[k] * dt;
    }
    // the clip's authored rotation rides on top unsmoothed, so its anticipation and overshoot stay crisp
    const head = {
      pitch: cur.gaze.pitch + (P.rot[0] + pk.pitch) * amp,
      yaw: cur.gaze.yaw + (P.rot[1] + pk.yaw) * amp - P.spin,
      roll: cur.gaze.roll + P.rot[2] * amp,
    };
    const yawN = ((((head.yaw + 180) % 360) + 360) % 360) - 180; // full turns are not a lasting lean
    // --- body ---
    const x = (P.pos[0] * amp + cur.gx * 0.03) * R,
      y = (P.pos[1] * amp - pk.lift - cur.gy * 0.024) * R;
    const SQ = 0.62; // squash gain, matched to the reference recordings
    const sx = (1 + (P.sq[0] - 1) * amp * SQ) * pk.sx;
    const breath = calm || st.zzz ? 1 : 1 + Math.sin((S.time / 3.4) * TAU) * 0.005;
    const sy = (1 + (P.sq[1] - 1) * amp * SQ) * pk.sy * breath;
    const sT = st.spawn ? S.stateT : 99;
    const seedScale = st.spawn ? Math.max(0.1, easeOutBack((sT - 0.1) / 0.55)) : 1;
    const seedSquash = st.spawn ? lerp(0.78, 1, clamp((sT - 0.1) / 0.55)) : 1;
    const bottom = radiusAt(cur.radii, Math.PI / 2) * R;
    const pin = clamp(cur.pin || 0);
    cur.spinVel = approach(cur.spinVel, pin > 0.15 ? 400 : 0, 2.2, dt);
    cur.spinAngle = pin > 0.001 ? (cur.spinAngle + cur.spinVel * dt) % 360 : 0;
    const rot = 0;
    const pop = 1;
    const zoom = 1 + (P.zoom - 1) * amp;
    const sqY = sy * pop * seedScale * seedSquash;
    const cy = y + bottom * (1 - sqY) * (1 - pin); // squash is anchored at the seat; zoom and the pinwheel at the centre
    const scX = sx * pop * seedScale * zoom,
      scY = sqY * zoom;
    const cx = x;
    const d = bodyPath(cur.radii, cx, cy, scX, scY, rot);
    body.setAttribute("d", d);
    clipBody.setAttribute("d", d);
    const baseFill = TONES[tone].body;
    if (body.getAttribute("fill") !== baseFill) body.setAttribute("fill", baseFill);
    if (pin > 0.002) {
      const k = bezier(pin, [0.45, 0, 0.2, 1]),
        col = mixColor(baseFill, CORAL, smooth((pin - 0.1) / 0.75));
      const a = cur.spinAngle * D2R;
      for (let j = 0; j < 4; j++) {
        // turned first, then cut to the body's outline at the new angle: at any spin the slices still add up to the body
        const ca = Math.cos(a),
          sa = Math.sin(a);
        const sp2 = PIES[j].map((q, i) => {
          const qx = q[0] * ca - q[1] * sa,
            qy = q[0] * sa + q[1] * ca,
            rq = radiusAt(cur.radii, Math.atan2(qy, qx) - rot);
          const b = BLADES[j][i],
            bx = b[0] * ca - b[1] * sa,
            by = b[0] * sa + b[1] * ca;
          return [cx + lerp(qx * rq, bx, k) * R * scX, cy + lerp(qy * rq, by, k) * R * scY];
        });
        sliceEls[j].setAttribute("d", polyD(sp2));
        sliceEls[j].setAttribute("fill", col);
        sliceEls[j].setAttribute("stroke", col);
      }
      // while the slices are still nearly a whole body, the body stays underneath so the cuts never show
      sliceG.setAttribute("opacity", 1);
      body.setAttribute("opacity", r2(1 - smooth(k / 0.45)));
      body.setAttribute("fill", col);
      shadeG.setAttribute("opacity", r2(smooth((pin - 0.8) / 0.2)));
      shadeG.setAttribute(
        "transform",
        `translate(${r2(cx)} ${r2(cy)}) rotate(${r2(cur.spinAngle)}) scale(${r2(PIN_SCALE * R * scX)} ${r2(PIN_SCALE * R * scY)})`,
      );
    } else {
      sliceG.setAttribute("opacity", 0);
      shadeG.setAttribute("opacity", 0);
      body.setAttribute("opacity", 1);
    }
    // --- face ---
    const fr = eyeFrames(head, cur.split);
    const eyesOpen = st.spawn ? clamp((sT - 0.55) / 0.12) : 1;
    const lidOpen = openness * (1 - P.lid);
    // the eye on the side the head turns toward grows a little: the look leads the head
    const lead = clamp((yawN - base.yaw) / 22, -1, 1);
    const eyeFade = 1 - smooth(pin / 0.45); // eyes are back fully as soon as the slices have closed, not on the spring's long tail
    for (let i = 0; i < 2; i++) {
      const e = fr[i],
        g = eyes[i],
        node = eyeEls[i];
      const vis = clamp(e.depth / 0.12) * cur.eyeAlpha * eyesOpen * eyeFade;
      if (vis < 0.01) {
        node.setAttribute("opacity", 0);
        continue;
      }
      const grow = (1 + 0.13 * lead * (i ? 1 : -1)) * zoom * eyeBoost;
      const closure = 1 - Math.max(0, lidOpen) * g.open + pin * 0.8; // a reopening blink overshoots to 106 %
      const ep = eyePath(g, grow, closure);
      const rr = radiusAt(cur.radii, Math.atan2(e.y * scY, e.x * scX));
      const ex = cx + e.x * R * rr * scX,
        ey = cy + e.y * R * rr * scY;
      const ty = ep.piv * (1 - ep.kv);
      node.setAttribute("d", ep.d);
      node.setAttribute("stroke-width", r2(ep.w * Math.min(scX / zoom, scY / zoom) ** 0.5));
      node.setAttribute(
        "transform",
        `matrix(${r2(e.a)},${r2(e.b)},${r2(e.c * ep.kv)},${r2(e.d * ep.kv)},${r2(ex + e.c * ty)},${r2(ey + e.d * ty)})`,
      );
      node.setAttribute("opacity", r2(vis));
    }
    // --- sprout: rides the rim, leans with the head, its tip lags on a soft spring; leaves in perspective ---
    const sproutGrow = st.spawn ? easeOut((sT - 0.72) / 0.45) : 1;
    const leafOpen = st.spawn ? easeOutBack((sT - 1.02) / 0.42) : 1;
    const gustPhase = sp.gust ? (S.stateT % CLIPS.gust.dur) / CLIPS.gust.dur : 0;
    const gust = sp.gust ? bump(gustPhase / 0.42) : 0;
    const leanT =
      (sp.lean || 0) +
      (sp.toward ? pdx * sp.toward : 0) +
      (sp.sway ? Math.sin(S.time * 2.1) * sp.sway : 0) +
      gust * 0.62;
    cur.lean = approach(cur.lean, leanT, sp.gust ? 7 : 3.5, dt);
    const tilt = (head.roll - REST.roll) * D2R * 0.9 + (yawN - REST.yaw) * D2R * 0.1 + rot;
    const rimA = -Math.PI / 2 + tilt;
    const rimR = radiusAt(cur.radii, rimA - rot) * R - 1.2;
    const rootX = cx + Math.cos(rimA) * rimR * scX,
      rootY = cy + Math.sin(rimA) * rimR * scY;
    const hh = Math.max(dt, 1e-3);
    cur.vx = approach(cur.vx, (rootX - (cur.lastRootX ?? rootX)) / hh, 18, dt);
    cur.vy = approach(cur.vy, (rootY - (cur.lastRootY ?? rootY)) / hh, 18, dt);
    cur.lastRootX = rootX;
    cur.lastRootY = rootY;
    const flutter = sp.gust ? Math.sin(S.time * 26) * 0.12 * gust : 0;
    const flap = sp.flap ? Math.sin(S.stateT * 9) * 0.5 * clamp(1 - S.stateT / 2) : 0;
    const lagT = clamp(-cur.vx * 0.0035, -0.55, 0.55) + flutter;
    const spreadT = clamp(cur.vy * 0.0028, -0.45, 0.45) + cur.droop * 0.95 + flap - gust * 0.15;
    const kS = 95,
      cS = 2 * 0.42 * Math.sqrt(kS);
    cur.leafV += (-(cur.leafA - lagT) * kS - cur.leafV * cS) * dt;
    cur.leafA += cur.leafV * dt;
    cur.sprV += (-(cur.spr - spreadT) * kS - cur.sprV * cS) * dt;
    cur.spr += cur.sprV * dt;
    const lean = tilt + cur.lean + cur.leafA + cur.droop * 0.35;
    const L = 9.5 * (1 - cur.droop * 0.15) * sproutGrow * (1 + cur.grow * 0.12);
    const tipX = Math.sin(lean) * L,
      tipY = -Math.cos(lean) * L;
    const midX = Math.sin(tilt + cur.lean * 0.4) * L * 0.5,
      midY = -Math.cos(tilt + cur.lean * 0.4) * L * 0.5;
    sprout.setAttribute(
      "transform",
      `translate(${r2(rootX)} ${r2(rootY)}) scale(${r2(cur.sproutAmt * (compact ? 1.25 : 1))})`,
    );
    sprout.setAttribute("opacity", r2(clamp(cur.sproutAmt * 1.5) * (sproutGrow > 0.02 ? 1 : 0)));
    stem.setAttribute("d", `M0 0Q${r2(midX)} ${r2(midY)} ${r2(tipX)} ${r2(tipY)}`);
    // working: leaves turn into blades (the left one flips over), two more open between them, all spin up together
    cur.miniVel = approach(cur.miniVel, sp.wheel && !morph ? 520 : 0, 2.2, dt);
    cur.miniAngle = (cur.miniAngle + cur.miniVel * dt) % 360;
    const m = smooth(cur.mini);
    const persp = Math.cos(head.yaw * D2R),
      pf = lerp(Math.sign(persp || 1) * Math.max(0.16, Math.abs(persp)), 1, m);
    leaves.setAttribute(
      "transform",
      `translate(${r2(tipX)} ${r2(tipY - 1.5 * m)}) rotate(${r2((lean / D2R) * (1 - m) + cur.miniAngle * m)}) scale(${r2(pf * leafOpen * (1 - 0.15 * m))} ${r2(leafOpen * (1 - 0.15 * m))})`,
    );
    const closeA = cur.fold * 58;
    const leafCol = mixColor(TONES[tone].body, CORAL, smooth((cur.mini - 0.15) / 0.7));
    const aR = 6 + cur.spr * 42 - closeA,
      aL = -8 - cur.spr * 42 + closeA;
    leafR.setAttribute("transform", `rotate(${r2(lerp(aR, 0, m))})`);
    leafR.setAttribute("fill", leafCol);
    leafL.setAttribute("opacity", m > 0.02 ? 0 : 1);
    // blade 2 starts as the mirrored left leaf and turns over into a right-handed blade
    bladeEls[0].setAttribute("opacity", m > 0.02 ? 1 : 0);
    bladeEls[0].setAttribute(
      "transform",
      `rotate(${r2(lerp(-aL, 180, m))}) scale(${r2(lerp(-0.85, 1, m))} 1)`,
    );
    [bladeEls[1], bladeEls[2]].forEach((b, j) => {
      const gk = easeOutBack((cur.mini - 0.3) / 0.7);
      b.setAttribute("opacity", gk > 0.01 ? 1 : 0);
      b.setAttribute("transform", `rotate(${j ? 270 : 90}) scale(${r2(Math.max(0, gk))})`);
    });
    bladeEls.forEach((b) => b.setAttribute("fill", leafCol));
    leafC.setAttribute(
      "transform",
      `scale(${r2(Math.max(0, easeOutBack(cur.grow) * (1 - cur.fold) * (1 - m)))})`,
    );
    mini.setAttribute("opacity", 0);
    // --- 冒孢子 spores ---
    const tipAbsX = rootX + tipX * (compact ? 1.25 : 1),
      tipAbsY = rootY + tipY * (compact ? 1.25 : 1);
    if (sp.spores && !compact && !calm) {
      S.sporeT -= dt;
      if (S.sporeT <= 0) {
        S.sporeT = 0.55;
        S.spores.push({
          c: el("circle", { r: 0 }, sporeLayer),
          age: 0,
          x: tipAbsX,
          y: tipAbsY - 6,
          s: Math.random() < 0.5 ? -1 : 1,
          size: 1.8 + Math.random() * 1.2,
        });
      }
    }
    S.spores = S.spores.filter((p) => {
      p.age += dt;
      const q = p.age / 1.9;
      if (q >= 1) {
        p.c.remove();
        return false;
      }
      p.c.setAttribute("cx", r2(p.x + Math.sin(q * 5) * 3.5 * p.s + q * 6 * p.s));
      p.c.setAttribute("cy", r2(p.y - easeOut(q) * 30));
      p.c.setAttribute("r", r2(p.size * (q < 0.15 ? q / 0.15 : 1 - (q - 0.15) * 0.6)));
      p.c.setAttribute("opacity", r2((q < 0.15 ? q / 0.15 : 1 - q) * 0.9));
      return true;
    });
    // --- 起风 streaks ---
    streaks.forEach((s, i) => {
      if (!sp.gust || compact || calm) {
        s.setAttribute("opacity", 0);
        return;
      }
      const q = clamp((gustPhase - i * 0.06) / 0.5);
      if (q <= 0 || q >= 1) {
        s.setAttribute("opacity", 0);
        return;
      }
      const yy = -44 + i * 13 + Math.sin(q * 6 + i) * 1.5,
        x0 = -74 + q * 150,
        len = 18 + i * 4;
      s.setAttribute(
        "d",
        `M${r2(x0 - len)} ${r2(yy)}Q${r2(x0 - len / 2)} ${r2(yy - 3)} ${r2(x0)} ${r2(yy)}`,
      );
      s.setAttribute("opacity", r2(bump(q)));
    });
    // --- 合叶 z's ---
    if (st.zzz && !compact && !calm) {
      S.zTimer -= dt;
      if (S.zTimer <= 0) {
        S.zTimer = 1.5;
        const t = el("text", { "font-size": 11, opacity: 0 }, zLayer);
        t.textContent = "z";
        S.zs.push({ t, age: 0 });
      }
    }
    S.zs = S.zs.filter((z) => {
      z.age += dt;
      const p = z.age / 2.8;
      if (p >= 1 || !st.zzz) {
        z.t.remove();
        return false;
      }
      z.t.setAttribute("x", r2(cx + 30 + Math.sin(p * 5) * 3 + p * 10));
      z.t.setAttribute("y", r2(cy - 30 - p * 26));
      z.t.setAttribute("font-size", r2(9 + p * 8));
      z.t.setAttribute("opacity", r2(Math.sin(p * Math.PI) * 0.5));
      return true;
    });
  }
  function frame(dt) {
    let left = dt;
    while (left > 1e-4) {
      const h = Math.min(left, 1 / 120);
      step(h);
      left -= h;
    }
  }

  svg.addEventListener("click", () => {
    if (opts.interactive === false || STATES[S.state].morph) return;
    if (Math.random() < 0.3) poke("spin");
    else smile(Math.random() < 0.4);
  });

  const bot = {
    svg,
    frame,
    setExpression,
    smile,
    poke,
    blink,
    setState(name) {
      setState(name);
      if (!bots.has(bot)) frame(0.9);
    },
    setLive(on) {
      calm = reduce || !on;
      if (!calm) {
        if (opts.gaze !== 0) watchPointer();
        addBot(bot);
      } else {
        bots.delete(bot);
        frame(0.9);
      }
    },
    setTone(t) {
      if (TONES[t]) {
        tone = t;
        paint();
      }
    },
    setForm(f) {
      if (FORMS[f]) {
        form = f;
        blink();
        poke("bounce");
      }
    },
    clearExpression() {
      S.override = null;
      applyFace(false);
    },
    get state() {
      return S.state;
    },
    destroy() {
      bots.delete(bot);
      io.disconnect();
      svg.remove();
    },
  };
  const io = new IntersectionObserver((en) => {
    bot.visible = en[0].isIntersecting;
  });
  bot.visible = true;
  io.observe(svg);
  setState(opts.state || "idle");
  frame(opts.state === "spawn" ? 0.02 : calm ? 0.9 : 0.5);
  if (!calm) addBot(bot);
  return bot;
}

let last = 0;
let running = false;
function loop(now) {
  if (!bots.size) {
    running = false;
    return;
  }
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  bots.forEach((b) => {
    if (b.visible) b.frame(dt);
  });
  requestAnimationFrame(loop);
}
function addBot(b) {
  bots.add(b);
  if (!running) {
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
}

export const createMossbotCompanion = create;
export const MOSSBOT_COMPANION_STATE_NAMES = Object.keys(STATES);
