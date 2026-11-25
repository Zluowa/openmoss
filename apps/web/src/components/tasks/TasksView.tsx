// FILE: TasksView.tsx
// Purpose: The Tasks route — one calm list of everything to do, any of which can be handed to
//          an agent. Open to-dos come first (what needs the user, then what's working, then
//          the rest), a line at the end adds a new one, and finished ones fade out below.
//          Selecting a to-do opens its card, floating beside the list.
// Layer: Tasks route surface
// Exports: TasksView (default)

import type { ThreadId } from "@moss/contracts";
import { formatModelDisplayName } from "@moss/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { HitArea } from "~/components/ui/hit-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMs } from "~/hooks/useNowMs";
import {
  resolveThreadPullRequestFallback,
  type ThreadPullRequest,
  useThreadPullRequests,
} from "~/hooks/useThreadPullRequests";
import { TerminalIcon } from "~/lib/icons";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
} from "../../sidebarRowStyles";
import { useStore } from "../../store";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import { KANBAN_STATUS_TONE, resolveKanbanCardStatus } from "../kanban/KanbanCardView";
import { KanbanNewTaskDialog } from "../kanban/KanbanNewTaskDialog";
import type { KanbanCard, KanbanProjectBoard } from "../kanban/kanban.logic";
import { useKanbanBoard } from "../kanban/useKanbanBoard";
import { useKanbanCardContextMenu } from "../kanban/useKanbanCardContextMenu";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface } from "../RouteSurface";
import { TASK_META_TONE_CLASS } from "./TaskCardPrimitives";
import { TaskCardSurface, useTaskSelection } from "./TaskCardSurface";
import { TaskStatusGlyph } from "./TaskGlyphs";
import { TaskListItem } from "./TaskListItem";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TasksPageHeader } from "./TasksPageHeader";
import { buildTaskSections, type TaskRowModel } from "./tasks.logic";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

/** The list's one centred column; the page header row lines up with it. */
const TASKS_LIST_COLUMN_CLASS_NAME = "mx-auto w-full max-w-[40rem] px-ui-pad-xl";

/** Finished to-dos shown before "Show all". */
const DONE_PREVIEW_COUNT = 2;

const OPEN_COLUMN_RANK: Record<KanbanCard["column"], number> = {
  awaitingYou: 0,
  inProgress: 1,
  draft: 2,
  done: 3,
};

function compareOpenBoardCards(left: KanbanCard, right: KanbanCard): number {
  const rankDiff = OPEN_COLUMN_RANK[left.column] - OPEN_COLUMN_RANK[right.column];
  if (rankDiff !== 0) return rankDiff;
  return right.sortTimestamp - left.sortTimestamp;
}

function collectBoardTaskLists(
  projects: readonly KanbanProjectBoard[],
  todoThreadIds: ReadonlySet<ThreadId>,
) {
  const openCards: KanbanCard[] = [];
  const doneCards: KanbanCard[] = [];
  for (const project of projects) {
    for (const card of [...project.awaitingYou, ...project.inProgress, ...project.draft]) {
      if (!todoThreadIds.has(card.threadId)) {
        openCards.push(card);
      }
    }
    for (const card of project.done) {
      if (!todoThreadIds.has(card.threadId)) {
        doneCards.push(card);
      }
    }
  }
  openCards.sort(compareOpenBoardCards);
  doneCards.sort((left, right) => right.sortTimestamp - left.sortTimestamp);
  return { openCards, doneCards };
}

function resolveBoardCardPr(
  card: KanbanCard,
  prByThreadId: ReadonlyMap<ThreadId, ThreadPullRequest | null>,
) {
  if (!card.thread) return null;
  if (prByThreadId.has(card.threadId)) {
    return prByThreadId.get(card.threadId) ?? null;
  }
  return resolveThreadPullRequestFallback({
    branch: card.thread.branch,
    hasDedicatedWorktree: card.thread.worktreePath !== null,
    lastKnownPr: card.thread.lastKnownPr ?? null,
    pullRequests: card.thread.pullRequests,
  });
}

