import { useRef } from "react";

import { useTimelineSynchronizedAnimations } from "~/lib/animationTimelineSync";
import { Loader2Icon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

type SpinnerProps = React.ComponentProps<typeof Loader2Icon> & {
  /**
   * The spinner sits inside a control that already says what it is doing (a busy button's
   * label). It is then hidden from the accessibility tree, so "Loading" never joins that name.
   */
  decorative?: boolean;
};

function Spinner({ className, decorative = false, ...props }: SpinnerProps) {
  // The icon wrapper hides a glyph only when its label is empty, and drops `aria-hidden`.
  const accessibility = decorative
    ? { "aria-label": "" }
    : { "aria-label": "Loading", role: "status" };
  return <Loader2Icon className={cn("animate-spin", className)} {...accessibility} {...props} />;
}

// Status glyph for live work that can stay on screen for minutes (running tasks,
// subagents, workflow runs). A continuous `animate-spin` repaints on every display
// frame, 180 times a second on a 180 Hz monitor, and these glyphs sit under the
// composer's backdrop blur. The stepped token and timeline sync match the sidebar
// spinners (see ThreadRunningSpinner), so all live glyphs redraw in the same frames.
function LiveStatusSpinner({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement | null>(null);
  useTimelineSynchronizedAnimations(ref);
  return (
    <LoaderIcon
      ref={ref}
      aria-hidden
      className={cn("animate-spin-stepped motion-reduce:animate-none", className)}
    />
  );
}

export { LiveStatusSpinner, Spinner };
