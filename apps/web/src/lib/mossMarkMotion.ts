// FILE: mossMarkMotion.ts
// Purpose: How the Moss mark moves while an agent works. The mark is a paper pinwheel, and a
//          pinwheel only turns when there is wind: here the wind is the agent's real activity.
// Layer: Web UI animation logic (pure; MossLogoMark owns the frame loop and the DOM)
// Exports: MossMarkActivity, MossMarkMotion, MossMarkPose, createMossMarkMotion,
//          setMossMarkActivity, noteMossMarkProgress, stepMossMarkMotion, mossMarkPose
// Why: Three rules make it read as one object instead of a set of spinners.
//      1. It only ever turns one way (counter-clockwise), whatever state follows whatever.
//      2. Speed is continuous: every state change starts from the speed the mark already has.
//      3. Whenever it stops, it stops on a multiple of 90 degrees. The mark is four-fold
//         symmetric, so every stop is exactly the still logo.

/**
 * What the agent is doing, as the mark shows it:
 * - `sending`: a message is on its way, or the agent is starting. Still; rings of light ripple
 *   out from the hub, like a signal going out.
 * - `thinking`: no output yet. A gust turns it a quarter, it rests, another gust comes.
 * - `replying`: text is streaming. It spins as fast as the text arrives.
 * - `working`: a tool is running. Still; light walks the folds.
 * - `waiting`: the agent needs the person. Still; the whole mark breathes.
 * - `stalled`: the connection is being retried. The wind dies down and the colour drains.
 * - `done`: the turn ended. It coasts to rest and one ripple of light crosses it, hub to tips.
 */
export type MossMarkActivity =
  | "sending"
  | "thinking"
  | "replying"
  | "working"
  | "waiting"
  | "stalled"
  | "done";

export interface MossMarkPose {
  /** Degrees; it only decreases (counter-clockwise on screen). */
  readonly angle: number;
  /** Light on each folded corner, 0 (resting colour) to 1 (fully lit), clockwise from the top. */
  readonly folds: readonly [number, number, number, number];
  /** Opacity of the whole mark, 0..1. */
  readonly opacity: number;
  /** Colour saturation of the whole mark, 0..1. */
  readonly saturation: number;
  /**
   * A ring of light travelling from the hub to the blade tips: where it is (0 at the hub, 1 at
   * the tips) and how bright (0 means there is none).
   */
  readonly ripple: { readonly radius: number; readonly light: number };
}

/** Mutable simulation state. Create with {@link createMossMarkMotion}; treat as opaque. */
export interface MossMarkMotion {
  activity: MossMarkActivity;
  /** Seconds since the activity began. */
  time: number;
  angle: number;
  /** Degrees per second, never negative. */
  speed: number;
  /** Where a settling mark comes to rest; always a multiple of 90. */
  target: number;
  /** The glide in progress: distance and speed when it began, how long it takes, how far in. */
  settle: { distance: number; speed: number; duration: number; elapsed: number } | null;
  gusts: number;
  nextGustAt: number;
  /** Progress units (streamed characters) not yet folded into `rate`. */
  pendingProgress: number;
  /** Smoothed progress units per second. */
  rate: number;
  folds: [number, number, number, number];
  opacity: number;
  saturation: number;
  rippleRadius: number;
  rippleLight: number;
}

const QUARTER = 90;
/** A gust: a quarter turn from rest that swells in a third of a second and tails off softly. */
const GUST_DURATION_S = 1.25;
/**
 * A landing from speed lasts `LANDING_PACE * distance / speed`: at that pace the mark only ever
 * slows down. The bounds keep a fast mark from stopping dead and a slow one from crawling.
 */
const LANDING_PACE = 2.4;
const SHORTEST_LANDING_S = 0.5;
const LONGEST_LANDING_S = 1.2;
const FIRST_GUST_AFTER_S = 0.25;
const GUST_INTERVAL_S = 2;
const GUST_INTERVAL_SPREAD_S = 0.5;
const MIN_REST_S = 0.4;
/** While replying: a light breeze with no text, rising toward the ceiling as text speeds up. */
const REPLY_BASE_SPEED = 30;
const REPLY_SPEED_RANGE = 480;
/** Characters per second at which the mark reaches about two thirds of its top speed. */
const REPLY_RATE_SCALE = 60;
/** How quickly the spin answers a change in text speed: quick enough to feel tied to it. */
const RATE_SMOOTHING_S = 0.22;
const SPIN_SMOOTHING_S = 0.3;
const STALLED_SPEED = 8;
const STALLED_SATURATION = 0.4;
/** Folds are listed clockwise; light travels the way the mark turns, counter-clockwise. */
const FOLD_TURN_ORDER = [0, 3, 2, 1] as const;
const FOLD_WALK_PERIOD_S = 1.6;
/** A ripple takes this long to cross the mark; while sending, one leaves every period. */
const RIPPLE_TRAVEL_S = 1.1;
const RIPPLE_PERIOD_S = 1.5;
/** The finishing ripple waits until the landing has mostly played out. */
const DONE_RIPPLE_AFTER_S = 0.35;
const BREATH_PERIOD_S = 2.4;

