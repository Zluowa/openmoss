// FILE: WorktreeSetupCard.tsx
// Purpose: Worktree preparation in the transcript, drawn like the desktop chat's turn
//          status: a "Preparing worktree…" line that shimmers while it works, its steps as
//          quiet lines beneath, and Work locally / Cancel while they can still win.
// Layer: Chat transcript UI
// Exports: WorktreeSetupCard

import { cn } from "~/lib/utils";
import type { WorktreeSetupResolutionAction, WorktreeSetupStep } from "../../../../types";
import { useTranslation } from "../../../../localization";
import { Button } from "../../../ui/button";
import { ConversationShimmer } from "../../ConversationShimmer";
import { TranscriptEventLine } from "../TranscriptDisclosureRow";

export function WorktreeSetupCard({
  steps,
  pendingAction,
  onResolve,
}: {
  steps: ReadonlyArray<WorktreeSetupStep>;
  pendingAction?: WorktreeSetupResolutionAction | null | undefined;
  onResolve?: ((action: WorktreeSetupResolutionAction) => void) | undefined;
}) {
  const { t } = useTranslation();
  const failed = steps.some((step) => step.status === "error");
  // The send pipeline only honors a resolution at checkpoints before the turn
  // dispatch, so hide the actions once "Starting session" is underway (or the
  // setup already failed) rather than offering a cancel that can no longer win.
  const canResolve =
    onResolve !== undefined &&
    !failed &&
    !steps.some((step) => step.id === "start-session" && step.status !== "pending");
  return (
    <div className="flex min-w-0 flex-col text-size-chat" data-worktree-setup="">
      <TranscriptEventLine
        verb={t(failed ? "transcript.event.worktreeFailed" : "transcript.event.preparingWorktree")}
        busy={!failed}
      />
      <ol className="flex flex-col ps-3">
        {steps.map((step) => (
          <li
            key={step.id}
            data-worktree-step={step.status}
            className={cn(
              "flex min-h-6 items-center",
              step.status === "error"
                ? "text-destructive"
                : step.status === "pending"
                  ? "text-muted-foreground/60"
                  : "text-muted-foreground",
            )}
          >
            {step.status === "active" ? (
              <ConversationShimmer active>{step.label}</ConversationShimmer>
            ) : (
              <span>
                {step.label}
                {step.status === "error" ? ` · ${t("transcript.event.stepFailed")}` : ""}
              </span>
            )}
          </li>
        ))}
      </ol>
      {canResolve ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            disabled={pendingAction != null}
            onClick={() => onResolve("work-locally")}
          >
            {pendingAction === "work-locally" ? "Switching to local..." : "Work locally"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={pendingAction != null}
            onClick={() => onResolve("cancel")}
          >
            {pendingAction === "cancel" ? "Cancelling..." : "Cancel"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
