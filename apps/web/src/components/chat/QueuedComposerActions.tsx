// FILE: QueuedComposerActions.tsx
// Purpose: Inline action cluster (Steer / Delete / Menu) rendered on each queued
// composer row. Used in both the compact and expanded composer layouts so the
// action chrome stays in lockstep across surfaces.
// Layer: Chat composer UI primitive
// Exports: QueuedComposerActions

import { EllipsisIcon, SteerIcon, Trash2 } from "~/lib/icons";

import type { QueuedComposerTurn } from "../../composerDraftStore";

import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

type QueuedComposerActionsProps = {
  queuedTurn: QueuedComposerTurn;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  /** The live turn is a manual compaction, so Steer stops it and sends this next. */
  steerSkipsCompaction?: boolean;
};

function QueuedComposerActions({
  queuedTurn,
  onSteer,
  onRemove,
  onEdit,
  steerSkipsCompaction = false,
}: QueuedComposerActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0">
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="chip" onClick={() => void onSteer(queuedTurn)} />}
        >
          <SteerIcon className="size-4" />
          <span>Steer</span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-80 leading-tight">
          {steerSkipsCompaction
            ? "Skip compaction and send this message."
            : "Send this follow-up now to redirect the current work. If native steering is unavailable, stop the current turn and start a new one."}
        </TooltipPopup>
      </Tooltip>
      <IconButton
        variant="ghost"
        size="icon-chip"
        label="Delete queued follow-up"
        onClick={() => onRemove(queuedTurn.id)}
      >
        <Trash2 className="size-4" />
      </IconButton>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-chip"
              aria-label="Queued follow-up actions"
              className="[&_svg,&_[data-slot=central-icon]]:mx-0"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="top" sideOffset={6}>
          <MenuItem onClick={() => onEdit(queuedTurn)}>Edit queued follow-up</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

export { QueuedComposerActions };
