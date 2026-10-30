import type { ComputerHistoryObservation, ComputerHistorySemanticSummary } from "@synara/contracts";

import { normalizeComputerHistorySemanticSummary } from "./store.ts";
import {
  syncComputerHistorySummaryJobResources,
  type ComputerHistorySummaryJobResource,
} from "./summaryResources.ts";

export const COMPUTER_HISTORY_MINUTE_MS = 60 * 1_000;
export const COMPUTER_HISTORY_HOUR_MS = 60 * COMPUTER_HISTORY_MINUTE_MS;
export const COMPUTER_HISTORY_TEN_MINUTE_MS = 10 * COMPUTER_HISTORY_MINUTE_MS;
export const COMPUTER_HISTORY_SIX_HOUR_MS = 36 * COMPUTER_HISTORY_TEN_MINUTE_MS;
export const COMPUTER_HISTORY_SUMMARY_RETRY_DELAY_MS = 2_000;
export const COMPUTER_HISTORY_SUMMARY_MAX_ATTEMPTS = 3;
export const COMPUTER_HISTORY_SUMMARY_MAX_CONVERGENCE_PASSES = 8;

export type ComputerHistorySummaryJobKind = "10min" | "6h";

/**
 * The only input shape accepted by the recursive summary engine.  It is
 * intentionally narrower than ComputerHistoryObservation: no window title,
 * URL, path, activity text, screenshot, or OCR field can enter this lane.
 */
export interface ComputerHistoryMinuteFrameInput {
  readonly capturedAtMs: number;
  readonly minuteStartMs: number;
  readonly app: {
    readonly bundleIdentifier: string;
    readonly name: string;
  };
  readonly semanticSummary?: ComputerHistorySemanticSummary;
}

export interface ComputerHistorySafeSummaryInput {
  readonly capturedAtMs: number;
  readonly app: {
    readonly bundleIdentifier: string;
    readonly name: string;
  };
  readonly semanticSummary?: ComputerHistorySemanticSummary;
}

export interface ComputerHistoryMinuteSummary {
  readonly minuteStartMs: number;
  readonly title: string;
  readonly description: string;
  readonly applications: readonly string[];
  readonly applicationBundleIdentifiers: readonly string[];
}

export interface ComputerHistoryRecursiveSummary {
  readonly logicalJobKey: string;
  readonly kind: ComputerHistorySummaryJobKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly description: string;
  readonly summaryText: string;
  readonly applications: readonly string[];
  readonly applicationBundleIdentifiers: readonly string[];
  readonly childJobKeys: readonly string[];
}

export interface ComputerHistorySummaryBackendInput {
  readonly kind: ComputerHistorySummaryJobKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly minuteInputs: readonly ComputerHistoryMinuteSummary[];
  readonly childSummaries: readonly ComputerHistoryRecursiveSummary[];
  readonly previous?: ComputerHistoryRecursiveSummary;
}

export interface ComputerHistorySummaryBackend {
  summarize(
    input: ComputerHistorySummaryBackendInput,
    signal?: AbortSignal,
  ): Promise<ComputerHistoryRecursiveSummary>;
  /** Optional local dependency-graph signal; never implied by text changes. */
  readonly needsAnotherPass?: (
    input: ComputerHistorySummaryBackendInput,
    output: ComputerHistoryRecursiveSummary,
  ) => boolean;
}

export class ComputerHistoryRetryableSummaryError extends Error {
  readonly retryable = true;
}

export class ComputerHistoryNonRetryableSummaryError extends Error {
  readonly retryable = false;
}

export class ComputerHistorySummaryNonConvergentError extends Error {
  readonly code = "non_convergent" as const;
}

export class ComputerHistorySummaryDeadlineError extends Error {
  readonly retryable = true;
}

export interface ComputerHistorySummaryJobEngineOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly setTimer?: (handler: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly backend?: ComputerHistorySummaryBackend;
  readonly rootDir?: string;
  readonly randomAlpha?: (length: number) => string;
  /** Bounds one non-cooperative local backend call. */
  readonly backendTimeoutMs?: number;
  /** Lets the owning service surface scheduled refresh failures without
   * turning timer callbacks into unhandled promise rejections. */
  readonly onRunResult?: (result: ComputerHistorySummaryJobRunResult) => void;
  readonly onRunError?: (error: unknown) => void;
}

type SummaryRunScope = "all" | "10min" | "6h";

export interface ComputerHistorySummaryJobRunResult {
  readonly ran: boolean;
  readonly changed: boolean;
  readonly failedJobKeys: readonly string[];
  readonly published: readonly ComputerHistoryRecursiveSummary[];
}

