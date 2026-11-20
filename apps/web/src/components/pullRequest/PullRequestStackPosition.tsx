// FILE: PullRequestStackPosition.tsx
// Purpose: Shared compact stack-position indicator for pull request list and detail surfaces.
// Layer: Pull request presentation
// Exports: PullRequestStackPosition

import type { PullRequestStackSummary } from "@moss/contracts";

import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { GitForkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

type StackPosition = Pick<PullRequestStackSummary, "number" | "size" | "position" | "baseBranch">;

function StackPositionContents({ stack }: { stack: StackPosition }) {
  return (
    <>
      <GitForkIcon className="size-3" aria-hidden />
      <span className="tabular-nums">
        {stack.position}/{stack.size}
      </span>
    </>
  );
}

export function PullRequestStackPosition({
  stack,
  appearance = "badge",
  className,
}: {
  stack: StackPosition;
  appearance?: "badge" | "plain";
  className?: string;
}) {
  const { format } = useTranslation();
  if (appearance === "plain") {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)} aria-hidden="true">
        <StackPositionContents stack={stack} />
      </span>
    );
  }

  const label = format("codeReview.stack.positionAria", {
    stack: stack.number,
    position: stack.position,
    size: stack.size,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            size="sm"
            aria-label={label}
            className={cn("gap-1 font-normal text-muted-foreground", className)}
          >
            <StackPositionContents stack={stack} />
          </Badge>
        }
      />
      <TooltipPopup side="top">
        {format("codeReview.stack.positionTooltip", {
          stack: stack.number,
          position: stack.position,
          size: stack.size,
          base: stack.baseBranch,
        })}
      </TooltipPopup>
    </Tooltip>
  );
}
