// FILE: KanbanFilterMenu.tsx
// Purpose: The board's one filter control in the Tasks page header: a ghost filter button
//          opening a menu with the "Needs review" toggle. It reads and writes the persisted
//          `kanbanNeedsReviewFilter` store flag, so the overview and the project board share it.
// Layer: Kanban UI component (store-aware)
// Exports: KanbanFilterMenu

import { FilterIcon } from "~/lib/icons";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { IconButton } from "../ui/icon-button";
import { StatusDot } from "../ui/status-chip";
import { Menu, MenuCheckboxItem, MenuTrigger } from "../ui/menu";

export function KanbanFilterMenu() {
  const needsReviewEnabled = useKanbanUiStore((state) => state.kanbanNeedsReviewFilter);
  const setNeedsReviewEnabled = useKanbanUiStore((state) => state.setKanbanNeedsReviewFilter);
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-sm"
            label="Filter"
            tooltip="Filter"
            data-active={needsReviewEnabled || undefined}
            className="relative text-muted-foreground hover:text-foreground data-active:text-foreground"
          >
            <FilterIcon />
            {needsReviewEnabled ? (
              <StatusDot
                aria-hidden
                className="absolute top-1 right-1 bg-[var(--color-text-accent)]"
              />
            ) : null}
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end">
        <MenuCheckboxItem
          checked={needsReviewEnabled}
          onCheckedChange={(checked) => setNeedsReviewEnabled(checked === true)}
        >
          Needs review
        </MenuCheckboxItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
