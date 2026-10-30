import { createHash } from "node:crypto";

import type {
  ComputerHistoryModelTimelineEntry,
  ComputerHistoryObservation,
  ComputerHistorySummaryInterval,
  ComputerHistorySummaryLevel,
  ComputerHistoryTimelineApplication,
  ComputerHistoryTimelineEntry,
  ComputerHistoryTimelineEntryDraft,
} from "@synara/contracts";
import { normalizeComputerHistorySemanticSummary } from "./store.ts";

export const COMPUTER_HISTORY_TEN_MINUTE_MS = 10 * 60 * 1_000;
export const COMPUTER_HISTORY_SIX_HOUR_MS = 6 * 60 * 60 * 1_000;
export const COMPUTER_HISTORY_SUGGESTION_WINDOW_MS = 48 * 60 * 60 * 1_000;

export type ComputerHistorySummaryKind = "10min" | "6h";

export interface ComputerHistorySummarySuggestion {
  readonly type: "skill" | "automation";
  readonly name: string;
  readonly description: string;
}

export interface ComputerHistoryProjectionRecord {
  readonly seq: number;
  readonly observation: ComputerHistoryObservation;
}

export interface ComputerHistorySummaryResource {
  readonly kind: ComputerHistorySummaryKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly entryId: string;
  readonly filename: string;
  readonly title: string;
  readonly description: string;
  readonly applications: readonly string[];
  readonly applicationBundleIdentifiers: readonly string[];
  readonly summaryText: string;
  readonly observationTimestamps: readonly number[];
  readonly suggestion?: ComputerHistorySummarySuggestion;
  readonly entry: ComputerHistoryTimelineEntryDraft;
}

export interface ComputerHistoryProjection {
  readonly entries: readonly ComputerHistoryTimelineEntryDraft[];
  readonly intervals: readonly ComputerHistorySummaryInterval[];
  /** Includes both visible 10-minute resources and their completed 6-hour parents. */
  readonly resources: readonly ComputerHistorySummaryResource[];
}

export interface ComputerHistoryProjectionOptions {
  readonly nowMs: number;
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit?: number;
  readonly applicationCatalog?: ReadonlyMap<
    string,
    { readonly name?: string; readonly iconDataURL?: string }
  >;
}

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_APPLICATION_LENGTH = 160;

/** Common credential-bearing forms are replaced before any model/resource projection. */
export function redactComputerHistoryText(value: string, maxLength: number): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(
      /-----BEGIN [^-\r\n]{1,80} PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]{1,80} PRIVATE KEY-----/giu,
      "[redacted]",
    )
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[redacted]")
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_\-]{12,}\b/gu, "[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{12,}\b/gu, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_\-.]{12,}\b/giu, "[redacted]")
    .replace(
      /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|password|passwd|secret|credential|key)\s*[:=]\s*[^\s,;]{1,256}/giu,
      "[redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.slice(0, maxLength);
}

function safeApplicationName(value: string): string {
  return redactComputerHistoryText(value, MAX_APPLICATION_LENGTH) || "Application";
}

function summaryLevelFor(kind: ComputerHistorySummaryKind): ComputerHistorySummaryLevel {
  return kind === "6h" ? "six_hour" : "ten_minute";
}

function safeTitle(value: string | undefined, fallback: string): string {
  return redactComputerHistoryText(value ?? "", MAX_TITLE_LENGTH) || fallback;
}

