// FILE: LiveElapsedTimer.tsx
// Purpose: Counts up from a start time once a second ("12s", "1m 4s") by
//          writing the text node directly. Keeping the live clock in this tiny
//          leaf means active turns never re-render the transcript every second.
// Layer: Web chat presentation component
// Exports: LiveElapsedTimer

import { useEffect, useRef } from "react";

import { useTranslation } from "../../localization";
import { formatClockElapsed } from "../../session-logic";
import { startVisibleInterval } from "../../lib/visibleInterval";

function formatElapsedNow(startIso: string, locale: string): string {
  return formatClockElapsed(startIso, new Date().toISOString(), locale) ?? "0s";
}

export function LiveElapsedTimer({ startedAt }: { startedAt: string }) {
  const { locale } = useTranslation();
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatElapsedNow(startedAt, locale);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsedNow(startedAt, locale);
      }
    };
    updateText();
    return startVisibleInterval(updateText, 1000);
  }, [locale, startedAt]);

  return <span ref={textRef}>{initialText}</span>;
}
