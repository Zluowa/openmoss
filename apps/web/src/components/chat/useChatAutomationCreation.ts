import {
  EventId,
  CommandId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type AutomationSchedule,
  type AutomationCreateInput,
  type ModelSelection,
  type ProviderStartOptions,
} from "@synara/contracts";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";
import {
  GENERIC_CHAT_THREAD_TITLE,
  buildPromptThreadTitleFallback,
} from "@synara/shared/chatThreads";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import {
  acknowledgedRiskIdsForDraft,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "../../lib/automationDraft";
import {
  automationQueryKey,
  createInputFromForm,
  formatCadence,
  isFormSubmittable,
  type AutomationFormState,
} from "../../routes/-automations.shared";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { useChatAutomationSetup } from "./useChatAutomationSetup";
import { toastManager } from "../ui/toast";
import { AutomationCreateIntent, isAutomationCreateRejected } from "~/lib/automationCreateIntent";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
function automationScheduleActivityPayload(schedule: AutomationSchedule) {
  switch (schedule.type) {
    case "manual":
      return { type: "manual" } as const;
    case "project-event":
      return { type: "project-event", projectId: schedule.projectId } as const;
    case "once":
      return { type: "once", runAt: schedule.runAt } as const;
    case "interval":
      return { type: "interval", everySeconds: schedule.everySeconds } as const;
    case "daily":
      return schedule.timezone
        ? { type: "daily", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "daily", timeOfDay: schedule.timeOfDay };
    case "weekdays":
      return schedule.timezone
        ? { type: "weekdays", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone }
        : { type: "weekdays", timeOfDay: schedule.timeOfDay };
    case "weekly":
      return schedule.timezone
        ? {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
            timezone: schedule.timezone,
          }
        : {
            type: "weekly",
            dayOfWeek: schedule.dayOfWeek,
            timeOfDay: schedule.timeOfDay,
          };
    case "cron":
      return {
        type: "cron",
        expression: schedule.expression,
        timezone: schedule.timezone,
      } as const;
  }
}
interface ChatAutomationCreationInput {
  threadId: ThreadId;
  activeProject: Project | undefined;
  automationDraftSubmittingRef: ReturnType<
    typeof useChatAutomationSetup
  >["automationDraftSubmittingRef"];
  isServerThread: boolean;
  activeThread: Thread | undefined;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  setIsAutomationDraftSubmitting: ReturnType<
    typeof useChatAutomationSetup
  >["setIsAutomationDraftSubmitting"];
  queryClient: QueryClient;
  clearComposerInput: (threadId: ThreadId) => void;
  resetAutomationDraftState: ReturnType<typeof useChatAutomationSetup>["resetAutomationDraftState"];
  activeThreadAssociatedWorktree: ReturnType<typeof deriveAssociatedWorktreeMetadata>;
  threadNotes: string;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  automationDraftForm: ReturnType<typeof useChatAutomationSetup>["automationDraftForm"];
  automationDraftWarnings: ReturnType<typeof useChatAutomationSetup>["automationDraftWarnings"];
  acknowledgedAutomationWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["acknowledgedAutomationWarnings"];
}

export function useChatAutomationCreation({
  threadId,
  activeProject,
  automationDraftSubmittingRef,
  isServerThread,
  activeThread,
  providerOptionsForDispatch,
  setIsAutomationDraftSubmitting,
  queryClient,
  clearComposerInput,
  resetAutomationDraftState,
  activeThreadAssociatedWorktree,
  threadNotes,
  selectedModelSelection,
  runtimeMode,
  interactionMode,
  automationDraftForm,
  automationDraftWarnings,
  acknowledgedAutomationWarnings,
}: ChatAutomationCreationInput) {
  const { identityKey: accountIdentityKey, isCurrent: isAccountCurrent } =
    useMossImagesAccountBoundary();
  const creationKey = JSON.stringify([accountIdentityKey, threadId]);
  const creation = useMemo(
    () => new AutomationCreateIntent(`moss:automation-create:chat:v1:${creationKey}`),
    [creationKey],
  );
  const [automationCreationError, setAutomationCreationError] = useState<string | null>(null);
  const [automationCreationPendingOpen, setAutomationCreationPendingOpen] = useState(
    () => creation.pending !== null,
  );
  const [, refreshCreation] = useState(0);
  const scope = useRef(creationKey);
  useLayoutEffect(() => {
    scope.current = creationKey;
  }, [creationKey]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setAutomationCreationError(creation.error);
    setAutomationCreationPendingOpen(creation.pending !== null);
  }, [creation]);

  const runCreation = useCallback(
    async (automationInput: AutomationCreateInput): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeProject || automationDraftSubmittingRef.current || !isAccountCurrent())
        return false;
      const isCurrent = () =>
        mounted.current && scope.current === creationKey && isAccountCurrent();
      automationDraftSubmittingRef.current = true;
      setIsAutomationDraftSubmitting(true);
      setAutomationCreationError(null);
      const performCreation = async (): Promise<boolean> => {
        const definition = await creation.submit(
          { ...automationInput, requestId: automationInput.requestId ?? randomUUID() },
          (pending) => {
            if (!isCurrent())
              throw new Error(
                "The account or chat changed before creation could be sent. Reopen the original creation to confirm its result.",
              );
            refreshCreation((value) => value + 1);
            return api.automation.create(pending);
          },
        );
        if (!isCurrent()) return false;
        const original = creation.pending!;
        creation.clear();
        refreshCreation((value) => value + 1);
        setAutomationCreationPendingOpen(false);
        const activityThreadId = original.sourceThreadId ?? null;
        if (activityThreadId) {
          void (async () => {
            try {
              if (!isCurrent()) return;
              await api.orchestration.dispatchCommand({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe(`automation-created:${definition.id}:note`),
                threadId: activityThreadId,
                activity: {
                  id: EventId.makeUnsafe(`automation-created:${definition.id}:note`),
                  tone: "info",
                  kind: "automation.created",
                  summary: `Created automation: ${definition.name} - ${formatCadence(definition.schedule)}`,
                  payload: {
                    source: "chat-composer",
                    automationId: definition.id,
                    automationName: definition.name,
                    mode: definition.mode,
                    cadenceLabel: formatCadence(definition.schedule),
                    schedule: automationScheduleActivityPayload(definition.schedule),
                  },
                  turnId: null,
                  createdAt: definition.createdAt,
                },
                createdAt: definition.createdAt,
              });
            } catch {
              if (isCurrent())
                toastManager.add({
                  type: "warning",
                  title: "Thread note not added",
                  description:
                    "The automation was created, but Moss could not add the activity note.",
                });
            }
          })();
        }
        void queryClient.invalidateQueries({ queryKey: automationQueryKey });
        clearComposerInput(activeThread?.id ?? threadId);
        resetAutomationDraftState();
        toastManager.add({
          type: "success",
          title: "Automation created",
          description: `${definition.name} - ${formatCadence(definition.schedule)}`,
        });
        return true;
      };
      return performCreation()
        .catch((cause: unknown) => {
          if (isCurrent()) {
            let error = cause;
            if (isAutomationCreateRejected(cause)) {
              try {
                creation.clear();
              } catch (storageError) {
                error = storageError;
              }
            }
            const message =
              error instanceof Error
                ? error.message
                : "Moss could not confirm the automation creation.";
            setAutomationCreationError(message);
            setAutomationCreationPendingOpen(creation.pending !== null);
            refreshCreation((value) => value + 1);
            toastManager.add({
              type: "error",
              title: "Could not create automation",
              description: message,
            });
          }
          return false;
        })
        .finally(() => {
          automationDraftSubmittingRef.current = false;
          if (mounted.current) setIsAutomationDraftSubmitting(false);
        });
    },
    [
      isAccountCurrent,
      activeProject,
      activeThread?.id,
      automationDraftSubmittingRef,
      clearComposerInput,
      creation,
      creationKey,
      queryClient,
      refreshCreation,
      resetAutomationDraftState,
      setIsAutomationDraftSubmitting,
      threadId,
    ],
  );

  const createAutomationFromForm = useCallback(
    async (input: {
      readonly form: AutomationFormState;
      readonly warnings: readonly AutomationDraftWarning[];
      readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
      readonly providerOptions?: ProviderStartOptions;
      readonly activityThreadId?: ThreadId | null;
    }): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeProject) {
        return false;
      }
      if (automationDraftSubmittingRef.current) {
        return false;
      }
      if (!isFormSubmittable(input.form)) {
        return false;
      }
      if (hasBlockingAutomationDraftWarnings(input.warnings, input.acknowledgedWarningIds)) {
        return false;
      }
      const acknowledgedRisks = acknowledgedRiskIdsForDraft(
        input.warnings,
        input.acknowledgedWarningIds,
      );
      const activityThreadId =
        input.activityThreadId ?? (isServerThread ? (activeThread?.id ?? null) : null);
      const automationInput = createInputFromForm(
        input.form,
        input.providerOptions ?? providerOptionsForDispatch,
        acknowledgedRisks,
        activityThreadId,
      );
      return runCreation(automationInput);
    },
    [
      activeProject,
      activeThread,
      automationDraftSubmittingRef,
      isServerThread,
      providerOptionsForDispatch,
      runCreation,
    ],
  );

  const ensureAutomationTargetThread = useCallback(
    async (input: {
      readonly titleSeed: string;
      readonly threadModelSelection: ModelSelection;
      readonly threadRuntimeMode: RuntimeMode;
      readonly threadInteractionMode: ProviderInteractionMode;
    }): Promise<ThreadId | null> => {
      const isCurrent = () =>
        mounted.current && scope.current === creationKey && isAccountCurrent();
      if (!isCurrent()) return null;
      const api = readNativeApi();
      if (!api || !activeProject || !activeThread) {
        toastManager.add({
          type: "warning",
          title: "Chat required",
          description: "Open a chat before creating a chat-bound automation.",
        });
        return null;
      }
      if (isServerThread) {
        return activeThread.id;
      }

      const title = buildPromptThreadTitleFallback(input.titleSeed || GENERIC_CHAT_THREAD_TITLE);
      // Nested function so the `try` body holds no value blocks — see the comment on
      // `deleteEmptyTerminalThread` above for why React Compiler requires this shape.
      const promoteDraftForAutomation = async (): Promise<ThreadId | null> => {
        if (!isCurrent()) return null;
        const result = await promoteThreadCreate(
          {
            type: "thread.create",
            commandId: newCommandId(),
            threadId: activeThread.id,
            projectId: activeProject.id,
            title,
            modelSelection: input.threadModelSelection,
            runtimeMode: input.threadRuntimeMode,
            interactionMode: input.threadInteractionMode,
            envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
            branch: activeThread.branch ?? null,
            worktreePath: activeThread.worktreePath ?? null,
            workingDirectory: activeThread.workingDirectory ?? null,
            associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
            associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
            associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
            lastKnownPr: activeThread.lastKnownPr ?? null,
            // Promotion materializes the draft as a durable thread now; the draft's
            // timestamp only records when its composer was opened.
            createdAt: new Date().toISOString(),
          },
          api,
          { force: true },
        );
        if (!isCurrent()) return null;
        if (result === "unavailable") {
          toastManager.add({
            type: "error",
            title: "Could not create chat",
            description: "Moss could not promote this draft before saving the automation.",
          });
          return null;
        }

        const inheritedProjectInstructions =
          useProjectInstructionsStore.getState().instructionsByProjectId[activeProject.id] ?? "";
        const inheritedThreadNotes = mergeProjectInstructionsIntoThreadNotes({
          threadNotes,
          projectInstructions: inheritedProjectInstructions,
        });
        if (inheritedThreadNotes !== threadNotes && inheritedThreadNotes.trim().length > 0) {
          if (!isCurrent()) return null;
          void dispatchThreadNotes(activeThread.id, inheritedThreadNotes).catch(() => undefined);
        }

        return activeThread.id;
      };

      try {
        return await promoteDraftForAutomation();
      } catch (error) {
        if (!isCurrent()) return null;
        toastManager.add({
          type: "error",
          title: "Could not create chat",
          description:
            error instanceof Error
              ? error.message
              : "Moss could not promote this draft before saving the automation.",
        });
        return null;
      }
    },
    [
      isAccountCurrent,
      creationKey,
      activeProject,
      activeThread,
      activeThreadAssociatedWorktree,
      isServerThread,
      threadNotes,
    ],
  );

  const prepareAutomationFormForCreate = useCallback(
    async (
      form: AutomationFormState,
    ): Promise<{
      readonly form: AutomationFormState;
      readonly activityThreadId: ThreadId | null;
    } | null> => {
      if (!mounted.current || scope.current !== creationKey || !isAccountCurrent()) return null;
      const activityThreadId = isServerThread ? (activeThread?.id ?? null) : null;
      if (!automationRequiresTargetThread(form.mode) || !activeThread) {
        return { form, activityThreadId };
      }
      if (isServerThread || form.targetThreadId !== activeThread.id) {
        return { form, activityThreadId };
      }

      // Draft review can keep the local draft ID in the form; promote it only when
      // the automation is actually submitted so cancelling review leaves no empty thread.
      const targetThreadId = await ensureAutomationTargetThread({
        titleSeed: form.prompt || form.name,
        threadModelSelection: selectedModelSelection,
        threadRuntimeMode: runtimeMode,
        threadInteractionMode: interactionMode,
      });
      if (
        !targetThreadId ||
        !mounted.current ||
        scope.current !== creationKey ||
        !isAccountCurrent()
      ) {
        return null;
      }
      return {
        form: { ...form, targetThreadId },
        activityThreadId: targetThreadId,
      };
    },
    [
      activeThread,
      isAccountCurrent,
      creationKey,
      ensureAutomationTargetThread,
      interactionMode,
      isServerThread,
      runtimeMode,
      selectedModelSelection,
    ],
  );

  const submitAutomationDraft = useCallback(async () => {
    if (!automationDraftForm) {
      return;
    }
    if (
      !isFormSubmittable(automationDraftForm) ||
      hasBlockingAutomationDraftWarnings(automationDraftWarnings, acknowledgedAutomationWarnings)
    ) {
      return;
    }
    const preparedCreate = await prepareAutomationFormForCreate(automationDraftForm);
    if (!preparedCreate) {
      return;
    }
    await createAutomationFromForm({
      form: preparedCreate.form,
      warnings: automationDraftWarnings,
      acknowledgedWarningIds: acknowledgedAutomationWarnings,
      activityThreadId: preparedCreate.activityThreadId,
    });
  }, [
    acknowledgedAutomationWarnings,
    automationDraftForm,
    automationDraftWarnings,
    createAutomationFromForm,
    prepareAutomationFormForCreate,
  ]);
  return {
    createAutomationFromForm,
    prepareAutomationFormForCreate,
    submitAutomationDraft,
    automationCreationPending: creation.pending,
    automationCreationPendingOpen,
    setAutomationCreationPendingOpen,
    automationCreationError,
    retryAutomationCreation: () =>
      creation.pending ? runCreation(creation.pending) : Promise.resolve(false),
  };
}