export interface ComputerHistorySummaryJobEngine {
  readonly state: () => "stopped" | "running" | "paused";
  readonly start: (options?: { readonly catchUp?: boolean }) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: (options?: { readonly catchUp?: boolean }) => Promise<void>;
  readonly addInput: (input: ComputerHistorySafeSummaryInput) => boolean;
  readonly addObservation: (observation: ComputerHistoryObservation) => boolean;
  readonly replaceInputs: (inputs: readonly ComputerHistorySafeSummaryInput[]) => number;
  readonly runPending: (
    nowMs?: number,
    scope?: SummaryRunScope,
  ) => Promise<ComputerHistorySummaryJobRunResult>;
  readonly snapshot: () => readonly ComputerHistoryRecursiveSummary[];
  readonly minuteInputs: () => readonly ComputerHistoryMinuteFrameInput[];
  readonly resourcePaths: () => ReadonlyMap<string, string>;
  /** True when an explicit full-input replacement is waiting for an atomic
   * rebuild; ordinary appended observations do not revoke the LKG overlay. */
  readonly hasPendingInputReplacement: () => boolean;
  readonly invalidatePublishedResources: () => void;
}

const DEFAULT_SLEEP = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The summary job was cancelled.", "AbortError"));
      return;
    }
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DOMException("The summary job was cancelled.", "AbortError"));
    };
    const onDone = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(onDone, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const safeText = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // A post-sanitized semantic result must never re-introduce a URL, path, or
  // credential into a durable summary. Reject the whole field instead of
  // persisting a partially redacted sentence whose provenance is unclear.
  if (
    /\b(?:https?|ftp|file):\/\//iu.test(normalized) ||
    /(?:^|[\s(])(?:\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/|[A-Za-z]:[\\/])/u.test(
      normalized,
    ) ||
    /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|credential)\s*[:=]/iu.test(
      normalized,
    ) ||
    /\b[\w.+-]{1,64}@[\w.-]{1,255}\.[A-Za-z]{2,63}\b/u.test(normalized) ||
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(normalized)
  ) {
    return fallback;
  }
  return normalized || fallback;
};

const SUMMARY_TITLE_MAX_LENGTH = 120;
const SUMMARY_DESCRIPTION_MAX_LENGTH = 400;
const SUMMARY_TEXT_MAX_LENGTH = 1_000;
const SUMMARY_APPLICATION_MAX_COUNT = 50;

function strictSummaryText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ComputerHistoryNonRetryableSummaryError(`Invalid summary ${field}.`);
  }
  const normalized = safeText(value, "");
  if (!normalized || normalized.length > maxLength) {
    throw new ComputerHistoryNonRetryableSummaryError(`Unsafe summary ${field}.`);
  }
  return normalized;
}

const safeApplication = (value: string, fallback: string): string =>
  safeText(value.slice(0, 160), fallback);

function minuteStart(timestampMs: number): number {
  return Math.floor(timestampMs / COMPUTER_HISTORY_MINUTE_MS) * COMPUTER_HISTORY_MINUTE_MS;
}

function tenMinuteStart(timestampMs: number): number {
  return Math.floor(timestampMs / COMPUTER_HISTORY_TEN_MINUTE_MS) * COMPUTER_HISTORY_TEN_MINUTE_MS;
}

function sixHourStart(timestampMs: number): number {
  return Math.floor(timestampMs / COMPUTER_HISTORY_SIX_HOUR_MS) * COMPUTER_HISTORY_SIX_HOUR_MS;
}

function logicalKey(kind: ComputerHistorySummaryJobKind, startMs: number): string {
  return `${kind}:${startMs}`;
}

