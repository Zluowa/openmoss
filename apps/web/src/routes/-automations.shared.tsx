import { StatusDot } from "~/components/ui/status-chip";
import {
  localizedTemplateText,
  SCHEDULED_PAGE_COPY,
  type ScheduledTaskTemplate,
} from "@moss/shared/scheduledTaskTemplates";
import {
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationId,
  type AutomationListResult,
  type AutomationMemory,
  type AutomationMode,
  type AutomationNotificationPolicy,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
  type ModelSelection,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
} from "@moss/contracts";
import { automationRequiresTargetThread } from "@moss/shared/automationMode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getProviderInstanceOptions,
  resolveSelectableProviderInstanceId,
  useAppSettings,
} from "~/appSettings";
import type { Thread } from "~/types";
import {
  ComposerPickerMenuPopup,
  ComposerPickerSelectPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { HitArea } from "~/components/ui/hit-area";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { TimePicker } from "~/components/ui/time-picker";
import { toastManager } from "~/components/ui/toast";
import type { AutomationDraftWarning, AutomationDraftWarningId } from "~/lib/automationDraft";
import {
  acknowledgedRiskIdsForFormWarnings,
  applyScheduleToForm,
  automationFastIntervalLimitMessage,
  automationFormSubmitBlockReason,
  automationIntervalPresetOptions,
  buildAutomationFormWarnings,
  createInputFromForm,
  datetimeLocalFromIso,
  defaultModelSelection,
  formatCadence,
  formatCadenceLong,
  formatClockTime,
  formatDateTime,
  formatNextRun,
  formatSchedule,
  formFromDefinition,
  groupAutomationsByContinuedThread,
  automationsForThread,
  intervalFormPartsFromSeconds,
  isFormSubmittable,
  isoFromDatetimeLocal,
  modelSelectionForProjectChange,
  projectModelSelection,
  providerOptionsForAutomationModelSelection,
  scheduleFromForm,
  scheduleFromKind,
  scheduleKindFromSchedule,
  SCHEDULE_KIND_OPTIONS,
  TIME_OF_DAY_PATTERN,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  weekdayLabel,
  type AutomationCreateDraft,
  type AutomationFormState,
  type IntervalUnit,
  type ScheduleKind,
} from "~/lib/automationForm";
import {
  automationFailurePolicyOptions,
  type AutomationFailurePolicyValue,
} from "~/lib/automationFailurePolicy";
import { ClockIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import { useTranslation } from "~/localization";
import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
  providerSupportsAutoRuntimeMode,
} from "~/lib/runtimeMode";
import { findProviderStatus } from "~/lib/providerAvailability";
import { cn } from "~/lib/utils";
import {
  SETTINGS_CONTROL_RADIUS_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { buildModelSelection } from "~/providerModelOptions";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useStore } from "~/store";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";
import { isSidechatThread } from "@moss/shared/sidechatThread";

export const automationQueryKey = ["automations"] as const;
export const EMPTY_AUTOMATION_LIST: AutomationListResult = {
  definitions: [],
  runs: [],
  memories: [],
};
const AUTOMATION_DEFINITION_UPDATE_SCOPE = {
  id: "automation-definition-updates",
} as const;

export function automationTargetThreads<
  TThread extends Pick<Thread, "projectId" | "sidechatSourceThreadId" | "sidechatContext">,
>(threads: readonly TThread[], projectId: string): readonly TThread[] {
  return threads.filter((thread) => thread.projectId === projectId && !isSidechatThread(thread));
}

export function automationDefinitionUpdateMutationOptions(
  mutationFn: (input: AutomationUpdateInput) => Promise<AutomationDefinition>,
) {
  return { scope: AUTOMATION_DEFINITION_UPDATE_SCOPE, mutationFn };
}

export {
  acknowledgedRiskIdsForFormWarnings,
  applyScheduleToForm,
  automationFastIntervalLimitMessage,
  automationFormSubmitBlockReason,
  automationIntervalPresetOptions,
  buildAutomationFormWarnings,
  createInputFromForm,
  datetimeLocalFromIso,
  defaultModelSelection,
  formatCadence,
  formatCadenceLong,
  formatClockTime,
  formatDateTime,
  formatNextRun,
  formatSchedule,
  formFromDefinition,
  groupAutomationsByContinuedThread,
  automationsForThread,
  isFormSubmittable,
  isoFromDatetimeLocal,
  modelSelectionForProjectChange,
  projectModelSelection,
  providerOptionsForAutomationModelSelection,
  scheduleFromForm,
  scheduleFromKind,
  scheduleKindFromSchedule,
  SCHEDULE_KIND_OPTIONS,
  TIME_OF_DAY_PATTERN,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  weekdayLabel,
  type AutomationFormState,
  type IntervalUnit,
  type ScheduleKind,
};

/** Starter prompts surfaced behind the composer's "Use template" button. */
export const AUTOMATION_TEMPLATES: readonly {
  readonly label: string;
  readonly name: string;
  readonly prompt: string;
}[] = [
  {
    label: "Triage new crashes",
    name: "Triage crashes",
    prompt: "Look for new crashes in $sentry and open a fix PR for the most impactful one.",
  },
  {
    label: "Update dependencies",
    name: "Update dependencies",
    prompt:
      "Check for outdated dependencies, bump the safe minor and patch versions, then run the tests.",
  },
  {
    label: "Daily standup summary",
    name: "Daily summary",
    prompt:
      "Summarize what changed on the main branch in the last 24 hours as a short standup update.",
  },
];

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function runStatusVariant(
  status: AutomationRun["status"],
): "success" | "warning" | "error" | "info" | "outline" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "error";
    case "waiting-for-approval":
    case "skipped":
      return "warning";
    case "running":
    case "claimed":
    case "pending":
      return "info";
  }
}

