// FILE: TasksViewSwitch.tsx
// Purpose: The compact List / Board segmented control in the Tasks page header, where both
//          views exist. Picking one opens it and makes it what the Tasks entry opens next.
// Layer: Tasks UI component
// Exports: TasksViewSwitch

import { useNavigate } from "@tanstack/react-router";

import { type TasksViewMode, useAppSettings } from "~/appSettings";
import { SegmentedPicker, type SegmentedPickerOption } from "~/components/SegmentedPicker";
import { KanbanIcon, ListTodoIcon } from "~/lib/icons";
import { useTasksSurfaceEnabled } from "~/tasksSurface";

const VIEW_OPTIONS: ReadonlyArray<SegmentedPickerOption<TasksViewMode>> = [
  { value: "list", label: "List", icon: <ListTodoIcon className="size-3.5 shrink-0" /> },
  { value: "kanban", label: "Kanban", icon: <KanbanIcon className="size-3.5 shrink-0" /> },
];

export function TasksViewSwitch({ current }: { current: TasksViewMode }) {
  const navigate = useNavigate();
  const { updateSettings } = useAppSettings();
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  if (!tasksSurfaceEnabled) return null;
  return (
    <SegmentedPicker
      ariaLabel="View"
      value={current}
      options={VIEW_OPTIONS}
      className="w-48 shrink-0"
      onValueChange={(view) => {
        if (view === current) return;
        updateSettings({ tasksViewMode: view });
        void navigate({ to: view === "kanban" ? "/kanban" : "/tasks" });
      }}
    />
  );
}
