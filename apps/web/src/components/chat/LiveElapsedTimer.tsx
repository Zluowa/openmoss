// FILE: LiveElapsedTimer.tsx
// Purpose: Counts up from a start time once a second ("12s", "1m 4s") by
//          writing the text node directly. Keeping the live clock in this tiny
//          leaf means active turns never re-render the transcript every second.
// Layer: Web chat presentation component
// Exports: LiveElapsedTimer

import { useEffect, useRef } from "react";

import { useTranslation } from "../../localization";
import { formatClockDuration } from "../../session-logic";
import { startVisibleInterval } from "../../lib/visibleInterval";
import { computeActiveWorkedDurationMs, type WorkedPauseInterval } from "./workedForPresentation";

function formatElapsedAt(
  startIso: string,
  endIso: string,
  locale: string,
  pausedIntervals?: ReadonlyArray<WorkedPauseInterval> | null,
): string {
  const activeMs = computeActiveWorkedDurationMs(startIso, endIso, pausedIntervals);
  return activeMs === null ? "0s" : formatClockDuration(activeMs, locale);
}

export function LiveElapsedTimer({
  startedAt,
  paused = false,
  pausedAt = null,
  pausedIntervals,
}: {
  startedAt: string;
  paused?: boolean;
  pausedAt?: string | null;
  pausedIntervals?: ReadonlyArray<WorkedPauseInterval> | null;
}) {
  const { locale } = useTranslation();
  const textRef = useRef<HTMLSpanElement>(null);
  const initialEndIso = paused && pausedAt ? pausedAt : new Date().toISOString();
  const initialText = formatElapsedAt(startedAt, initialEndIso, locale, pausedIntervals);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        const endIso = paused && pausedAt ? pausedAt : new Date().toISOString();
        textRef.current.textContent = formatElapsedAt(startedAt, endIso, locale, pausedIntervals);
      }
    };
    updateText();
    if (paused) {
      return undefined;
    }
    return startVisibleInterval(updateText, 1000);
  }, [locale, paused, pausedAt, pausedIntervals, startedAt]);

  return <span ref={textRef}>{initialText}</span>;
}
