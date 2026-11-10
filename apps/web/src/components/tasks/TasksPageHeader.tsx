// FILE: TasksPageHeader.tsx
// Purpose: The one top bar the Tasks list and the board share, on the Moss route header:
//          a quiet title (or the open project with a back arrow), then the List / Board
//          switch, the view's single filter control, and New task.
// Layer: Tasks UI component
// Exports: TasksPageHeader

import type { ReactNode } from "react";

import type { TasksViewMode } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { ArrowLeftIcon } from "~/lib/icons";
import { RouteSurfaceHeader } from "../RouteSurface";
import { NewTaskButton } from "./NewTaskButton";
import { TasksViewSwitch } from "./TasksViewSwitch";

export function TasksPageHeader({
  view,
  title = "Tasks",
  onBack,
  filter,
  onNewTask,
  newTaskDisabled,
}: {
  view: TasksViewMode;
  /** Defaults to "Tasks"; a project board shows the project's name. */
  title?: string;
  /** Shown as a back arrow before the title (a project board returns to every project). */
  onBack?: (() => void) | undefined;
  /** The view's one filter control, if it has filters. */
  filter?: ReactNode;
  onNewTask: () => void;
  newTaskDisabled?: boolean | undefined;
}) {
  return (
    <RouteSurfaceHeader divider={false}>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {onBack ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
            onClick={onBack}
            aria-label="Back to all projects"
            title="Back to all projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        ) : null}
        <h1 className="min-w-0 truncate text-ui font-medium text-foreground">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {onBack ? null : <TasksViewSwitch current={view} />}
        {filter}
        <NewTaskButton disabled={newTaskDisabled} onClick={onNewTask} />
      </div>
    </RouteSurfaceHeader>
  );
}
