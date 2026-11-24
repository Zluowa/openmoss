// FILE: RunArchiveButton.tsx
// Purpose: Archive / Unarchive on a previous run. When the run worked in a worktree, the Moss
//          tooltip says before the click that archiving keeps what the run made on disk.
// Layer: Automations UI component
// Exports: RunArchiveButton

import { HitArea } from "~/components/ui/hit-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function RunArchiveButton({
  archived,
  keepsGeneratedWork,
  onArchive,
}: {
  readonly archived: boolean;
  /** The run made worktrees or branches, which archiving does not remove. */
  readonly keepsGeneratedWork: boolean;
  readonly onArchive: (archived: boolean) => void;
}) {
  const button = (
    <HitArea
      onClick={(event) => {
        event.stopPropagation();
        onArchive(!archived);
      }}
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      {archived ? "Unarchive" : "Archive"}
    </HitArea>
  );
  if (!keepsGeneratedWork) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">
        Archiving does not remove generated worktrees or branches.
      </TooltipPopup>
    </Tooltip>
  );
}