const approach = (from: number, to: number, dt: number, tau: number): number =>
  from + (to - from) * (1 - Math.exp(-dt / tau));
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function createMossMarkMotion(activity: MossMarkActivity): MossMarkMotion {
  const motion: MossMarkMotion = {
    activity,
    time: 0,
    angle: 0,
    speed: 0,
    target: 0,
    settle: null,
    gusts: 0,
    nextGustAt: FIRST_GUST_AFTER_S,
    pendingProgress: 0,
    rate: 0,
    folds: [0, 0, 0, 0],
    opacity: 1,
    saturation: 1,
    rippleRadius: 0,
    rippleLight: 0,
  };
  return motion;
}

const turnsFreely = (activity: MossMarkActivity): boolean =>
  activity === "replying" || activity === "stalled";

/**
 * Glide to rest on a multiple of 90 degrees. From rest (`extraQuarters` = 1) this is a gust.
 * From speed, the landing is the next rest pose at least a short coast ahead, so the mark never
 * stops dead and never has to turn back.
 */
function beginSettle(motion: MossMarkMotion, extraQuarters = 0): void {
  const coast = (motion.speed * SHORTEST_LANDING_S) / LANDING_PACE;
  motion.target =
    Math.floor((motion.angle - coast) / QUARTER + 1e-9) * QUARTER - extraQuarters * QUARTER;
  const distance = motion.angle - motion.target;
  const duration =
    motion.speed < 1
      ? GUST_DURATION_S
      : Math.min(
          LONGEST_LANDING_S,
          Math.max(SHORTEST_LANDING_S, (LANDING_PACE * distance) / motion.speed),
        );
  motion.settle = { distance, speed: motion.speed, duration, elapsed: 0 };
}

export function setMossMarkActivity(motion: MossMarkMotion, activity: MossMarkActivity): void {
  if (motion.activity === activity) return;
  const wasFree = turnsFreely(motion.activity);
  motion.activity = activity;
  motion.time = 0;
  if (turnsFreely(activity)) {
    motion.settle = null;
    return;
  }
  // From a free spin, or mid-gust into a still state, land on the next rest pose. A mark that
  // is already settling keeps its landing; thinking adds its gusts on top once it has landed.
  if (wasFree || motion.settle === null) beginSettle(motion);
  motion.nextGustAt = FIRST_GUST_AFTER_S;
  motion.pendingProgress = 0;
}

/** Tell the mark that `amount` more output arrived (streamed characters, new activity). */
export function noteMossMarkProgress(motion: MossMarkMotion, amount: number): void {
  if (amount > 0) motion.pendingProgress += amount;
}

function stepSettle(motion: MossMarkMotion, dt: number): void {
  const settle = motion.settle;
  if (!settle) {
    motion.speed = 0;
    return;
  }
  settle.elapsed += dt;
  const x = settle.elapsed / settle.duration;
  if (x >= 1) {
    motion.angle = motion.target;
    motion.speed = 0;
    motion.settle = null;
    return;
  }
  // One quartic for gusts and landings alike. With u = 1 - x:
  //   remaining(x) = u^3 * (distance + (3 * distance - speed * duration) * x)
  // It starts at the speed the mark already has and arrives with zero speed and zero
  // deceleration, so nothing ever snaps. It cannot turn back while
  // speed * duration <= 4 * distance, which the durations above guarantee.
  const u = 1 - x;
  const carry = settle.speed * settle.duration;
  const lift = 3 * settle.distance - carry;
  const remaining = u * u * u * (settle.distance + lift * x);
  motion.angle = Math.min(motion.angle, motion.target + remaining);
  motion.speed = Math.max(0, (u * u * (carry + 4 * lift * x)) / settle.duration);
}

function gustInterval(gustIndex: number): number {
  // Golden-ratio steps: irregular like weather, yet the same every run.
  return GUST_INTERVAL_S + GUST_INTERVAL_SPREAD_S * ((gustIndex * 0.618034) % 1);
}

function foldLight(motion: MossMarkMotion, fold: number): number {
  const order = FOLD_TURN_ORDER[fold]!;
  switch (motion.activity) {
    case "working": {
      const phase =
        (((motion.time - order * (FOLD_WALK_PERIOD_S / 4)) % FOLD_WALK_PERIOD_S) +
          FOLD_WALK_PERIOD_S) %
        FOLD_WALK_PERIOD_S;
      const half = FOLD_WALK_PERIOD_S / 2;
      // Squared, so each fold's light fades in and out with no corner.
      return phase < half ? Math.sin((Math.PI * phase) / half) ** 2 : 0;
    }
    // Turning folds catch the light in proportion to how fast the mark turns.
    case "thinking":
      return 0.7 * clamp01(motion.speed / 130);
    case "replying":
      return 0.45 * clamp01(motion.speed / REPLY_SPEED_RANGE);
    default:
      return 0;
  }
}

