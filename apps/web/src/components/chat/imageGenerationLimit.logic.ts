// FILE: imageGenerationLimit.logic.ts
// Purpose: Select and fold durable image-generation limit activities for the composer banner.
// Layer: Chat composer domain logic
// Exports: strict activity parsers, stable store selector, lifecycle reducer, copy/priority helpers

import type {
  OrchestrationThreadActivity,
  ProviderInstanceId,
  ProviderKind,
  ThreadId,
} from "@synara/contracts";

import type { AppState } from "../../storeState";
import {
  resolveComposerAccountSourceKind,
  type ComposerAccountSourceKind,
} from "./providerAccountSources";

export const IMAGE_GENERATION_LIMIT_ID = "image_gen" as const;
export const IMAGE_GENERATION_USAGE_LIMIT_KIND = "codex.image_generation.usage_limit" as const;
export const GENERATED_IMAGE_ARTIFACT_KIND = "codex.generated_image" as const;
export const PERSONAL_IMAGE_USAGE_URL = "https://chatgpt.com/codex/settings/usage" as const;

type RecordValue = Record<string, unknown>;

export interface ImageGenerationLimitActivitySlice {
  readonly threadId: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export interface ImageGenerationLimitFailure {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly activityId: string;
  readonly createdAt: string;
  readonly completionTimeMs: number;
  readonly resetsAt: number | null;
  readonly failureIdentity: string;
}

export type ImageGenerationLimitEvent =
  | {
      readonly kind: "failure";
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: string;
      readonly turnId: string | null;
      readonly activityId: string;
      readonly createdAt: string;
      readonly completionTimeMs: number;
      readonly resetsAt: number | null;
      readonly sequence: number | null;
      readonly sourceOrder: number;
    }
  | {
      readonly kind: "success";
      readonly providerInstanceId: ProviderInstanceId;
      readonly threadId: string;
      readonly turnId: string | null;
      readonly activityId: string;
      readonly createdAt: string;
      readonly completionTimeMs: number;
      readonly sequence: number | null;
      readonly sourceOrder: number;
    };

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseEpochSeconds(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseActivityBase(
  activity: Pick<OrchestrationThreadActivity, "id" | "kind" | "createdAt" | "turnId" | "sequence">,
  threadId: string,
  sourceOrder: number,
) {
  if (activity.kind !== "tool.completed") return null;
  const createdAt = nonEmptyString(activity.createdAt);
  const completionTimeMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!createdAt || !Number.isFinite(completionTimeMs)) return null;
  const activityId = nonEmptyString(activity.id);
  if (!activityId) return null;
  const turnId = activity.turnId == null ? null : String(activity.turnId);
  const sequence =
    typeof activity.sequence === "number" &&
    Number.isInteger(activity.sequence) &&
    activity.sequence >= 0
      ? activity.sequence
      : null;
  return {
    activityId,
    createdAt,
    completionTimeMs,
    sequence,
    sourceOrder,
    threadId,
    turnId,
  } as const;
}

/**
 * Parses the B3.1 failure shape closed. In particular, summary/detail text,
 * HTTP status, and arbitrary lookalike objects never create a failure.
 */
export function parseImageGenerationLimitActivity(
  activity: OrchestrationThreadActivity,
  threadId: string,
  sourceOrder = 0,
): ImageGenerationLimitEvent | null {
  const base = parseActivityBase(activity, threadId, sourceOrder);
  if (!base) return null;

  const payload = asRecord(activity.payload);
  if (!payload || payload.itemType !== "image_generation" || payload.status !== "failed") {
    return null;
  }
  const providerInstanceId = nonEmptyString(payload.providerInstanceId);
  const data = asRecord(payload.data);
  if (!providerInstanceId || !data) return null;
  if (
    data.kind !== IMAGE_GENERATION_USAGE_LIMIT_KIND ||
    data.type !== "usageLimitExceeded" ||
    data.limitId !== IMAGE_GENERATION_LIMIT_ID
  ) {
    return null;
  }
  const resetsAt = parseEpochSeconds(data.resetsAt);
  if (resetsAt === undefined) return null;

  return {
    kind: "failure",
    providerInstanceId: providerInstanceId as ProviderInstanceId,
    ...base,
    resetsAt,
  };
}

/**
 * Parses the only success representation that can clear an image limit: a
 * completed image lifecycle record with the canonical generated-image data.
 */
export function parseImageGenerationCompletionActivity(
  activity: OrchestrationThreadActivity,
  threadId: string,
  sourceOrder = 0,
): ImageGenerationLimitEvent | null {
  const base = parseActivityBase(activity, threadId, sourceOrder);
  if (!base) return null;

  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const providerInstanceId = nonEmptyString(payload?.providerInstanceId);
  const path = nonEmptyString(data?.path);
  if (
    !payload ||
    payload.itemType !== "image_generation" ||
    payload.status === "failed" ||
    !providerInstanceId ||
    data?.kind !== GENERATED_IMAGE_ARTIFACT_KIND ||
    !path
  ) {
    return null;
  }

  return {
    kind: "success",
    providerInstanceId: providerInstanceId as ProviderInstanceId,
    ...base,
  };
}

function parseRelevantActivity(
  activity: OrchestrationThreadActivity,
  threadId: string,
  sourceOrder: number,
): ImageGenerationLimitEvent | null {
  return (
    parseImageGenerationLimitActivity(activity, threadId, sourceOrder) ??
    parseImageGenerationCompletionActivity(activity, threadId, sourceOrder)
  );
}

/** Selects only structured image lifecycle completions from hydrated slices. */
export function selectRelevantImageGenerationActivities(
  slices: ReadonlyArray<ImageGenerationLimitActivitySlice>,
): ImageGenerationLimitEvent[] {
  const events: ImageGenerationLimitEvent[] = [];
  let sourceOrder = 0;
  for (const slice of slices) {
    for (const activity of slice.activities) {
      const event = parseRelevantActivity(activity, slice.threadId, sourceOrder);
      if (event) events.push(event);
      sourceOrder += 1;
    }
  }
  return events;
}

const EMPTY_ACTIVITY_IDS: readonly string[] = [];

/**
 * Store selector that only exposes relevant image activities and keeps its
 * result reference stable when unrelated streaming activities are appended.
 */
export function createImageGenerationLimitThreadSelector(): (
  state: Pick<AppState, "threadIds" | "activityIdsByThreadId" | "activityByThreadId">,
) => ReadonlyArray<ImageGenerationLimitActivitySlice> {
  type ThreadSelectionCache = {
    readonly activityIds: readonly string[] | undefined;
    readonly activityById: Readonly<Record<string, OrchestrationThreadActivity>> | undefined;
    readonly relevant: readonly OrchestrationThreadActivity[];
    readonly slice: ImageGenerationLimitActivitySlice | null;
  };

  let previousByThread = new Map<string, ThreadSelectionCache>();
  let previousResult: ReadonlyArray<ImageGenerationLimitActivitySlice> = [];

  return (state) => {
    const activityIdsByThreadId = state.activityIdsByThreadId ?? {};
    const threadIds = state.threadIds ?? Object.keys(activityIdsByThreadId);
    const nextByThread = new Map<string, ThreadSelectionCache>();
    const nextResult: ImageGenerationLimitActivitySlice[] = [];

    for (const threadId of threadIds) {
      const activityIds = activityIdsByThreadId[threadId as ThreadId];
      const activityById = state.activityByThreadId?.[threadId as ThreadId];
      const previous = previousByThread.get(threadId);
      let relevant = previous?.relevant ?? [];
      if (
        previous === undefined ||
        previous.activityIds !== activityIds ||
        previous.activityById !== activityById
      ) {
        const nextRelevant: OrchestrationThreadActivity[] = [];
        for (const activityId of activityIds ?? EMPTY_ACTIVITY_IDS) {
          const activity = activityById?.[activityId];
          if (!activity) continue;
          if (
            parseImageGenerationLimitActivity(activity, threadId) ||
            parseImageGenerationCompletionActivity(activity, threadId)
          ) {
            nextRelevant.push(activity);
          }
        }
        const relevantUnchanged =
          nextRelevant.length === relevant.length &&
          nextRelevant.every((activity, index) => relevant[index] === activity);
        relevant = relevantUnchanged ? relevant : nextRelevant;
      }

      const slice =
        relevant.length === 0
          ? null
          : previous?.slice && previous.slice.activities === relevant
            ? previous.slice
            : { threadId, activities: relevant };
      nextByThread.set(threadId, {
        activityIds,
        activityById,
        relevant,
        slice,
      });
      if (slice) nextResult.push(slice);
    }

    const unchanged =
      nextResult.length === previousResult.length &&
      nextResult.every((slice, index) => previousResult[index] === slice);
    previousByThread = nextByThread;
    if (unchanged) return previousResult;
    previousResult = nextResult;
    return previousResult;
  };
}

function compareEvents(left: ImageGenerationLimitEvent, right: ImageGenerationLimitEvent): number {
  if (left.completionTimeMs !== right.completionTimeMs) {
    return left.completionTimeMs - right.completionTimeMs;
  }
  if (left.sequence !== null || right.sequence !== null) {
    if (left.sequence === null) return 1;
    if (right.sequence === null) return -1;
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  }
  const activityIdOrder = left.activityId.localeCompare(right.activityId);
  if (activityIdOrder !== 0) return activityIdOrder;
  return left.sourceOrder - right.sourceOrder;
}

function eventFailure(
  event: Extract<ImageGenerationLimitEvent, { kind: "failure" }>,
): ImageGenerationLimitFailure {
  const failureIdentity = imageGenerationFailureIdentity({
    providerInstanceId: event.providerInstanceId,
    threadId: event.threadId,
    turnId: event.turnId,
    activityId: event.activityId,
    completionTimeMs: event.completionTimeMs,
  });
  return {
    providerInstanceId: event.providerInstanceId,
    threadId: event.threadId,
    turnId: event.turnId,
    activityId: event.activityId,
    createdAt: event.createdAt,
    completionTimeMs: event.completionTimeMs,
    resetsAt: event.resetsAt,
    failureIdentity,
  };
}

/** Folds durable completion order, keeping state independently per provider instance. */
export function foldImageGenerationLimitEvents(
  events: ReadonlyArray<ImageGenerationLimitEvent>,
): ReadonlyMap<ProviderInstanceId, ImageGenerationLimitFailure | null> {
  const byProvider = new Map<ProviderInstanceId, ImageGenerationLimitFailure | null>();
  for (const event of events.toSorted(compareEvents)) {
    const current = byProvider.get(event.providerInstanceId) ?? null;
    if (event.kind === "failure") {
      byProvider.set(event.providerInstanceId, eventFailure(event));
      continue;
    }
    // A successful image completion in the same thread and turn cannot clear
    // that turn's failure. It still counts as the newer completion because the
    // events were folded in durable order, so older replays cannot revive it.
    if (current && current.threadId === event.threadId && current.turnId === event.turnId) {
      continue;
    }
    byProvider.set(event.providerInstanceId, null);
  }
  return byProvider;
}

export function imageGenerationFailureIdentity(input: {
  providerInstanceId: ProviderInstanceId | string;
  threadId: string;
  turnId: string | null;
  activityId: string;
  completionTimeMs: number;
}): string {
  return [
    input.providerInstanceId,
    input.threadId,
    input.turnId ?? "",
    input.activityId,
    String(input.completionTimeMs),
  ].join("\u001f");
}

export function selectImageGenerationLimitState(input: {
  readonly slices: ReadonlyArray<ImageGenerationLimitActivitySlice>;
  readonly providerInstanceId: ProviderInstanceId | string | null | undefined;
  readonly nowEpochSeconds?: number;
  readonly dismissedFailureIdentity?: string | null;
}): ImageGenerationLimitFailure | null {
  if (!input.providerInstanceId) return null;
  const events = selectRelevantImageGenerationActivities(input.slices);
  const folded = foldImageGenerationLimitEvents(events);
  const failure = folded.get(input.providerInstanceId as ProviderInstanceId) ?? null;
  if (!failure) return null;
  if (
    failure.resetsAt !== null &&
    failure.resetsAt <= (input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000))
  ) {
    return null;
  }
  if (failure.failureIdentity === (input.dismissedFailureIdentity ?? null)) return null;
  return failure;
}