/** Status-colored dot/icon class for a single run, shared by the detail history and triage rows. */
export function runStatusDotClassName(status: AutomationRun["status"]): string {
  switch (runStatusVariant(status)) {
    case "success":
      return "text-emerald-500";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-amber-500";
    case "info":
      return "text-blue-500";
    case "outline":
      return "text-muted-foreground/50";
  }
}

/**
 * True when a click/keydown originated from an interactive control nested inside a clickable
 * row (delete button, link, input, etc.) rather than the row surface itself. Row components use
 * it to let inner controls handle their own events without also triggering the row's action.
 */
export function isRowInteractiveEventTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false;
  }
  return Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true']"));
}

/**
 * Leading status glyph for a single run row: a quiet check for success, otherwise a
 * status-colored dot. Shared by the detail history and the list triage rows so both
 * surfaces read identically.
 */
export function RunStatusIndicator({
  status,
  className,
}: {
  readonly status: AutomationRun["status"];
  readonly className?: string;
}) {
  if (runStatusVariant(status) === "success") {
    return (
      <CentralIcon
        name="circle-check"
        className={cn("size-4 shrink-0 text-muted-foreground/70", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        runStatusDotClassName(status),
        className,
      )}
    >
      <StatusDot className="block bg-current" />
    </span>
  );
}

export function isTriageRun(run: AutomationRun): boolean {
  if (run.status === "waiting-for-approval") {
    return true;
  }
  if (run.result) {
    return run.finishedAt !== null && isUnresolvedTriageResult(run.result);
  }
  return run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

export function isUnresolvedTriageResult(result: AutomationRunResult | null): boolean {
  return Boolean(result && result.unread && result.archivedAt === null);
}

export function unresolvedTriageRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.filter((run) => isTriageRun(run));
}

export function automationAttentionCount(runs: readonly AutomationRun[]): number {
  return unresolvedTriageRuns(runs).length;
}

export function runStatusLabel(status: AutomationRun["status"]): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "claimed":
      return "Starting";
    case "running":
      return "Running";
    case "waiting-for-approval":
      return "Waiting for approval";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "skipped":
      return "Skipped";
  }
}

export function runResultSummary(run: AutomationRun): string {
  if (run.result?.summary) return run.result.summary;
  if (run.error) return run.error;
  switch (run.result?.outcome) {
    case "findings":
      return "Found something to review";
    case "no-findings":
      return "No findings";
    case "changed-files":
      return "Changed files";
    case "needs-attention":
      return "Needs attention";
    case "unknown":
      return run.threadId ? "Completed; open the thread for the reply" : "Completed";
    case undefined:
      return runStatusLabel(run.status);
  }
}

export function runResultTitle(run: AutomationRun): string | null {
  const title = run.result?.title?.trim();
  return title ? title : null;
}

export function canCancelAutomationRun(run: AutomationRun): boolean {
  return (
    run.status === "pending" ||
    run.status === "claimed" ||
    run.status === "running" ||
    run.status === "waiting-for-approval"
  );
}

/**
 * Plain-language warning for a latest run that needs the user's attention, or null when
 * the run ended normally (or is still progressing). Drives the amber glyph and the
 * subtitle warning segment on automation list rows.
 */
export function automationAttentionLabel(run: AutomationRun): string | null {
  switch (run.status) {
    case "waiting-for-approval":
      return "Waiting for approval";
    case "failed":
      return "Last run failed";
    case "cancelled":
      return "Last run cancelled";
    case "interrupted":
      return "Last run interrupted";
    default:
      return null;
  }
}

type LiveAutomationRun = AutomationRun & {
  readonly status: "pending" | "claimed" | "running" | "waiting-for-approval";
};

export function isLiveRun(run: AutomationRun | null): run is LiveAutomationRun {
  return (
    run?.status === "pending" ||
    run?.status === "claimed" ||
    run?.status === "running" ||
    run?.status === "waiting-for-approval"
  );
}

/**
 * Icon + tint for an automation list row's leading status glyph.
 * - Live runs spin with a circular loading glyph.
 * - Completed successful runs show a checkmark circle.
 * - Failed/cancelled/interrupted runs keep the warning exclamation.
 * - Scheduled (enabled with a future next run) shows a clock.
 * - Paused automations show a pause glyph.
 */
export function automationListRowIcon(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
): { readonly name: string; readonly className: string } {
  // Pausing prevents future dispatches but does not cancel an in-flight run, so the
  // active run state must take precedence over the definition's enabled flag.
  if (isLiveRun(latestRun)) {
    return {
      name: "loading-circle",
      className: "size-4 animate-spin text-blue-500 motion-reduce:animate-none",
    };
  }
  if (!definition.enabled) {
    // Auto-disabled after consecutive failures is a problem to look at, not a pause the
    // user chose — keep the warning glyph so the row doesn't read as intentionally idle.
    if (definition.disabledReason === "failures") {
      return { name: "exclamation-circle", className: "size-4 text-amber-500" };
    }
    return { name: "pause", className: "size-4 text-muted-foreground/40" };
  }
  if (latestRun?.status === "succeeded") {
    return { name: "circle-check", className: "size-4 text-green-500" };
  }
  if (latestRun && automationAttentionLabel(latestRun) !== null) {
    return { name: "exclamation-circle", className: "size-4 text-amber-500" };
  }
  if (definition.nextRunAt) {
    return { name: "clock", className: "size-4 text-foreground/70" };
  }
  return { name: "circle-placeholder-on", className: "size-4 text-foreground/70" };
}

const deletedAutomationIdsInCache = new Set<string>();

function isNewerTimestamp(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) > 0;
}

// Snapshots are reconciliation data, so equal timestamps keep the live cache winner.
function isSameOrNewerTimestamp(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) >= 0;
}

