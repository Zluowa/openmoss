import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

/** The lifecycle states exposed by the local Computer History recorder. */
export const ComputerHistoryRecorderState = Schema.Literals(["stopped", "running", "paused"]);
export type ComputerHistoryRecorderState = typeof ComputerHistoryRecorderState.Type;

export const ComputerHistoryActivationState = Schema.Literals([
  "idle",
  "starting",
  "waiting_for_permissions",
  "failed",
]);
export type ComputerHistoryActivationState = typeof ComputerHistoryActivationState.Type;

export const ComputerHistoryPermissionState = Schema.Literals([
  "granted",
  "pending",
  "denied",
  "restricted",
  "unknown",
]);
export type ComputerHistoryPermissionState = typeof ComputerHistoryPermissionState.Type;

export const ComputerHistoryBrowserSupportStatus = Schema.Literals([
  "supported",
  "permission_denied",
  "unsupported",
  "unknown",
]);
export type ComputerHistoryBrowserSupportStatus = typeof ComputerHistoryBrowserSupportStatus.Type;

export const ComputerHistoryBrowserCapability = Schema.Struct({
  bundleIdentifier: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: ComputerHistoryBrowserSupportStatus,
  detail: TrimmedNonEmptyString,
});
export type ComputerHistoryBrowserCapability = typeof ComputerHistoryBrowserCapability.Type;

export const ComputerHistoryCaptureCapability = Schema.Struct({
  mode: Schema.Literals(["window_metadata_only", "interaction_activity"]),
  interactionEvents: Schema.Boolean,
  activitySummaries: Schema.Boolean,
  detail: TrimmedNonEmptyString,
});
export type ComputerHistoryCaptureCapability = typeof ComputerHistoryCaptureCapability.Type;

/** A post-redacted summary produced only by Apple's on-device model. */
export interface ComputerHistorySemanticSummary {
  readonly title: string;
  readonly description: string;
  readonly source: "apple_on_device";
}

export const ComputerHistoryRuleBehavior = Schema.Literals(["allow", "block"]);
export type ComputerHistoryRuleBehavior = typeof ComputerHistoryRuleBehavior.Type;

const ComputerHistoryRuleList = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500));

/** App and URL observation policies are deliberately independent. */
export const ComputerHistoryObservationSettings = Schema.Struct({
  defaultApplicationBehavior: ComputerHistoryRuleBehavior,
  defaultURLBehavior: ComputerHistoryRuleBehavior,
  allowlist: ComputerHistoryRuleList,
  blocklist: ComputerHistoryRuleList,
  urlAllowlist: ComputerHistoryRuleList,
  urlBlocklist: ComputerHistoryRuleList,
});
export type ComputerHistoryObservationSettings = typeof ComputerHistoryObservationSettings.Type;

export const ComputerHistorySettings = Schema.Struct({
  observation: ComputerHistoryObservationSettings,
  consentAt: Schema.NullOr(Schema.String),
});
export type ComputerHistorySettings = typeof ComputerHistorySettings.Type;

export const ComputerHistoryHealth = Schema.Struct({
  droppedEvents: NonNegativeInt,
  queueDepth: NonNegativeInt,
  storageBytes: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  corruptionDetected: Schema.Boolean,
  keychainState: Schema.Literals(["ready", "locked", "unavailable", "unknown"]),
});
export type ComputerHistoryHealth = typeof ComputerHistoryHealth.Type;

export const ComputerHistoryState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  recorderState: ComputerHistoryRecorderState,
  activationState: ComputerHistoryActivationState,
  inputMonitoringPermission: ComputerHistoryPermissionState,
  accessibilityPermission: ComputerHistoryPermissionState,
  screenRecordingPermission: ComputerHistoryPermissionState,
  privateBrowsingExcluded: Schema.Boolean,
  browserCapabilities: Schema.Array(ComputerHistoryBrowserCapability),
  captureCapability: ComputerHistoryCaptureCapability,
  settings: ComputerHistorySettings,
  health: ComputerHistoryHealth,
  message: Schema.NullOr(Schema.String),
});
export type ComputerHistoryState = typeof ComputerHistoryState.Type;

export const ComputerHistoryApp = Schema.Struct({
  bundleIdentifier: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  permitted: Schema.Boolean,
  /** True only when the native browser capability registry identifies this bundle as a browser. */
  isWebBrowser: Schema.Boolean,
  /** A bounded native application icon, when the desktop helper can provide one. */
  iconDataURL: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerHistoryApp = typeof ComputerHistoryApp.Type;

export const ComputerHistoryApplicationListResult = Schema.Struct({
  applications: Schema.Array(ComputerHistoryApp),
});
export type ComputerHistoryApplicationListResult = typeof ComputerHistoryApplicationListResult.Type;

export const ComputerHistoryResolveApplicationsInput = Schema.Struct({
  /** Existing search callers remain supported; exact selection may omit it. */
  query: Schema.optional(Schema.String),
  /** Optional exact bundle IDs used by the permissions picker. */
  bundleIdentifiers: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500)),
  ),
});
export type ComputerHistoryResolveApplicationsInput =
  typeof ComputerHistoryResolveApplicationsInput.Type;

