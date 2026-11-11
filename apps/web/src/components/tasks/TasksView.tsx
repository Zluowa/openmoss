// FILE: TasksView.tsx
// Purpose: The Tasks route — one calm list of everything to do, any of which can be handed to
//          an agent. Open to-dos come first (what needs the user, then what's working, then
//          the rest), a line at the end adds a new one, and finished ones fade out below.
//          Selecting a to-do opens its card, floating beside the list.
// Layer: Tasks route surface
// Exports: TasksView (default)

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useNowMs } from "~/hooks/useNowMs";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";
import { cn } from "~/lib/utils";
import { SIDEBAR_NESTED_LIST_GAP_CLASS_NAME } from "../../sidebarRowStyles";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface } from "../RouteSurface";
import { TaskCardSurface, useTaskSelection } from "./TaskCardSurface";
import { TaskListItem } from "./TaskListItem";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TasksPageHeader } from "./TasksPageHeader";
import { buildTaskSections, type TaskRowModel } from "./tasks.logic";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

/** The list's one centred column; the page header row lines up with it. */
const TASKS_LIST_COLUMN_CLASS_NAME = "mx-auto w-full max-w-[40rem] px-ui-pad-xl";

/** Finished to-dos shown before "Show all". */
const DONE_PREVIEW_COUNT = 2;

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
  const selection = useTaskSelection(rows, mutations);
  const [showsAllDone, setShowsAllDone] = useState(false);
  const quickAddRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isNewTaskShortcut(event)) return;
      event.preventDefault();
      quickAddRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
  const shownDone = showsAllDone ? completed : completed.slice(0, DONE_PREVIEW_COUNT);

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <TasksPageHeader
          view="list"
          onNewTask={() => quickAddRef.current?.focus()}
          className={TASKS_LIST_COLUMN_CLASS_NAME}
        />

        <TaskCardSurface selection={selection} now={now} mutations={mutations}>
          {/* The page header names the page; the list starts right under it. */}
          <div className={cn("flex flex-col gap-ui-gap-lg pb-20", TASKS_LIST_COLUMN_CLASS_NAME)}>
            {isLoading && rows.length === 0 ? (
              <p className="px-3 text-ui-sm text-muted-foreground">Loading…</p>
            ) : null}

            {isError && rows.length === 0 ? (
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
              </div>
              <TaskQuickAdd inputRef={quickAddRef} onCreate={selection.addTask} />
            </div>

            {completed.length > 0 ? (
              <div className={cn("flex flex-col opacity-80", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
                <div
                  role="list"
                  aria-label="Done"
                  className={cn("flex flex-col", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}
                >
                  {shownDone.map(renderRow)}
                </div>
                {completed.length > DONE_PREVIEW_COUNT ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={showsAllDone}
                    onClick={() => setShowsAllDone((current) => !current)}
                    className="self-start"
                  >
                    {showsAllDone ? "Show less" : `Show all ${completed.length} done`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </TaskCardSurface>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
