// FILE: MossbotKid.tsx
// Purpose: The pinwheel kid (风车娃) as a Mossbot avatar. At rest it is a still SVG of whole pixels with no timers, so
//          long lists stay cheap. When `live`, a canvas plays the clip for the companion state: one shared frame loop
//          for every live kid, smooth between keyframes, paused while scrolled out of view, still for reduced motion.
// Layer: Web component
// Exports: MossbotKid, MossbotKidStill, mossbotKidToneFor
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type SVGProps,
} from "react";
import { cn } from "~/lib/utils";
import { MOSSBOT_KID_TONES, type MossbotKidTone } from "~/theme/mossbotKid";
import { mossbotCompanionToneFor, type MossbotCompanionState } from "../MossbotCompanion";
import {
  MOSSBOT_KID_TICKS_PER_SECOND,
  mossbotKidClip,
  mossbotKidClipAfter,
  mossbotKidClipFor,
  mossbotKidClipTicks,
  sampleMossbotKidClip,
  type MossbotKidClip,
} from "./mossbotKidClips";
import {
  MOSSBOT_KID_STAGE,
  mossbotKidPalette,
  renderMossbotKidPose,
  type MossbotKidForm,
  type MossbotKidGrid,
  type MossbotKidPose,
} from "./mossbotKidSprite";

/** The square of the stage an avatar shows: every form with its still pinwheel, centred on the kid. */
const VIEW = { x: 1, y: 5, size: 31 } as const;
/** Below this many CSS pixels a stage pixel is smaller than a screen pixel; draw smoothed instead of hard-edged. */
const CRISP_FROM = 24;
/** Clips that play once and then settle into idle, as the vector companion's states do. */
const ONE_SHOT = new Set(["startup", "cheering", "wave"]);

/** The clip for a state, or for a scene (a clip id) when one is given. */
function clipFor(state: MossbotCompanionState, scene: string | undefined): MossbotKidClip {
  return scene ? mossbotKidClip(scene) : mossbotKidClipFor(state);
}

/** Assistant colour keys map onto the kid's tones; the default colour is the kid's own coral. */
export function mossbotKidToneFor(color: string | null | undefined): MossbotKidTone {
  if (!color || color === "default") return "coral";
  if (color in MOSSBOT_KID_TONES) return color as MossbotKidTone;
  return mossbotCompanionToneFor(color);
}

interface Run {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly fill: string;
}

const stillCache = new Map<string, readonly Run[]>();

// Neighbouring pixels of one colour in a row become one rect, so a still kid is a few dozen elements.
function stillRuns(
  form: MossbotKidForm,
  tone: MossbotKidTone,
  state: MossbotCompanionState,
  scene: string | undefined,
) {
  const cacheKey = `${form}:${tone}:${state}:${scene ?? ""}`;
  const cached = stillCache.get(cacheKey);
  if (cached) return cached;
  const clip = clipFor(state, scene);
  const frame = clip.loop[0] ?? clip.enter[0];
  const grid = frame ? renderMossbotKidPose(frame.pose, form) : [];
  const colours = mossbotKidPalette(tone);
  const runs: Run[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x];
      if (!key) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === key) end++;
      runs.push({ x, y, w: end - x, fill: colours[key] });
      x = end;
    }
  });
  stillCache.set(cacheKey, runs);
  return runs;
}