function stableInputKey(input: ComputerHistoryMinuteFrameInput): string {
  return JSON.stringify([
    input.capturedAtMs,
    input.minuteStartMs,
    input.app.bundleIdentifier,
    input.app.name,
    input.semanticSummary?.title ?? "",
    input.semanticSummary?.description ?? "",
  ]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function safeSemantic(
  value: ComputerHistorySemanticSummary | undefined,
): ComputerHistorySemanticSummary | undefined {
  if (!value) return undefined;
  try {
    const normalized = normalizeComputerHistorySemanticSummary(value);
    const title = safeText(normalized.title, "Activity summary");
    const description = safeText(normalized.description, "No additional metadata was captured.");
    return { title, description, source: "apple_on_device" };
  } catch {
    return undefined;
  }
}

/** Project a persisted record into the narrow, non-sensitive job input. */
export function toComputerHistorySafeSummaryInput(
  observation: ComputerHistoryObservation,
): ComputerHistorySafeSummaryInput {
  if (!Number.isSafeInteger(observation.capturedAtMs) || observation.capturedAtMs < 0) {
    throw new Error("Computer History summary input timestamp is invalid.");
  }
  const bundleIdentifier = safeApplication(observation.app.bundleIdentifier, "unknown.application");
  const name = safeApplication(observation.app.name, "Application");
  const semanticSummary = safeSemantic(observation.semanticSummary);
  return {
    capturedAtMs: observation.capturedAtMs,
    app: { bundleIdentifier, name },
    ...(semanticSummary === undefined ? {} : { semanticSummary }),
  };
}

function normalizeInput(input: ComputerHistorySafeSummaryInput): ComputerHistoryMinuteFrameInput {
  if (!Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 0) {
    throw new Error("Computer History summary input timestamp is invalid.");
  }
  const bundleIdentifier = safeApplication(input.app.bundleIdentifier, "unknown.application");
  const name = safeApplication(input.app.name, "Application");
  const semanticSummary = safeSemantic(input.semanticSummary);
  return {
    capturedAtMs: input.capturedAtMs,
    minuteStartMs: minuteStart(input.capturedAtMs),
    app: { bundleIdentifier, name },
    ...(semanticSummary === undefined ? {} : { semanticSummary }),
  };
}

function minuteSummary(
  inputs: readonly ComputerHistoryMinuteFrameInput[],
): ComputerHistoryMinuteSummary {
  const first = inputs[0];
  if (!first) throw new Error("Cannot summarize an empty minute.");
  const semantic = inputs.flatMap((input) =>
    input.semanticSummary ? [input.semanticSummary] : [],
  );
  const applications = uniqueSorted(inputs.map((input) => input.app.name)).slice(
    0,
    SUMMARY_APPLICATION_MAX_COUNT,
  );
  const applicationBundleIdentifiers = uniqueSorted(
    inputs.map((input) => input.app.bundleIdentifier),
  ).slice(0, SUMMARY_APPLICATION_MAX_COUNT);
  const title = safeText(
    semantic[0]?.title ?? "",
    applications[0] ? `Activity in ${applications[0]}` : "Activity",
  ).slice(0, SUMMARY_TITLE_MAX_LENGTH);
  const description = safeText(
    uniqueSorted(semantic.map((summary) => summary.description)).join(" · "),
    applications.length > 0
      ? `Activity in ${applications.join(", ")}`
      : "No additional metadata was captured.",
  ).slice(0, SUMMARY_DESCRIPTION_MAX_LENGTH);
  return {
    minuteStartMs: first.minuteStartMs,
    title,
    description,
    applications,
    applicationBundleIdentifiers,
  };
}

function summaryEqual(
  left: ComputerHistoryRecursiveSummary | undefined,
  right: ComputerHistoryRecursiveSummary,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function normalizeBackendSummary(
  input: ComputerHistorySummaryBackendInput,
  value: unknown,
): ComputerHistoryRecursiveSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputerHistoryNonRetryableSummaryError("Summary backend returned a non-object.");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "logicalJobKey",
    "kind",
    "startMs",
    "endMs",
    "title",
    "description",
    "summaryText",
    "applications",
    "applicationBundleIdentifiers",
    "childJobKeys",
  ]);
  if (Object.keys(candidate).some((key) => !expectedKeys.has(key))) {
    throw new ComputerHistoryNonRetryableSummaryError("Summary backend returned unknown fields.");
  }
  const expectedKey = logicalKey(input.kind, input.startMs);
  if (
    candidate.logicalJobKey !== expectedKey ||
    candidate.kind !== input.kind ||
    candidate.startMs !== input.startMs ||
    candidate.endMs !== input.endMs
  ) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned mismatched identity.",
    );
  }
  if (
    !Array.isArray(candidate.applications) ||
    candidate.applications.length > SUMMARY_APPLICATION_MAX_COUNT
  ) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned invalid applications.",
    );
  }
  const applications = candidate.applications.map((application) => {
    if (typeof application !== "string" || application.length === 0 || application.length > 160) {
      throw new ComputerHistoryNonRetryableSummaryError(
        "Summary backend returned an unsafe application.",
      );
    }
    return strictSummaryText(application, 160, "application");
  });
  if (
    !Array.isArray(candidate.applicationBundleIdentifiers) ||
    candidate.applicationBundleIdentifiers.length > SUMMARY_APPLICATION_MAX_COUNT
  ) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned invalid application identifiers.",
    );
  }
  const applicationBundleIdentifiers = candidate.applicationBundleIdentifiers.map((identifier) => {
    if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 200) {
      throw new ComputerHistoryNonRetryableSummaryError(
        "Summary backend returned an unsafe application identifier.",
      );
    }
    return strictSummaryText(identifier, 200, "application identifier");
  });
  if (new Set(applicationBundleIdentifiers).size !== applicationBundleIdentifiers.length) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned duplicate application identifiers.",
    );
  }
  if (new Set(applications).size !== applications.length) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned duplicate applications.",
    );
  }
  if (
    !Array.isArray(candidate.childJobKeys) ||
    candidate.childJobKeys.some((key) => typeof key !== "string")
  ) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Summary backend returned invalid child keys.",
    );
  }
  const childJobKeys = candidate.childJobKeys as string[];
  const expectedChildren = input.childSummaries.map((child) => child.logicalJobKey);
  if (input.kind === "10min" && childJobKeys.length !== 0) {
    throw new ComputerHistoryNonRetryableSummaryError("Ten-minute summary returned child keys.");
  }
  if (
    input.kind === "6h" &&
    (childJobKeys.length !== expectedChildren.length ||
      childJobKeys.some((key, index) => key !== expectedChildren[index]))
  ) {
    throw new ComputerHistoryNonRetryableSummaryError(
      "Six-hour summary returned mismatched children.",
    );
  }
  return {
    logicalJobKey: expectedKey,
    kind: input.kind,
    startMs: input.startMs,
    endMs: input.endMs,
    title: strictSummaryText(candidate.title, SUMMARY_TITLE_MAX_LENGTH, "title"),
    description: strictSummaryText(
      candidate.description,
      SUMMARY_DESCRIPTION_MAX_LENGTH,
      "description",
    ),
    summaryText: strictSummaryText(candidate.summaryText, SUMMARY_TEXT_MAX_LENGTH, "text"),
    applications,
    applicationBundleIdentifiers,
    childJobKeys,
  };
}