function applicationProjection(
  observations: readonly ComputerHistoryObservation[],
  applicationCatalog: ComputerHistoryProjectionOptions["applicationCatalog"],
): ComputerHistoryTimelineApplication[] {
  const applications = new Map<string, ComputerHistoryTimelineApplication>();
  for (const observation of observations) {
    const bundleIdentifier = redactComputerHistoryText(observation.app.bundleIdentifier, 200);
    if (!bundleIdentifier) continue;
    const catalogEntry = applicationCatalog?.get(observation.app.bundleIdentifier);
    const displayName = safeApplicationName(catalogEntry?.name ?? observation.app.name);
    if (applications.has(bundleIdentifier)) continue;
    applications.set(bundleIdentifier, {
      bundleIdentifier,
      displayName,
      ...(catalogEntry?.iconDataURL ? { iconDataURL: catalogEntry.iconDataURL } : {}),
    });
  }
  return [...applications.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function bucketStart(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function stableId(kind: ComputerHistorySummaryKind, startMs: number): string {
  return createHash("sha256")
    .update(`moss:computer-history:memory-summary:v1:${kind}:${startMs}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function computerHistorySummaryEntryId(
  kind: ComputerHistorySummaryKind,
  startMs: number,
): string {
  return `history-summary-${kind}-${startMs}-${stableId(kind, startMs)}`;
}

function utcFilenameTimestamp(timestampMs: number): string {
  return new Date(timestampMs)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replace(/:/gu, "-")
    .replace(/Z$/u, "");
}

export function computerHistorySummaryFilename(
  kind: ComputerHistorySummaryKind,
  startMs: number,
): string {
  return `${utcFilenameTimestamp(startMs)}-${stableId(kind, startMs)}-${kind}-memory-summary.md`;
}

function uniqueStrings(values: readonly string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, max);
}

function safeSemanticSummary(
  observation: ComputerHistoryObservation,
): ComputerHistoryObservation["semanticSummary"] | undefined {
  if (!observation.semanticSummary) return undefined;
  try {
    return normalizeComputerHistorySemanticSummary(observation.semanticSummary);
  } catch {
    return undefined;
  }
}

function buildSummary(
  kind: ComputerHistorySummaryKind,
  startMs: number,
  endMs: number,
  observations: readonly ComputerHistoryObservation[],
  applicationCatalog: ComputerHistoryProjectionOptions["applicationCatalog"],
  nowMs: number,
): ComputerHistorySummaryResource {
  const first = observations[0];
  if (!first) throw new Error("Cannot project an empty Computer History summary.");
  const appNames = uniqueStrings(
    observations.map((item) => safeApplicationName(item.app.name)),
    50,
  );
  const applicationBundleIdentifiers = uniqueStrings(
    observations.map((item) => redactComputerHistoryText(item.app.bundleIdentifier, 200)),
    50,
  );
  const firstApp = applicationCatalog?.get(first.app.bundleIdentifier);
  const firstAppName = safeApplicationName(firstApp?.name ?? first.app.name);
  const semanticSummaries = observations.flatMap((observation) => {
    const summary = safeSemanticSummary(observation);
    return summary ? [summary] : [];
  });
  const title = safeTitle(semanticSummaries[0]?.title ?? first.window.title, firstAppName);
  const semanticDescriptions = uniqueStrings(
    semanticSummaries.map((summary) =>
      redactComputerHistoryText(summary.description, MAX_DESCRIPTION_LENGTH),
    ),
    20,
  );
  const activityText = uniqueStrings(
    observations
      .map((item) => redactComputerHistoryText(item.activityText ?? "", MAX_DESCRIPTION_LENGTH))
      .filter(Boolean),
    20,
  );
  const description = redactComputerHistoryText(
    semanticDescriptions.length > 0
      ? semanticDescriptions.join(" · ")
      : activityText.length > 0
        ? activityText.join(" · ")
        : appNames.join(", "),
    MAX_DESCRIPTION_LENGTH,
  );
  const summaryText = redactComputerHistoryText(
    `${title}. ${description || "No additional activity was captured."}`,
    MAX_DESCRIPTION_LENGTH,
  );
  const applications = applicationProjection(observations, applicationCatalog);
  const applicationNames = applications.map((application) => application.displayName);
  const entry: ComputerHistoryTimelineEntryDraft = {
    id: computerHistorySummaryEntryId(kind, startMs),
    summaryLevel: summaryLevelFor(kind),
    interval: { startMs, endMs },
    title,
    description,
    applications:
      applications.length > 0
        ? applications
        : [{ bundleIdentifier: first.app.bundleIdentifier, displayName: firstAppName }],
  };
  const hasRecentObservation = observations.some(
    (observation) =>
      kind === "6h" &&
      startMs + COMPUTER_HISTORY_SIX_HOUR_MS <= nowMs &&
      observation.capturedAtMs >= nowMs - COMPUTER_HISTORY_SUGGESTION_WINDOW_MS &&
      observation.capturedAtMs <= nowMs,
  );
  const suggestion = hasRecentObservation
    ? {
        type: "skill" as const,
        name: `Review ${applicationNames.slice(0, 3).join(", ")} activity`,
        description: `Review the ${applicationNames.slice(0, 3).join(", ")} activity in this ${kind === "6h" ? "six-hour" : "ten-minute"} summary.`,
      }
    : undefined;
  return {
    kind,
    startMs,
    endMs,
    entryId: entry.id,
    filename: computerHistorySummaryFilename(kind, startMs),
    title,
    description,
    applications: applicationNames.length > 0 ? applicationNames : [firstAppName],
    applicationBundleIdentifiers,
    summaryText,
    observationTimestamps: observations.map((observation) => observation.capturedAtMs),
    ...(suggestion ? { suggestion } : {}),
    entry,
  };
}

/**
 * Project encrypted observations without exposing their raw payloads. All
 * grouping, IDs, ordering and six-hour supersession are deterministic.
 */
export function projectComputerHistory(
  records: readonly ComputerHistoryProjectionRecord[],
  options: ComputerHistoryProjectionOptions,
): ComputerHistoryProjection {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sinceMs = Math.max(0, options.sinceMs ?? 0);
  const untilMs = options.untilMs ?? Number.MAX_SAFE_INTEGER;
  const allObservations = records
    .map((record) => record.observation)
    .filter(
      (observation) =>
        Number.isSafeInteger(observation.capturedAtMs) && observation.capturedAtMs >= 0,
    )
    .sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  const tenMinuteBuckets = new Map<number, ComputerHistoryObservation[]>();
  for (const observation of allObservations) {
    const start = bucketStart(observation.capturedAtMs, COMPUTER_HISTORY_TEN_MINUTE_MS);
    const bucket = tenMinuteBuckets.get(start) ?? [];
    bucket.push(observation);
    tenMinuteBuckets.set(start, bucket);
  }
  const tenMinuteSummaries = [...tenMinuteBuckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startMs, observations]) =>
      buildSummary(
        "10min",
        startMs,
        startMs + COMPUTER_HISTORY_TEN_MINUTE_MS,
        observations,
        options.applicationCatalog,
        nowMs,
      ),
    );
  const sixHourBuckets = new Map<number, ComputerHistoryObservation[]>();
  for (const [startMs, observations] of tenMinuteBuckets) {
    const sixHourStart = bucketStart(startMs, COMPUTER_HISTORY_SIX_HOUR_MS);
    const bucket = sixHourBuckets.get(sixHourStart) ?? [];
    bucket.push(...observations);
    sixHourBuckets.set(sixHourStart, bucket);
  }
  const completedSixHourSummaries = [...sixHourBuckets.entries()]
    .filter(([startMs]) => startMs + COMPUTER_HISTORY_SIX_HOUR_MS <= nowMs)
    .sort(([left], [right]) => left - right)
    .map(([startMs, observations]) =>
      buildSummary(
        "6h",
        startMs,
        startMs + COMPUTER_HISTORY_SIX_HOUR_MS,
        observations.sort((left, right) => left.capturedAtMs - right.capturedAtMs),
        options.applicationCatalog,
        nowMs,
      ),
    );
  const completedSixHourStarts = new Set(
    completedSixHourSummaries.map((summary) => summary.startMs),
  );

  // A time-bounded query must be projected from the bounded observations, not
  // merely selected after projecting a whole bucket.  The latter would leak
  // titles, applications, and hosts from observations outside the requested
  // range whenever a 10-minute or 6-hour bucket straddles that range.  Keep
  // the full summaries above for resource materialization/reveal, and build a
  // separate query-only view for entries and intervals.
  const queryObservations = allObservations.filter(
    (observation) => observation.capturedAtMs >= sinceMs && observation.capturedAtMs <= untilMs,
  );
  const queryTenMinuteBuckets = new Map<number, ComputerHistoryObservation[]>();
  for (const observation of queryObservations) {
    const start = bucketStart(observation.capturedAtMs, COMPUTER_HISTORY_TEN_MINUTE_MS);
    const bucket = queryTenMinuteBuckets.get(start) ?? [];
    bucket.push(observation);
    queryTenMinuteBuckets.set(start, bucket);
  }
  const queryTenMinuteSummaries = [...queryTenMinuteBuckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startMs, observations]) =>
      buildSummary(
        "10min",
        startMs,
        startMs + COMPUTER_HISTORY_TEN_MINUTE_MS,
        observations,
        options.applicationCatalog,
        nowMs,
      ),
    );
  const querySixHourBuckets = new Map<number, ComputerHistoryObservation[]>();
  for (const [startMs, observations] of queryTenMinuteBuckets) {
    const sixHourStart = bucketStart(startMs, COMPUTER_HISTORY_SIX_HOUR_MS);
    const bucket = querySixHourBuckets.get(sixHourStart) ?? [];
    bucket.push(...observations);
    querySixHourBuckets.set(sixHourStart, bucket);
  }
  const queryCompletedSixHourSummaries = [...querySixHourBuckets.entries()]
    .filter(([startMs]) => completedSixHourStarts.has(startMs))
    .sort(([left], [right]) => left - right)
    .map(([startMs, observations]) =>
      buildSummary(
        "6h",
        startMs,
        startMs + COMPUTER_HISTORY_SIX_HOUR_MS,
        observations.sort((left, right) => left.capturedAtMs - right.capturedAtMs),
        options.applicationCatalog,
        nowMs,
      ),
    );
  const queryCompletedSixHourStarts = new Set(
    queryCompletedSixHourSummaries.map((summary) => summary.startMs),
  );
  const visibleEntries = [
    ...queryTenMinuteSummaries.filter(
      (summary) =>
        !queryCompletedSixHourStarts.has(
          bucketStart(summary.startMs, COMPUTER_HISTORY_SIX_HOUR_MS),
        ),
    ),
    ...queryCompletedSixHourSummaries,
  ]
    .sort((left, right) => left.startMs - right.startMs)
    .map((summary) => summary.entry);
  const max = Math.min(200, Math.max(1, options.limit ?? 200));
  const entries = visibleEntries.slice(-max);
  const intervals = [
    ...queryTenMinuteSummaries.map((summary) => ({
      kind: "10min" as const,
      startMs: summary.startMs,
      endMs: summary.endMs,
      entryCount: queryTenMinuteBuckets.get(summary.startMs)?.length ?? 0,
      summary: summary.summaryText,
    })),
    ...queryCompletedSixHourSummaries.map((summary) => ({
      kind: "6h" as const,
      startMs: summary.startMs,
      endMs: summary.endMs,
      entryCount: querySixHourBuckets.get(summary.startMs)?.length ?? 0,
      summary: summary.summaryText,
    })),
  ].sort((left, right) => left.startMs - right.startMs || left.kind.localeCompare(right.kind));
  return {
    entries,
    intervals,
    resources: [...tenMinuteSummaries, ...completedSixHourSummaries].sort(
      (left, right) => left.startMs - right.startMs || left.kind.localeCompare(right.kind),
    ),
  };
}

/**
 * Project a timeline entry for an explicitly authorized model tool call.
 *
 * This is intentionally a separate projection instead of a JSON spread. The
 * desktop entry contains UI-only icon data and a local memory resource path.
 * Neither is part of the model contract, even when a caller requests a
 * narrow time range.
 */
export function projectComputerHistoryEntryForModel(
  entry: ComputerHistoryTimelineEntryDraft | ComputerHistoryTimelineEntry,
): ComputerHistoryModelTimelineEntry {
  const scrubModelText = (value: string, maxLength: number): string =>
    redactComputerHistoryText(value, maxLength)
      .replace(/\b(?:https?|ftp|file):\/\/[^\s)]+/giu, "[redacted]")
      .replace(/\bdata:[^\s)]+/giu, "[redacted]")
      .replace(
        /((?:^|[\s(]))(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+)/gu,
        "$1[redacted]",
      )
      .replace(/\b[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,}\b/giu, "[redacted]")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maxLength);
  const scrubModelIdentifier = (value: string): string =>
    redactComputerHistoryText(value, 200)
      .replace(
        /((?:^|[\s(]))(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+)/gu,
        "$1[redacted]",
      )
      .trim();

  const applications = entry.applications
    .map((application) => ({
      // Bundle identifiers are identifiers, not URL hosts. Keep their dots;
      // the host scrubber below applies only to human-facing text.
      bundleIdentifier: scrubModelIdentifier(application.bundleIdentifier),
      displayName: scrubModelText(application.displayName, MAX_APPLICATION_LENGTH),
    }))
    .filter((application) => application.bundleIdentifier && application.displayName)
    .filter(
      (application, index, all) =>
        all.findIndex(
          (candidate) => candidate.bundleIdentifier === application.bundleIdentifier,
        ) === index,
    )
    .slice(0, 50);

  const suggestion = entry.suggestion
    ? {
        type: entry.suggestion.type,
        name: scrubModelText(entry.suggestion.name, MAX_TITLE_LENGTH),
        description: scrubModelText(entry.suggestion.description, MAX_DESCRIPTION_LENGTH),
      }
    : undefined;
  return {
    id: entry.id,
    summaryLevel: entry.summaryLevel,
    interval: { startMs: entry.interval.startMs, endMs: entry.interval.endMs },
    title: scrubModelText(entry.title, MAX_TITLE_LENGTH) || "Computer History",
    description:
      scrubModelText(entry.description, MAX_DESCRIPTION_LENGTH) ||
      "No additional metadata was captured.",
    applications,
    ...(suggestion ? { suggestion } : {}),
  };
}

export function hasCompletedComputerHistorySummary(
  records: readonly ComputerHistoryProjectionRecord[],
  nowMs: number,
): boolean {
  return projectComputerHistory(records, { nowMs, limit: 1 }).resources.some(
    (resource) => resource.kind === "6h",
  );
}