export type ImageGenerationLimitPresentationVariant =
  | "upgrade-plus"
  | "upgrade-pro"
  | "add-credits"
  | "retry"
  | "managed";

export type ImageGenerationLimitAction = "personal-usage" | "managed-usage" | null;

export interface ImageGenerationLimitPresentation {
  readonly sourceKind: ComposerAccountSourceKind;
  readonly variant: ImageGenerationLimitPresentationVariant;
  readonly action: ImageGenerationLimitAction;
}

export function normalizeImageGenerationPlanName(
  planName: string | null | undefined,
): string | null {
  const normalized = planName?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : null;
}

export function resolveImageGenerationLimitPresentation(input: {
  readonly sourceKind: ComposerAccountSourceKind;
  readonly planName?: string | null | undefined;
}): ImageGenerationLimitPresentation {
  if (input.sourceKind === "moss") {
    return { sourceKind: input.sourceKind, variant: "managed", action: "managed-usage" };
  }
  if (input.sourceKind !== "personal") {
    return { sourceKind: input.sourceKind, variant: "retry", action: null };
  }
  switch (normalizeImageGenerationPlanName(input.planName)) {
    case "free":
    case "go":
      return { sourceKind: input.sourceKind, variant: "upgrade-plus", action: "personal-usage" };
    case "plus":
    case "prolite":
    case "pro lite":
    case "pro 2x":
    case "pro (2x)":
      return { sourceKind: input.sourceKind, variant: "upgrade-pro", action: "personal-usage" };
    case "pro":
      return { sourceKind: input.sourceKind, variant: "add-credits", action: "personal-usage" };
    default:
      return { sourceKind: input.sourceKind, variant: "retry", action: null };
  }
}

