// FILE: useKanbanTaskSubmit.ts
// Purpose: Owns the kanban new-task dialog's draft/create/send lifecycle.
// Layer: Kanban UI hook
// Exports: useKanbanTaskSubmit

import type {
  AssistantDeliveryMode,
  ModelSlug,
  ProjectId,
  ProviderInteractionMode,
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { inferLegacyProviderKindFromModelSelection } from "@synara/shared/providerInstances";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import type { ProviderInstanceOption } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import type { DraftThreadEnvMode } from "~/composerDraftStore";
import { providerInstanceModelSelectionKey, useComposerDraftStore } from "~/composerDraftStore";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { createAndSendKanbanTask, createKanbanDraftTask } from "~/lib/kanbanTaskCreate";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";
import { useTranslation } from "~/localization";
import { buildModelSelection } from "~/providerModelOptions";
import { truncateKanbanTaskPreview } from "./KanbanNewTaskDialog.logic";

interface UseKanbanTaskSubmitInput {
  readonly selectedProjectId: ProjectId | null;
  readonly hasSendableContent: boolean;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectedModel: ModelSlug | null;
  readonly selectedModelSupportsAutoMode: boolean | undefined;
  readonly taskPreview: string;
  readonly trimmedPrompt: string;
  readonly scratchThreadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly envMode: DraftThreadEnvMode;
  readonly sendAsDraft: boolean;
  /** New-task dialog "send as goal" toggle (off by default; dialog-owned state). */
  readonly sendAsGoal?: boolean | undefined;
  readonly defaultProvider: ProviderKind;
  readonly assistantDeliveryMode: AssistantDeliveryMode;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly providerInstances: ReadonlyArray<
    Pick<ProviderInstanceOption, "instanceId" | "provider">
  >;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly isPreparingImages: boolean;
  readonly waitForPendingImages: () => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}

export function useKanbanTaskSubmit(input: UseKanbanTaskSubmitInput) {
  const {
    selectedProjectId,
    hasSendableContent,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    taskPreview,
    trimmedPrompt,
    scratchThreadId,
    runtimeMode,
    interactionMode,
    envMode,
    sendAsDraft,
    sendAsGoal = false,
    defaultProvider,
    assistantDeliveryMode,
    providerOptionsForDispatch,
    providerInstances,
    providerStatuses,
    isPreparingImages,
    waitForPendingImages,
    onOpenChange,
  } = input;
  const { locale, t } = useTranslation();
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  // Synchronous re-entry guard: repeated Cmd+Enter can fire before React flushes
  // the loading state, and two passes here would create two tasks.
  const isCreatingRef = useRef(false);

  const canCreate =
    selectedProjectId !== null &&
    hasSendableContent &&
    selectedModel !== null &&
    !isCreating &&
    !isPreparingImages;

  const handleCreate = useCallback(async () => {
    if (
      !selectedProjectId ||
      !hasSendableContent ||
      selectedModel === null ||
      isCreating ||
      isCreatingRef.current
    ) {
      return;
    }

    isCreatingRef.current = true;
    setIsCreating(true);
    let closeDialog = false;
    let threadIdToOpen: ThreadId | null = null;
    try {
      await waitForPendingImages();
      const truncatedPrompt = truncateKanbanTaskPreview(taskPreview);
      // The scratch draft carries the full selection (model + reasoning effort +
      // speed) set through the picker; fall back to a bare selection otherwise.
      const scratchState = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId];
      const draftModelSelection =
        scratchState?.modelSelectionByProvider[
          providerInstanceModelSelectionKey(selectedProvider, selectedProviderInstanceId)
        ];
      const modelSelection =
        draftModelSelection &&
        inferLegacyProviderKindFromModelSelection(draftModelSelection) === selectedProvider
          ? {
              ...draftModelSelection,
              instanceId: selectedProviderInstanceId,
            }
          : buildModelSelection(selectedProvider, selectedModel, null, {
              instanceId: selectedProviderInstanceId,
            });
      const taskInput = {
        projectId: selectedProjectId,
        prompt: trimmedPrompt,
        sourceComposerThreadId: scratchThreadId,
        modelSelection,
        runtimeMode,
        interactionMode,
        envMode,
      };

      if (sendAsDraft) {
        createKanbanDraftTask(taskInput);
        toastManager.add({
          type: "success",
          title: t("kanban.newTask.toast.addedToDrafts"),
          description: truncatedPrompt,
        });
        closeDialog = true;
        return;
      }

      // Send now: create + promote + dispatch straight to In Progress. The
      // selected action is already locked, so a slow provider preflight cannot
      // let the visible toggle diverge from this captured branch.
      const sendAvailability = await resolveProviderSendAvailabilityWithRefresh({
        provider: selectedProvider,
        instanceId: modelSelection.instanceId,
        statuses: providerStatuses,
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
      });
      if (!sendAvailability.usable) {
        toastManager.add({
          type: "error",
          title: localizeProviderSendBlockedReason(locale, sendAvailability),
        });
        return;
      }

      const { threadId, result } = await createAndSendKanbanTask({
        ...taskInput,
        defaultProvider,
        assistantDeliveryMode,
        providerOptions: providerOptionsForDispatch,
        ...(sendAsGoal ? { sendAsGoal: true as const } : {}),
        providerInstances,
      });
      if (result.kind === "dispatched") {
        if (result.deferred) {
          toastManager.add({
            type: "info",
            title: "Chat send in progress",
            description: "The board stood down; the running chat send owns this turn.",
          });
          closeDialog = true;
          return;
        }
        toastManager.add({
          type: result.warning ? "warning" : "success",
          title: t("kanban.newTask.toast.started"),
          description: result.warning ?? truncatedPrompt,
        });
        closeDialog = true;
        return;
      }
      if (result.kind === "open-thread") {
        toastManager.add({
          type: "info",
          title: t("kanban.newTask.toast.finishInChat"),
          description:
            result.reason === "worktree-pending"
              ? t("kanban.newTask.toast.worktreePending")
              : t("kanban.newTask.toast.savedAsDraft"),
        });
        closeDialog = true;
        threadIdToOpen = threadId;
        return;
      }
      // Promotion/dispatch could not complete faithfully; the draft still
      // exists on the board, so surface the failure and keep the dialog open.
      toastManager.add({
        type: "error",
        title: t("kanban.newTask.startFailed"),
        description: t("kanban.newTask.toast.savedToDraftsFallback"),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: sendAsDraft ? t("kanban.newTask.saveDraftFailed") : t("kanban.newTask.startFailed"),
        description: t("kanban.newTask.toast.retry"),
      });
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
      if (closeDialog) {
        onOpenChange(false);
      }
      if (threadIdToOpen) {
        void navigate({ to: "/$threadId", params: { threadId: threadIdToOpen } });
      }
    }
  }, [
    assistantDeliveryMode,
    defaultProvider,
    envMode,
    hasSendableContent,
    interactionMode,
    isCreating,
    locale,
    navigate,
    onOpenChange,
    providerOptionsForDispatch,
    providerInstances,
    providerStatuses,
    refreshProviderStatuses,
    runtimeMode,
    scratchThreadId,
    selectedModel,
    selectedProviderInstanceId,
    selectedProjectId,
    selectedProvider,
    sendAsDraft,
    sendAsGoal,
    taskPreview,
    t,
    trimmedPrompt,
    waitForPendingImages,
  ]);

  return {
    isCreating,
    canCreate,
    handleCreate,
  };
}
