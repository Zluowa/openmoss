// FILE: KanbanFilterMenu.tsx
// Purpose: The board's one filter control in the Tasks page header: a ghost filter button
//          opening a menu with the "Needs review" toggle. It reads and writes the persisted
//          `kanbanNeedsReviewFilter` store flag, so the overview and the project board share it.
// Layer: Kanban UI component (store-aware)
// Exports: KanbanFilterMenu

import { FilterIcon } from "~/lib/icons";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuTrigger } from "../ui/menu";

export function KanbanFilterMenu() {
  const needsReviewEnabled = useKanbanUiStore((state) => state.kanbanNeedsReviewFilter);
  const setNeedsReviewEnabled = useKanbanUiStore((state) => state.setKanbanNeedsReviewFilter);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Filter"
            title="Filter"
            data-active={needsReviewEnabled || undefined}
            className="relative text-muted-foreground hover:text-foreground data-active:text-foreground"
          />
        }
      >
        <FilterIcon />
        {needsReviewEnabled ? (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-text-accent)]"
          />
        ) : null}
      </MenuTrigger>
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