function mergeDefinitionsByUpdatedAt(
  snapshotDefinitions: readonly AutomationDefinition[],
  previousDefinitions: readonly AutomationDefinition[],
): AutomationDefinition[] {
  const previousById = new Map(
    previousDefinitions.map((definition) => [definition.id, definition]),
  );
  const seen = new Set<string>();
  const definitions: AutomationDefinition[] = [];
  for (const snapshotDefinition of snapshotDefinitions) {
    if (deletedAutomationIdsInCache.has(snapshotDefinition.id)) {
      continue;
    }
    seen.add(snapshotDefinition.id);
    const previousDefinition = previousById.get(snapshotDefinition.id);
    definitions.push(
      previousDefinition &&
        isSameOrNewerTimestamp(previousDefinition.updatedAt, snapshotDefinition.updatedAt)
        ? previousDefinition
        : snapshotDefinition,
    );
  }
  return definitions;
}

function upsertDefinitionByUpdatedAt(
  definitions: readonly AutomationDefinition[],
  incoming: AutomationDefinition,
): AutomationDefinition[] {
  const existing = definitions.find((definition) => definition.id === incoming.id);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...definitions];
  }
  return existing
    ? definitions.map((definition) => (definition.id === incoming.id ? incoming : definition))
    : [incoming, ...definitions];
}

function mergeRunsByUpdatedAt(
  snapshotRuns: readonly AutomationRun[],
  previousRuns: readonly AutomationRun[],
  visibleAutomationIds?: ReadonlySet<AutomationId>,
): AutomationRun[] {
  const previousById = new Map(previousRuns.map((run) => [run.id, run]));
  const runs: AutomationRun[] = [];
  for (const snapshotRun of snapshotRuns) {
    if (
      deletedAutomationIdsInCache.has(snapshotRun.automationId) ||
      (visibleAutomationIds && !visibleAutomationIds.has(snapshotRun.automationId))
    ) {
      continue;
    }
    const previousRun = previousById.get(snapshotRun.id);
    runs.push(
      previousRun && isSameOrNewerTimestamp(previousRun.updatedAt, snapshotRun.updatedAt)
        ? previousRun
        : snapshotRun,
    );
  }
  return runs;
}

function upsertRunByUpdatedAt(
  runs: readonly AutomationRun[],
  incoming: AutomationRun,
): AutomationRun[] {
  const existing = runs.find((run) => run.id === incoming.id);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...runs];
  }
  return existing
    ? runs.map((run) => (run.id === incoming.id ? incoming : run))
    : [incoming, ...runs];
}

function mergeMemoriesByUpdatedAt(
  snapshotMemories: readonly AutomationMemory[],
  previousMemories: readonly AutomationMemory[],
  visibleAutomationIds: ReadonlySet<AutomationId>,
): AutomationMemory[] {
  const previousByAutomationId = new Map(
    previousMemories.map((memory) => [memory.automationId, memory]),
  );
  const seen = new Set<AutomationId>();
  const memories: AutomationMemory[] = [];
  for (const snapshotMemory of snapshotMemories) {
    if (!visibleAutomationIds.has(snapshotMemory.automationId)) {
      continue;
    }
    seen.add(snapshotMemory.automationId);
    const previousMemory = previousByAutomationId.get(snapshotMemory.automationId);
    memories.push(
      previousMemory && isSameOrNewerTimestamp(previousMemory.updatedAt, snapshotMemory.updatedAt)
        ? previousMemory
        : snapshotMemory,
    );
  }
  for (const previousMemory of previousMemories) {
    if (
      !seen.has(previousMemory.automationId) &&
      visibleAutomationIds.has(previousMemory.automationId)
    ) {
      memories.push(previousMemory);
    }
  }
  return memories;
}

function upsertMemoryByUpdatedAt(
  memories: readonly AutomationMemory[],
  incoming: AutomationMemory,
): AutomationMemory[] {
  const existing = memories.find((memory) => memory.automationId === incoming.automationId);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...memories];
  }
  return existing
    ? memories.map((memory) => (memory.automationId === incoming.automationId ? incoming : memory))
    : [incoming, ...memories];
}

export function applyAutomationEvent(
  prev: AutomationListResult | undefined,
  event: AutomationStreamEvent,
): AutomationListResult {
  const base = prev ?? EMPTY_AUTOMATION_LIST;
  switch (event.type) {
    case "snapshot": {
      const definitions = mergeDefinitionsByUpdatedAt(event.definitions, base.definitions);
      const visibleAutomationIds = new Set(definitions.map((definition) => definition.id));
      return {
        definitions,
        runs: mergeRunsByUpdatedAt(event.runs, base.runs, visibleAutomationIds),
        memories: mergeMemoriesByUpdatedAt(
          event.memories ?? [],
          base.memories ?? [],
          visibleAutomationIds,
        ),
      };
    }
    case "definition-upserted": {
      if (deletedAutomationIdsInCache.has(event.definition.id)) {
        return base;
      }
      deletedAutomationIdsInCache.delete(event.definition.id);
      const definitions = upsertDefinitionByUpdatedAt(base.definitions, event.definition);
      return { definitions, runs: base.runs, memories: base.memories ?? [] };
    }
    case "definition-deleted":
      deletedAutomationIdsInCache.add(event.automationId);
      return {
        definitions: base.definitions.filter((definition) => definition.id !== event.automationId),
        runs: base.runs.filter((run) => run.automationId !== event.automationId),
        memories: (base.memories ?? []).filter(
          (memory) => memory.automationId !== event.automationId,
        ),
      };
    case "run-upserted": {
      if (deletedAutomationIdsInCache.has(event.run.automationId)) {
        return base;
      }
      const runs = upsertRunByUpdatedAt(base.runs, event.run);
      return { definitions: base.definitions, runs, memories: base.memories ?? [] };
    }
    case "memory-upserted": {
      const currentMemories = base.memories ?? [];
      const memories = upsertMemoryByUpdatedAt(currentMemories, event.memory);
      return { definitions: base.definitions, runs: base.runs, memories };
    }
  }
}