function productionSummaryBackend(): ComputerHistorySummaryBackend {
  return {
    async summarize(input) {
      const source = input.kind === "10min" ? input.minuteInputs : input.childSummaries;
      if (source.length === 0) {
        throw new ComputerHistoryNonRetryableSummaryError("No safe summary inputs are available.");
      }
      const titles = uniqueSorted(source.map((item) => item.title));
      const descriptions = uniqueSorted(source.map((item) => item.description));
      const applications = uniqueSorted(source.flatMap((item) => item.applications));
      const applicationBundleIdentifiers = uniqueSorted(
        source.flatMap((item) => item.applicationBundleIdentifiers),
      );
      const title = safeText(
        titles[0] ?? "",
        applications.length > 0
          ? `Activity in ${applications.slice(0, 3).join(", ")}`
          : "Computer History summary",
      ).slice(0, SUMMARY_TITLE_MAX_LENGTH);
      const description = safeText(
        descriptions.join(" · "),
        applications.length > 0
          ? `Activity in ${applications.join(", ")}`
          : "No additional metadata was captured.",
      ).slice(0, SUMMARY_DESCRIPTION_MAX_LENGTH);
      return {
        logicalJobKey: logicalKey(input.kind, input.startMs),
        kind: input.kind,
        startMs: input.startMs,
        endMs: input.endMs,
        title,
        description,
        summaryText: safeText(`${title}. ${description}`, "Computer History summary.").slice(
          0,
          SUMMARY_TEXT_MAX_LENGTH,
        ),
        applications: applications.slice(0, SUMMARY_APPLICATION_MAX_COUNT),
        applicationBundleIdentifiers: applicationBundleIdentifiers.slice(
          0,
          SUMMARY_APPLICATION_MAX_COUNT,
        ),
        childJobKeys:
          input.kind === "6h" ? input.childSummaries.map((child) => child.logicalJobKey) : [],
      };
    },
  };
}

