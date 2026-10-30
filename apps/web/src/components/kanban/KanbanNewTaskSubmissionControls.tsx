// FILE: KanbanNewTaskSubmissionControls.tsx
// Purpose: Keeps the new-task dialog's submission description, toggle, and CTA in sync.
// Layer: Kanban UI presentation
// Exports: KanbanNewTaskSubmissionDescription, KanbanNewTaskSubmissionControls

import { useId } from "react";

import { Button } from "~/components/ui/button";
import { DialogDescription } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useTranslation } from "~/localization";
import { resolveKanbanNewTaskSubmissionPresentation } from "./KanbanNewTaskDialog.logic";

export function KanbanNewTaskSubmissionDescription({
  sendAsDraft,
}: {
  readonly sendAsDraft: boolean;
}) {
  const { t } = useTranslation();
  const presentation = resolveKanbanNewTaskSubmissionPresentation(sendAsDraft);
  return (
    <DialogDescription className="sr-only">
      {t(presentation.dialogDescriptionKey)}
    </DialogDescription>
  );
}

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
  const outcomeDescriptionId = useId();
  const presentation = resolveKanbanNewTaskSubmissionPresentation(sendAsDraft);
  const primaryActionLabel = isPreparingImages
    ? t("kanban.newTask.optimizing")
    : isCreating
      ? t(sendAsDraft ? "kanban.newTask.saving" : "kanban.newTask.starting")
      : t(presentation.primaryActionLabelKey);

  return (
    <div className="ml-auto flex min-w-0 basis-full items-end justify-end gap-3 sm:basis-auto">
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <label className="flex cursor-pointer items-center gap-2 py-0.5 text-ui-sm text-muted-foreground">
          <Switch
            checked={sendAsDraft}
            disabled={isCreating}
            aria-describedby={outcomeDescriptionId}
            onCheckedChange={(checked) => onSendAsDraftChange(checked === true)}
          />
          {t("kanban.newTask.saveAsDraft")}
        </label>
        <span
          id={outcomeDescriptionId}
          className="max-w-full break-words text-right text-ui-sm leading-snug text-muted-foreground/80"
          aria-live="polite"
        >
          {t(presentation.visibleOutcomeDescriptionKey)}
        </span>
      </div>
      <Button type="button" size="sm" onClick={onSubmit} disabled={!canCreate}>
        {primaryActionLabel}
      </Button>
    </div>
  );
}
