// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { IconButton } from "~/components/ui/icon-button";
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
    <IconButton
      variant="glass"
      size="icon-lg"
      shape="capsule"
      label={t("Jump to latest")}
      tooltip={t("Jump to latest")}
      className={cn("absolute left-1/2 z-10 -translate-x-1/2", className)}
      {...(style ? { style } : {})}
      onClick={() => {
        onClick();
      }}
    >
      <ArrowDown size={18} aria-hidden="true" />
    </IconButton>
  );
}
