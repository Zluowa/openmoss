// FILE: MossbotCompanion.tsx
// Purpose: The Mossbot companion as an avatar: a moss-green ball with a sprout and two eyes. At rest it is a plain
//          SVG drawn by React (no engine, no timers), so long lists stay cheap. When `live` is set, or when the
//          state needs a pose a still SVG can't draw, the animation engine is loaded on demand and takes over.
// Layer: Web component
// Exports: MossbotCompanion, MossbotCompanionStill, mossbotCompanionToneFor, MossbotCompanionState,
//          MossbotCompanionHandle
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type SVGProps,
} from "react";
import { cn } from "~/lib/utils";
import {
  MOSSBOT_COMPANION_EYE,
  MOSSBOT_COMPANION_TONES,
  type MossbotCompanionTone,
} from "~/theme/mossbotCompanion";

export type MossbotCompanionState =
  | "idle"
  | "spawn"
  | "listening"
  | "thinking"
  | "working"
  | "busy"
  | "waiting"
  | "notify"
  | "done"
  | "error"
  | "sleeping"
  | "greeting";

/** What the engine hands back; the engine module itself is untyped animation code. */
export interface MossbotCompanionHandle {
  readonly svg: SVGSVGElement;
  setState(state: MossbotCompanionState): void;
  setTone(tone: MossbotCompanionTone): void;
  setLive(live: boolean): void;
  smile(big?: boolean): void;
  destroy(): void;
}

interface MossbotCompanionEngine {
  createMossbotCompanion(
    host: HTMLElement,
    options: {
      size: number;
      tone: MossbotCompanionTone;
      state: MossbotCompanionState;
      gaze: number;
      interactive: boolean;
      still: boolean;
      label: string;
    },
  ): MossbotCompanionHandle;
}

let enginePromise: Promise<MossbotCompanionEngine> | null = null;
function loadEngine(): Promise<MossbotCompanionEngine> {
  enginePromise ??= (
    import("./companion/mossbotCompanionEngine") as unknown as Promise<MossbotCompanionEngine>
  ).catch((cause: unknown) => {
    // A failed chunk load (e.g. an update replaced the files) is retried next time; until then the still face stays.
    enginePromise = null;
    throw cause;
  });
  return enginePromise;
}

/** Assistant colour keys (coordinatorColor) map onto the companion's earth tones. */
const TONE_BY_COLOR: Readonly<Record<string, MossbotCompanionTone>> = {
  default: "moss",
  green: "jade",
  blue: "slate",
  cyan: "lake",
  violet: "plum",
  rose: "clay",
  amber: "ochre",
  orange: "rust",
};

export function mossbotCompanionToneFor(color: string | null | undefined): MossbotCompanionTone {
  if (!color) return "moss";
  if (color in MOSSBOT_COMPANION_TONES) return color as MossbotCompanionTone;
  return TONE_BY_COLOR[color] ?? "moss";
}

// The resting frame, exactly as the engine draws it (front pose, neutral eyes). Small sizes use the engine's tighter
// framing and slightly bolder eyes so the face still reads at 14–40 px.
const LEAF_LEFT = "M0 0C-1.2 -4.6 -6.6 -8.2 -12.6 -7.4C-10.4 -2.4 -5 0.6 0 0Z";
const LEAF_RIGHT = "M0 0C1.4 -5.4 7.8 -9.6 14.8 -8.6C12.2 -2.8 5.8 0.8 0 0Z";

export function MossbotCompanionStill({
  tone = "moss",
  compact = true,
  ...props
}: SVGProps<SVGSVGElement> & { tone?: MossbotCompanionTone; compact?: boolean }) {
  const body = MOSSBOT_COMPANION_TONES[tone].body;
  const eyeHalf = compact ? 7.59 : 6.6;
  const eyeWidth = compact ? 12 : 10.45;
  return (
    <svg
      viewBox={compact ? "-53 -62 106 106" : "-64 -76 128 128"}
      fill="none"
      aria-hidden="true"
      overflow="visible"
      {...props}
    >
      <g transform={`translate(0 -42.8) scale(${compact ? 1.25 : 1})`}>
        <path d="M0 0V-9.5" stroke={body} strokeWidth={compact ? 3.4 : 2.6} strokeLinecap="round" />
        <g transform="translate(0 -9.5)" fill={body}>
          <path d={LEAF_LEFT} />
          <path d={LEAF_RIGHT} transform="rotate(6)" />
        </g>
      </g>
      <circle r="44" fill={body} />
      <g stroke={MOSSBOT_COMPANION_EYE} strokeWidth={eyeWidth} strokeLinecap="round">
        <path d={`M-13.6 ${-1.46 - eyeHalf}V${-1.46 + eyeHalf}`} />
        <path d={`M13.6 ${-1.46 - eyeHalf}V${-1.46 + eyeHalf}`} />
      </g>
    </svg>
  );
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * `live` runs the animation (one shared frame loop for every live companion on screen). Without it the companion is
 * still: idle draws the SVG above, any other state draws one settled engine frame (closed eyes when sleeping, the
 * pinwheel sprout when working, …). Reduced-motion users always get the still version.
 */
export function MossbotCompanion({
  tone = "moss",
  state = "idle",
  live = false,
  interactive = false,
  label,
  className,
  ...rest
}: {
  tone?: MossbotCompanionTone;
  state?: MossbotCompanionState;
  live?: boolean;
  interactive?: boolean;
  label?: string;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  const handleRef = useRef<MossbotCompanionHandle | null>(null);
  const [size, setSize] = useState(0);
  const [engineShown, setEngineShown] = useState(false);
  const animate = live && !prefersReducedMotion();
  const needsEngine = animate || state !== "idle";

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setSize(Math.round(root.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // The engine is created once it is needed and the box has a size. The size only picks the framing, so the engine
  // is rebuilt when the box crosses the small/large line, not on every resize. Tone, state and live changes go to
  // the running engine; `latest` carries them into an engine that finishes loading after they changed.
  const compact = size === 0 || size <= 40;
  const hasSize = size > 0;
  const latest = useRef({ size, tone, state, animate, label });
  latest.current = { size, tone, state, animate, label };
  useEffect(() => {
    const stage = stageRef.current;
    if (!needsEngine || !stage || !hasSize) return;
    let cancelled = false;
    void loadEngine().then(
      (engine) => {
        if (cancelled) return;
        const now = latest.current;
        handleRef.current = engine.createMossbotCompanion(stage, {
          size: now.size,
          tone: now.tone,
          state: now.state,
          gaze: now.animate && now.size > 40 ? 1 : 0,
          interactive,
          still: !now.animate,
          label: now.label ?? "Moss",
        });
        setEngineShown(true);
      },
      () => {
        // Keep the still face; the animation is decoration and never blocks the page.
      },
    );
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
      setEngineShown(false);
    };
  }, [needsEngine, hasSize, compact, interactive]);

  useEffect(() => handleRef.current?.setTone(tone), [tone]);
  useEffect(() => handleRef.current?.setState(state), [state]);
  useEffect(() => handleRef.current?.setLive(animate), [animate]);

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-mossbot-companion={engineShown ? "engine" : "still"}
      data-state={state}
      className={cn("mossbot-companion", className)}
      {...rest}
    >
      {!engineShown && <MossbotCompanionStill tone={tone} compact={compact} />}
      <span ref={stageRef} className="mossbot-companion-stage" />
    </span>
  );
}
