import type { ProjectAgentSummary } from "@moss/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "~/components/ui/dialog";
import { useProjectAgent } from "~/components/chat/project/useProjectAgent";
import { useProjectAgentSummariesStore } from "~/components/chat/project/useProjectAgentSummaries";
import { GroupLifecycleSection } from "~/components/chat/group/GroupLifecycleSection";
import { useMossbotCopy } from "./mossbot.copy";

/** Uses the same name confirmation, deletion API and preserved-folder receipt as native settings. */
export function MossbotDeleteDialog({
  assistant,
  onClose,
}: {
  assistant: ProjectAgentSummary;
  onClose: () => void;
}) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const agent = useProjectAgent({ projectId: assistant.projectId, enabled: true });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !agent.busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Delete assistant")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {agent.error && (
            <p role="alert" className="text-ui text-destructive">
              {agent.error}
            </p>
          )}
          {!agent.overview && !agent.error && (
            <p role="status" className="text-ui">
              {t("Loading…")}
            </p>
          )}
          <GroupLifecycleSection
            agent={agent}
            projectName={assistant.coordinatorName ?? "Moss"}
            deleteOnly
            initialConfirmDelete
            onDeleted={() => {
              const summaries = useProjectAgentSummariesStore.getState();
              summaries.setSummaries(
                [...summaries.summariesByProjectId.values()].filter(
                  (item) => item.projectId !== assistant.projectId,
                ),
              );
              onClose();
              void navigate({ to: "/mossbot" });
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
