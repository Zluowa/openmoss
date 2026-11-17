// FILE: PrStateChip.tsx
// Purpose: Compact PR markers in the state's color: the chip (state icon + #number, hover title)
//          shared by the kanban card meta row and the sidebar Activity rows, and the count chip
//          (state icon + number of PRs) that lists a chat's several PRs (upstream #2195).
// Layer: UI component (pure)
// Exports: PrStateChip, PrStateCountChip

import type { OrchestrationThreadPullRequest } from "@moss/contracts";
import type { KeyboardEvent, MouseEvent, SyntheticEvent } from "react";

import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";
import { PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";

export function PrStateChip({
  pr,
  className,
  onOpen,
}: {
  pr: OrchestrationThreadPullRequest;
  className?: string;
  onOpen?:
    | ((
        event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
        pr: OrchestrationThreadPullRequest,
      ) => void)
    | undefined;
}) {
  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  return (
    <span
      title={`#${pr.number} ${presentation.label}: ${pr.title}`}
      {...(onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: (event: MouseEvent<HTMLElement>) => onOpen(event, pr),
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(event, pr);
              }
            },
          }
        : {})}
      className={cn(
        // The PR type scale, not a pixel: this chip is the same fine print as every other PR
        // surface, so it tracks the user's font-size setting with them.
        PR_FINE_TEXT_CLASS_NAME,
        "flex shrink-0 items-center gap-0.5",
        presentation.colorClass,
        className,
      )}
    >
      <PrIcon className="size-3 shrink-0" aria-hidden />#{pr.number}
    </span>
  );
}

// The count chip and its menu sit inside a row that opens its chat on press and renames on
// double-click; none of their gestures may reach the row (the portaled menu is still inside the
// row in React's tree).
const stopRowGesture = (event: SyntheticEvent) => event.stopPropagation();

/**
 * A chat's several PRs as one chip: the first PR's state icon and color, then how many there
 * are. It opens a menu listing each PR (state icon, #number, title), so no press opens one at
 * random. A span, like the single chip, because hosts render it inside their row button.
 */
export function PrStateCountChip({
  pullRequests,
  className,
  onOpen,
}: {
  /** The first decides the icon and color. */
  pullRequests: readonly [OrchestrationThreadPullRequest, ...OrchestrationThreadPullRequest[]];
  className?: string;
  onOpen: (event: MouseEvent<HTMLElement>, pr: OrchestrationThreadPullRequest) => void;
}) {
  const presentation = resolvePrStatePresentation(pullRequests[0]);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  const label = `${pullRequests.length} pull requests`;
  return (
    <Menu>
      <MenuTrigger
        nativeButton={false}
        render={
          <span
            role="button"
            tabIndex={0}
            title={label}
            aria-label={label}
            data-slot="pull-request-count-chip"
            onClick={stopRowGesture}
            onDoubleClick={stopRowGesture}
            onPointerUp={stopRowGesture}
            onKeyDown={stopRowGesture}
            className={cn(
              PR_FINE_TEXT_CLASS_NAME,
              "flex shrink-0 cursor-pointer items-center gap-0.5 rounded-inline hover:underline",
              "outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
              presentation.colorClass,
              className,
            )}
          />
        }
      >
        <PrIcon className="size-3 shrink-0" aria-hidden />
        {pullRequests.length}
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="end"
        side="bottom"
        className="max-w-80 min-w-56"
        onClick={stopRowGesture}
        onDoubleClick={stopRowGesture}
        onPointerUp={stopRowGesture}
        onContextMenu={stopRowGesture}
      >
        {pullRequests.map((pr) => {
          const itemPresentation = resolvePrStatePresentation(pr);
          const ItemIcon = PR_STATE_PRESENTATION_ICONS[itemPresentation.iconKind];
          return (
            <MenuItem
              key={pr.url}
              className="min-h-7 gap-2 py-1 leading-snug sm:text-ui"
              title={`#${pr.number} ${itemPresentation.label}: ${pr.title}`}
              onClick={(event) => onOpen(event, pr)}
            >
              <ItemIcon
                className={cn("size-3.5 shrink-0", itemPresentation.colorClass)}
                aria-hidden
              />
              <span className="min-w-0 truncate">{`#${pr.number} ${pr.title}`}</span>
            </MenuItem>
          );
        })}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
