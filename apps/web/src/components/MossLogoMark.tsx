// FILE: MossLogoMark.tsx
// Purpose: The Moss mark as inline SVG, still or showing what an agent is doing.
// Layer: Shared app branding primitive
// Why: Pages that do not serve `public/moss-logo-coral.png` draw it from the vector, and the
//      chat's working line uses the same mark the way Claude uses its spark. The motion
//      itself is lib/mossMarkMotion.ts; this file only runs its frames and paints its pose.

import { useEffect, useId, useRef, type SVGProps } from "react";
import {
  MOSS_LOGO_COLOR,
  MOSS_LOGO_FOLD_COLOR,
  MOSS_LOGO_FOLD_PATHS,
  MOSS_LOGO_PATH,
  MOSS_LOGO_VIEW_BOX,
} from "~/assets/mossLogoPath";
import {
  createMossMarkMotion,
  noteMossMarkProgress,
  setMossMarkActivity,
  stepMossMarkMotion,
  type MossMarkActivity,
  type MossMarkMotion,
} from "~/lib/mossMarkMotion";
import { cn } from "~/lib/utils";

export type { MossMarkActivity } from "~/lib/mossMarkMotion";

/** A fully lit fold shows this much of its own colour; the blade's front shows through the rest. */
const LIT_FOLD_OPACITY = 0.3;
/** The ripple is a soft white ring this wide (share of the mark's radius) and this bright. */
const RIPPLE_WIDTH = 0.3;
const RIPPLE_BRIGHTNESS = 0.6;
/** Hub to the farthest blade tip, in the mark's own units. */
const MARK_RADIUS = 66;
/** After a pause (hidden tab, long rest) the mark resumes instead of jumping ahead. */
const LONGEST_STEP_S = 0.05;

function paint(svg: SVGSVGElement, motion: MossMarkMotion): void {
  // The CSS `rotate` property composites on its own layer and leaves the caller's transform
  // classes alone.
  svg.style.rotate = `${motion.angle.toFixed(2)}deg`;
  svg.style.filter = motion.saturation < 0.996 ? `saturate(${motion.saturation.toFixed(3)})` : "";
  const body = svg.firstElementChild as SVGGElement | null;
  if (!body) return;
  body.style.opacity = motion.opacity < 0.996 ? motion.opacity.toFixed(3) : "";
  for (let fold = 0; fold < 4; fold += 1) {
    const path = body.children[fold + 1] as SVGPathElement | undefined;
    const light = motion.folds[fold]!;
    if (path) {
      path.style.opacity = light > 0.004 ? (1 - (1 - LIT_FOLD_OPACITY) * light).toFixed(3) : "";
    }
  }
  // The ripple: the mark's own shape painted over itself with a ring-shaped gradient, so the
  // light stays on the paper and never spills outside it.
  const ring = body.children[5] as SVGPathElement | undefined;
  const stops = svg.querySelectorAll("stop");
  if (!ring || stops.length !== 3) return;
  const light = motion.rippleLight;
  if (light <= 0.004) {
    ring.style.display = "none";
    return;
  }
  ring.style.display = "";
  const centre = motion.rippleRadius * (1 + RIPPLE_WIDTH) - RIPPLE_WIDTH / 2;
  const at = (offset: number) => Math.min(1, Math.max(0, offset)).toFixed(3);
  stops[0]!.setAttribute("offset", at(centre - RIPPLE_WIDTH / 2));
  stops[1]!.setAttribute("offset", at(centre));
  stops[1]!.setAttribute("stop-opacity", (RIPPLE_BRIGHTNESS * light).toFixed(3));
  stops[2]!.setAttribute("offset", at(centre + RIPPLE_WIDTH / 2));
}

/** Back to the still logo: no turn, no light, no colour change. */
function paintStill(svg: SVGSVGElement): void {
  svg.style.rotate = "";
  svg.style.filter = "";
  const body = svg.firstElementChild as SVGGElement | null;
  if (!body) return;
  body.style.opacity = "";
  for (let fold = 0; fold < 4; fold += 1) {
    const path = body.children[fold + 1] as SVGPathElement | undefined;
    if (path) path.style.opacity = "";
  }
  const ring = body.children[5] as SVGPathElement | undefined;
  if (ring) ring.style.display = "none";
}

