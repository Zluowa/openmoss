// FILE: RailUpdateVisuals.tsx
// Purpose: The look shared by the rail's update buttons: T3 Code's round control (MIT) on the
//          rail's own button box, with a progress ring.
// Layer: Web shell navigation.

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { appRailButtonClassName } from "../AppRail";

export const RAIL_UPDATE_BUTTON_CLASS_NAME = cn(
  appRailButtonClassName(false),
  "rounded-full text-[var(--sidebar-accent-foreground)] starting:scale-75 starting:opacity-0 transition-[background-color,scale,opacity] duration-180 ease-out motion-reduce:transition-none",
);

/** Matches the 28px visual disc of the rail usage ring and bottom-left avatar. */
export const RAIL_UPDATE_DISC_CLASS_NAME =
  "relative grid size-7 place-items-center rounded-full bg-[var(--sidebar-accent)]/85";

const RING_RADIUS = 12.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Spinning when the work has no measurable progress, otherwise filled to `percent`. */
export function RailProgressRing({
  spinning = false,
  percent = 0,
  children,
}: {
  readonly spinning?: boolean;
  readonly percent?: number;
  readonly children: ReactNode;
}) {
  return (
    <span className="relative grid size-7 place-items-center rounded-full bg-[var(--sidebar-accent)]/75">
      <svg
        aria-hidden="true"
        data-rail-progress-ring
        className={cn(
          "pointer-events-none absolute inset-0 size-full",
          spinning
            ? "animate-spin will-change-transform [animation-duration:1.4s] motion-reduce:animate-none"
            : "-rotate-90",
        )}
        viewBox="0 0 28 28"
      >
        <circle
          cx="14"
          cy="14"
          r={RING_RADIUS}
          fill="none"
          className="stroke-current/15"
          strokeWidth="2.25"
        />
        <circle
          cx="14"
          cy="14"
          r={RING_RADIUS}
          fill="none"
          stroke="var(--color-text-accent, var(--primary, currentColor))"
          strokeLinecap="round"
          strokeWidth="2.25"
          {...(spinning
            ? { strokeDasharray: `${RING_CIRCUMFERENCE * 0.28} ${RING_CIRCUMFERENCE}` }
            : {
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - percent / 100),
              })}
          className={
            spinning
              ? undefined
              : "transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
          }
        />
      </svg>
      {children}
    </span>
  );
}
