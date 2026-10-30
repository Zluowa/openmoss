import type {
  ComputerHistoryClearScope,
  ComputerHistorySettings,
  ComputerHistoryState,
  ComputerHistoryTimelineEntry,
} from "@synara/contracts";

import type { TranslationKey } from "~/localization";

export type PermissionMode = "allow" | "include";
export type TimelineDensity = "10m" | "6h";

export const DEFAULT_SETTINGS: ComputerHistorySettings = {
  consentAt: null,
  observation: {
    defaultApplicationBehavior: "allow",
    defaultURLBehavior: "allow",
    allowlist: [],
    blocklist: [],
    urlAllowlist: [],
    urlBlocklist: [],
  },
};

export const ONBOARDING_PAGES = [
  {
    title: "settings.history.onboarding.page1.title",
    body: "settings.history.onboarding.page1.body",
  },
  {
    title: "settings.history.onboarding.page2.title",
    body: "settings.history.onboarding.page2.body",
  },
  {
    title: "settings.history.onboarding.page3.title",
    body: "settings.history.onboarding.page3.body",
  },
  {
    title: "settings.history.onboarding.page4.title",
    body: "settings.history.onboarding.page4.body",
  },
] as const satisfies ReadonlyArray<{ title: TranslationKey; body: TranslationKey }>;

const TIMELINE_PERIOD_LABELS: Record<
  "morning" | "afternoon" | "evening" | "overnight",
  TranslationKey
> = {
  morning: "settings.history.morning",
  afternoon: "settings.history.afternoon",
  evening: "settings.history.evening",
  overnight: "settings.history.overnight",
};

export const CLEAR_SCOPE_LABELS: Record<ComputerHistoryClearScope, TranslationKey> = {
  last_10m: "settings.history.scope.last10m",
  last_1h: "settings.history.scope.last1h",
  last_1d: "settings.history.scope.last1d",
  all: "settings.history.scope.all",
};

export const CLEAR_SCOPE_QUESTION_KEYS: Record<ComputerHistoryClearScope, TranslationKey> = {
  last_10m: "settings.history.clearQuestion.last10m",
  last_1h: "settings.history.clearQuestion.last1h",
  last_1d: "settings.history.clearQuestion.last1d",
  all: "settings.history.clearQuestion.all",
};

export function clearScopeQuestionKey(scope: ComputerHistoryClearScope): TranslationKey {
  return CLEAR_SCOPE_QUESTION_KEYS[scope];
}

export function extractComputerHistoryErrorCode(error: unknown): string | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    const first = message.match(/^Codex Computer Use Apple Event error (-?\d+):/u);
    const second = message.match(/^AE.+ failed with (-?\d+)(?:\s|$)/u);
    const match = first ?? second;
    if (match?.[1]) return match[1];
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause) pending.push(cause);
    }
  }
  return null;
}

export function segmentExampleText(
  value: string,
  locale?: string,
): Array<{
  readonly text: string;
  readonly delayIndex: number;
}> {
  const segments: Array<{ text: string; delayIndex: number }> = [];
  const Segmenter = globalThis.Intl?.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(locale, { granularity: "word" });
    let delayIndex = 0;
    let hasWord = false;
    for (const part of segmenter.segment(value)) {
      segments.push({
        text: part.segment,
        delayIndex: part.isWordLike ? delayIndex : Math.max(0, delayIndex - (hasWord ? 1 : 0)),
      });
      if (part.isWordLike) {
        hasWord = true;
        delayIndex += 1;
      }
    }
    return segments;
  }
  let delayIndex = 0;
  let hasWord = false;
  for (const part of value.split(/(\s+)/u).filter(Boolean)) {
    const wordLike = /[\p{L}\p{N}]/u.test(part);
    segments.push({
      text: part,
      delayIndex: wordLike ? delayIndex : Math.max(0, delayIndex - (hasWord ? 1 : 0)),
    });
    if (wordLike) {
      hasWord = true;
      delayIndex += 1;
    }
  }
  return segments;
}