const DONE_RIPPLE_END_S = DONE_RIPPLE_AFTER_S + RIPPLE_TRAVEL_S;

/** Where the ripple is in its crossing, 0..1, or -1 when none is travelling. */
function ripplePhase(motion: MossMarkMotion): number {
  if (motion.activity === "sending") {
    const phase = (motion.time % RIPPLE_PERIOD_S) / RIPPLE_TRAVEL_S;
    return phase < 1 ? phase : -1;
  }
  if (motion.activity === "done") {
    const phase = (motion.time - DONE_RIPPLE_AFTER_S) / RIPPLE_TRAVEL_S;
    return phase > 0 && phase < 1 ? phase : -1;
  }
  return -1;
}

/**
 * Advance the simulation by `dt` seconds. Returns how long the caller may wait before the next
 * step: 0 means next animation frame, a positive number is seconds of stillness, and Infinity
 * means the mark is at rest until something changes.
 */
export function stepMossMarkMotion(motion: MossMarkMotion, dt: number): number {
  motion.time += dt;
  const { activity } = motion;

  if (turnsFreely(activity)) {
    motion.rate = approach(
      motion.rate,
      dt > 0 ? motion.pendingProgress / dt : 0,
      dt,
      RATE_SMOOTHING_S,
    );
    motion.pendingProgress = 0;
    const goal =
      activity === "stalled"
        ? STALLED_SPEED
        : REPLY_BASE_SPEED + REPLY_SPEED_RANGE * (1 - Math.exp(-motion.rate / REPLY_RATE_SCALE));
    motion.speed = approach(
      motion.speed,
      goal,
      dt,
      activity === "stalled" ? 1.6 : SPIN_SMOOTHING_S,
    );
    motion.angle -= motion.speed * dt;
  } else {
    motion.rate = 0;
    const wasSettling = motion.settle !== null;
    stepSettle(motion, dt);
    if (wasSettling && motion.settle === null) {
      // Every landing is held for a beat, so the still logo always registers.
      motion.nextGustAt = Math.max(motion.nextGustAt, motion.time + MIN_REST_S);
    } else if (activity === "thinking" && motion.settle === null) {
      // New activity is wind too: it brings the next gust forward.
      const windArrived = motion.pendingProgress > 0;
      if (motion.time >= motion.nextGustAt || windArrived) {
        beginSettle(motion, 1);
        motion.gusts += 1;
        motion.nextGustAt = motion.time + gustInterval(motion.gusts);
      }
    }
    motion.pendingProgress = 0;
  }

  for (let fold = 0; fold < 4; fold += 1) {
    motion.folds[fold] = approach(motion.folds[fold]!, foldLight(motion, fold), dt, 0.05);
  }
  // The ring leaves the hub quickly and slows toward the tips, brightening as it starts and
  // fading before it arrives, the way a ripple spreads and thins.
  const phase = ripplePhase(motion);
  if (phase < 0) {
    motion.rippleLight = 0;
  } else {
    motion.rippleRadius = 1 - (1 - phase) ** 2;
    motion.rippleLight = Math.sin(Math.PI * Math.min(1, phase * 4) * 0.5) * (1 - phase);
  }
  const breath =
    activity === "waiting"
      ? 0.72 + 0.28 * Math.cos((motion.time / BREATH_PERIOD_S) * 2 * Math.PI)
      : 1;
  motion.opacity = approach(motion.opacity, breath, dt, 0.12);
  motion.saturation = approach(
    motion.saturation,
    activity === "stalled" ? STALLED_SATURATION : 1,
    dt,
    activity === "stalled" ? 1.8 : 0.3,
  );

  if (turnsFreely(activity) || motion.settle !== null) return 0;
  const easing =
    motion.folds.some((light) => light > 0.004) ||
    Math.abs(motion.opacity - 1) > 0.004 ||
    Math.abs(motion.saturation - 1) > 0.004;
  switch (activity) {
    case "thinking":
      return easing ? 0 : Math.max(0, motion.nextGustAt - motion.time);
    case "sending":
    case "working":
    case "waiting":
      return 0;
    case "done":
      return motion.time < DONE_RIPPLE_END_S || easing ? 0 : Infinity;
    default:
      return easing ? 0 : Infinity;
  }
}

export function mossMarkPose(motion: MossMarkMotion): MossMarkPose {
  return {
    angle: motion.angle,
    folds: [motion.folds[0], motion.folds[1], motion.folds[2], motion.folds[3]],
    opacity: motion.opacity,
    saturation: motion.saturation,
    ripple: { radius: motion.rippleRadius, light: motion.rippleLight },
  };
}
