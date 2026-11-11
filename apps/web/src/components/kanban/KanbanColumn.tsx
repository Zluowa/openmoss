// FILE: KanbanColumn.tsx
// Purpose: One kanban column — droppable body, sortable draft cards.
// Layer: UI component (project-board building block)
// Exports: KanbanColumn, kanbanColumnDropId, parseKanbanColumnDropId

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectId } from "@moss/contracts";
import { memo, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_HEIGHT_CLASS_NAME } from "../../sidebarRowStyles";
import { KanbanCardView, type KanbanCardPrLookup } from "./KanbanCardView";
import { KanbanStatusIcon } from "./KanbanStatusIcon";
import { KANBAN_COLUMN_V2_LABELS } from "@moss/shared/kanban";
import { resolveDraftDropAction, type KanbanCard, type KanbanColumnKey } from "./kanban.logic";

const COLUMN_DROP_ID_PREFIX = "kanban-column";
const DONE_RENDER_CAP = 30;
// Done columns grow unbounded; cap the initial render so opening the board
// stays cheap for long-lived projects.

export function kanbanColumnDropId(projectId: ProjectId, column: KanbanColumnKey): string {
  return `${COLUMN_DROP_ID_PREFIX}|${column}|${projectId}`;
}

export function parseKanbanColumnDropId(
  dropId: string,
): { projectId: string; column: KanbanColumnKey } | null {
  const [prefix, column, ...projectIdParts] = dropId.split("|");
  if (prefix !== COLUMN_DROP_ID_PREFIX || projectIdParts.length === 0) {
    return null;
  }
  if (
    column !== "draft" &&
    column !== "inProgress" &&
    column !== "awaitingYou" &&
    column !== "done"
  ) {
    return null;
  }
  return { projectId: projectIdParts.join("|"), column };
}

function SortableKanbanCard({
  card,
  onOpen,
  onContextMenu,
  onKeyDown,
  prByThreadId,
  nowMs,
}: {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
  onContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onKeyDown?: ((card: KanbanCard, event: React.KeyboardEvent) => void) | undefined;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.cardId,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("list-none", isDragging && "z-20")}
      {...attributes}
      {...listeners}
    >
      <KanbanCardView
        card={card}
        onOpen={onOpen}
        {...(onContextMenu ? { onContextMenu } : {})}
        {...(onKeyDown ? { onKeyDown } : {})}
        prByThreadId={prByThreadId}
        isDragSource={isDragging}
        {...(nowMs !== undefined ? { nowMs } : {})}
      />
    </li>
  );
}

function KanbanColumnComponent({
  projectId,
  columnKey,
  cards,
  onOpenCard,
  onCardContextMenu,
  onCardKeyDown,
  sortable: sortableProp,
  droppable: droppableProp,
  activeCard: activeCardProp,
  onNewCard,
  prByThreadId,
  nowMs,
  capDone = true,
}: {
  projectId: ProjectId;
  columnKey: KanbanColumnKey;
  cards: readonly KanbanCard[];
  onOpenCard: (card: KanbanCard) => void;
  /** Right-click handler forwarded to each card's context menu. */
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  /** Keyboard handler forwarded to each card (board: Alt+Arrow draft reorder). */
  onCardKeyDown?: ((card: KanbanCard, event: React.KeyboardEvent) => void) | undefined;
  /** Draft column in the project board: cards reorder via dnd-kit sortable. */
  sortable?: boolean;
  /** Project board only — the column body registers as a drop target. */
  droppable?: boolean;
  /** Card currently being dragged, for drop-target affordances. */
  activeCard?: KanbanCard | null;
  /** Renders a + button in the column header (Draft column's new-task entry point). */
  onNewCard?: (() => void) | undefined;
  prByThreadId: KanbanCardPrLookup;
  /** Shared board clock for live elapsed labels. */
  nowMs?: number;
  /** The review board owns its fold; other boards keep the local Done cap. */
  capDone?: boolean;
}) {
  const sortable = sortableProp ?? false;
  const droppable = droppableProp ?? false;
  const activeCard = activeCardProp ?? null;
  const dropId = kanbanColumnDropId(projectId, columnKey);
  const { isOver, setNodeRef } = useDroppable({ id: dropId, disabled: !droppable });

  const sortableItems = useMemo(() => cards.map((card) => card.cardId), [cards]);
  const [showAll, setShowAll] = useState(false);

  const cappedCards =
    columnKey === "done" && capDone && !showAll && cards.length > DONE_RENDER_CAP
      ? cards.slice(0, DONE_RENDER_CAP)
      : cards;
  const hiddenCount = cards.length - cappedCards.length;

  const dispatchTarget =
    columnKey === "inProgress" &&
    activeCard !== null &&
    resolveDraftDropAction(activeCard) === "dispatch";

  const cardElements = cappedCards.map((card) =>
    sortable ? (
      <SortableKanbanCard
        key={card.cardId}
        card={card}
        onOpen={onOpenCard}
        onContextMenu={onCardContextMenu}
        onKeyDown={onCardKeyDown}
        prByThreadId={prByThreadId}
        {...(nowMs !== undefined ? { nowMs } : {})}
      />
    ) : (
      <li key={card.cardId} className="list-none">
        <KanbanCardView
          card={card}
          onOpen={onOpenCard}
          {...(onCardContextMenu ? { onContextMenu: onCardContextMenu } : {})}
          {...(onCardKeyDown ? { onKeyDown: onCardKeyDown } : {})}
          prByThreadId={prByThreadId}
          {...(nowMs !== undefined ? { nowMs } : {})}
        />
      </li>
    ),
  );

  return (
    <section className="flex min-h-0 w-full min-w-0 flex-col @min-[52rem]/kanban-project:min-w-64 @min-[52rem]/kanban-project:flex-1">
      <header
        className={cn(
          "flex shrink-0 items-center gap-ui-gap-xs px-ui-pad-sm",
          SIDEBAR_ROW_HEIGHT_CLASS_NAME,
        )}
      >
        <h3 className="text-ui font-medium text-foreground">
          {KANBAN_COLUMN_V2_LABELS[columnKey]}
        </h3>
        <span className="text-ui-xs text-muted-foreground tabular-nums">{cards.length}</span>
        <span className="ml-auto flex shrink-0 items-center gap-ui-gap-xs">
          {dispatchTarget ? (
            <span className="text-ui-xs text-info-foreground">Drop to send</span>
          ) : null}
          {onNewCard ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              aria-label="New task"
              title="New task"
              onClick={onNewCard}
            >
              <PlusIcon className="size-4" />
            </Button>
          ) : null}
          <KanbanStatusIcon column={columnKey} />
        </span>
      </header>
      <ul
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-ui-gap-xs overflow-y-auto rounded-panel p-1 transition-colors",
          dispatchTarget && "bg-info/5 ring-1 ring-info/30",
          dispatchTarget && isOver && "bg-info/10 ring-info/60",
        )}
      >
        {sortable ? (
          <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
            {cardElements}
          </SortableContext>
        ) : (
          cardElements
        )}
        {cards.length === 0 ? (
          <li className="list-none rounded-card border border-dashed border-border p-ui-pad-lg text-center text-ui-sm text-muted-foreground">
            No cards
          </li>
        ) : null}
        {hiddenCount > 0 ? (
          <li className="list-none">
            <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowAll(true)}>
              Show {hiddenCount} more
            </Button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

export const KanbanColumn = memo(KanbanColumnComponent);