export function browserPermissionSubtitle(
  isWebBrowser: boolean,
  applicationBehavior: "allow" | "block",
  urlBehavior: "allow" | "block",
  selectedWebsiteCount: number,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string | null {
  if (!isWebBrowser || applicationBehavior !== "block") return null;
  if (urlBehavior === "allow") {
    return selectedWebsiteCount === 0
      ? t("settings.history.browser.allWebsites")
      : t(
          selectedWebsiteCount === 1
            ? "settings.history.browser.allButWebsite"
            : "settings.history.browser.allButWebsites",
          { count: selectedWebsiteCount },
        );
  }
  return selectedWebsiteCount === 0
    ? t("settings.history.browser.noWebsites")
    : t(
        selectedWebsiteCount === 1
          ? "settings.history.browser.onlyWebsite"
          : "settings.history.browser.onlyWebsites",
        { count: selectedWebsiteCount },
      );
}

export function fallbackApplicationName(bundleIdentifier: string): string {
  const pieces = bundleIdentifier.split(".").filter(Boolean);
  return pieces.at(-1) ?? bundleIdentifier;
}

export function stateLabel(
  state: ComputerHistoryState | null,
  t: (key: TranslationKey) => string,
): string {
  if (!state) return t("settings.history.loading");
  if (!state.supported) return t("settings.history.state.unavailableLabel");
  if (state.activationState === "waiting_for_permissions") {
    return t("settings.history.state.permission");
  }
  if (state.activationState === "failed") return t("settings.history.state.attention");
  if (!state.enabled) return t("settings.history.state.off");
  if (state.recorderState === "paused") return t("settings.history.state.paused");
  return t("settings.history.state.on");
}

export function formatEntryTime(timestampMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

export function timelinePeriodFor(timestampMs: number): keyof typeof TIMELINE_PERIOD_LABELS {
  const hour = new Date(timestampMs).getHours();
  if (hour >= 4 && hour < 10) return "morning";
  if (hour >= 10 && hour < 16) return "afternoon";
  if (hour >= 16 && hour < 22) return "evening";
  return "overnight";
}

export function formatTimelineEntryTime(
  entry: Pick<ComputerHistoryTimelineEntry, "summaryLevel" | "interval">,
  t: (key: TranslationKey) => string,
): string {
  return entry.summaryLevel === "six_hour"
    ? t(TIMELINE_PERIOD_LABELS[timelinePeriodFor(entry.interval.startMs)])
    : formatEntryTime(entry.interval.startMs);
}

export function formatTimelineIntervalTooltip(
  entry: Pick<ComputerHistoryTimelineEntry, "interval">,
  locale?: string,
): string {
  return `${formatEntryTime(entry.interval.startMs, locale)} – ${formatEntryTime(entry.interval.endMs, locale)}`;
}

export function dateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return (
    String(date.getFullYear()) + "-" + String(date.getMonth() + 1) + "-" + String(date.getDate())
  );
}

function dayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dateHeading(
  timestampMs: number,
  t: (key: TranslationKey) => string,
  locale?: string,
): string {
  const difference = Math.round((dayStart(Date.now()) - dayStart(timestampMs)) / 86_400_000);
  if (difference === 0) return t("settings.history.today");
  if (difference === 1) return t("settings.history.yesterday");
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(timestampMs));
}

export interface TimelineCluster {
  readonly key: string;
  readonly date: string;
  readonly startMs: number;
  readonly entries: ComputerHistoryTimelineEntry[];
  readonly interval: ComputerHistoryTimelineEntry["interval"];
}

export interface TimelineDayGroup {
  readonly key: string;
  readonly date: string;
  readonly entries: ComputerHistoryTimelineEntry[];
}

/**
 * The Codex history surface is grouped by day. Keep the grouping independent
 * from the server's ordering so a reconnect or a paginated response cannot
 * move an entry into the wrong visual group.
 */
export function timelineDayGroups(
  entries: readonly ComputerHistoryTimelineEntry[],
): TimelineDayGroup[] {
  const groups = new Map<string, TimelineDayGroup>();
  for (const entry of entries) {
    const date = dateKey(entry.interval.startMs);
    const current = groups.get(date);
    if (current) {
      current.entries.push(entry);
    } else {
      groups.set(date, { key: date, date, entries: [entry] });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort(
        (left, right) => right.interval.startMs - left.interval.startMs,
      ),
    }))
    .sort((left, right) => {
      const leftStart = left.entries[0]?.interval.startMs ?? 0;
      const rightStart = right.entries[0]?.interval.startMs ?? 0;
      return rightStart - leftStart;
    });
}

export function timelineClusters(
  entries: readonly ComputerHistoryTimelineEntry[],
  density: TimelineDensity,
): TimelineCluster[] {
  // Formal entries already carry their exact summary interval; density is
  // retained for callers migrating from the old selector API.
  void density;
  const clusters = new Map<string, TimelineCluster>();
  for (const entry of entries) {
    const startMs = entry.interval.startMs;
    const key = dateKey(startMs) + ":" + String(startMs);
    const current = clusters.get(key);
    if (current) {
      current.entries.push(entry);
    } else {
      clusters.set(key, {
        key,
        date: dateKey(startMs),
        startMs,
        interval: entry.interval,
        entries: [entry],
      });
    }
  }
  return [...clusters.values()].sort((left, right) => left.startMs - right.startMs);
}

export function normalizeHostInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname && !hostname.includes("%") ? hostname : null;
  } catch {
    return null;
  }
}

export function toggleTimelineCluster(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function toggleHighlightedApp(current: string | null, app: string): string | null {
  return current === app ? null : app;
}

export function timelineHasGap(
  previous: Pick<ComputerHistoryTimelineEntry, "interval"> | undefined,
  current: Pick<ComputerHistoryTimelineEntry, "interval">,
  next: Pick<ComputerHistoryTimelineEntry, "interval"> | undefined,
): { readonly before: boolean; readonly after: boolean } {
  return {
    before: previous !== undefined && previous.interval.startMs > current.interval.endMs,
    after: next !== undefined && current.interval.startMs > next.interval.endMs,
  };
}

export function isComputerHistoryApplicationIncluded(
  settings: ComputerHistorySettings,
  bundleIdentifier: string,
): boolean {
  const observation = settings.observation;
  return observation.defaultApplicationBehavior === "allow"
    ? !observation.blocklist.includes(bundleIdentifier)
    : observation.allowlist.includes(bundleIdentifier);
}