/**
 * Roll back only the fields a failed update patched. Restoring the whole pre-mutation list
 * snapshot would also clobber everything that landed after it — a second inline edit's
 * optimistic merge, stream upserts — so the failed patch's keys are restored from the
 * pre-merge definition into the definition as it exists in the cache *now*. Input keys the
 * definition never had (legacy aliases) are removed rather than restored.
 */
export function rollbackAutomationDefinitionPatch(
  list: AutomationListResult,
  input: AutomationUpdateInput,
  previousDefinition: AutomationDefinition,
): AutomationListResult {
  return {
    definitions: list.definitions.map((definition) => {
      if (definition.id !== input.id) return definition;
      const next: Record<string, unknown> = { ...definition };
      for (const key of Object.keys(input)) {
        if (key === "id") continue;
        // A newer optimistic patch or authoritative stream event may already have
        // replaced this field while the failed request was in flight. Only undo the
        // value this mutation itself installed; otherwise an older failure can erase
        // the newer edit.
        if (!Object.is(next[key], (input as unknown as Record<string, unknown>)[key])) {
          continue;
        }
        if (key in previousDefinition) {
          next[key] = (previousDefinition as unknown as Record<string, unknown>)[key];
        } else {
          delete next[key];
        }
      }
      return next as unknown as AutomationDefinition;
    }),
    runs: list.runs,
    memories: list.memories ?? [],
  };
}

