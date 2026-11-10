// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { CSSProperties } from "react";
import { ArrowDown } from "./icons";
import { cn } from "~/lib/utils";
import { useMossbotCopy } from "../mossbot.copy";

export function JumpToLatestButton({
  onClick,
  className,
  style,
}: {
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useMossbotCopy();
  return (
    <button
      onClick={onClick}
      type="button"
      aria-label={t("Jump to latest")}
      title={t("Jump to latest")}
      className={cn(
        "absolute left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border/40 bg-muted text-foreground shadow-lg hover:bg-primary",
        className,
      )}
      style={style}
    >
      <ArrowDown size={18} aria-hidden="true" />
    </button>
  );
}