export function resolveImageGenerationAccountSource(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
}): ComposerAccountSourceKind {
  return resolveComposerAccountSourceKind(input);
}

export type ComposerBannerPriority = "blocking" | "image" | "model" | "warning" | null;

export function selectComposerBannerPriority(input: {
  readonly showUpsell?: boolean;
  readonly showWorkspaceUsageLimit?: boolean;
  readonly showProviderHealthLimit?: boolean;
  readonly hasImageGenerationLimit?: boolean;
  readonly showModelLimit?: boolean;
  readonly showWarning?: boolean;
}): ComposerBannerPriority {
  if (input.showUpsell || input.showWorkspaceUsageLimit || input.showProviderHealthLimit) {
    return "blocking";
  }
  if (input.hasImageGenerationLimit) return "image";
  if (input.showModelLimit) return "model";
  if (input.showWarning) return "warning";
  return null;
}

export function shouldShowImageGenerationLimitBanner(input: {
  readonly hasImageGenerationLimit: boolean;
  readonly showMossQuotaExhausted?: boolean;
  readonly hardRateLimit?: boolean;
  readonly providerHealthUnavailable?: boolean;
}): boolean {
  return (
    input.hasImageGenerationLimit &&
    !input.showMossQuotaExhausted &&
    !input.hardRateLimit &&
    !input.providerHealthUnavailable
  );
}

/** Formats the reset time differently for the same day and for other days. */
export function formatImageGenerationResetDate(
  resetsAt: number | null | undefined,
  locale: string,
  nowMs = Date.now(),
): string | null {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt < 0) {
    return null;
  }
  const resetDate = new Date(resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  const nowDate = new Date(nowMs);
  const sameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();
  return sameDay
    ? resetDate.toLocaleTimeString(locale, { timeStyle: "short" })
    : resetDate.toLocaleString(locale, { timeStyle: "short", dateStyle: "medium" });
}

/** Returns the one-shot reset delay, or null when no timer is required. */
const MAX_IMAGE_GENERATION_LIMIT_TIMEOUT_MS = 2_147_483_647;

export function getImageGenerationLimitResetDelayMs(
  resetsAt: number | null | undefined,
  nowMs: number,
): number | null {
  if (resetsAt === null || resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt < 0) {
    return null;
  }
  const delayMs = resetsAt * 1_000 - nowMs;
  return delayMs > 0 ? Math.min(delayMs, MAX_IMAGE_GENERATION_LIMIT_TIMEOUT_MS) : null;
}