/**
 * Runs the motion for one mark. Frames are requested only while something changes: a resting
 * mark schedules nothing, and the rests between gusts are plain timeouts. With reduced motion
 * the mark is the still logo and nothing is scheduled at all; turning the setting off resumes.
 */
function useMossMarkMotion(activity: MossMarkActivity | undefined, progress: number | undefined) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const motionRef = useRef<MossMarkMotion | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const progressRef = useRef(progress);

  const animated = activity !== undefined;
  useEffect(() => {
    const svg = svgRef.current;
    if (!animated || !svg) return;
    const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const reducedMotion = () => reducedMotionQuery?.matches === true;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = performance.now();
    let scheduled = false;
    let rested = 0;

    const tick = () => {
      scheduled = false;
      timer = undefined;
      const motion = motionRef.current;
      if (!motion) return;
      if (reducedMotion()) {
        paintStill(svg);
        return;
      }
      const now = performance.now();
      // A rest the motion asked for counts in full; anything longer was a pause.
      const dt = Math.min(rested + LONGEST_STEP_S, Math.max(0, (now - last) / 1000));
      last = now;
      const wait = stepMossMarkMotion(motion, dt);
      rested = wait === Infinity ? 0 : wait;
      paint(svg, motion);
      if (wait === Infinity) return;
      scheduled = true;
      if (wait <= 0) frame = requestAnimationFrame(tick);
      else timer = setTimeout(tick, wait * 1000);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      timer = undefined;
      scheduled = false;
    };
    const wake = () => {
      if (reducedMotion()) {
        stop();
        paintStill(svg);
        return;
      }
      if (scheduled) {
        // A long rest is cut short; a frame already on its way is left alone.
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        rested = (performance.now() - last) / 1000;
      } else last = performance.now();
      scheduled = true;
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;
    reducedMotionQuery?.addEventListener?.("change", wake);
    wake();
    return () => {
      wakeRef.current = null;
      reducedMotionQuery?.removeEventListener?.("change", wake);
      stop();
      paintStill(svg);
    };
  }, [animated]);

  useEffect(() => {
    if (activity === undefined) {
      motionRef.current = null;
      return;
    }
    if (motionRef.current) setMossMarkActivity(motionRef.current, activity);
    else motionRef.current = createMossMarkMotion(activity);
    wakeRef.current?.();
  }, [activity]);

  useEffect(() => {
    const previous = progressRef.current;
    progressRef.current = progress;
    const motion = motionRef.current;
    if (!motion || progress === undefined || previous === undefined) return;
    if (progress > previous) {
      noteMossMarkProgress(motion, progress - previous);
      wakeRef.current?.();
    }
  }, [progress]);

  return svgRef;
}

export function MossLogoMark({
  activity,
  progress,
  className,
  ...props
}: SVGProps<SVGSVGElement> & {
  /** What the agent is doing. Omit for the still mark. */
  readonly activity?: MossMarkActivity;
  /**
   * A number that grows as output arrives (streamed characters, activity count). The mark
   * turns with its growth: fast text spins it fast, and a pause lets it slow down.
   */
  readonly progress?: number;
}) {
  const ariaLabel = props["aria-label"];
  const svgRef = useMossMarkMotion(activity, progress);
  const rippleId = `moss-mark-ripple-${useId()}`;

  return (
    <svg
      viewBox={MOSS_LOGO_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      ref={svgRef}
      className={cn("shrink-0", className)}
      data-activity={activity}
    >
      <g>
        <path d={MOSS_LOGO_PATH} fill={MOSS_LOGO_COLOR} />
        {MOSS_LOGO_FOLD_PATHS.map((fold) => (
          <path key={fold} d={fold} fill={MOSS_LOGO_FOLD_COLOR} />
        ))}
        {activity ? (
          <path d={MOSS_LOGO_PATH} fill={`url(#${rippleId})`} style={{ display: "none" }} />
        ) : null}
      </g>
      {activity ? (
        <defs>
          <radialGradient
            id={rippleId}
            gradientUnits="userSpaceOnUse"
            cx="0"
            cy="0"
            r={MARK_RADIUS}
          >
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
      ) : null}
    </svg>
  );
}