export function useAutomations(onRunStarted?: (threadId: ThreadId) => void) {
  const queryClient = useQueryClient();

  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  const data = automationsQuery.data ?? EMPTY_AUTOMATION_LIST;

  const createMutation = useMutation({
    mutationFn: (input: AutomationCreateInput) => ensureNativeApi().automation.create(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const updateMutation = useMutation({
    ...automationDefinitionUpdateMutationOptions((input) =>
      ensureNativeApi().automation.update(input),
    ),
    // Optimistically merge the patch so inline edits on the detail page feel instant; the
    // server's authoritative definition (with recomputed nextRunAt) arrives via the stream.
    onMutate: (input) => {
      const previous = queryClient.getQueryData<AutomationListResult>(automationQueryKey);
      const previousDefinition =
        previous?.definitions.find((definition) => definition.id === input.id) ?? null;
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) => {
        const base = prev ?? EMPTY_AUTOMATION_LIST;
        return {
          definitions: base.definitions.map((definition) =>
            definition.id === input.id
              ? ({ ...definition, ...input } as AutomationDefinition)
              : definition,
          ),
          runs: base.runs,
          memories: base.memories ?? [],
        };
      });
      return { previousDefinition };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error, input, context) => {
      // A failed update would otherwise leave its optimistic merge in the cache until the
      // next stream tick. Roll back just this patch's fields — not the whole snapshot, which
      // would also erase concurrent edits' merges (see rollbackAutomationDefinitionPatch).
      const previousDefinition = context?.previousDefinition;
      if (previousDefinition) {
        queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) =>
          prev ? rollbackAutomationDefinitionPatch(prev, input, previousDefinition) : prev,
        );
      }
      toastManager.add({ type: "error", title: error.message });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.delete({ id: definition.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const runNowMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.runNow({ automationId: definition.id }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKey });
      if (result.run.threadId) onRunStarted?.(result.run.threadId);
    },
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const cancelRunMutation = useMutation({
    mutationFn: (run: AutomationRun) => ensureNativeApi().automation.cancelRun({ runId: run.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const markRunReadMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly unread: boolean }) =>
      ensureNativeApi().automation.markRunRead({ runId: input.run.id, unread: input.unread }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const archiveRunMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly archived: boolean }) =>
      ensureNativeApi().automation.archiveRun({ runId: input.run.id, archived: input.archived }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });

  const runsByAutomationId = new Map<string, AutomationRun[]>();
  for (const run of data.runs) {
    const runs = runsByAutomationId.get(run.automationId) ?? [];
    runs.push(run);
    runsByAutomationId.set(run.automationId, runs);
  }
  for (const runs of runsByAutomationId.values()) {
    runs.sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
  }

  return {
    data,
    isLoading: automationsQuery.isLoading,
    error: automationsQuery.error,
    refetch: automationsQuery.refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    markRunReadMutation,
    archiveRunMutation,
    runsByAutomationId,
  };
}

type CadenceOption = { readonly value: string; readonly label: string };

/** Heartbeat run-count presets ("" = unlimited). */
const MAX_ITERATION_PRESETS: readonly CadenceOption[] = [
  { value: "", label: "Unlimited" },
  { value: "10", label: "10 runs" },
  { value: "25", label: "25 runs" },
  { value: "50", label: "50 runs" },
  { value: "100", label: "100 runs" },
  { value: "250", label: "250 runs" },
];

function maxIterationLabel(value: string): string {
  return value === "1" ? "1 run" : `${value} runs`;
}

export function maxIterationOptions(
  currentValue: string | number | null | undefined,
): readonly { readonly value: string; readonly label: string }[] {
  const value = currentValue == null ? "" : String(currentValue).trim();
  if (!/^\d+$/.test(value) || MAX_ITERATION_PRESETS.some((preset) => preset.value === value)) {
    return MAX_ITERATION_PRESETS;
  }
  return [{ value, label: maxIterationLabel(value) }, ...MAX_ITERATION_PRESETS];
}

// Shown at the top of an automation's detail panel when saving or manual run actions need
// one-time risk approval.
export function AutomationApprovalBanner({
  warnings,
  busy,
  onApprove,
  onApproveAndRun,
}: {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onApproveAndRun: () => void;
}) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning">
      <AlertTitle>Approval needed</AlertTitle>
      <AlertDescription>
        <span>Moss saves your changes only after you approve.</span>
        <ul className="flex flex-col gap-1.5">
          {warnings.map((warning) => (
            <li key={warning.id} className="text-ui leading-snug">
              <span className="font-medium text-foreground/90">{warning.title}</span>
              <span className="block">{warning.detail}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={onApproveAndRun}>
            Approve &amp; run now
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function AutomationModelPicker({
  value,
  projectCwd,
  disabled,
  onChange,
  onAutoModeSupportChange,
}: {
  readonly value: ModelSelection;
  readonly projectCwd: string | null;
  readonly disabled?: boolean;
  readonly onChange: (value: ModelSelection) => void;
  readonly onAutoModeSupportChange?: (supported: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [open, setOpen] = useState(false);
  const providerInstances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const selectedProviderInstanceId = useMemo(
    () => resolveSelectableProviderInstanceId(settings, value.provider, value.instanceId),
    [settings, value.instanceId, value.provider],
  );
  const modelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [value.provider]: value.model }),
    [value.model, value.provider],
  );
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: projectCwd,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    selectedRuntimeModel,
  } = useProviderModelCatalog({
    selectedProvider: value.provider,
    selectedProviderInstanceId,
    discoveryEnabled: open,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider,
  });
  const providerStatus = findProviderStatus(
    providerStatuses,
    value.provider,
    selectedProviderInstanceId,
  );
  const persistedRuntimeModel =
    value.provider === "claudeAgent" && typeof value.supportsAutoMode === "boolean"
      ? {
          slug: value.model,
          name: value.model,
          supportsAutoMode: value.supportsAutoMode,
        }
      : undefined;
  const autoModeSupported = providerModelSupportsAutoRuntimeMode(
    value.provider,
    selectedRuntimeModel ?? persistedRuntimeModel,
    providerStatus,
  );
  useEffect(() => {
    onAutoModeSupportChange?.(autoModeSupported);
  }, [autoModeSupported, onAutoModeSupportChange]);

  return (
    <ProviderModelPicker
      compact
      provider={value.provider}
      model={value.model}
      lockedProvider={null}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      modelOptionsByProviderInstance={modelOptionsByProviderInstance}
      loadingModelProviders={loadingModelProviders}
      discoveryErrorsByProvider={discoveryErrorsByProvider}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      disabled={disabled ?? false}
      open={open}
      onOpenChange={setOpen}
      onProviderModelChange={(provider, model, instanceId) => {
        const runtimeModel = resolveRuntimeModelDescriptor({
          provider,
          model,
          runtimeModels: runtimeModelsByProvider[provider],
        });
        onChange(
          buildModelSelection(provider, model, undefined, runtimeModel?.supportsAutoMode, {
            instanceId: instanceId ?? provider,
          }),
        );
      }}
      providerInstances={providerInstances}
      selectedProviderInstanceId={selectedProviderInstanceId}
    />
  );
}

export function reconcileAutomationFormAutoModeSupport(
  form: AutomationFormState,
  supported: boolean,
): AutomationFormState {
  const modelSelection =
    form.modelSelection.provider === "claudeAgent" &&
    form.modelSelection.supportsAutoMode !== supported
      ? { ...form.modelSelection, supportsAutoMode: supported }
      : form.modelSelection;
  const runtimeMode =
    !supported && form.runtimeMode === "auto" ? "approval-required" : form.runtimeMode;
  return modelSelection !== form.modelSelection || runtimeMode !== form.runtimeMode
    ? { ...form, modelSelection, runtimeMode }
    : form;
}

export function createDraftFromTemplate(
  template: ScheduledTaskTemplate,
  isZh: boolean,
): AutomationCreateDraft {
  const base = {
    name: localizedTemplateText(template.title, isZh),
    prompt: localizedTemplateText(template.prompt, isZh),
  };
  switch (template.schedule.kind) {
    case "daily":
      return {
        ...base,
        scheduleKind: "daily",
        timeOfDay: template.schedule.timeOfDay,
      };
    case "weekdays":
      return {
        ...base,
        scheduleKind: "weekdays",
        timeOfDay: template.schedule.timeOfDay,
      };
    case "weekly":
      return {
        ...base,
        scheduleKind: "weekly",
        dayOfWeek: String(template.schedule.dayOfWeek),
        timeOfDay: template.schedule.timeOfDay,
      };
  }
}

function localizedScheduleKindLabel(kind: ScheduleKind, isZh: boolean): string {
  if (!isZh) {
    return SCHEDULE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
  }
  switch (kind) {
    case "daily":
      return "每天";
    case "weekdays":
      return "工作日";
    case "weekly":
      return "每周";
    case "hourly":
      return "每小时";
    case "custom":
      return "自定义间隔";
    case "once":
      return "仅一次";
    case "cron":
      return "Cron 表达式";
    case "manual":
      return "仅手动";
  }
}

function localizedWeekdayName(day: number, isZh: boolean): string {
  if (!isZh) return weekdayLabel(day);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day] ?? "周日";
}

function DialogFormRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
      <span className="shrink-0 text-ui text-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end">{children}</div>
    </div>
  );
}

