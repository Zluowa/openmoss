// FILE: KanbanNewTaskSubmissionControls.tsx
// Purpose: Keeps the new-task dialog's draft toggle and CTA in sync.
// Layer: Kanban UI presentation
// Exports: KanbanNewTaskSubmissionControls

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/localization";
import { resolveKanbanNewTaskSubmissionPresentation } from "./KanbanNewTaskDialog.logic";

export function KanbanNewTaskSubmissionControls({
  sendAsDraft,
  canCreate,
  isCreating,
  isPreparingImages,
  onSendAsDraftChange,
  onSubmit,
}: {
  readonly sendAsDraft: boolean;
  readonly canCreate: boolean;
  readonly isCreating: boolean;
  readonly isPreparingImages: boolean;
  readonly onSendAsDraftChange: (sendAsDraft: boolean) => void;
  readonly onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const presentation = resolveKanbanNewTaskSubmissionPresentation(sendAsDraft);
  const primaryActionLabel = isPreparingImages
    ? t("kanban.newTask.optimizing")
    : isCreating
      ? t(sendAsDraft ? "kanban.newTask.saving" : "kanban.newTask.starting")
      : t(presentation.primaryActionLabelKey);

  return (
    <div className="ml-auto flex min-w-0 basis-full items-center justify-end gap-3 sm:basis-auto">
      <label className="flex cursor-pointer items-center gap-2 py-0.5 text-ui-sm text-muted-foreground">
        <Switch
          checked={sendAsDraft}
          disabled={isCreating}
          onCheckedChange={(checked) => onSendAsDraftChange(checked === true)}
        />
        {t("kanban.newTask.saveAsDraft")}
      </label>
      <Button type="button" size="sm" onClick={onSubmit} disabled={!canCreate}>
        {primaryActionLabel}
      </Button>
    </div>
  );
}
