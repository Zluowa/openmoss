// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { CSSProperties } from "react";
import { ArrowUp, Clock } from "./icons";
import { cn } from "~/lib/utils";
export function ComposerSendButton({
  compact,
  waits,
  label,
  title,
  look,
  disabled,
  onSend,
}: {
  compact: boolean;
  waits: boolean;
  label: string;
  title: string;
  look: { className: string; style?: CSSProperties };
  disabled: boolean;
  onSend: (alternate: boolean) => void;
}) {
  return (
    <button
      onClick={(event) => onSend(event.metaKey || event.ctrlKey)}
      disabled={disabled}
      aria-label={label}
      title={title}
      style={waits ? undefined : look.style}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full disabled:cursor-default",
        compact ? "size-9" : "size-8",
        waits ? "bg-muted text-muted-foreground hover:bg-accent" : look.className,
      )}
    >
      {waits ? (
        <Clock size={compact ? 14 : 15} />
      ) : (
        <ArrowUp size={16} strokeWidth={1.75} absoluteStrokeWidth />
      )}
    </button>
  );
}