function BoardTaskListItem({
  card,
  pr,
  onOpen,
  onContextMenu,
}: {
  card: KanbanCard;
  pr: ReturnType<typeof resolveBoardCardPr>;
  onOpen: (card: KanbanCard) => void;
  onContextMenu: (card: KanbanCard, event: MouseEvent<HTMLElement>) => void;
}) {
  const status = resolveKanbanCardStatus(card, pr);
  const isDone = card.column === "done";
  const agent = !isDone ? (card.thread?.modelSelection ?? null) : null;

  return (
    <div
      role="listitem"
      onClick={() => onOpen(card)}
      onContextMenu={(event) => onContextMenu(card, event)}
      className={cn(
        "flex cursor-default items-center gap-ui-gap-xs px-ui-pad-sm transition-colors",
        SIDEBAR_ROW_HEIGHT_CLASS_NAME,
        SIDEBAR_ROW_RADIUS_CLASS_NAME,
        SIDEBAR_ROW_HOVER_CLASS_NAME,
      )}
    >
      <span className="flex shrink-0">
        {card.isTerminal ? (
          <TerminalIcon className="size-4 text-muted-foreground/70" aria-hidden />
        ) : (
          <TaskStatusGlyph kind={status.kind} className="size-4" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 items-baseline gap-ui-gap-xs py-ui-pad-xs">
        <HitArea
          onClick={(event) => {
            event.stopPropagation();
            onOpen(card);
          }}
          className={cn(
            "min-w-0 truncate text-left text-ui outline-none",
            isDone ? "text-muted-foreground" : "text-foreground",
          )}
        >
          <span data-translation-skip="true">{card.title}</span>
        </HitArea>
        <span
          className={cn(
            "max-w-56 shrink-0 truncate text-ui-sm",
            TASK_META_TONE_CLASS[KANBAN_STATUS_TONE[status.kind] ?? "muted"],
            status.kind === "running" && "shimmer",
          )}
        >
          {status.label}
        </span>
      </div>

      {agent ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={formatModelDisplayName(agent.model) ?? agent.model}
                className="flex shrink-0"
              />
            }
          >
            <ProviderIcon provider={agent.provider} className="size-4 opacity-80" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {formatModelDisplayName(agent.model) ?? agent.model}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export default function TasksView() {
  const navigate = useNavigate();
  // The connected server may not offer Tasks (an older server): back to Kanban.
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  useEffect(() => {
    if (!tasksSurfaceEnabled) void navigate({ to: "/kanban", replace: true });
  }, [navigate, tasksSurfaceEnabled]);
  const { todos, isLoading, isError, refetch } = useTodoList();
  const mutations = useTodoMutations();
  // Ticks relative times, and lets a just-linked chat settle from Starting to missing.
  const nowMs = useNowMs(true, 15_000);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const rows = useTaskRows(todos, now);
  // One list, no headings: the sections' order (needs you, working, to do) is kept.
  const { openRows, completed } = useMemo(() => {
    const { sections, completed } = buildTaskSections(rows);
    return { openRows: sections.flatMap((section) => section.rows), completed };
  }, [rows]);
  const board = useKanbanBoard();
  const todoThreadIds = useMemo(
    () => new Set(todos.flatMap((todo) => (todo.threadId ? [todo.threadId] : []))),
    [todos],
  );
  const { openCards: boardOpenCards, doneCards: boardDoneCards } = useMemo(
    () => collectBoardTaskLists(board.projects, todoThreadIds),
    [board.projects, todoThreadIds],
  );
  const allProjects = useStore((state) => state.projects);
  const projectCwdById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project.cwd] as const)),
    [allProjects],
  );
  const renderedBoardThreads = useMemo(
    () =>
      [...boardOpenCards, ...boardDoneCards].flatMap((card) => (card.thread ? [card.thread] : [])),
    [boardDoneCards, boardOpenCards],
  );
  const prByThreadId = useThreadPullRequests({
    threads: renderedBoardThreads,
    projectCwdById,
  });
  const newTaskProjectOptions = board.projects.map((project) => ({
    id: project.projectId,
    name: project.projectName,
  }));
  const [newTaskDialogKey, setNewTaskDialogKey] = useState<number | null>(null);
  const isNewTaskDialogOpenRef = useRef(false);
  useEffect(() => {
    isNewTaskDialogOpenRef.current = newTaskDialogKey !== null;
  }, [newTaskDialogKey]);
  const selection = useTaskSelection(rows, mutations);
  const [showsAllDone, setShowsAllDone] = useState(false);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const { onCardContextMenu, renameDialog } = useKanbanCardContextMenu();

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isNewTaskShortcut(event) || isNewTaskDialogOpenRef.current) return;
      if (newTaskProjectOptions.length === 0) return;
      event.preventDefault();
      setNewTaskDialogKey(Date.now());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newTaskProjectOptions.length]);

  const handleOpenBoardCard = (card: KanbanCard) => {
    void navigate({ to: "/$threadId", params: { threadId: card.threadId } });
  };

  const renderRow = (row: TaskRowModel) => (
    <TaskListItem
      key={row.todo.id}
      row={row}
      selected={row.todo.id === selection.selectedTodoId}
      onSelect={() => selection.select(row.todo.id)}
      now={now}
      onUpdate={(input) => mutations.updateTodo(input)}
      onDelete={() => selection.removeTask(row.todo.id)}
    />
  );

  const renderBoardRow = (card: KanbanCard) => (
    <BoardTaskListItem
      key={card.cardId}
      card={card}
      pr={resolveBoardCardPr(card, prByThreadId)}
      onOpen={handleOpenBoardCard}
      onContextMenu={onCardContextMenu}
    />
  );

  const totalDoneCount = completed.length + boardDoneCards.length;
  const doneLimit = showsAllDone ? totalDoneCount : DONE_PREVIEW_COUNT;
  const shownDoneTodos = completed.slice(0, doneLimit);
  const shownDoneBoard = boardDoneCards.slice(0, Math.max(0, doneLimit - shownDoneTodos.length));
  const hasNoVisibleTasks =
    rows.length === 0 && boardOpenCards.length === 0 && boardDoneCards.length === 0;

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <TasksPageHeader
          view="list"
          onNewTask={() => setNewTaskDialogKey(Date.now())}
          newTaskDisabled={newTaskProjectOptions.length === 0}
          className={TASKS_LIST_COLUMN_CLASS_NAME}
        />

        <TaskCardSurface selection={selection} now={now} mutations={mutations}>
          {/* The page header names the page; the list starts right under it. */}
          <div className={cn("flex flex-col gap-ui-gap-lg pb-20", TASKS_LIST_COLUMN_CLASS_NAME)}>
            {isLoading && hasNoVisibleTasks ? (
              <p className="px-3 text-ui-sm text-muted-foreground">Loading…</p>
            ) : null}

            {isError && hasNoVisibleTasks ? (
              <div className="flex items-center gap-3 px-3">
                <p className="text-ui text-foreground">Couldn't load your tasks.</p>
                <Button size="sm" shape="capsule" variant="subtle" onClick={() => void refetch()}>
                  Try again
                </Button>
              </div>
            ) : null}

            <div className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
              <div
                role="list"
                aria-label="To do"
                className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}
              >
                {openRows.map(renderRow)}
                {boardOpenCards.map(renderBoardRow)}
              </div>
              <TaskQuickAdd inputRef={quickAddRef} onCreate={selection.addTask} />
            </div>

            {totalDoneCount > 0 ? (
              <div className={cn("flex flex-col opacity-80", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
                <div
                  role="list"
                  aria-label="Done"
                  className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}
                >
                  {shownDoneTodos.map(renderRow)}
                  {shownDoneBoard.map(renderBoardRow)}
                </div>
                {totalDoneCount > DONE_PREVIEW_COUNT ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={showsAllDone}
                    onClick={() => setShowsAllDone((current) => !current)}
                    className="self-start"
                  >
                    {showsAllDone ? "Show less" : `Show all ${totalDoneCount} done`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </TaskCardSurface>
      </RouteSurface>

      {newTaskDialogKey !== null ? (
        <KanbanNewTaskDialog
          key={newTaskDialogKey}
          onOpenChange={(open) => {
            if (!open) setNewTaskDialogKey(null);
          }}
          projectOptions={newTaskProjectOptions}
          initialProjectId={null}
        />
      ) : null}
      {renameDialog}
    </RouteInsetSurface>
  );
}
