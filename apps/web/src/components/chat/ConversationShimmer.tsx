// Codex 26.901.51231 ShimmerText: a one-second masked sweep after 600ms,
// repeated every four seconds. Animate the overlay, keeping the text stationary.
import { useEffect, useRef, type ComponentProps } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

const FIRST_SWEEP_DELAY_MS = 600;
const SWEEP_DURATION_MS = 1_000;
const SWEEP_INTERVAL_MS = 4_000;
const ACTIVE_CLASS = "codex-text-shimmer-active";

export function ConversationShimmer({
  active = true,
  children,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    const element = ref.current;
    if (!active || reducedMotion || !element) return;

    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let repeatTimer: ReturnType<typeof setInterval> | undefined;
    const sweep = () => {
      element.classList.add(ACTIVE_CLASS);
      endTimer = setTimeout(() => element.classList.remove(ACTIVE_CLASS), SWEEP_DURATION_MS);
    };
    const startTimer = setTimeout(() => {
      sweep();
      repeatTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    }, FIRST_SWEEP_DELAY_MS);

    return () => {
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      clearInterval(repeatTimer);
      element.classList.remove(ACTIVE_CLASS);
    };
  }, [active, reducedMotion]);

  return (
    <span
      {...props}
      ref={ref}
      className={cn(active && "codex-text-shimmer", className) || undefined}
      data-conversation-shimmer={active ? "true" : undefined}
    >
      {children}
      {active && (
        <span
          aria-hidden="true"
          inert
          data-thread-find-skip="true"
          data-translation-skip="true"
          className="codex-text-shimmer-sweep"
        >
          <span className="codex-text-shimmer-highlight">{children}</span>
        </span>
      )}
    </span>
  );
}
