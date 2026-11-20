// FILE: ReviewChangesButton.tsx
// Purpose: Compact outlined "View changes" action button for the per-turn changed-files card.
// Layer: Chat changed-files UI
// Exports: ReviewChangesButton

import type { CSSProperties } from "react";

import { useTranslation } from "../../localization";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface ReviewChangesButtonProps {
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export const ReviewChangesButton = function ReviewChangesButton({
  onClick,
  className,
  style,
  label: labelProp,
}: ReviewChangesButtonProps) {
  const { t } = useTranslation();
  const label = labelProp ?? t("codex.unifiedDiff.viewChanges");
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn("px-2.5 font-normal text-foreground/90 hover:text-foreground", className)}
      style={style}
      onClick={onClick}
    >
      {label}
    </Button>
  );
};
