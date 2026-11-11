// FILE: KanbanOverview.tsx
// Purpose: Top kanban layer — one column per project (In Progress → Draft → Done cards);
//          clicking a project drills into its full board. Cards follow the attention-first
//          flatten order; the needs-review filter lives in the page header.
// Layer: UI component (read-only; drag & drop lives in the project board)
// Exports: KanbanOverview

import type { ProjectId } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { ChevronRightIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
} from "../../sidebarRowStyles";
import { KanbanCardView, type KanbanCardPrLookup } from "./KanbanCardView";
import {
  overviewColumnWeight,
  overviewVisibleKanbanCards,
  type KanbanBoard,
  type KanbanCard,
  type KanbanProjectBoard,
} from "./kanban.logic";

const OverviewProjectColumn = function OverviewProjectColumn({
  projectBoard,
  onOpenProject,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  prByThreadId,
  nowMs,
}: {
  projectBoard: KanbanProjectBoard;
  onOpenProject: (projectId: ProjectId) => void;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: (projectId: ProjectId) => void;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
}) {
  const { visibleCards, hiddenCount } = overviewVisibleKanbanCards(projectBoard, true);

  return (
    // A project's share of the width follows how many cards it shows (up to four card
    // widths), so a busy project spreads its cards across the page instead of one long
    // strip beside a mostly empty window. Never narrower than one card.
    <section
      className="flex min-w-72 flex-col"
      style={{ flex: `${overviewColumnWeight(visibleCards.length)} 1 18rem` }}
    >
      <div className="flex shrink-0 items-center gap-ui-gap-xs">
        <button
          type="button"
          onClick={() => onOpenProject(projectBoard.projectId)}
          className={cn(
            "group/kanban-project",
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            "flex-1",
          )}
        >
          <h2 className="min-w-0 truncate text-ui font-medium text-foreground">
            {projectBoard.projectName}
          </h2>
          <span className="text-ui-xs text-muted-foreground tabular-nums">
            {projectBoard.totalCount}
          </span>
          <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover/kanban-project:opacity-100 group-focus-visible/kanban-project:opacity-100" />
        </button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          aria-label={`New task in ${projectBoard.projectName}`}
          title={`New task in ${projectBoard.projectName}`}
          onClick={() => onNewTask(projectBoard.projectId)}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <ul className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-ui-gap-xs overflow-y-auto p-1">
        {visibleCards.map((card) => (
          <li key={card.cardId} className="list-none">
            <KanbanCardView
              card={card}
              onOpen={onOpenCard}
              prByThreadId={prByThreadId}
              {...(onCardContextMenu ? { onContextMenu: onCardContextMenu } : {})}
              {...(nowMs !== undefined ? { nowMs } : {})}
            />
          </li>
        ))}
        {hiddenCount > 0 ? (
          <li className="col-span-full list-none">
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => onOpenProject(projectBoard.projectId)}
            >
              Show {hiddenCount} more
            </Button>
          </li>
        ) : null}
      </ul>
    </section>
  );
};

export function KanbanOverview({
  board,
  onOpenProject,
  onOpenCard,
  onCardContextMenu,
  onNewTask,
  prByThreadId,
  nowMs,
}: {
  board: KanbanBoard;
  onOpenProject: (projectId: ProjectId) => void;
  onOpenCard: (card: KanbanCard) => void;
  onCardContextMenu?: ((card: KanbanCard, event: React.MouseEvent) => void) | undefined;
  onNewTask: (projectId: ProjectId) => void;
  prByThreadId: KanbanCardPrLookup;
  nowMs?: number;
}) {
  // Projects without any cards are pure noise on the overview; their boards stay
  // reachable through /kanban/$projectId if linked directly.
  const visibleProjects = board.projects.filter((projectBoard) => projectBoard.totalCount > 0);

  if (visibleProjects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <div className="text-ui-lg font-medium text-foreground">Nothing on the board yet</div>
          <div className="mt-1 text-ui text-muted-foreground">
            Drafted prompts, running turns, and completed chats will show up here automatically.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-ui-gap-md overflow-x-auto px-ui-pad-lg pb-ui-pad-lg">
        {visibleProjects.map((projectBoard) => (
          <OverviewProjectColumn
            key={projectBoard.projectId}
            projectBoard={projectBoard}
            onOpenProject={onOpenProject}
            onOpenCard={onOpenCard}
            onCardContextMenu={onCardContextMenu}
            onNewTask={onNewTask}
            prByThreadId={prByThreadId}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
        ))}
      </div>
    </div>
  );
}