export function AutomationDialog({
  open,
  form,
  projects,
  threads,
  warnings: warningsProp,
  acknowledgedWarningIds: acknowledgedWarningIdsProp,
  onOpenChange,
  onFormChange,
  onToggleWarning,
  onSubmit,
  busy,
  submitError,
}: {
  readonly open: boolean;
  readonly form: AutomationFormState;
  readonly projects: ReturnType<typeof useStore.getState>["projects"];
  readonly threads: ReadonlyArray<
    Pick<Thread, "id" | "projectId" | "title" | "sidechatSourceThreadId" | "sidechatContext">
  >;
  readonly warnings?: readonly AutomationDraftWarning[];
  readonly acknowledgedWarningIds?: ReadonlySet<AutomationDraftWarningId>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFormChange: (form: AutomationFormState) => void;
  readonly onToggleWarning?: (id: AutomationDraftWarningId, checked: boolean) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
  readonly submitError?: string | null;
}) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";
  const text = (entry: { readonly zh: string; readonly en: string }) =>
    localizedTemplateText(entry, isZh);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const warnings: readonly AutomationDraftWarning[] = warningsProp ?? [];
  const acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId> =
    acknowledgedWarningIdsProp ?? new Set<AutomationDraftWarningId>();
  const setField = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  const projectThreads = automationTargetThreads(threads, form.projectId);
  const selectedProject = projects.find((project) => project.id === form.projectId);
  const [selectedModelSupportsAuto, setSelectedModelSupportsAuto] = useState(() =>
    form.modelSelection.provider === "claudeAgent"
      ? form.modelSelection.supportsAutoMode !== false
      : providerSupportsAutoRuntimeMode(form.modelSelection.provider),
  );
  const handleAutoModeSupportChange = useCallback(
    (supported: boolean) => {
      setSelectedModelSupportsAuto(supported);
      const reconciled = reconcileAutomationFormAutoModeSupport(form, supported);
      if (reconciled !== form) {
        onFormChange(reconciled);
      }
    },
    [form, onFormChange],
  );
  const fastIntervalLimitMessage = automationFastIntervalLimitMessage(form);
  const submitBlockReason = automationFormSubmitBlockReason(form, warnings, acknowledgedWarningIds);
  const submittable = submitBlockReason === null;
  const maxIterationPresets = maxIterationOptions(form.maxIterations);
  const intervalAmount = Number.parseInt(form.intervalAmount, 10);
  const intervalSeconds = Number.isFinite(intervalAmount)
    ? form.intervalUnit === "seconds"
      ? intervalAmount
      : intervalAmount * 60
    : undefined;
  const intervalPresetOptions = automationIntervalPresetOptions({
    currentSeconds: intervalSeconds,
    includeHourly: false,
  });

  const chooseProject = (projectId: string) => {
    const targetStillMatches =
      form.targetThreadId.length > 0 &&
      threads.some((thread) => thread.id === form.targetThreadId && thread.projectId === projectId);
    const modelSelection = modelSelectionForProjectChange(
      projects,
      form.projectId,
      projectId,
      form.modelSelection,
    );
    onFormChange({
      ...form,
      projectId,
      modelSelection,
      runtimeMode: normalizeRuntimeModeForProvider(form.runtimeMode, modelSelection.provider),
      targetThreadId: targetStillMatches ? form.targetThreadId : "",
    });
  };

  const submit = () => {
    if (busy || !submittable) return;
    onSubmit();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  const showClockTime =
    form.scheduleKind === "daily" ||
    form.scheduleKind === "weekdays" ||
    form.scheduleKind === "weekly";
  const showTimezone = showClockTime || form.scheduleKind === "cron";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{text(SCHEDULED_PAGE_COPY.modalCreateTitle)}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {submitError ? (
            <Alert variant="error">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="scheduled-task-name">{text(SCHEDULED_PAGE_COPY.fieldName)}</Label>
            <Input
              id="scheduled-task-name"
              value={form.name}
              onChange={(event) => setField("name", event.target.value)}
              placeholder={text(SCHEDULED_PAGE_COPY.fieldNamePlaceholder)}
              aria-label="Automation title"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="scheduled-task-prompt">
              {text(SCHEDULED_PAGE_COPY.fieldInstructions)}
            </Label>
            <Textarea
              id="scheduled-task-prompt"
              value={form.prompt}
              onChange={(event) => setField("prompt", event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={text(SCHEDULED_PAGE_COPY.fieldInstructionsPlaceholder)}
              aria-label="Automation prompt"
              rows={4}
              className="min-h-24"
            />
          </div>

          <Card className={SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME}>
            <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldRepeat)}>
              <Select
                value={form.scheduleKind}
                onValueChange={(value) => {
                  if (value) setField("scheduleKind", value as ScheduleKind);
                }}
              >
                <SelectTrigger
                  variant="ghost"
                  size="sm"
                  className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto min-w-24")}
                  aria-label={text(SCHEDULED_PAGE_COPY.fieldRepeat)}
                >
                  <SelectValue>{localizedScheduleKindLabel(form.scheduleKind, isZh)}</SelectValue>
                </SelectTrigger>
                <ComposerPickerSelectPopup align="end">
                  {SCHEDULE_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {localizedScheduleKindLabel(option.value, isZh)}
                    </SelectItem>
                  ))}
                </ComposerPickerSelectPopup>
              </Select>
            </DialogFormRow>

            {form.scheduleKind === "weekly" ? (
              <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldWeekday)}>
                <Select
                  value={form.dayOfWeek}
                  onValueChange={(value) => {
                    if (value) setField("dayOfWeek", value);
                  }}
                >
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto min-w-20")}
                    aria-label={text(SCHEDULED_PAGE_COPY.fieldWeekday)}
                  >
                    <SelectValue>
                      {localizedWeekdayName(Number.parseInt(form.dayOfWeek, 10) || 0, isZh)}
                    </SelectValue>
                  </SelectTrigger>
                  <ComposerPickerSelectPopup align="end">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {localizedWeekdayName(day, isZh)}
                      </SelectItem>
                    ))}
                  </ComposerPickerSelectPopup>
                </Select>
              </DialogFormRow>
            ) : null}

            {showClockTime ? (
              <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldTime)}>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="sm" className="font-normal tabular-nums">
                        <ClockIcon className="size-3.5 text-muted-foreground" />
                        <span>{form.timeOfDay}</span>
                        <ChevronIconDown />
                      </Button>
                    }
                  />
                  <ComposerPickerMenuPopup align="end" className="p-1.5">
                    <TimePicker
                      className="w-44"
                      value={form.timeOfDay}
                      onChange={(value) => setField("timeOfDay", value)}
                    />
                  </ComposerPickerMenuPopup>
                </Menu>
              </DialogFormRow>
            ) : null}

            {form.scheduleKind === "custom" ? (
              <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldInterval)}>
                <Select
                  value={intervalSeconds === undefined ? "" : String(intervalSeconds)}
                  onValueChange={(value) => {
                    if (!value) return;
                    const seconds = Number.parseInt(value, 10);
                    if (!Number.isFinite(seconds) || seconds <= 0) return;
                    const parts = intervalFormPartsFromSeconds(seconds);
                    onFormChange({
                      ...form,
                      intervalUnit: parts.unit,
                      intervalAmount: parts.amount,
                    });
                  }}
                >
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto min-w-24")}
                    aria-label={text(SCHEDULED_PAGE_COPY.fieldInterval)}
                  >
                    <SelectValue>
                      {intervalPresetOptions.find(
                        (option) =>
                          option.value ===
                          (intervalSeconds === undefined ? "" : String(intervalSeconds)),
                      )?.label ?? ""}
                    </SelectValue>
                  </SelectTrigger>
                  <ComposerPickerSelectPopup align="end">
                    {intervalPresetOptions.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </ComposerPickerSelectPopup>
                </Select>
              </DialogFormRow>
            ) : null}

            {form.scheduleKind === "once" ? (
              <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldRunAt)}>
                <Input
                  type="datetime-local"
                  size="sm"
                  step={1}
                  value={form.onceRunAt}
                  onChange={(event) => setField("onceRunAt", event.target.value)}
                  className="max-w-52"
                />
              </DialogFormRow>
            ) : null}

            {form.scheduleKind === "cron" ? (
              <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldCron)}>
                <Input
                  size="sm"
                  value={form.cronExpression}
                  onChange={(event) => setField("cronExpression", event.target.value)}
                  placeholder="0 9 * * *"
                  className="max-w-44 font-mono"
                />
              </DialogFormRow>
            ) : null}
          </Card>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger
              render={
                <HitArea className="flex w-full items-center justify-between rounded-row px-1 py-1.5 text-ui text-muted-foreground hover:text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <DisclosureChevron open={advancedOpen} className="size-3.5" />
                    <span>{text(SCHEDULED_PAGE_COPY.advancedSettings)}</span>
                  </span>
                  <span className="truncate text-ui-sm text-muted-foreground/70">
                    {selectedProject?.name ?? ""}
                  </span>
                </HitArea>
              }
            />
            <CollapsiblePanel>
              <Card className={cn("mt-2", SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME)}>
                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldProject)}>
                  <Select
                    value={form.projectId}
                    onValueChange={(value) => {
                      if (value) chooseProject(value);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto max-w-48")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldProject)}
                    >
                      <SelectValue>
                        {selectedProject?.name ?? text(SCHEDULED_PAGE_COPY.fieldSelectProject)}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldAgentModel)}>
                  <AutomationModelPicker
                    value={form.modelSelection}
                    projectCwd={selectedProject?.cwd ?? null}
                    onChange={(value) => {
                      onFormChange({
                        ...form,
                        modelSelection: value,
                        runtimeMode: normalizeRuntimeModeForProvider(
                          form.runtimeMode,
                          value.provider,
                        ),
                      });
                    }}
                    onAutoModeSupportChange={handleAutoModeSupportChange}
                  />
                </DialogFormRow>

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldMode)}>
                  <Select
                    value={form.mode}
                    onValueChange={(value) => {
                      if (value) setField("mode", value as AutomationMode);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldMode)}
                    >
                      <SelectValue>
                        {isZh
                          ? form.mode === "standalone"
                            ? "每次新建对话"
                            : form.mode === "dedicated"
                              ? "专用对话"
                              : "在指定对话继续"
                          : form.mode === "standalone"
                            ? "Standalone"
                            : form.mode === "dedicated"
                              ? "Dedicated thread"
                              : "Heartbeat"}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      <SelectItem value="standalone">
                        {isZh ? "每次新建对话" : "Standalone"}
                      </SelectItem>
                      <SelectItem value="dedicated">
                        {isZh ? "专用对话" : "Dedicated thread"}
                      </SelectItem>
                      <SelectItem value="heartbeat">
                        {isZh ? "在指定对话继续" : "Heartbeat"}
                      </SelectItem>
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                {automationRequiresTargetThread(form.mode) ? (
                  <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldTargetThread)}>
                    <Select
                      value={form.targetThreadId}
                      disabled={projectThreads.length === 0}
                      onValueChange={(value) => {
                        if (value) setField("targetThreadId", value);
                      }}
                    >
                      <SelectTrigger
                        variant="ghost"
                        size="sm"
                        className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto max-w-48")}
                        aria-label={text(SCHEDULED_PAGE_COPY.fieldTargetThread)}
                      >
                        <SelectValue>
                          {projectThreads.find((t) => t.id === form.targetThreadId)
                            ? resolveThreadPickerTitle(
                                projectThreads.find((t) => t.id === form.targetThreadId)!.title,
                              )
                            : isZh
                              ? "选择对话"
                              : "Pick a thread"}
                        </SelectValue>
                      </SelectTrigger>
                      <ComposerPickerSelectPopup align="end">
                        {projectThreads.map((thread) => (
                          <SelectItem key={thread.id} value={thread.id}>
                            {resolveThreadPickerTitle(thread.title)}
                          </SelectItem>
                        ))}
                      </ComposerPickerSelectPopup>
                    </Select>
                  </DialogFormRow>
                ) : (
                  <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldWorkspace)}>
                    <Select
                      value={form.worktreeMode}
                      onValueChange={(value) => {
                        if (value) setField("worktreeMode", value as AutomationWorktreeMode);
                      }}
                    >
                      <SelectTrigger
                        variant="ghost"
                        size="sm"
                        className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                        aria-label={text(SCHEDULED_PAGE_COPY.fieldWorkspace)}
                      >
                        <SelectValue>
                          {isZh
                            ? form.worktreeMode === "auto"
                              ? "自动"
                              : form.worktreeMode === "worktree"
                                ? "独立工作树"
                                : "本地目录"
                            : form.worktreeMode}
                        </SelectValue>
                      </SelectTrigger>
                      <ComposerPickerSelectPopup align="end">
                        <SelectItem value="auto">{isZh ? "自动" : "Auto"}</SelectItem>
                        <SelectItem value="worktree">{isZh ? "独立工作树" : "Worktree"}</SelectItem>
                        <SelectItem value="local">{isZh ? "本地目录" : "Local"}</SelectItem>
                      </ComposerPickerSelectPopup>
                    </Select>
                  </DialogFormRow>
                )}

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldPermissions)}>
                  <Select
                    value={form.runtimeMode}
                    onValueChange={(value) => {
                      if (value) setField("runtimeMode", value as RuntimeMode);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldPermissions)}
                    >
                      <SelectValue>
                        {isZh
                          ? form.runtimeMode === "approval-required"
                            ? "需要批准"
                            : form.runtimeMode === "auto"
                              ? "自动批准"
                              : "完全访问"
                          : form.runtimeMode === "approval-required"
                            ? "Approval required"
                            : form.runtimeMode === "auto"
                              ? "Auto"
                              : "Full access"}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      <SelectItem value="approval-required">
                        {isZh ? "需要批准" : "Approval required"}
                      </SelectItem>
                      {selectedModelSupportsAuto ? (
                        <SelectItem value="auto">{isZh ? "自动批准" : "Auto"}</SelectItem>
                      ) : null}
                      <SelectItem value="full-access">
                        {isZh ? "完全访问" : "Full access"}
                      </SelectItem>
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldNotify)}>
                  <Select
                    value={form.notificationPolicy}
                    onValueChange={(value) => {
                      if (value)
                        setField("notificationPolicy", value as AutomationNotificationPolicy);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldNotify)}
                    >
                      <SelectValue>
                        {isZh
                          ? form.notificationPolicy === "all"
                            ? "全部运行"
                            : "仅失败时"
                          : form.notificationPolicy === "all"
                            ? "All runs"
                            : "Failed runs only"}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      <SelectItem value="all">{isZh ? "全部运行" : "All runs"}</SelectItem>
                      <SelectItem value="failed-runs-only">
                        {isZh ? "仅失败时" : "Failed runs only"}
                      </SelectItem>
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldOnFailure)}>
                  <Select
                    value={form.stopAfterFailures}
                    onValueChange={(value) => {
                      if (value)
                        setField("stopAfterFailures", value as AutomationFailurePolicyValue);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldOnFailure)}
                    >
                      <SelectValue>
                        {automationFailurePolicyOptions(form.stopAfterFailures).find(
                          (option) => option.value === form.stopAfterFailures,
                        )?.label ?? form.stopAfterFailures}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      {automationFailurePolicyOptions(form.stopAfterFailures).map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldMaxRuns)}>
                  <Select
                    value={form.maxIterations}
                    onValueChange={(value) => {
                      if (value !== null) setField("maxIterations", value);
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, "w-auto")}
                      aria-label={text(SCHEDULED_PAGE_COPY.fieldMaxRuns)}
                    >
                      <SelectValue>
                        {maxIterationPresets.find((preset) => preset.value === form.maxIterations)
                          ?.label ?? "Unlimited"}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup align="end">
                      {maxIterationPresets.map((preset) => (
                        <SelectItem key={preset.value || "unlimited"} value={preset.value}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </ComposerPickerSelectPopup>
                  </Select>
                </DialogFormRow>

                {showTimezone ? (
                  <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldTimezone)}>
                    <Input
                      size="sm"
                      value={form.timezone}
                      onChange={(event) => setField("timezone", event.target.value)}
                      placeholder="Asia/Shanghai"
                      className="max-w-44 text-right"
                    />
                  </DialogFormRow>
                ) : null}

                <DialogFormRow label={text(SCHEDULED_PAGE_COPY.fieldStopWhen)}>
                  <Input
                    size="sm"
                    value={form.stopWhen}
                    onChange={(event) => setField("stopWhen", event.target.value)}
                    placeholder={text(SCHEDULED_PAGE_COPY.fieldStopWhenPlaceholder)}
                    className="max-w-48 text-right"
                  />
                </DialogFormRow>
              </Card>
            </CollapsiblePanel>
          </Collapsible>

          {warnings.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
              {warnings.map((warning) => (
                <label
                  key={warning.id}
                  className="flex items-start gap-2 text-ui leading-snug text-muted-foreground"
                >
                  {warning.requiresAcknowledgement ? (
                    <input
                      type="checkbox"
                      checked={acknowledgedWarningIds.has(warning.id)}
                      onChange={(event) => onToggleWarning?.(warning.id, event.target.checked)}
                      className="mt-0.5"
                    />
                  ) : (
                    <StatusDot className="mt-1 bg-amber-500" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{warning.title}</span>
                    <span className="block">{warning.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {fastIntervalLimitMessage ? (
            <Alert variant="warning">
              <AlertDescription>{fastIntervalLimitMessage}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>

        <DialogFooter variant="bare" className="items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {submitBlockReason ? (
              <span
                className="block truncate text-ui-sm leading-snug text-muted-foreground"
                role="status"
              >
                {submitBlockReason}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {text(SCHEDULED_PAGE_COPY.cancel)}
            </Button>
            <Button type="button" onClick={submit} disabled={busy || !submittable}>
              {text(SCHEDULED_PAGE_COPY.create)}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChevronIconDown() {
  return <CentralIcon name="chevron-down-small" className="size-3.5 opacity-60" />;
}