export const ComputerHistoryResolveApplicationsResult = Schema.Struct({
  applications: Schema.Array(ComputerHistoryApp),
});
export type ComputerHistoryResolveApplicationsResult =
  typeof ComputerHistoryResolveApplicationsResult.Type;

export const ComputerHistoryGetStateInput = Schema.Struct({});
export type ComputerHistoryGetStateInput = typeof ComputerHistoryGetStateInput.Type;

export const ComputerHistoryGetSettingsInput = Schema.Struct({});
export type ComputerHistoryGetSettingsInput = typeof ComputerHistoryGetSettingsInput.Type;

export const ComputerHistoryUpdateSettingsInput = Schema.Struct({
  settings: ComputerHistorySettings,
});
export type ComputerHistoryUpdateSettingsInput = typeof ComputerHistoryUpdateSettingsInput.Type;

export const ComputerHistorySetEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
  /** Consent is required when turning history on for the first time. */
  consentAt: Schema.optional(Schema.String),
});
export type ComputerHistorySetEnabledInput = typeof ComputerHistorySetEnabledInput.Type;

export const ComputerHistoryListHistoryInput = Schema.Struct({
  sinceMs: Schema.optional(NonNegativeInt),
  untilMs: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});
export type ComputerHistoryListHistoryInput = typeof ComputerHistoryListHistoryInput.Type;

/** The two summary granularities used by the Codex Computer History surface. */
export const ComputerHistorySummaryLevel = Schema.Literals(["ten_minute", "six_hour"]);
export type ComputerHistorySummaryLevel = typeof ComputerHistorySummaryLevel.Type;

/** The precise wall-clock interval represented by a timeline summary. */
export const ComputerHistoryTimelineInterval = Schema.Struct({
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
});
export type ComputerHistoryTimelineInterval = typeof ComputerHistoryTimelineInterval.Type;

/** A timeline application intentionally exposes display metadata only. */
export const ComputerHistoryTimelineApplication = Schema.Struct({
  bundleIdentifier: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  iconDataURL: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerHistoryTimelineApplication = typeof ComputerHistoryTimelineApplication.Type;

/** A suggestion belongs to its matching summary entry, never to a free list. */
export const ComputerHistoryTimelineSuggestion = Schema.Struct({
  type: Schema.Literals(["skill", "automation"]),
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type ComputerHistoryTimelineSuggestion = typeof ComputerHistoryTimelineSuggestion.Type;

export const ComputerHistoryTimelineEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  summaryLevel: ComputerHistorySummaryLevel,
  interval: ComputerHistoryTimelineInterval,
  title: Schema.String,
  description: Schema.String,
  applications: Schema.Array(ComputerHistoryTimelineApplication),
  /** Local generated summary resource path; never sent through the Agent Gateway. */
  memoryFilePath: TrimmedNonEmptyString,
  suggestion: Schema.optional(ComputerHistoryTimelineSuggestion),
});
export type ComputerHistoryTimelineEntry = typeof ComputerHistoryTimelineEntry.Type;
/** Internal projection form before the local resource index attaches its path. */
export type ComputerHistoryTimelineEntryDraft = Omit<
  ComputerHistoryTimelineEntry,
  "memoryFilePath"
>;

/**
 * Explicit model-context contract for `history_query`. It intentionally uses
 * the Codex interval name and excludes local paths, URL hosts, raw app objects,
 * and icon bytes present in the desktop/UI result above.
 */
export const ComputerHistoryModelTimelineEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  summaryLevel: ComputerHistorySummaryLevel,
  interval: ComputerHistoryTimelineInterval,
  title: Schema.String,
  description: Schema.String,
  applications: Schema.Array(
    Schema.Struct({
      bundleIdentifier: TrimmedNonEmptyString,
      displayName: TrimmedNonEmptyString,
    }),
  ),
  suggestion: Schema.optional(ComputerHistoryTimelineSuggestion),
});
export type ComputerHistoryModelTimelineEntry = typeof ComputerHistoryModelTimelineEntry.Type;