function nextBoundary(nowMs: number, intervalMs: number): number {
  return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

/**
 * A local deterministic recursive summary engine.  It deliberately has no
 * provider, model, or network dependency.  The engine is usable standalone
 * in tests and can be attached to the service's lifecycle by calling
 * start/pause/resume/stop around recorder state transitions.
 */
export function createComputerHistorySummaryJobEngine(
  options: ComputerHistorySummaryJobEngineOptions = {},
): ComputerHistorySummaryJobEngine {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const setTimer =
    options.setTimer ?? ((handler, milliseconds) => setTimeout(handler, milliseconds));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const backend = options.backend ?? productionSummaryBackend();
  let inputs = new Map<string, ComputerHistoryMinuteFrameInput>();
  let pendingInputsReplacement: Map<string, ComputerHistoryMinuteFrameInput> | undefined;
  let pendingReplacementRevokesAddressability = false;
  const summaries = new Map<string, ComputerHistoryRecursiveSummary>();
  const timers = new Set<unknown>();
  let lifecycle: "stopped" | "running" | "paused" = "stopped";
  let activeRun: Promise<ComputerHistorySummaryJobRunResult> | undefined;
  let rerunRequested = false;
  let rerunScope: SummaryRunScope = "all";
  let abortController: AbortController | undefined;
  let generation = 0;
  let tenMinuteInputSignatures = new Map<string, string>();
  let sixHourChildSignatures = new Map<string, string>();
  let abandonedRun = false;
  let orphanedBackend = false;
  let publishedResourcePaths = new Map<string, string>();

  const inputMapsEqual = (
    left: ReadonlyMap<string, ComputerHistoryMinuteFrameInput>,
    right: ReadonlyMap<string, ComputerHistoryMinuteFrameInput>,
  ): boolean => {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (JSON.stringify(right.get(key)) !== JSON.stringify(value)) return false;
    }
    return true;
  };

  const stageInput = (normalized: ComputerHistoryMinuteFrameInput): boolean => {
    const source = pendingInputsReplacement ?? inputs;
    const key = stableInputKey(normalized);
    if (source.has(key)) return false;
    // Never mutate a map captured by an active run. The new map becomes a
    // distinct generation and is consumed by the run's explicit rerun.
    const next = new Map(source);
    next.set(key, normalized);
    pendingInputsReplacement = next;
    if (activeRun) {
      rerunRequested = true;
      rerunScope = "all";
    }
    return true;
  };

  const clearTimers = (): void => {
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };

  const schedule = (intervalMs: number, scope: SummaryRunScope): void => {
    if (lifecycle !== "running") return;
    const delay = Math.max(0, nextBoundary(now(), intervalMs) - now());
    const timer = setTimer(() => {
      timers.delete(timer);
      void (async () => {
        try {
          await runPending(now(), scope);
        } catch {
          // A scheduled failure is surfaced through the engine/service state;
          // it must never become an unhandled rejection.
        } finally {
          try {
            schedule(intervalMs, scope);
          } catch (error) {
            try {
              options.onRunError?.(error);
            } catch {
              // Health observers are advisory and must not alter timer safety.
            }
          }
        }
      })();
    }, delay);
    timers.add(timer);
  };

  const retryable = (error: unknown): boolean =>
    Boolean(
      error &&
      typeof error === "object" &&
      "retryable" in error &&
      (error as { retryable?: unknown }).retryable === true,
    );

  const runWithRetry = async (
    input: ComputerHistorySummaryBackendInput,
    signal: AbortSignal,
  ): Promise<ComputerHistoryRecursiveSummary> => {
    let attempt = 0;
    while (true) {
      if (signal.aborted) throw new DOMException("The summary job was cancelled.", "AbortError");
      attempt += 1;
      const attemptController = new AbortController();
      const forwardAbort = (): void => attemptController.abort();
      signal.addEventListener("abort", forwardAbort, { once: true });
      let timedOut = false;
      let backendPromise: Promise<ComputerHistoryRecursiveSummary> | undefined;
      try {
        const timeoutMs = Math.max(1, options.backendTimeoutMs ?? 5_000);
        let timeout: unknown;
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimer(() => {
            timedOut = true;
            attemptController.abort();
            reject(
              signal.aborted
                ? new DOMException("The summary job was cancelled.", "AbortError")
                : new ComputerHistorySummaryDeadlineError("Summary backend deadline exceeded."),
            );
          }, timeoutMs);
        });
        let output: ComputerHistoryRecursiveSummary;
        try {
          backendPromise = backend.summarize(input, attemptController.signal);
          // A non-cooperative backend may settle after the deadline.  Attach a
          // sink so the late rejection is never unhandled, and poison the
          // engine until that promise settles to prevent overlap.
          void backendPromise.then(
            () => {
              if (orphanedBackend && backendPromise) orphanedBackend = false;
            },
            () => {
              if (orphanedBackend && backendPromise) orphanedBackend = false;
            },
          );
          output = await Promise.race([backendPromise, deadline]);
        } finally {
          if (timeout !== undefined) clearTimer(timeout);
        }
        if (signal.aborted) {
          throw new DOMException("The summary job was cancelled.", "AbortError");
        }
        return normalizeBackendSummary(input, output);
      } catch (error) {
        if (timedOut) {
          orphanedBackend = true;
          throw error;
        }
        if (!retryable(error) || attempt >= COMPUTER_HISTORY_SUMMARY_MAX_ATTEMPTS) throw error;
        await sleep(COMPUTER_HISTORY_SUMMARY_RETRY_DELAY_MS, signal);
      } finally {
        signal.removeEventListener("abort", forwardAbort);
      }
    }
  };

  const buildMinuteInputs = (
    sourceInputs: ReadonlyMap<string, ComputerHistoryMinuteFrameInput> = inputs,
  ): Map<number, ComputerHistoryMinuteFrameInput[]> => {
    const result = new Map<number, ComputerHistoryMinuteFrameInput[]>();
    for (const input of sourceInputs.values()) {
      const bucket = result.get(input.minuteStartMs) ?? [];
      bucket.push(input);
      result.set(input.minuteStartMs, bucket);
    }
    for (const bucket of result.values()) {
      bucket.sort((left, right) => stableInputKey(left).localeCompare(stableInputKey(right)));
    }
    return result;
  };

  const runPendingInternal = async (
    nowMs: number,
    scope: SummaryRunScope,
    runGeneration: number,
  ): Promise<ComputerHistorySummaryJobRunResult> => {
    if (lifecycle !== "running") {
      return { ran: false, changed: false, failedJobKeys: [], published: [] };
    }
    const signal = abortController?.signal ?? new AbortController().signal;
    // Snapshot the selected source map before awaiting a backend. A later
    // observation/replacement is staged for the next run rather than being
    // allowed to mutate this run's graph mid-flight.
    const replacementAtRunStart = pendingInputsReplacement;
    const effectiveInputs = new Map(replacementAtRunStart ?? inputs);
    const minuteBuckets = buildMinuteInputs(effectiveInputs);
    const staged = new Map(summaries);
    const stagedTenMinuteInputSignatures = new Map(tenMinuteInputSignatures);
    const stagedSixHourChildSignatures = new Map(sixHourChildSignatures);
    if (replacementAtRunStart) {
      const nextTenStarts = new Set(
        [...effectiveInputs.values()].map((input) => tenMinuteStart(input.capturedAtMs)),
      );
      const affectedSixHourStarts = new Set<number>();
      for (const [key, summary] of staged) {
        if (summary.kind === "10min" && !nextTenStarts.has(summary.startMs)) {
          staged.delete(key);
          stagedTenMinuteInputSignatures.delete(key);
          affectedSixHourStarts.add(sixHourStart(summary.startMs));
        }
      }
      for (const [key, summary] of staged) {
        if (summary.kind === "6h" && affectedSixHourStarts.has(summary.startMs)) {
          staged.delete(key);
          stagedSixHourChildSignatures.delete(key);
        }
      }
    }
    const changed = new Set<string>();
    const failedJobKeys: string[] = [];
    let passChanged = false;
    let converged = false;

    for (let pass = 0; pass < COMPUTER_HISTORY_SUMMARY_MAX_CONVERGENCE_PASSES; pass += 1) {
      if (signal.aborted || runGeneration !== generation) {
        throw new DOMException("The summary job was cancelled.", "AbortError");
      }
      passChanged = false;
      if (scope === "all" || scope === "10min") {
        const tenMinuteStarts = [...new Set([...minuteBuckets.keys()].map(tenMinuteStart))].sort(
          (left, right) => left - right,
        );
        for (const startMs of tenMinuteStarts) {
          const minuteInputs = [...minuteBuckets.entries()]
            .filter(([minute]) => tenMinuteStart(minute) === startMs)
            .sort(([left], [right]) => left - right)
            .map(([, bucket]) => minuteSummary(bucket));
          if (minuteInputs.length === 0) continue;
          const key = logicalKey("10min", startMs);
          const inputSignature = JSON.stringify(minuteInputs);
          if (stagedTenMinuteInputSignatures.get(key) === inputSignature && staged.has(key)) {
            continue;
          }
          const previous = staged.get(key);
          try {
            const request: ComputerHistorySummaryBackendInput = {
              kind: "10min",
              startMs,
              endMs: startMs + COMPUTER_HISTORY_TEN_MINUTE_MS,
              minuteInputs,
              childSummaries: [],
              ...(previous ? { previous } : {}),
            };
            const next = await runWithRetry(request, signal);
            // The source signature is consumed by this successful attempt,
            // even when the produced node is new or its text changed.  The
            // next graph pass must inspect dependencies, not call the same
            // backend again for an already-processed source.
            stagedTenMinuteInputSignatures.set(key, inputSignature);
            const requeue = backend.needsAnotherPass?.(request, next) === true;
            if (requeue) {
              stagedTenMinuteInputSignatures.delete(key);
              passChanged = true;
            }
            if (!summaryEqual(previous, next)) {
              staged.set(key, next);
              changed.add(key);
              passChanged = true;
            }
          } catch (error) {
            if ((error as { name?: string }).name === "AbortError") throw error;
            failedJobKeys.push(key);
          }
        }
      }

      if (scope === "all" || scope === "6h") {
        const childBySixHour = new Map<number, ComputerHistoryRecursiveSummary[]>();
        for (const summary of staged.values()) {
          if (summary.kind !== "10min") continue;
          const parentStart = sixHourStart(summary.startMs);
          const children = childBySixHour.get(parentStart) ?? [];
          children.push(summary);
          childBySixHour.set(parentStart, children);
        }
        for (const [startMs, children] of [...childBySixHour.entries()].sort(([a], [b]) => a - b)) {
          const sortedChildren = children.sort((left, right) => left.startMs - right.startMs);
          // A parent only supersedes its ten-minute children once the exact
          // 36 child intervals have completed.
          if (
            sortedChildren.length !== 36 ||
            startMs + COMPUTER_HISTORY_SIX_HOUR_MS > nowMs ||
            sortedChildren.some(
              (child, index) => child.startMs !== startMs + index * COMPUTER_HISTORY_TEN_MINUTE_MS,
            )
          ) {
            continue;
          }
          const key = logicalKey("6h", startMs);
          const childSignature = JSON.stringify(sortedChildren);
          if (stagedSixHourChildSignatures.get(key) === childSignature && staged.has(key)) {
            continue;
          }
          const previous = staged.get(key);
          try {
            const request: ComputerHistorySummaryBackendInput = {
              kind: "6h",
              startMs,
              endMs: startMs + COMPUTER_HISTORY_SIX_HOUR_MS,
              minuteInputs: [],
              childSummaries: sortedChildren,
              ...(previous ? { previous } : {}),
            };
            const next = await runWithRetry(request, signal);
            stagedSixHourChildSignatures.set(key, childSignature);
            const requeue = backend.needsAnotherPass?.(request, next) === true;
            if (requeue) {
              stagedSixHourChildSignatures.delete(key);
              passChanged = true;
            }
            if (!summaryEqual(previous, next)) {
              staged.set(key, next);
              changed.add(key);
              passChanged = true;
            }
          } catch (error) {
            if ((error as { name?: string }).name === "AbortError") throw error;
            failedJobKeys.push(key);
          }
        }
      }
      if (failedJobKeys.length > 0) break;
      if (!passChanged) {
        converged = true;
        break;
      }
    }

    if (!converged || failedJobKeys.length > 0) {
      if (!converged && failedJobKeys.length === 0) {
        failedJobKeys.push("non_convergent");
      }
      return { ran: true, changed: false, failedJobKeys, published: [] };
    }

    if (options.rootDir) {
      const resources: ComputerHistorySummaryJobResource[] = [...staged.values()]
        .sort((left, right) => left.startMs - right.startMs || left.kind.localeCompare(right.kind))
        .map((summary) => ({
          logicalJobKey: summary.logicalJobKey,
          kind: summary.kind,
          startMs: summary.startMs,
          endMs: summary.endMs,
          title: summary.title,
          description: summary.description,
          summaryText: summary.summaryText,
          applications: summary.applications,
        }));
      // Build from the staged map, never from live state.  A writer error
      // therefore leaves both the in-memory and manifest snapshots at LKG.
      const paths = await syncComputerHistorySummaryJobResources(options.rootDir, resources, {
        ...(options.randomAlpha ? { randomAlpha: options.randomAlpha } : {}),
      });
      publishedResourcePaths = new Map(paths);
    }
    summaries.clear();
    for (const [key, summary] of staged) summaries.set(key, summary);
    inputs = new Map(effectiveInputs);
    if (pendingInputsReplacement === replacementAtRunStart) {
      pendingInputsReplacement = undefined;
      pendingReplacementRevokesAddressability = false;
    }
    tenMinuteInputSignatures = stagedTenMinuteInputSignatures;
    sixHourChildSignatures = stagedSixHourChildSignatures;
    const published = [...changed]
      .map((key) => staged.get(key))
      .filter((summary): summary is ComputerHistoryRecursiveSummary => summary !== undefined);
    return { ran: true, changed: changed.size > 0, failedJobKeys: [], published };
  };

  const runPending = async (
    nowMs = now(),
    scope: SummaryRunScope = "all",
  ): Promise<ComputerHistorySummaryJobRunResult> => {
    if (abandonedRun || orphanedBackend) {
      return { ran: false, changed: false, failedJobKeys: ["cancelled"], published: [] };
    }
    if (activeRun) {
      rerunRequested = true;
      rerunScope = rerunScope === scope ? scope : "all";
      return activeRun;
    }
    const controller = new AbortController();
    abortController = controller;
    const runGeneration = generation;
    const run = (async () => {
      let result = await runPendingInternal(nowMs, scope, runGeneration);
      while (rerunRequested && lifecycle === "running" && !abortController?.signal.aborted) {
        rerunRequested = false;
        const nextScope = rerunScope;
        rerunScope = "all";
        result = await runPendingInternal(now(), nextScope, runGeneration);
      }
      return result;
    })();
    activeRun = run;
    try {
      const result = await run;
      try {
        options.onRunResult?.(result);
      } catch {
        // Health observers are advisory and must not alter job semantics.
      }
      return result;
    } catch (error) {
      try {
        options.onRunError?.(error);
      } catch {
        // Health observers are advisory and must not alter job semantics.
      }
      throw error;
    } finally {
      if (activeRun === run) activeRun = undefined;
      if (abortController === controller) {
        abortController = undefined;
        abandonedRun = false;
      }
    }
  };

  return {
    state: () => lifecycle,
    start: async (startOptions = {}) => {
      if (lifecycle === "running") return;
      if (abandonedRun || orphanedBackend) {
        throw new ComputerHistorySummaryDeadlineError(
          "Computer History summary engine is waiting for a cancelled backend.",
        );
      }
      generation += 1;
      lifecycle = "running";
      try {
        if (startOptions.catchUp !== false) {
          const result = await runPending();
          if (result.failedJobKeys.length > 0) {
            throw new Error(
              `Computer History summary catch-up failed: ${result.failedJobKeys.join(",")}`,
            );
          }
        }
      } catch (error) {
        lifecycle = "stopped";
        clearTimers();
        generation += 1;
        throw error;
      }
      schedule(COMPUTER_HISTORY_MINUTE_MS, "10min");
      schedule(COMPUTER_HISTORY_HOUR_MS, "6h");
    },
    stop: async () => {
      lifecycle = "stopped";
      clearTimers();
      generation += 1;
      abandonedRun = activeRun !== undefined;
      abortController?.abort();
      activeRun = undefined;
      rerunRequested = false;
      rerunScope = "all";
    },
    pause: async () => {
      lifecycle = "paused";
      clearTimers();
      generation += 1;
      abandonedRun = activeRun !== undefined;
      abortController?.abort();
      activeRun = undefined;
      rerunRequested = false;
      rerunScope = "all";
    },
    resume: async (resumeOptions = {}) => {
      if (abandonedRun || orphanedBackend) {
        throw new ComputerHistorySummaryDeadlineError(
          "Computer History summary engine is waiting for a cancelled backend.",
        );
      }
      generation += 1;
      lifecycle = "running";
      try {
        if (resumeOptions.catchUp !== false) {
          const result = await runPending();
          if (result.failedJobKeys.length > 0) {
            throw new Error(
              `Computer History summary catch-up failed: ${result.failedJobKeys.join(",")}`,
            );
          }
        }
      } catch (error) {
        lifecycle = "paused";
        clearTimers();
        generation += 1;
        throw error;
      }
      schedule(COMPUTER_HISTORY_MINUTE_MS, "10min");
      schedule(COMPUTER_HISTORY_HOUR_MS, "6h");
    },
    addInput: (input) => {
      const normalized = normalizeInput(input);
      return stageInput(normalized);
    },
    addObservation: (observation) => {
      const safe = toComputerHistorySafeSummaryInput(observation);
      return stageInput(normalizeInput(safe));
    },
    replaceInputs: (nextInputs) => {
      const stagedInputs = new Map<string, ComputerHistoryMinuteFrameInput>();
      let accepted = 0;
      for (const input of nextInputs) {
        const normalized = normalizeInput(input);
        const key = stableInputKey(normalized);
        if (stagedInputs.has(key)) continue;
        stagedInputs.set(key, normalized);
        accepted += 1;
      }
      const currentInputs = pendingInputsReplacement ?? inputs;
      if (inputMapsEqual(stagedInputs, currentInputs)) {
        // Hydration is called by ordinary list/status operations. Re-staging
        // an identical map would make a fresh recursive snapshot appear
        // pending forever and could revoke an otherwise current projection.
        if (pendingInputsReplacement && inputMapsEqual(stagedInputs, inputs)) {
          pendingInputsReplacement = undefined;
          pendingReplacementRevokesAddressability = false;
        }
        return accepted;
      }
      pendingInputsReplacement = stagedInputs;
      pendingReplacementRevokesAddressability = true;
      // A replacement changes the source graph. Until the new graph has been
      // atomically summarized and published, old recursive files are never
      // addressable by the service even if their in-memory LKG remains.
      if (activeRun) {
        rerunRequested = true;
        rerunScope = "all";
      }
      return accepted;
    },
    runPending,
    snapshot: () =>
      [...summaries.values()].sort(
        (left, right) => left.startMs - right.startMs || left.kind.localeCompare(right.kind),
      ),
    minuteInputs: () =>
      [...(pendingInputsReplacement ?? inputs).values()].sort(
        (left, right) => left.capturedAtMs - right.capturedAtMs,
      ),
    resourcePaths: () => new Map(publishedResourcePaths),
    hasPendingInputReplacement: () =>
      pendingReplacementRevokesAddressability && pendingInputsReplacement !== undefined,
    invalidatePublishedResources: () => {
      publishedResourcePaths = new Map();
    },
  };
}