export function MossbotKidStill({
  form = "block",
  tone = "coral",
  state = "idle",
  scene,
  crisp = true,
  ...props
}: SVGProps<SVGSVGElement> & {
  form?: MossbotKidForm;
  tone?: MossbotKidTone;
  state?: MossbotCompanionState;
  scene?: string | undefined;
  crisp?: boolean;
}) {
  const runs = stillRuns(form, tone, state, scene);
  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.size} ${VIEW.size}`}
      overflow="visible"
      shapeRendering={crisp ? "crispEdges" : "auto"}
      aria-hidden="true"
      {...props}
    >
      {runs.map((run) => (
        <rect
          key={`${run.x}:${run.y}`}
          x={run.x}
          y={run.y}
          width={run.w}
          height={1}
          fill={run.fill}
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The shared frame loop for live kids.

interface LiveKid {
  canvas: HTMLCanvasElement;
  form: MossbotKidForm;
  tone: MossbotKidTone;
  /** The clip being played, its transition in included, and the id of the clip it leads to. */
  clip: MossbotKidClip;
  target: string;
  /** The pose last drawn, where the next transition starts from. */
  pose: MossbotKidPose | null;
  startedAt: number;
  /** Device pixels per stage pixel. */
  unit: number;
  visible: boolean;
  drawn: string;
}

const live = new Set<LiveKid>();
let running = false;

function frame(now: number) {
  if (live.size === 0) {
    running = false;
    return;
  }
  for (const kid of live) if (kid.visible) draw(kid, now);
  requestAnimationFrame(frame);
}

function start(kid: LiveKid) {
  live.add(kid);
  if (!running) {
    running = true;
    requestAnimationFrame(frame);
  }
}

/** Moves the kid into another clip through a transition from the pose it shows now. */
function switchTo(kid: LiveKid, next: MossbotKidClip, now: number) {
  kid.clip = kid.pose ? mossbotKidClipAfter(kid.pose, next) : next;
  kid.target = next.id;
  kid.startedAt = now;
}

function draw(kid: LiveKid, now: number) {
  if (ONE_SHOT.has(kid.target)) {
    const once =
      ((mossbotKidClipTicks(kid.clip.enter) + mossbotKidClipTicks(kid.clip.loop)) * 1000) /
      MOSSBOT_KID_TICKS_PER_SECOND;
    if (now - kid.startedAt >= once) switchTo(kid, mossbotKidClipFor("idle"), now);
  }
  const sample = sampleMossbotKidClip(kid.clip, now - kid.startedAt, { smooth: true });
  kid.pose = sample.pose;
  const unit = kid.unit;
  const ox = Math.round(sample.offsetX * unit);
  const oy = Math.round(sample.offsetY * unit);
  const signature = `${kid.startedAt}:${sample.phase}:${sample.index}:${Math.round(sample.pose.pin)}:${ox}:${oy}:${kid.tone}:${kid.form}:${unit}`;
  if (signature === kid.drawn) return;
  kid.drawn = signature;
  paint(
    kid.canvas,
    renderMossbotKidPose(sample.pose, kid.form),
    mossbotKidPalette(kid.tone),
    unit,
    ox,
    oy,
  );
}

function paint(
  canvas: HTMLCanvasElement,
  grid: MossbotKidGrid,
  colours: Record<string, string>,
  unit: number,
  ox: number,
  oy: number,
) {
  const width = MOSSBOT_KID_STAGE.cols * unit;
  const height = MOSSBOT_KID_STAGE.rows * unit;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  grid.forEach((row, y) => {
    row.forEach((key, x) => {
      if (!key) return;
      ctx.fillStyle = colours[key] ?? "transparent";
      ctx.fillRect(x * unit + ox, y * unit + oy, unit, unit);
    });
  });
}

/** Where the live canvas sits: the whole stage, placed so the avatar's square shows the VIEW part of it. */
const CANVAS_BOX = {
  left: `${(-VIEW.x / VIEW.size) * 100}%`,
  top: `${(-VIEW.y / VIEW.size) * 100}%`,
  width: `${(MOSSBOT_KID_STAGE.cols / VIEW.size) * 100}%`,
  height: `${(MOSSBOT_KID_STAGE.rows / VIEW.size) * 100}%`,
} as const;

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The kid in one body form and tone, doing what the companion state says. `live` animates it; without it the kid is
 * the still SVG of the state's settled pose. Reduced-motion users always get the still version.
 */
export function MossbotKid({
  form = "block",
  tone = "coral",
  state = "idle",
  scene,
  live: liveProp = false,
  label,
  className,
  ...rest
}: {
  form?: MossbotKidForm;
  tone?: MossbotKidTone;
  state?: MossbotCompanionState;
  /** A scene (a clip id, see mossbotKidClips.ts) to play instead of the state's clip. */
  scene?: string | undefined;
  live?: boolean;
  label?: string;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kidRef = useRef<LiveKid | null>(null);
  const [size, setSize] = useState(0);
  const animate = liveProp && !prefersReducedMotion();

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setSize(root.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const unit = useMemo(
    () => Math.max(1, Math.round((size * (globalThis.devicePixelRatio || 1)) / VIEW.size)),
    [size],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!animate || !canvas || !root) return;
    const first = clipFor(state, scene);
    const kid: LiveKid = {
      canvas,
      form,
      tone,
      clip: first,
      target: first.id,
      pose: null,
      startedAt: performance.now(),
      unit,
      visible: true,
      drawn: "",
    };
    kidRef.current = kid;
    start(kid);
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        kid.visible = entries.some((entry) => entry.isIntersecting);
      });
      observer.observe(root);
    }
    return () => {
      observer?.disconnect();
      live.delete(kid);
      kidRef.current = null;
    };
    // The loop entry is created once per animated mount; the effect below updates it in place.
  }, [animate]);

  useEffect(() => {
    const kid = kidRef.current;
    if (!kid) return;
    Object.assign(kid, { form, tone, unit });
    const next = clipFor(state, scene);
    if (next.id !== kid.target) switchTo(kid, next, performance.now());
  }, [form, tone, state, scene, unit]);

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-mossbot-kid={animate ? "live" : "still"}
      data-state={state}
      className={cn("mossbot-kid", className)}
      {...rest}
    >
      {animate ? (
        <canvas ref={canvasRef} className="mossbot-kid-canvas" style={CANVAS_BOX} />
      ) : (
        <MossbotKidStill
          form={form}
          tone={tone}
          state={state}
          scene={scene}
          crisp={size === 0 || size >= CRISP_FROM}
        />
      )}
    </span>
  );
}
