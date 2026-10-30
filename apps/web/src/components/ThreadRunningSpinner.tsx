// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running/pulse spinner for sidebar thread status slots.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner, ThreadBackgroundWorkSpinner

import { useRef } from "react";

import { useTimelineSynchronizedAnimations } from "~/lib/animationTimelineSync";
import { cn } from "~/lib/utils";

// Working glyph: a 24px filled donut, track at 30% opacity and a three-quarter
// ring on top. Sidebar rows paint it at 14px in muted ink. The rotation stays on the stepped
// `animate-spin-stepped` token (index.css) rather than `animate-spin`: this
// glyph is always on while a thread runs, and a continuous 60 fps spin inside
// the translucent sidebar forced the whole backdrop-filtered surface + window
// vibrancy to re-render every frame. Every instance is also pinned to the
// document timeline origin: N running threads then step in the same frame
// (one sidebar repaint per step) instead of N frames.
const SPINNER_TRACK = "M12 4a8 8 0 1 1 0 16a8 8 0 1 1 0-16Zm0 2a6 6 0 1 0 0 12a6 6 0 1 0 0-12Z";
const SPINNER_ARC = "M12 4a8 8 0 1 1-8 8h2a6 6 0 1 0 6-6Z";
// Dashed ring for background work: 2-unit dashes over a 4.6-unit period.
const BACKGROUND_CANVAS = 15;
const BACKGROUND_LINE_WIDTH = 2;
const BACKGROUND_RADIUS = (BACKGROUND_CANVAS - BACKGROUND_LINE_WIDTH) / 2;
const BACKGROUND_DASH = "2 2.6";

export function ThreadRunningSpinner({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  useTimelineSynchronizedAnimations(svgRef);
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={cn(
        "inline-block size-4 shrink-0 animate-spin-stepped text-foreground/70 motion-reduce:animate-none",
        className,
      )}
    >
      <path opacity="0.3" fill="currentColor" d={SPINNER_TRACK} />
      <path fill="currentColor" d={SPINNER_ARC} />
    </svg>
  );
}

// Quieter sibling for a thread whose turn ended but whose background tasks still run.
// A grey dashed ring turning at half speed reads as "still going, nothing for you to do",
// distinct from the live spinner and from the blue unread dot. It shares the 50ms step
// and timeline origin, so it repaints in the same frames as the running spinners.
export function ThreadBackgroundWorkSpinner({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  useTimelineSynchronizedAnimations(svgRef);
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      viewBox={`0 0 ${BACKGROUND_CANVAS} ${BACKGROUND_CANVAS}`}
      fill="none"
      className={cn(
        "inline-block size-3 shrink-0 animate-spin-stepped-slow text-muted-foreground/65 motion-reduce:animate-none",
        className,
      )}
    >
      <circle
        cx={BACKGROUND_CANVAS / 2}
        cy={BACKGROUND_CANVAS / 2}
        r={BACKGROUND_RADIUS}
        stroke="currentColor"
        strokeWidth={BACKGROUND_LINE_WIDTH * 0.8}
        strokeLinecap="round"
        strokeDasharray={BACKGROUND_DASH}
      />
    </svg>
  );
}