export const ComputerHistoryListHistoryResult = Schema.Struct({
  entries: Schema.Array(ComputerHistoryTimelineEntry),
  nextCursor: Schema.NullOr(Schema.String),
  modelContextDisclosure: Schema.Struct({
    /** Whether the immediate caller has placed the result in model context. */
    included: Schema.Boolean,
    /** The gateway does not inject history into unrelated model turns. */
    notImplicitlyInjected: Schema.Boolean,
    text: TrimmedNonEmptyString,
  }),
});
export type ComputerHistoryListHistoryResult = typeof ComputerHistoryListHistoryResult.Type;

export const ComputerHistoryListSuggestionsInput = Schema.Struct({
  sinceMs: Schema.optional(NonNegativeInt),
});
export type ComputerHistoryListSuggestionsInput = typeof ComputerHistoryListSuggestionsInput.Type;

export const ComputerHistorySuggestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  explanation: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  kind: Schema.Literals(["skill", "automation"]),
});
export type ComputerHistorySuggestion = typeof ComputerHistorySuggestion.Type;

export const ComputerHistoryListSuggestionsResult = Schema.Struct({
  suggestions: Schema.Array(ComputerHistorySuggestion),
});
export type ComputerHistoryListSuggestionsResult = typeof ComputerHistoryListSuggestionsResult.Type;

export const ComputerHistoryListSummaryIntervalsInput = Schema.Struct({
  sinceMs: NonNegativeInt,
});
export type ComputerHistoryListSummaryIntervalsInput =
  typeof ComputerHistoryListSummaryIntervalsInput.Type;

export const ComputerHistorySummaryInterval = Schema.Struct({
  kind: Schema.Literals(["10min", "6h"]),
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
  entryCount: NonNegativeInt,
  summary: TrimmedNonEmptyString,
});
export type ComputerHistorySummaryInterval = typeof ComputerHistorySummaryInterval.Type;

export const ComputerHistoryListSummaryIntervalsResult = Schema.Struct({
  intervals: Schema.Array(ComputerHistorySummaryInterval),
});
export type ComputerHistoryListSummaryIntervalsResult =
  typeof ComputerHistoryListSummaryIntervalsResult.Type;

export const ComputerHistoryClearScope = Schema.Literals(["last_10m", "last_1h", "last_1d", "all"]);
export type ComputerHistoryClearScope = typeof ComputerHistoryClearScope.Type;

export const ComputerHistoryClearHistoryInput = Schema.Struct({
  scope: ComputerHistoryClearScope,
  intervalStartMs: Schema.optional(NonNegativeInt),
  intervalEndMs: Schema.optional(NonNegativeInt),
});
export type ComputerHistoryClearHistoryInput = typeof ComputerHistoryClearHistoryInput.Type;

export const ComputerHistoryClearHistoryResult = Schema.Struct({
  deletedCount: NonNegativeInt,
  summaryIndexRefresh: Schema.Literals(["pending", "complete"]),
});
export type ComputerHistoryClearHistoryResult = typeof ComputerHistoryClearHistoryResult.Type;

export const ComputerHistoryRevealInFinderInput = Schema.Struct({
  entryId: TrimmedNonEmptyString,
});
export type ComputerHistoryRevealInFinderInput = typeof ComputerHistoryRevealInFinderInput.Type;

export const ComputerHistoryRevealInFinderResult = Schema.Struct({
  opened: Schema.Boolean,
});
export type ComputerHistoryRevealInFinderResult = typeof ComputerHistoryRevealInFinderResult.Type;

/**
 * The only observation shape that may cross into encrypted persistence.
 *
 * Browser URL/private-mode data is deliberately absent. It is a transient
 * policy candidate in the helper protocol and is consumed before this type is
 * constructed. Keeping the persisted type this small makes accidental URL,
 * private-mode, accessibility, keyboard, and mouse retention a type error.
 */
export interface ComputerHistoryObservation {
  readonly capturedAtMs: number;
  readonly app: { readonly bundleIdentifier: string; readonly name: string };
  readonly window: { readonly title?: string };
  readonly activityText?: string;
  readonly semanticSummary?: ComputerHistorySemanticSummary;
}

/** Transient native candidate. Never pass this object to the encrypted store. */
export interface ComputerHistoryCaptureCandidate {
  readonly type: "history_capture_candidate";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly app: { readonly bundleIdentifier: string; readonly name: string };
  readonly window: { readonly title?: string; readonly url?: string };
  readonly privateBrowsing: boolean;
  readonly browserMode?: "normal" | "incognito";
}

/** One-shot server response to a transient native candidate. */
export interface ComputerHistoryCaptureDecision {
  readonly type: "history_capture_decision";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly allow: boolean;
}

export const COMPUTER_HISTORY_MAX_QUERY_RESULTS = 200;
export const COMPUTER_HISTORY_RETENTION_DAYS = 7;
export const COMPUTER_HISTORY_QUOTA_BYTES = 100 * 1024 * 1024;
