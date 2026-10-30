// FILE: mossNormalizedTimeline.tsx
// Purpose: Map Moss normalized session events into chat-adjacent timeline rows.
// Layer: Web chat control-plane presentation helper
// Exports: normalized event hook, work-entry/timeline derivation, lightweight timeline component

import {
  isToolLifecycleItemType,
  type MossNormalizedSessionEvent,
  type MossSubscribeNormalizedSessionEventsInput,
  type ProviderSubmitPermissionActionResult,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readNativeApi } from "../../nativeApi";
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";

type UnknownRecord = Record<string, unknown>;

export interface MossNormalizedTimelineState {
  events: ReadonlyArray<MossNormalizedSessionEvent>;
  workEntries: ReadonlyArray<WorkLogEntry>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}

export type MossNormalizedEventSubscriptionStatus =
  | "disabled"
  | "bridge-missing"
  | "subscribed"
  | "empty-replay"
  | "live"
  | "error";

export type MossNormalizedEventSubscriptionScope = "active-thread" | "selected-session";

export interface MossNormalizedEventSubscriptionState {
  readonly status: MossNormalizedEventSubscriptionStatus;
  readonly label: string;
  readonly threadId: string | null;
  readonly eventCount: number;
  readonly error: string | null;
}

export interface MossNormalizedTimelineSubscriptionState extends MossNormalizedEventSubscriptionState {
  readonly scope: MossNormalizedEventSubscriptionScope;
  readonly scopeLabel: string;
}

export interface MossNormalizedSessionEventsState extends MossNormalizedTimelineState {
  readonly subscription: MossNormalizedEventSubscriptionState;
}

export type MossNormalizedEventTimelineFilter = "all" | MossNormalizedSessionEvent["type"];

export interface MossNormalizedEventFilterOption {
  readonly value: MossNormalizedEventTimelineFilter;
  readonly label: string;
  readonly count: number;
}

export interface MossNormalizedEventTimelineScope {
  readonly threadId?: string | null | undefined;
  readonly sessionId?: string | null | undefined;
  readonly label: string;
  readonly activeThread: boolean;
  readonly onClear?: (() => void) | undefined;
}

export interface MossNormalizedEventTraceField {
  readonly label: string;
  readonly value: string;
}

export type MossNormalizedPermissionKind =
  | "command"
  | "file-read"
  | "file-change"
  | "user-input"
  | "unknown";
export type MossNormalizedPermissionStateTone = "pending" | "resolved" | "denied" | "unknown";

export interface MossNormalizedPermissionState {
  readonly status: string;
  readonly state: MossNormalizedPermissionStateTone;
  readonly label: string;
  readonly kind: MossNormalizedPermissionKind;
  readonly kindLabel: string;
  readonly detail?: string | undefined;
  readonly decision?: string | undefined;
}

export type MossNormalizedPermissionActionIntentKind = "approve" | "deny" | "defer";
export type MossNormalizedPermissionActionShellStatus =
  | "runtime-bridge-missing"
  | "ready"
  | "submitting"
  | "accepted"
  | "unsupported"
  | "rejected"
  | "failed"
  | "not-applicable";

export type MossNormalizedPermissionActionSubmissionStatus =
  | "submitting"
  | ProviderSubmitPermissionActionResult["status"]
  | "failed";

export interface MossNormalizedPermissionActionIntent {
  readonly intent: MossNormalizedPermissionActionIntentKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string | undefined;
}

export interface MossNormalizedPermissionActionShell {
  readonly status: MossNormalizedPermissionActionShellStatus;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason: string;
  readonly permissionState: MossNormalizedPermissionStateTone;
  readonly permissionKind: MossNormalizedPermissionKind;
  readonly intents: ReadonlyArray<MossNormalizedPermissionActionIntent>;
}

export interface MossNormalizedPermissionActionSubmissionState {
  readonly intent: MossNormalizedPermissionActionIntentKind;
  readonly status: MossNormalizedPermissionActionSubmissionStatus;
  readonly message: string;
}

export type MossNormalizedToolLifecycleRole = "call" | "result";
export type MossNormalizedToolLifecycleTone =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "orphaned";

export interface MossNormalizedToolLifecycleState {
  readonly lifecycleId: string;
  readonly state: MossNormalizedToolLifecycleTone;
  readonly label: string;
  readonly role: MossNormalizedToolLifecycleRole;
  readonly hasCall: boolean;
  readonly hasResult: boolean;
  readonly toolName?: string | undefined;
  readonly status?: string | undefined;
}

export interface MossNormalizedUsageSummary {
  readonly label: string;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly usedTokens?: number | undefined;
  readonly model?: string | undefined;
  readonly totalCostUsd?: number | undefined;
  readonly cumulativeCostUsd?: number | undefined;
}

export type MossNormalizedFinishStateTone = "completed" | "interrupted" | "failed" | "unknown";

export interface MossNormalizedFinishSummary {
  readonly status: string;
  readonly state: MossNormalizedFinishStateTone;
  readonly label: string;
  readonly stopReason?: string | undefined;
  readonly error?: string | undefined;
}

export type MossNormalizedTextStreamKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output"
  | "unknown";

export type MossNormalizedTextRole =
  | "assistant"
  | "reasoning"
  | "plan"
  | "command-output"
  | "file-change-output"
  | "unknown";

export interface MossNormalizedTextSummary {
  readonly streamKind: MossNormalizedTextStreamKind;
  readonly role: MossNormalizedTextRole;
  readonly label: string;
  readonly preview?: string | undefined;
  readonly previewLength: number;
}

export type MossNormalizedErrorSeverity = "warning" | "error" | "fatal" | "unknown";

export interface MossNormalizedErrorSummary {
  readonly severity: MossNormalizedErrorSeverity;
  readonly label: string;
  readonly message?: string | undefined;
  readonly errorClass?: string | undefined;
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly recoverable?: boolean | undefined;
}

export type MossNormalizedSessionRunStateKind =
  | "idle"
  | "running"
  | "waiting-for-permission"
  | "completed"
  | "interrupted"
  | "failed";

export interface MossNormalizedSessionRunState {
  readonly state: MossNormalizedSessionRunStateKind;
  readonly label: string;
  readonly eventCount: number;
  readonly pendingPermissionCount: number;
  readonly runningToolCount: number;
  readonly errorCount: number;
  readonly lastEventType?: MossNormalizedSessionEvent["type"] | undefined;
  readonly lastFinishState?: MossNormalizedFinishStateTone | undefined;
}

export type MossNormalizedEventDetailSectionKind =
  | "trace"
  | "row"
  | "text"
  | "tool"
  | "permission"
  | "permission-action"
  | "usage"
  | "finish"
  | "error";

export interface MossNormalizedEventDetailField {
  readonly label: string;
  readonly value: string;
}

export interface MossNormalizedEventDetailSection {
  readonly kind: MossNormalizedEventDetailSectionKind;
  readonly title: string;
  readonly fields: ReadonlyArray<MossNormalizedEventDetailField>;
}

export interface MossNormalizedEventDetail {
  readonly eventId: string;
  readonly type: MossNormalizedSessionEvent["type"];
  readonly provider: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly title: string;
  readonly preview?: string | undefined;
  readonly permissionActionShell?: MossNormalizedPermissionActionShell | undefined;
  readonly sections: ReadonlyArray<MossNormalizedEventDetailSection>;
}

export interface UseMossNormalizedSessionEventsInput {
  threadId: ThreadId | null | undefined;
  afterEventId?: MossSubscribeNormalizedSessionEventsInput["afterEventId"] | undefined;
  limit?: MossSubscribeNormalizedSessionEventsInput["limit"] | undefined;
  enabled?: boolean | undefined;
}

export interface MossNormalizedEventTimelineProps {
  events: ReadonlyArray<MossNormalizedSessionEvent>;
  emptyLabel?: string | undefined;
  initialSelectedEventId?: string | undefined;
  scope?: MossNormalizedEventTimelineScope | undefined;
  subscription?: MossNormalizedTimelineSubscriptionState | undefined;
}

const MOSS_NORMALIZED_EVENT_FILTERS = [
  "all",
  "text",
  "tool-call",
  "tool-result",
  "usage",
  "permission-request",
  "finish",
  "error",
] as const satisfies ReadonlyArray<MossNormalizedEventTimelineFilter>;
const MOSS_EMPTY_REPLAY_STATUS_DELAY_MS = 20;

export function useMossNormalizedSessionEvents({
  threadId,
  afterEventId,
  limit,
  enabled = true,
}: UseMossNormalizedSessionEventsInput): MossNormalizedSessionEventsState {
  const [events, setEvents] = useState<ReadonlyArray<MossNormalizedSessionEvent>>([]);
  const [subscription, setSubscription] = useState<MossNormalizedEventSubscriptionState>(() =>
    mossNormalizedSubscriptionState({
      status: enabled && threadId ? "subscribed" : "disabled",
      threadId,
      eventCount: 0,
    }),
  );

  useEffect(() => {
    if (!enabled || !threadId) {
      setEvents([]);
      setSubscription(
        mossNormalizedSubscriptionState({
          status: "disabled",
          threadId,
          eventCount: 0,
        }),
      );
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setEvents([]);
      setSubscription(
        mossNormalizedSubscriptionState({
          status: "bridge-missing",
          threadId,
          eventCount: 0,
        }),
      );
      return;
    }

    const subscribe = api.provider.subscribeNormalizedSessionEvents;
    if (typeof subscribe !== "function") {
      setEvents([]);
      setSubscription(
        mossNormalizedSubscriptionState({
          status: "bridge-missing",
          threadId,
          eventCount: 0,
        }),
      );
      return;
    }

    const seenEventIds = new Set<string>();
    let cancelled = false;
    let emptyReplayTimer: ReturnType<typeof setTimeout> | undefined;
    let uniqueEventCount = 0;
    setEvents([]);
    setSubscription(
      mossNormalizedSubscriptionState({
        status: "subscribed",
        threadId,
        eventCount: 0,
      }),
    );

    const input = {
      threadId,
      ...(afterEventId ? { afterEventId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };

    try {
      const unsubscribe = subscribe(input, (event) => {
        if (cancelled) {
          return;
        }
        if (seenEventIds.has(event.eventId)) {
          return;
        }
        seenEventIds.add(event.eventId);
        uniqueEventCount += 1;
        if (emptyReplayTimer) {
          clearTimeout(emptyReplayTimer);
          emptyReplayTimer = undefined;
        }
        setSubscription(
          mossNormalizedSubscriptionState({
            status: "live",
            threadId,
            eventCount: uniqueEventCount,
          }),
        );
        setEvents((current) => [...current, event].toSorted(compareNormalizedEvents));
      });

      emptyReplayTimer = setTimeout(() => {
        if (cancelled || uniqueEventCount > 0) {
          return;
        }
        setSubscription(
          mossNormalizedSubscriptionState({
            status: "empty-replay",
            threadId,
            eventCount: 0,
          }),
        );
      }, MOSS_EMPTY_REPLAY_STATUS_DELAY_MS);

      return () => {
        cancelled = true;
        if (emptyReplayTimer) {
          clearTimeout(emptyReplayTimer);
          emptyReplayTimer = undefined;
        }
        unsubscribe();
      };
    } catch (error) {
      setEvents([]);
      setSubscription(
        mossNormalizedSubscriptionState({
          status: "error",
          threadId,
          eventCount: 0,
          error,
        }),
      );
      return;
    }
  }, [afterEventId, enabled, limit, threadId]);

  return useMemo(
    () => ({
      ...deriveMossNormalizedTimelineState(events),
      subscription: mossNormalizedSubscriptionState({
        status: subscription.status,
        threadId: subscription.threadId,
        eventCount: events.length,
        error: subscription.error,
      }),
    }),
    [events, subscription],
  );
}

export function deriveMossNormalizedTimelineState(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): MossNormalizedTimelineState {
  const workEntries = deriveMossNormalizedWorkEntries(events);
  return {
    events,
    workEntries,
    timelineEntries: workEntries.map((entry) => ({
      id: entry.id,
      kind: "work" as const,
      createdAt: entry.createdAt,
      entry,
    })),
  };
}

export function mossNormalizedSubscriptionState({
  status,
  threadId,
  eventCount,
  error = null,
}: {
  readonly status: MossNormalizedEventSubscriptionStatus;
  readonly threadId?: ThreadId | string | null | undefined;
  readonly eventCount: number;
  readonly error?: unknown;
}): MossNormalizedEventSubscriptionState {
  const errorMessage =
    error === null
      ? null
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : String(error);
  return {
    status,
    label: mossNormalizedSubscriptionStatusLabel(status),
    threadId: threadId ? String(threadId) : null,
    eventCount,
    error: errorMessage,
  };
}

function mossNormalizedSubscriptionStatusLabel(
  status: MossNormalizedEventSubscriptionStatus,
): string {
  switch (status) {
    case "disabled":
      return "Disabled";
    case "bridge-missing":
      return "Bridge missing";
    case "subscribed":
      return "Subscribed";
    case "empty-replay":
      return "Empty replay";
    case "live":
      return "Live events";
    case "error":
      return "Subscription error";
  }
}

export function deriveMossNormalizedWorkEntries(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): WorkLogEntry[] {
  return [...events].toSorted(compareNormalizedEvents).map(mossNormalizedEventToWorkEntry);
}

export function filterMossNormalizedEvents(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
  filter: MossNormalizedEventTimelineFilter,
): MossNormalizedSessionEvent[] {
  if (filter === "all") {
    return [...events];
  }

  return events.filter((event) => event.type === filter);
}

export function filterMossNormalizedEventsByScope(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
  scope?: MossNormalizedEventTimelineScope | null | undefined,
): MossNormalizedSessionEvent[] {
  if (!scope) {
    return [...events];
  }

  const scopeThreadId = scope.threadId ? String(scope.threadId) : null;
  const scopeSessionId = scope.sessionId ? String(scope.sessionId) : null;

  return events.filter((event) => {
    const threadMatches = scopeThreadId ? String(event.threadId) === scopeThreadId : true;
    const sessionMatches = scopeSessionId ? String(event.sessionId) === scopeSessionId : true;
    return threadMatches && sessionMatches;
  });
}

export function deriveMossNormalizedEventFilterOptions(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): ReadonlyArray<MossNormalizedEventFilterOption> {
  return MOSS_NORMALIZED_EVENT_FILTERS.map((filter) => ({
    value: filter,
    label: filterLabel(filter),
    count:
      filter === "all" ? events.length : events.filter((event) => event.type === filter).length,
  }));
}

export function deriveMossNormalizedEventTraceFields(
  event: MossNormalizedSessionEvent,
): ReadonlyArray<MossNormalizedEventTraceField> {
  const payload = asRecord(event.payload) ?? {};
  const launchPlanHash = firstString(payload.launchPlanHash);
  const fields: MossNormalizedEventTraceField[] = [
    { label: "Event", value: String(event.eventId) },
    { label: "Type", value: event.type },
    { label: "Provider", value: event.provider },
    { label: "Session", value: String(event.sessionId) },
  ];

  if (event.turnId) {
    fields.push({ label: "Turn", value: String(event.turnId) });
  }
  if (event.rawEventId) {
    fields.push({ label: "Raw event", value: String(event.rawEventId) });
  }
  if (launchPlanHash) {
    fields.push({ label: "Launch plan", value: launchPlanHash });
  }

  return fields;
}

export function deriveMossNormalizedPermissionState(
  event: MossNormalizedSessionEvent,
): MossNormalizedPermissionState | null {
  if (event.type !== "permission-request") {
    return null;
  }

  return deriveMossNormalizedPermissionStateFromPayload(asRecord(event.payload) ?? {});
}

export function deriveMossNormalizedPermissionActionShell(
  event: MossNormalizedSessionEvent,
  options?: {
    readonly bridgeAvailable?: boolean | undefined;
    readonly submission?: MossNormalizedPermissionActionSubmissionState | undefined;
  },
): MossNormalizedPermissionActionShell | null {
  const permissionState = deriveMossNormalizedPermissionState(event);
  if (!permissionState) {
    return null;
  }

  return deriveMossNormalizedPermissionActionShellFromState(permissionState, options);
}

export function deriveMossNormalizedToolLifecycleStates(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): ReadonlyMap<string, MossNormalizedToolLifecycleState> {
  const groups = new Map<string, MossNormalizedToolLifecycleGroup>();

  for (const event of events) {
    if (event.type !== "tool-call" && event.type !== "tool-result") {
      continue;
    }
    const payload = asRecord(event.payload) ?? {};
    const lifecycleId = toolLifecycleId(event, payload);
    const group = groups.get(lifecycleId) ?? {
      lifecycleId,
      events: [],
    };
    group.events.push({ event, payload });
    groups.set(lifecycleId, group);
  }

  const lifecycleByEventId = new Map<string, MossNormalizedToolLifecycleState>();
  for (const group of groups.values()) {
    const state = toolLifecycleStateForGroup(group);
    for (const item of group.events) {
      lifecycleByEventId.set(String(item.event.eventId), {
        ...state,
        role: item.event.type === "tool-result" ? "result" : "call",
      });
    }
  }

  return lifecycleByEventId;
}

export function deriveMossNormalizedUsageSummary(
  event: MossNormalizedSessionEvent,
): MossNormalizedUsageSummary | null {
  if (event.type !== "usage") {
    return null;
  }

  return deriveMossNormalizedUsageSummaryFromPayload(asRecord(event.payload) ?? {});
}

export function deriveMossNormalizedFinishSummary(
  event: MossNormalizedSessionEvent,
): MossNormalizedFinishSummary | null {
  if (event.type !== "finish") {
    return null;
  }

  return deriveMossNormalizedFinishSummaryFromPayload(asRecord(event.payload) ?? {});
}

export function deriveMossNormalizedTextSummary(
  event: MossNormalizedSessionEvent,
): MossNormalizedTextSummary | null {
  if (event.type !== "text") {
    return null;
  }

  return deriveMossNormalizedTextSummaryFromPayload(asRecord(event.payload) ?? {});
}

export function deriveMossNormalizedErrorSummary(
  event: MossNormalizedSessionEvent,
): MossNormalizedErrorSummary | null {
  if (event.type !== "error") {
    return null;
  }

  return deriveMossNormalizedErrorSummaryFromPayload(asRecord(event.payload) ?? {});
}

export function deriveMossNormalizedSessionRunState(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): MossNormalizedSessionRunState {
  const orderedEvents = [...events].toSorted(compareNormalizedEvents);
  const lastEvent = orderedEvents.at(-1);
  const pendingPermissionCount = orderedEvents.filter((event) => {
    const state = deriveMossNormalizedPermissionState(event);
    return state?.state === "pending";
  }).length;
  const errorCount = orderedEvents.filter((event) => event.type === "error").length;
  const runningToolCount = countRunningToolLifecycles(orderedEvents);
  const lastFinishSummary = lastMossNormalizedFinishSummary(orderedEvents);
  const state = sessionRunStateKind({
    lastEvent,
    lastFinishState: lastFinishSummary?.state,
    pendingPermissionCount,
    runningToolCount,
  });

  return {
    state,
    label: sessionRunStateLabel(state),
    eventCount: orderedEvents.length,
    pendingPermissionCount,
    runningToolCount,
    errorCount,
    ...(lastEvent ? { lastEventType: lastEvent.type } : {}),
    ...(lastFinishSummary ? { lastFinishState: lastFinishSummary.state } : {}),
  };
}

export function deriveMossNormalizedEventDetail(
  event: MossNormalizedSessionEvent,
  events: ReadonlyArray<MossNormalizedSessionEvent> = [event],
  options?: {
    readonly permissionActionShell?: MossNormalizedPermissionActionShell | null | undefined;
  },
): MossNormalizedEventDetail {
  const workEntry = mossNormalizedEventToWorkEntry(event);
  const traceFields = deriveMossNormalizedEventTraceFields(event).filter(
    (field) => field.label !== "Raw event",
  );
  const toolLifecycle = deriveMossNormalizedToolLifecycleStates(events).get(String(event.eventId));
  const permissionState = deriveMossNormalizedPermissionState(event);
  const permissionActionShell =
    options?.permissionActionShell ?? deriveMossNormalizedPermissionActionShell(event);
  const usageSummary = deriveMossNormalizedUsageSummary(event);
  const finishSummary = deriveMossNormalizedFinishSummary(event);
  const textSummary = deriveMossNormalizedTextSummary(event);
  const errorSummary = deriveMossNormalizedErrorSummary(event);
  const sections = [
    detailSection("trace", "Trace", traceFields),
    detailSection("row", "Row", [
      { label: "Title", value: workEntry.toolTitle ?? workEntry.label },
      { label: "Tone", value: workEntry.tone },
      { label: "Created", value: workEntry.createdAt },
      ...(workEntry.preview ? [{ label: "Preview", value: workEntry.preview }] : []),
    ]),
    textSummary
      ? detailSection("text", "Text", [
          { label: "Role", value: textRoleLabel(textSummary.role) },
          { label: "Stream", value: textSummary.streamKind },
          { label: "Preview length", value: formatInteger(textSummary.previewLength) },
          ...(textSummary.preview ? [{ label: "Preview", value: textSummary.preview }] : []),
        ])
      : null,
    toolLifecycle
      ? detailSection("tool", "Tool lifecycle", [
          { label: "Lifecycle", value: toolLifecycle.lifecycleId },
          { label: "State", value: toolLifecycle.label },
          { label: "Role", value: toolLifecycle.role === "result" ? "Result" : "Call" },
          { label: "Has call", value: toolLifecycle.hasCall ? "Yes" : "No" },
          { label: "Has result", value: toolLifecycle.hasResult ? "Yes" : "No" },
          ...(toolLifecycle.toolName ? [{ label: "Tool", value: toolLifecycle.toolName }] : []),
          ...(toolLifecycle.status ? [{ label: "Status", value: toolLifecycle.status }] : []),
        ])
      : null,
    permissionState
      ? detailSection("permission", "Permission", [
          { label: "State", value: permissionState.label },
          { label: "Status", value: permissionState.status },
          { label: "Kind", value: permissionState.kindLabel },
          ...(permissionState.decision
            ? [{ label: "Decision", value: permissionState.decision }]
            : []),
          ...(permissionState.detail ? [{ label: "Detail", value: permissionState.detail }] : []),
        ])
      : null,
    permissionActionShell
      ? detailSection("permission-action", "Permission actions", [
          { label: "Status", value: permissionActionShell.label },
          { label: "Enabled", value: permissionActionShell.enabled ? "Yes" : "No" },
          { label: "Reason", value: permissionActionShell.disabledReason },
          { label: "Intent count", value: formatInteger(permissionActionShell.intents.length) },
        ])
      : null,
    usageSummary
      ? detailSection("usage", "Usage", [
          { label: "Summary", value: usageSummary.label },
          ...(usageSummary.model ? [{ label: "Model", value: usageSummary.model }] : []),
          ...(usageSummary.inputTokens !== undefined
            ? [{ label: "Input tokens", value: formatInteger(usageSummary.inputTokens) }]
            : []),
          ...(usageSummary.outputTokens !== undefined
            ? [{ label: "Output tokens", value: formatInteger(usageSummary.outputTokens) }]
            : []),
          ...(usageSummary.usedTokens !== undefined
            ? [{ label: "Total tokens", value: formatInteger(usageSummary.usedTokens) }]
            : []),
          ...(usageSummary.totalCostUsd !== undefined
            ? [{ label: "Cost", value: formatCurrencyUsd(usageSummary.totalCostUsd) }]
            : []),
          ...(usageSummary.cumulativeCostUsd !== undefined
            ? [
                {
                  label: "Cumulative cost",
                  value: formatCurrencyUsd(usageSummary.cumulativeCostUsd),
                },
              ]
            : []),
        ])
      : null,
    finishSummary
      ? detailSection("finish", "Finish", [
          { label: "State", value: finishSummary.label },
          { label: "Status", value: finishSummary.status },
          ...(finishSummary.stopReason
            ? [{ label: "Stop reason", value: finishSummary.stopReason }]
            : []),
          ...(finishSummary.error ? [{ label: "Error", value: finishSummary.error }] : []),
        ])
      : null,
    errorSummary
      ? detailSection("error", "Error", [
          { label: "Severity", value: errorSummary.label },
          ...(errorSummary.errorClass ? [{ label: "Class", value: errorSummary.errorClass }] : []),
          ...(errorSummary.code ? [{ label: "Code", value: errorSummary.code }] : []),
          ...(errorSummary.retryable !== undefined
            ? [{ label: "Retryable", value: errorSummary.retryable ? "Yes" : "No" }]
            : []),
          ...(errorSummary.recoverable !== undefined
            ? [{ label: "Recoverable", value: errorSummary.recoverable ? "Yes" : "No" }]
            : []),
          ...(errorSummary.message ? [{ label: "Message", value: errorSummary.message }] : []),
        ])
      : null,
  ].filter((section): section is MossNormalizedEventDetailSection => section !== null);

  return {
    eventId: String(event.eventId),
    type: event.type,
    provider: event.provider,
    sessionId: String(event.sessionId),
    ...(event.turnId ? { turnId: String(event.turnId) } : {}),
    title: workEntry.toolTitle ?? workEntry.label,
    ...(workEntry.preview ? { preview: workEntry.preview } : {}),
    ...(permissionActionShell ? { permissionActionShell } : {}),
    sections,
  };
}

export function mossNormalizedEventToWorkEntry(event: MossNormalizedSessionEvent): WorkLogEntry {
  const payload = asRecord(event.payload) ?? {};
  const base: WorkLogEntry = {
    id: event.eventId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    label: labelForNormalizedEvent(event),
    tone: toneForNormalizedEvent(event),
  };

  switch (event.type) {
    case "text": {
      const textSummary = deriveMossNormalizedTextSummaryFromPayload(payload);
      return {
        ...base,
        toolTitle: textSummary.label,
        ...(textSummary.preview
          ? { preview: textSummary.preview, detail: textSummary.preview }
          : {}),
      };
    }
    case "tool-call":
    case "tool-result":
      return {
        ...base,
        ...toolFieldsForPayload(payload, event.type),
      };
    case "usage": {
      const detail = formatUsageSummary(payload);
      return {
        ...base,
        toolTitle: "Usage",
        ...(detail ? { preview: detail, detail } : {}),
      };
    }
    case "permission-request": {
      const permissionState = deriveMossNormalizedPermissionStateFromPayload(payload);
      const requestTitle = permissionRequestTitle(permissionState);
      const detail = permissionRequestDetail(permissionState);
      const requestKind = permissionRequestKindFromState(permissionState);
      return {
        ...base,
        label: requestTitle,
        toolTitle: requestTitle,
        ...(detail ? { preview: detail, detail } : {}),
        ...(requestKind ? { requestKind } : {}),
      };
    }
    case "finish": {
      const detail = finishDetail(payload);
      return {
        ...base,
        toolTitle: "Finished",
        ...(detail ? { preview: detail, detail } : {}),
      };
    }
    case "error": {
      const errorSummary = deriveMossNormalizedErrorSummaryFromPayload(payload);
      return {
        ...base,
        toolTitle: "Error",
        ...(errorSummary.message
          ? { preview: errorSummary.message, detail: errorSummary.message }
          : {}),
      };
    }
    default:
      return assertNever(event.type);
  }
}

export function MossNormalizedEventTimeline({
  events,
  emptyLabel = "No normalized events",
  initialSelectedEventId,
  scope,
  subscription,
}: MossNormalizedEventTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<MossNormalizedEventTimelineFilter>("all");
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>(
    initialSelectedEventId,
  );
  const [permissionActionSubmissions, setPermissionActionSubmissions] = useState<
    Record<string, MossNormalizedPermissionActionSubmissionState>
  >({});
  const permissionActionBridgeAvailable = Boolean(
    readNativeApi()?.provider?.submitPermissionAction,
  );
  const scopedEvents = useMemo(
    () => filterMossNormalizedEventsByScope(events, scope),
    [events, scope],
  );
  const filterOptions = useMemo(
    () => deriveMossNormalizedEventFilterOptions(scopedEvents),
    [scopedEvents],
  );
  const runState = useMemo(() => deriveMossNormalizedSessionRunState(scopedEvents), [scopedEvents]);
  const filteredEvents = useMemo(
    () => filterMossNormalizedEvents(scopedEvents, activeFilter),
    [activeFilter, scopedEvents],
  );
  const eventTypeById = useMemo(
    () => new Map(filteredEvents.map((event) => [String(event.eventId), event.type] as const)),
    [filteredEvents],
  );
  const eventById = useMemo(
    () => new Map(filteredEvents.map((event) => [String(event.eventId), event] as const)),
    [filteredEvents],
  );
  const allEventById = useMemo(
    () => new Map(scopedEvents.map((event) => [String(event.eventId), event] as const)),
    [scopedEvents],
  );
  const toolLifecycleByEventId = useMemo(
    () => deriveMossNormalizedToolLifecycleStates(scopedEvents),
    [scopedEvents],
  );
  const workEntries = useMemo(
    () => deriveMossNormalizedWorkEntries(filteredEvents),
    [filteredEvents],
  );
  const selectedEvent = selectedEventId ? allEventById.get(selectedEventId) : undefined;
  const selectedPermissionActionShell = selectedEvent
    ? deriveMossNormalizedPermissionActionShell(selectedEvent, {
        bridgeAvailable: permissionActionBridgeAvailable,
        submission: permissionActionSubmissions[String(selectedEvent.eventId)],
      })
    : null;
  const selectedEventDetail = useMemo(
    () =>
      selectedEvent
        ? deriveMossNormalizedEventDetail(selectedEvent, scopedEvents, {
            permissionActionShell: selectedPermissionActionShell,
          })
        : null,
    [scopedEvents, selectedEvent, selectedPermissionActionShell],
  );

  const handlePermissionAction = useCallback(
    (event: MossNormalizedSessionEvent, intent: MossNormalizedPermissionActionIntentKind) => {
      const submitPermissionAction = readNativeApi()?.provider?.submitPermissionAction;
      const eventId = String(event.eventId);
      if (typeof submitPermissionAction !== "function") {
        setPermissionActionSubmissions((current) => ({
          ...current,
          [eventId]: {
            intent,
            status: "failed",
            message: "Runtime action bridge missing",
          },
        }));
        return;
      }

      setPermissionActionSubmissions((current) => ({
        ...current,
        [eventId]: {
          intent,
          status: "submitting",
          message: "Submitting permission action",
        },
      }));

      void submitPermissionAction({
        threadId: event.threadId,
        sessionId: event.sessionId,
        normalizedEventId: event.eventId,
        intent,
      }).then(
        (result) => {
          setPermissionActionSubmissions((current) => ({
            ...current,
            [eventId]: {
              intent,
              status: result.status,
              message: result.message ?? permissionActionSubmissionFallbackMessage(result.status),
            },
          }));
        },
        (error) => {
          setPermissionActionSubmissions((current) => ({
            ...current,
            [eventId]: {
              intent,
              status: "failed",
              message: error instanceof Error ? error.message : "Permission action failed",
            },
          }));
        },
      );
    },
    [],
  );

  useEffect(() => {
    if (selectedEventId && !allEventById.has(selectedEventId)) {
      setSelectedEventId(undefined);
    }
  }, [allEventById, selectedEventId]);

  const resolvedEmptyLabel =
    activeFilter === "all" ? emptyLabel : `No ${filterLabel(activeFilter).toLowerCase()} events`;

  if (workEntries.length === 0) {
    return (
      <div>
        {scope ? <MossNormalizedEventScopeBanner scope={scope} /> : null}
        {subscription ? <MossNormalizedSubscriptionStateStrip subscription={subscription} /> : null}
        <MossNormalizedSessionRunStateStrip state={runState} />
        <MossNormalizedEventFilterBar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          options={filterOptions}
        />
        <div className="px-3 py-2 text-ui-lg text-muted-foreground" data-moss-normalized-empty="">
          {resolvedEmptyLabel}
        </div>
        {selectedEventDetail ? (
          <MossNormalizedEventDetailInspector
            detail={selectedEventDetail}
            onPermissionAction={
              selectedEvent ? (intent) => handlePermissionAction(selectedEvent, intent) : undefined
            }
            onClose={() => setSelectedEventId(undefined)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {scope ? <MossNormalizedEventScopeBanner scope={scope} /> : null}
      {subscription ? <MossNormalizedSubscriptionStateStrip subscription={subscription} /> : null}
      <MossNormalizedSessionRunStateStrip state={runState} />
      <MossNormalizedEventFilterBar
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        options={filterOptions}
      />
      <ol className="space-y-1 px-3 py-2" data-moss-normalized-timeline="">
        {workEntries.map((entry) => (
          <MossNormalizedEventTimelineRow
            key={entry.id}
            entry={entry}
            event={eventById.get(String(entry.id))}
            eventType={eventTypeById.get(String(entry.id))}
            onInspect={setSelectedEventId}
            onPermissionAction={handlePermissionAction}
            permissionActionBridgeAvailable={permissionActionBridgeAvailable}
            permissionActionSubmission={permissionActionSubmissions[String(entry.id)]}
            selected={selectedEventId === String(entry.id)}
            toolLifecycle={toolLifecycleByEventId.get(String(entry.id))}
          />
        ))}
      </ol>
      {selectedEventDetail ? (
        <MossNormalizedEventDetailInspector
          detail={selectedEventDetail}
          onPermissionAction={
            selectedEvent ? (intent) => handlePermissionAction(selectedEvent, intent) : undefined
          }
          onClose={() => setSelectedEventId(undefined)}
        />
      ) : null}
    </div>
  );
}

function MossNormalizedEventScopeBanner({
  scope,
}: {
  readonly scope: MossNormalizedEventTimelineScope;
}) {
  const clearDisabled = scope.activeThread && !scope.sessionId;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--app-surface-divider)] px-3 py-2 text-ui-sm"
      data-moss-normalized-session-scope=""
      data-scope-active-thread={scope.activeThread ? "true" : "false"}
      data-scope-session-id={scope.sessionId ?? ""}
      data-scope-thread-id={scope.threadId ?? ""}
    >
      <div className="min-w-0">
        <span className="font-medium text-foreground">Selected session</span>
        <span className="ml-2 text-muted-foreground">{scope.label}</span>
      </div>
      {scope.onClear ? (
        <button
          aria-label="Return Events to active thread scope"
          className="rounded border border-border/70 px-2 py-1 text-ui-sm text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-60"
          data-moss-normalized-session-scope-clear=""
          disabled={clearDisabled}
          onClick={scope.onClear}
          type="button"
        >
          Active thread
        </button>
      ) : null}
    </div>
  );
}

function MossNormalizedSubscriptionStateStrip({
  subscription,
}: {
  readonly subscription: MossNormalizedTimelineSubscriptionState;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-[var(--app-surface-divider)] px-3 py-2 text-ui-sm"
      data-moss-normalized-subscription-state=""
      data-subscription-event-count={subscription.eventCount}
      data-subscription-scope={subscription.scope}
      data-subscription-status={subscription.status}
      data-subscription-thread-id={subscription.threadId ?? ""}
    >
      <span className="font-medium text-foreground">{subscription.scopeLabel}</span>
      <span className="rounded border border-border/60 px-1.5 py-0.5 text-muted-foreground">
        {subscription.label}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">
        {subscription.threadId ?? "No thread"}
      </span>
      {subscription.error ? (
        <span className="min-w-0 truncate text-destructive">{subscription.error}</span>
      ) : null}
    </div>
  );
}

function MossNormalizedSessionRunStateStrip({
  state,
}: {
  readonly state: MossNormalizedSessionRunState;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-[var(--app-surface-divider)] px-3 py-2 text-ui-sm"
      data-moss-normalized-run-state=""
      data-run-state={state.state}
      data-run-state-errors={dataNumber(state.errorCount)}
      data-run-state-event-count={dataNumber(state.eventCount)}
      data-run-state-last-event-type={state.lastEventType}
      data-run-state-last-finish-state={state.lastFinishState}
      data-run-state-pending-permissions={dataNumber(state.pendingPermissionCount)}
      data-run-state-running-tools={dataNumber(state.runningToolCount)}
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${sessionRunStateClassName(state.state)}`}
        data-run-state-label=""
      >
        {state.label}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {formatInteger(state.eventCount)} events
      </span>
      {state.lastEventType ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          last {state.lastEventType}
        </span>
      ) : null}
      {state.lastFinishState ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          finish {state.lastFinishState}
        </span>
      ) : null}
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {formatInteger(state.pendingPermissionCount)} pending
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {formatInteger(state.runningToolCount)} running tools
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {formatInteger(state.errorCount)} errors
      </span>
    </div>
  );
}

function MossNormalizedEventTimelineRow({
  entry,
  event,
  eventType,
  onInspect,
  onPermissionAction,
  permissionActionBridgeAvailable,
  permissionActionSubmission,
  selected,
  toolLifecycle,
}: {
  readonly entry: WorkLogEntry;
  readonly event: MossNormalizedSessionEvent | undefined;
  readonly eventType: MossNormalizedSessionEvent["type"] | undefined;
  readonly onInspect: (eventId: string) => void;
  readonly onPermissionAction: (
    event: MossNormalizedSessionEvent,
    intent: MossNormalizedPermissionActionIntentKind,
  ) => void;
  readonly permissionActionBridgeAvailable: boolean;
  readonly permissionActionSubmission: MossNormalizedPermissionActionSubmissionState | undefined;
  readonly selected: boolean;
  readonly toolLifecycle: MossNormalizedToolLifecycleState | undefined;
}) {
  const permissionState = event ? deriveMossNormalizedPermissionState(event) : null;
  const permissionActionShell = event
    ? deriveMossNormalizedPermissionActionShell(event, {
        bridgeAvailable: permissionActionBridgeAvailable,
        submission: permissionActionSubmission,
      })
    : null;
  const usageSummary = event ? deriveMossNormalizedUsageSummary(event) : null;
  const finishSummary = event ? deriveMossNormalizedFinishSummary(event) : null;
  const textSummary = event ? deriveMossNormalizedTextSummary(event) : null;
  const errorSummary = event ? deriveMossNormalizedErrorSummary(event) : null;

  return (
    <li
      className={`rounded-md border bg-background px-2.5 py-2 text-ui-lg ${
        selected ? "border-foreground/80 shadow-sm" : "border-border/60"
      }`}
      data-event-type={eventType}
      data-event-id={String(entry.id)}
      data-moss-normalized-row=""
      data-permission-action-enabled={dataBoolean(permissionActionShell?.enabled)}
      data-permission-action-status={permissionActionShell?.status}
      data-permission-decision={permissionState?.decision}
      data-permission-kind={permissionState?.kind}
      data-permission-state={permissionState?.state}
      data-permission-status={permissionState?.status}
      data-selected={selected ? "true" : "false"}
      data-tone={entry.tone}
      data-tool-lifecycle-has-call={toolLifecycle ? String(toolLifecycle.hasCall) : undefined}
      data-tool-lifecycle-has-result={toolLifecycle ? String(toolLifecycle.hasResult) : undefined}
      data-tool-lifecycle-id={toolLifecycle?.lifecycleId}
      data-tool-lifecycle-role={toolLifecycle?.role}
      data-tool-lifecycle-state={toolLifecycle?.state}
      data-usage-cumulative-cost-usd={dataNumber(usageSummary?.cumulativeCostUsd)}
      data-usage-input-tokens={dataNumber(usageSummary?.inputTokens)}
      data-usage-model={usageSummary?.model}
      data-usage-output-tokens={dataNumber(usageSummary?.outputTokens)}
      data-usage-total-cost-usd={dataNumber(usageSummary?.totalCostUsd)}
      data-usage-used-tokens={dataNumber(usageSummary?.usedTokens)}
      data-text-preview-length={dataNumber(textSummary?.previewLength)}
      data-text-role={textSummary?.role}
      data-text-stream-kind={textSummary?.streamKind}
      data-error-class={errorSummary?.errorClass}
      data-error-code={errorSummary?.code}
      data-error-message={errorSummary?.message}
      data-error-recoverable={dataBoolean(errorSummary?.recoverable)}
      data-error-retryable={dataBoolean(errorSummary?.retryable)}
      data-error-severity={errorSummary?.severity}
      data-finish-error={finishSummary?.error}
      data-finish-state={finishSummary?.state}
      data-finish-status={finishSummary?.status}
      data-finish-stop-reason={finishSummary?.stopReason}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{entry.toolTitle ?? entry.label}</span>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-ui-sm tabular-nums text-muted-foreground">
            {formatTimelineTime(entry.createdAt)}
          </span>
          <button
            aria-label={`Inspect ${entry.toolTitle ?? entry.label}`}
            className="rounded border border-border/70 px-1.5 py-0.5 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
            data-moss-normalized-event-inspect={String(entry.id)}
            onClick={() => onInspect(String(entry.id))}
            type="button"
          >
            Inspect
          </button>
        </div>
      </div>
      {entry.preview ? (
        <div className="mt-1 truncate text-muted-foreground">{entry.preview}</div>
      ) : null}
      {toolLifecycle ? <MossNormalizedToolLifecycleMetadata state={toolLifecycle} /> : null}
      {permissionState ? <MossNormalizedPermissionStateMetadata state={permissionState} /> : null}
      {permissionActionShell ? (
        <MossNormalizedPermissionActionShellMetadata
          onSubmit={event ? (intent) => onPermissionAction(event, intent) : undefined}
          state={permissionActionShell}
        />
      ) : null}
      {usageSummary ? <MossNormalizedUsageSummaryMetadata state={usageSummary} /> : null}
      {finishSummary ? <MossNormalizedFinishSummaryMetadata state={finishSummary} /> : null}
      {textSummary ? <MossNormalizedTextSummaryMetadata state={textSummary} /> : null}
      {errorSummary ? <MossNormalizedErrorSummaryMetadata state={errorSummary} /> : null}
      {event ? <MossNormalizedEventTraceMetadata event={event} /> : null}
    </li>
  );
}

function MossNormalizedEventDetailInspector({
  detail,
  onPermissionAction,
  onClose,
}: {
  readonly detail: MossNormalizedEventDetail;
  readonly onPermissionAction?:
    | ((intent: MossNormalizedPermissionActionIntentKind) => void)
    | undefined;
  readonly onClose: () => void;
}) {
  return (
    <aside
      className="border-t border-[var(--app-surface-divider)] bg-muted/20 px-3 py-3 text-ui-lg"
      data-detail-section-count={dataNumber(detail.sections.length)}
      data-moss-normalized-event-detail-inspector=""
      data-selected-event-id={detail.eventId}
      data-selected-event-provider={detail.provider}
      data-selected-event-session={detail.sessionId}
      data-selected-event-turn={detail.turnId}
      data-selected-event-type={detail.type}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium uppercase tracking-normal text-muted-foreground">
            Event detail
          </div>
          <div className="truncate font-medium text-foreground" data-detail-title="">
            {detail.title}
          </div>
          {detail.preview ? (
            <div className="mt-1 truncate text-ui-sm text-muted-foreground" data-detail-preview="">
              {detail.preview}
            </div>
          ) : null}
        </div>
        <button
          aria-label="Close normalized event detail"
          className="rounded border border-border/70 px-2 py-1 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          data-moss-normalized-event-detail-close=""
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      {detail.permissionActionShell ? (
        <div className="mt-3">
          <MossNormalizedPermissionActionShellMetadata
            onSubmit={onPermissionAction}
            state={detail.permissionActionShell}
          />
        </div>
      ) : null}
      <div className="mt-3 grid gap-2">
        {detail.sections.map((section) => (
          <section
            className="rounded-md border border-border/60 bg-background px-2.5 py-2"
            data-detail-field-count={dataNumber(section.fields.length)}
            data-detail-section-kind={section.kind}
            data-moss-normalized-event-detail-section=""
            key={section.kind}
          >
            <div className="text-ui-sm font-medium text-foreground">{section.title}</div>
            <dl className="mt-1 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-ui-sm">
              {section.fields.map((field) => (
                <div className="contents" key={`${section.kind}:${field.label}`}>
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="truncate text-foreground" data-detail-field-value={field.label}>
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
  );
}

function MossNormalizedTextSummaryMetadata({
  state,
}: {
  readonly state: MossNormalizedTextSummary;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-moss-normalized-text-summary=""
      data-text-preview-length={dataNumber(state.previewLength)}
      data-text-role={state.role}
      data-text-stream-kind={state.streamKind}
    >
      <span
        className="rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-indigo-700 dark:text-indigo-300"
        data-text-role-label=""
      >
        {textRoleLabel(state.role)}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-muted-foreground">
        {state.streamKind}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {formatInteger(state.previewLength)} chars
      </span>
    </div>
  );
}

function MossNormalizedErrorSummaryMetadata({
  state,
}: {
  readonly state: MossNormalizedErrorSummary;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-error-class={state.errorClass}
      data-error-code={state.code}
      data-error-message={state.message}
      data-error-recoverable={dataBoolean(state.recoverable)}
      data-error-retryable={dataBoolean(state.retryable)}
      data-error-severity={state.severity}
      data-moss-normalized-error-summary=""
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${errorSeverityClassName(state.severity)}`}
        data-error-severity-label=""
      >
        {state.label}
      </span>
      {state.errorClass ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-muted-foreground">
          {state.errorClass}
        </span>
      ) : null}
      {state.code ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-muted-foreground">
          {state.code}
        </span>
      ) : null}
      {state.retryable !== undefined ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.retryable ? "retryable" : "not retryable"}
        </span>
      ) : null}
      {state.message ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

function MossNormalizedUsageSummaryMetadata({
  state,
}: {
  readonly state: MossNormalizedUsageSummary;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-moss-normalized-usage-summary=""
      data-usage-cumulative-cost-usd={dataNumber(state.cumulativeCostUsd)}
      data-usage-input-tokens={dataNumber(state.inputTokens)}
      data-usage-model={state.model}
      data-usage-output-tokens={dataNumber(state.outputTokens)}
      data-usage-total-cost-usd={dataNumber(state.totalCostUsd)}
      data-usage-used-tokens={dataNumber(state.usedTokens)}
    >
      <span
        className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300"
        data-usage-summary-label=""
      >
        {state.label}
      </span>
      {state.model ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.model}
        </span>
      ) : null}
      {state.totalCostUsd !== undefined ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {formatCurrencyUsd(state.totalCostUsd)}
        </span>
      ) : null}
      {state.cumulativeCostUsd !== undefined ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          cum {formatCurrencyUsd(state.cumulativeCostUsd)}
        </span>
      ) : null}
    </div>
  );
}

function MossNormalizedFinishSummaryMetadata({
  state,
}: {
  readonly state: MossNormalizedFinishSummary;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-finish-error={state.error}
      data-finish-state={state.state}
      data-finish-status={state.status}
      data-finish-stop-reason={state.stopReason}
      data-moss-normalized-finish-summary=""
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${finishStateClassName(state.state)}`}
        data-finish-state-label=""
      >
        {state.label}
      </span>
      {state.stopReason ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.stopReason}
        </span>
      ) : null}
      {state.error ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.error}
        </span>
      ) : null}
    </div>
  );
}

function MossNormalizedToolLifecycleMetadata({
  state,
}: {
  readonly state: MossNormalizedToolLifecycleState;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-moss-normalized-tool-lifecycle=""
      data-tool-lifecycle-has-call={String(state.hasCall)}
      data-tool-lifecycle-has-result={String(state.hasResult)}
      data-tool-lifecycle-id={state.lifecycleId}
      data-tool-lifecycle-role={state.role}
      data-tool-lifecycle-state={state.state}
      data-tool-lifecycle-status={state.status}
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${toolLifecycleClassName(state.state)}`}
        data-tool-lifecycle-state-label=""
      >
        {state.label}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {state.role === "result" ? "Result" : "Call"}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-muted-foreground">
        {state.lifecycleId}
      </span>
      {state.toolName ? (
        <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
          {state.toolName}
        </span>
      ) : null}
    </div>
  );
}

function MossNormalizedPermissionStateMetadata({
  state,
}: {
  readonly state: MossNormalizedPermissionState;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-moss-normalized-permission-state=""
      data-permission-decision={state.decision}
      data-permission-kind={state.kind}
      data-permission-state={state.state}
      data-permission-status={state.status}
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${permissionStateClassName(state.state)}`}
        data-permission-status-label=""
      >
        {state.label}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {state.kindLabel}
      </span>
      {state.decision ? (
        <span
          className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground"
          data-permission-decision-label=""
        >
          {state.decision}
        </span>
      ) : null}
    </div>
  );
}

function MossNormalizedPermissionActionShellMetadata({
  onSubmit,
  state,
}: {
  readonly onSubmit?: ((intent: MossNormalizedPermissionActionIntentKind) => void) | undefined;
  readonly state: MossNormalizedPermissionActionShell;
}) {
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm"
      data-moss-normalized-permission-action-shell=""
      data-permission-action-enabled={dataBoolean(state.enabled)}
      data-permission-action-intent-count={dataNumber(state.intents.length)}
      data-permission-action-kind={state.permissionKind}
      data-permission-action-reason={state.disabledReason}
      data-permission-action-state={state.permissionState}
      data-permission-action-status={state.status}
    >
      <span
        className={`rounded border px-1.5 py-0.5 ${permissionActionShellClassName(state.status)}`}
        data-permission-action-status-label=""
      >
        {state.label}
      </span>
      <span className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground">
        {state.disabledReason}
      </span>
      {state.intents.map((intent) => (
        <button
          aria-label={`${intent.label} permission`}
          className="rounded border border-border/70 px-1.5 py-0.5 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
          data-permission-action-disabled-reason={intent.disabledReason}
          data-permission-action-intent={intent.intent}
          disabled={!intent.enabled}
          key={intent.intent}
          onClick={() => onSubmit?.(intent.intent)}
          type="button"
        >
          {intent.label}
        </button>
      ))}
    </div>
  );
}

function MossNormalizedEventTraceMetadata({
  event,
}: {
  readonly event: MossNormalizedSessionEvent;
}) {
  const fields = deriveMossNormalizedEventTraceFields(event);

  return (
    <details
      className="mt-2 border-t border-border/50 pt-1"
      data-event-id={String(event.eventId)}
      data-event-type={event.type}
      data-moss-normalized-trace=""
    >
      <summary className="cursor-pointer text-ui-sm font-medium text-muted-foreground">
        Trace
      </summary>
      <dl className="mt-1 grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-ui-sm">
        {fields.map((field) => (
          <div className="contents" key={field.label}>
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="truncate font-mono text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function MossNormalizedEventFilterBar({
  activeFilter,
  options,
  onFilterChange,
}: {
  readonly activeFilter: MossNormalizedEventTimelineFilter;
  readonly options: ReadonlyArray<MossNormalizedEventFilterOption>;
  readonly onFilterChange: (filter: MossNormalizedEventTimelineFilter) => void;
}) {
  return (
    <div
      aria-label="Normalized event filters"
      className="flex gap-1 overflow-x-auto border-b border-[var(--app-surface-divider)] px-3 py-2"
      data-moss-normalized-event-filters=""
      role="group"
    >
      {options.map((option) => {
        const active = option.value === activeFilter;
        return (
          <button
            key={option.value}
            aria-pressed={active}
            className={`shrink-0 rounded-md border px-2 py-1 text-ui-sm transition-colors ${
              active
                ? "border-foreground bg-foreground text-background"
                : "border-border/70 bg-background text-muted-foreground hover:text-foreground"
            }`}
            data-active={active ? "true" : "false"}
            data-moss-normalized-event-filter={option.value}
            onClick={() => {
              onFilterChange(option.value);
            }}
            type="button"
          >
            <span>{option.label}</span>
            <span className="ml-1 tabular-nums opacity-75">{option.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function compareNormalizedEvents(
  left: MossNormalizedSessionEvent,
  right: MossNormalizedSessionEvent,
): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime === 0 ? left.eventId.localeCompare(right.eventId) : byTime;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function dataNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function dataBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function detailSection(
  kind: MossNormalizedEventDetailSectionKind,
  title: string,
  fields: ReadonlyArray<MossNormalizedEventDetailField>,
): MossNormalizedEventDetailSection {
  return {
    kind,
    title,
    fields: fields.filter((field) => field.value.trim().length > 0),
  };
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      switch (formatStatus(value)) {
        case "true":
        case "yes":
        case "1":
          return true;
        case "false":
        case "no":
        case "0":
          return false;
      }
    }
  }
  return null;
}

function labelForNormalizedEvent(event: MossNormalizedSessionEvent): string {
  switch (event.type) {
    case "text":
      return "Text";
    case "tool-call":
      return "Tool call";
    case "tool-result":
      return "Tool result";
    case "usage":
      return "Usage";
    case "permission-request":
      return "Permission request";
    case "finish":
      return "Finished";
    case "error":
      return "Error";
    default:
      return assertNever(event.type);
  }
}

function filterLabel(filter: MossNormalizedEventTimelineFilter): string {
  switch (filter) {
    case "all":
      return "All";
    case "text":
      return "Text";
    case "tool-call":
      return "Tool call";
    case "tool-result":
      return "Tool result";
    case "usage":
      return "Usage";
    case "permission-request":
      return "Permission request";
    case "finish":
      return "Finish";
    case "error":
      return "Error";
    default:
      return assertNever(filter);
  }
}

function toneForNormalizedEvent(event: MossNormalizedSessionEvent): WorkLogEntry["tone"] {
  if (event.type === "error") {
    return "error";
  }
  if (event.type === "tool-call" || event.type === "tool-result") {
    return "tool";
  }
  if (event.type === "text") {
    return "thinking";
  }
  return "info";
}

function deriveMossNormalizedTextSummaryFromPayload(
  payload: UnknownRecord,
): MossNormalizedTextSummary {
  const streamKind = textStreamKind(payload);
  const role = textRoleForStreamKind(streamKind);
  const text = textContentFromPayload(payload);
  const preview = text ? compactText(text) : undefined;

  return {
    streamKind,
    role,
    label: textStreamKindLabel(streamKind),
    previewLength: preview?.length ?? 0,
    ...(preview ? { preview } : {}),
  };
}

function textContentFromPayload(payload: UnknownRecord): string | null {
  const data = asRecord(payload.data);
  return firstString(payload.text, payload.delta, payload.content, data?.text, data?.delta);
}

function textStreamKind(payload: UnknownRecord): MossNormalizedTextStreamKind {
  const data = asRecord(payload.data);
  switch (firstString(payload.streamKind, data?.streamKind)) {
    case "assistant_text":
      return "assistant_text";
    case "reasoning_text":
      return "reasoning_text";
    case "reasoning_summary_text":
      return "reasoning_summary_text";
    case "plan_text":
      return "plan_text";
    case "command_output":
      return "command_output";
    case "file_change_output":
      return "file_change_output";
    default:
      return "unknown";
  }
}

function textRoleForStreamKind(streamKind: MossNormalizedTextStreamKind): MossNormalizedTextRole {
  switch (streamKind) {
    case "assistant_text":
      return "assistant";
    case "reasoning_text":
    case "reasoning_summary_text":
      return "reasoning";
    case "plan_text":
      return "plan";
    case "command_output":
      return "command-output";
    case "file_change_output":
      return "file-change-output";
    case "unknown":
      return "unknown";
    default:
      return assertNever(streamKind);
  }
}

function textStreamKindLabel(streamKind: MossNormalizedTextStreamKind): string {
  switch (streamKind) {
    case "assistant_text":
      return "Assistant text";
    case "reasoning_text":
    case "reasoning_summary_text":
      return "Reasoning";
    case "plan_text":
      return "Plan text";
    case "command_output":
      return "Command output";
    case "file_change_output":
      return "File change output";
    case "unknown":
      return "Text";
    default:
      return assertNever(streamKind);
  }
}

function textRoleLabel(role: MossNormalizedTextRole): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command-output":
      return "Command output";
    case "file-change-output":
      return "File change output";
    case "unknown":
      return "Unknown text";
    default:
      return assertNever(role);
  }
}

interface MossNormalizedToolLifecycleGroupItem {
  readonly event: MossNormalizedSessionEvent;
  readonly payload: UnknownRecord;
}

interface MossNormalizedToolLifecycleGroup {
  readonly lifecycleId: string;
  readonly events: MossNormalizedToolLifecycleGroupItem[];
}

function toolLifecycleId(event: MossNormalizedSessionEvent, payload: UnknownRecord): string {
  const data = asRecord(payload.data);
  return (
    firstString(
      payload.itemId,
      payload.toolCallId,
      payload.id,
      data?.itemId,
      data?.toolCallId,
      data?.id,
    ) ?? String(event.eventId)
  );
}

function toolLifecycleStateForGroup(
  group: MossNormalizedToolLifecycleGroup,
): Omit<MossNormalizedToolLifecycleState, "role"> {
  const call = group.events.find((item) => item.event.type === "tool-call");
  const result = group.events.find((item) => item.event.type === "tool-result");
  const status = toolLifecycleStatus(result?.payload ?? call?.payload ?? {});
  const state = toolLifecycleTone({
    hasCall: Boolean(call),
    hasResult: Boolean(result),
    status,
  });
  const toolName = firstString(
    call?.payload.toolName,
    asRecord(call?.payload.data)?.name,
    result?.payload.toolName,
    asRecord(result?.payload.data)?.name,
  );

  return {
    lifecycleId: group.lifecycleId,
    state,
    label: toolLifecycleLabel(state),
    hasCall: Boolean(call),
    hasResult: Boolean(result),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
  };
}

function toolLifecycleStatus(payload: UnknownRecord): string | null {
  return firstString(payload.status, asRecord(payload.data)?.status);
}

function toolLifecycleTone(input: {
  readonly hasCall: boolean;
  readonly hasResult: boolean;
  readonly status: string | null;
}): MossNormalizedToolLifecycleTone {
  if (input.status && failedToolLifecycleStatus(input.status)) {
    return "failed";
  }
  if (!input.hasCall && input.hasResult) {
    return "orphaned";
  }
  if (input.hasResult) {
    return "succeeded";
  }
  if (input.status && runningToolLifecycleStatus(input.status)) {
    return "running";
  }
  return "pending";
}

function failedToolLifecycleStatus(status: string): boolean {
  switch (formatStatus(status)) {
    case "failed":
    case "failure":
    case "error":
    case "errored":
    case "cancelled":
    case "canceled":
      return true;
    default:
      return false;
  }
}

function runningToolLifecycleStatus(status: string): boolean {
  switch (formatStatus(status)) {
    case "inprogress":
    case "in progress":
    case "running":
    case "started":
    case "executing":
      return true;
    default:
      return false;
  }
}

function toolLifecycleLabel(state: MossNormalizedToolLifecycleTone): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "orphaned":
      return "Orphaned";
    default:
      return assertNever(state);
  }
}

function toolLifecycleClassName(state: MossNormalizedToolLifecycleTone): string {
  switch (state) {
    case "pending":
      return "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
    case "running":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "succeeded":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    case "orphaned":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    default:
      return assertNever(state);
  }
}

function toolFieldsForPayload(
  payload: UnknownRecord,
  eventType: Extract<MossNormalizedSessionEvent["type"], "tool-call" | "tool-result">,
): Partial<WorkLogEntry> {
  const data = asRecord(payload.data);
  const toolKind = firstString(payload.toolKind);
  const toolName = firstString(payload.toolName, data?.name, data?.toolName);
  const title = firstString(payload.title, toolName, toolKind) ?? "Tool";
  const status = firstString(payload.status);
  const detail = firstString(
    payload.detail,
    data?.output,
    data?.stdout,
    data?.stderr,
    data?.content,
  );
  const preview =
    detail !== null
      ? compactText(detail)
      : status && status !== "completed"
        ? formatStatus(status)
        : null;
  const command = firstString(data?.command, data?.cmd);
  const itemType = toolKind && isToolLifecycleItemType(toolKind) ? toolKind : undefined;
  const toolCallId = firstString(payload.itemId);

  return {
    label: eventType === "tool-result" ? "Tool result" : "Tool call",
    toolTitle: title,
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(itemType ? { itemType } : {}),
    ...(detail ? { detail } : {}),
    ...(preview ? { preview } : {}),
    ...(command ? { command } : {}),
    ...(command && itemType === undefined ? { itemType: "command_execution" as const } : {}),
  };
}

function formatUsageSummary(payload: UnknownRecord): string | null {
  const summary = deriveMossNormalizedUsageSummaryFromPayload(payload);
  return summary.label === "Usage recorded" ? null : summary.label;
}

function deriveMossNormalizedUsageSummaryFromPayload(
  payload: UnknownRecord,
): MossNormalizedUsageSummary {
  const usage = asRecord(payload.usage);
  const modelUsage = asRecord(payload.modelUsage);
  const data = asRecord(payload.data);
  const inputTokens = firstNumber(
    payload.inputTokens,
    payload.promptTokens,
    usage?.inputTokens,
    usage?.promptTokens,
    modelUsage?.inputTokens,
    modelUsage?.promptTokens,
    data?.inputTokens,
    data?.promptTokens,
  );
  const outputTokens = firstNumber(
    payload.outputTokens,
    payload.completionTokens,
    usage?.outputTokens,
    usage?.completionTokens,
    modelUsage?.outputTokens,
    modelUsage?.completionTokens,
    data?.outputTokens,
    data?.completionTokens,
  );
  const usedTokens = firstNumber(
    payload.usedTokens,
    payload.totalTokens,
    usage?.usedTokens,
    usage?.totalTokens,
    modelUsage?.usedTokens,
    modelUsage?.totalTokens,
    data?.usedTokens,
    data?.totalTokens,
  );
  const totalCostUsd = firstNumber(
    payload.totalCostUsd,
    payload.costUsd,
    usage?.totalCostUsd,
    usage?.costUsd,
    modelUsage?.totalCostUsd,
    modelUsage?.costUsd,
    data?.totalCostUsd,
    data?.costUsd,
  );
  const cumulativeCostUsd = firstNumber(
    payload.cumulativeCostUsd,
    usage?.cumulativeCostUsd,
    modelUsage?.cumulativeCostUsd,
    data?.cumulativeCostUsd,
  );
  const model = firstString(payload.model, modelUsage?.model, usage?.model, data?.model);

  return {
    label: formatUsageSummaryFromParts({
      cumulativeCostUsd,
      inputTokens,
      model,
      outputTokens,
      totalCostUsd,
      usedTokens,
    }),
    ...(inputTokens !== null ? { inputTokens } : {}),
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(usedTokens !== null ? { usedTokens } : {}),
    ...(model ? { model } : {}),
    ...(totalCostUsd !== null ? { totalCostUsd } : {}),
    ...(cumulativeCostUsd !== null ? { cumulativeCostUsd } : {}),
  };
}

function formatUsageSummaryFromParts(input: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usedTokens: number | null;
  readonly model: string | null;
  readonly totalCostUsd: number | null;
  readonly cumulativeCostUsd: number | null;
}): string {
  const parts: string[] = [];

  if (input.inputTokens !== null || input.outputTokens !== null) {
    const tokenParts = [
      input.inputTokens !== null ? `${formatInteger(input.inputTokens)} in` : null,
      input.outputTokens !== null ? `${formatInteger(input.outputTokens)} out` : null,
      input.usedTokens !== null ? `${formatInteger(input.usedTokens)} total` : null,
    ].filter((part): part is string => part !== null);
    parts.push(tokenParts.join(" / "));
  } else if (input.usedTokens !== null) {
    parts.push(`${formatInteger(input.usedTokens)} tokens`);
  }
  if (input.model) {
    parts.push(input.model);
  }
  if (input.totalCostUsd !== null) {
    parts.push(formatCurrencyUsd(input.totalCostUsd));
  }
  if (input.cumulativeCostUsd !== null) {
    parts.push(`cum ${formatCurrencyUsd(input.cumulativeCostUsd)}`);
  }

  return parts.length > 0 ? parts.join(" - ") : "Usage recorded";
}

function permissionRequestTitle(state: MossNormalizedPermissionState): string {
  if (state.kind === "user-input") {
    if (state.state === "resolved") {
      return "User input resolved";
    }
    if (state.state === "denied") {
      return "User input denied";
    }
    return "User input";
  }
  if (state.state === "resolved") {
    return "Permission resolved";
  }
  if (state.state === "denied") {
    return "Permission denied";
  }
  return "Permission request";
}

function permissionRequestDetail(state: MossNormalizedPermissionState): string | null {
  if (state.decision) {
    return `${state.label.toLowerCase()} - ${state.decision}`;
  }
  if (state.detail) {
    return state.detail;
  }
  return `${state.label.toLowerCase()} - ${state.kindLabel.toLowerCase()}`;
}

function permissionRequestKindFromState(
  state: MossNormalizedPermissionState,
): WorkLogEntry["requestKind"] | undefined {
  switch (state.kind) {
    case "command":
    case "file-read":
    case "file-change":
      return state.kind;
    case "user-input":
    case "unknown":
      return undefined;
    default:
      return assertNever(state.kind);
  }
}

function deriveMossNormalizedPermissionStateFromPayload(
  payload: UnknownRecord,
): MossNormalizedPermissionState {
  const status = permissionStatus(payload);
  const decision = permissionDecision(payload);
  const state = permissionStateTone(status, decision);
  const kind = permissionKind(payload);
  const detail = firstString(payload.detail);
  return {
    status,
    state,
    label: permissionStateLabel(state),
    kind,
    kindLabel: permissionKindLabel(kind),
    ...(detail ? { detail } : {}),
    ...(decision ? { decision } : {}),
  };
}

function deriveMossNormalizedPermissionActionShellFromState(
  state: MossNormalizedPermissionState,
  options?: {
    readonly bridgeAvailable?: boolean | undefined;
    readonly submission?: MossNormalizedPermissionActionSubmissionState | undefined;
  },
): MossNormalizedPermissionActionShell {
  if (state.state === "pending") {
    if (options?.submission) {
      return permissionActionShellFromSubmission(state, options.submission);
    }

    if (options?.bridgeAvailable) {
      const disabledReason = "Runtime action bridge ready";
      return {
        status: "ready",
        label: "Ready",
        enabled: true,
        disabledReason,
        permissionState: state.state,
        permissionKind: state.kind,
        intents: (["approve", "deny", "defer"] as const).map((intent) => ({
          intent,
          label: permissionActionIntentLabel(intent),
          enabled: true,
        })),
      };
    }

    const disabledReason = "Runtime action bridge missing";
    return {
      status: "runtime-bridge-missing",
      label: "Runtime bridge missing",
      enabled: false,
      disabledReason,
      permissionState: state.state,
      permissionKind: state.kind,
      intents: (["approve", "deny", "defer"] as const).map((intent) => ({
        intent,
        label: permissionActionIntentLabel(intent),
        enabled: false,
        disabledReason,
      })),
    };
  }

  const disabledReason =
    state.state === "denied"
      ? "Permission denied"
      : state.state === "resolved"
        ? "Permission resolved"
        : "Permission state unknown";
  return {
    status: "not-applicable",
    label: "Not applicable",
    enabled: false,
    disabledReason,
    permissionState: state.state,
    permissionKind: state.kind,
    intents: [],
  };
}

function permissionActionShellFromSubmission(
  state: MossNormalizedPermissionState,
  submission: MossNormalizedPermissionActionSubmissionState,
): MossNormalizedPermissionActionShell {
  const disabledReason = submission.message;
  return {
    status: submission.status,
    label: permissionActionSubmissionStatusLabel(submission.status),
    enabled: false,
    disabledReason,
    permissionState: state.state,
    permissionKind: state.kind,
    intents: (["approve", "deny", "defer"] as const).map((intent) => ({
      intent,
      label: permissionActionIntentLabel(intent),
      enabled: false,
      disabledReason:
        intent === submission.intent ? disabledReason : "Permission action in progress",
    })),
  };
}

function permissionActionSubmissionFallbackMessage(
  status: ProviderSubmitPermissionActionResult["status"],
): string {
  switch (status) {
    case "accepted":
      return "Permission action accepted";
    case "unsupported":
      return "Permission action unsupported";
    case "rejected":
      return "Permission action rejected";
    default:
      return assertNever(status);
  }
}

function permissionActionSubmissionStatusLabel(
  status: MossNormalizedPermissionActionSubmissionStatus,
): string {
  switch (status) {
    case "submitting":
      return "Submitting";
    case "accepted":
      return "Accepted";
    case "unsupported":
      return "Unsupported";
    case "rejected":
      return "Rejected";
    case "failed":
      return "Failed";
    default:
      return assertNever(status);
  }
}

function permissionActionIntentLabel(intent: MossNormalizedPermissionActionIntentKind): string {
  switch (intent) {
    case "approve":
      return "Approve";
    case "deny":
      return "Deny";
    case "defer":
      return "Defer";
    default:
      return assertNever(intent);
  }
}

function permissionActionShellClassName(status: MossNormalizedPermissionActionShellStatus): string {
  switch (status) {
    case "runtime-bridge-missing":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "ready":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "submitting":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "accepted":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "unsupported":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "rejected":
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "not-applicable":
      return "border-border/70 bg-muted/30 text-muted-foreground";
    default:
      return assertNever(status);
  }
}

function permissionKind(payload: UnknownRecord): MossNormalizedPermissionKind {
  const explicitKind = firstString(payload.requestKind);
  switch (explicitKind) {
    case "command":
    case "file-read":
    case "file-change":
      return explicitKind;
    case "user-input":
      return "user-input";
  }

  switch (firstString(payload.requestType)) {
    case "exec_command_approval":
    case "command":
      return "command";
    case "file_read_approval":
    case "file-read":
      return "file-read";
    case "file_change_approval":
    case "file-change":
      return "file-change";
    case "tool_user_input":
    case "user_input":
    case "user-input":
      return "user-input";
    default:
      return "unknown";
  }
}

function permissionStatus(payload: UnknownRecord): string {
  return formatStatus(firstString(payload.status) ?? "pending");
}

function permissionDecision(payload: UnknownRecord): string | null {
  const decision = firstString(payload.decision, payload.resolution);
  if (decision) {
    return compactText(decision);
  }
  return payload.resolution === undefined ? null : "resolution recorded";
}

function permissionStateTone(
  status: string,
  decision: string | null,
): MossNormalizedPermissionStateTone {
  if (decision) {
    return deniedPermissionDecision(decision) ? "denied" : "resolved";
  }
  switch (status) {
    case "pending":
    case "open":
    case "requested":
    case "waiting":
      return "pending";
    case "denied":
    case "declined":
    case "rejected":
    case "blocked":
      return "denied";
    case "resolved":
    case "completed":
    case "accepted":
    case "approved":
    case "allowed":
      return "resolved";
    default:
      return decision ? "resolved" : "unknown";
  }
}

function deniedPermissionDecision(decision: string): boolean {
  switch (formatStatus(decision)) {
    case "denied":
    case "deny":
    case "declined":
    case "decline":
    case "rejected":
    case "reject":
      return true;
    default:
      return false;
  }
}

function permissionStateLabel(state: MossNormalizedPermissionStateTone): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "resolved":
      return "Resolved";
    case "denied":
      return "Denied";
    case "unknown":
      return "Unknown";
    default:
      return assertNever(state);
  }
}

function permissionKindLabel(kind: MossNormalizedPermissionKind): string {
  switch (kind) {
    case "command":
      return "Command";
    case "file-read":
      return "File read";
    case "file-change":
      return "File change";
    case "user-input":
      return "User input";
    case "unknown":
      return "Unknown request";
    default:
      return assertNever(kind);
  }
}

function permissionStateClassName(state: MossNormalizedPermissionStateTone): string {
  switch (state) {
    case "pending":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "resolved":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "denied":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    case "unknown":
      return "border-border/70 bg-muted/30 text-muted-foreground";
    default:
      return assertNever(state);
  }
}

function finishDetail(payload: UnknownRecord): string | null {
  const summary = deriveMossNormalizedFinishSummaryFromPayload(payload);
  return [summary.status, summary.stopReason, summary.error].filter(Boolean).join(" - ") || null;
}

function deriveMossNormalizedFinishSummaryFromPayload(
  payload: UnknownRecord,
): MossNormalizedFinishSummary {
  const state = firstString(payload.state, payload.exitKind);
  const stopReason = firstString(payload.stopReason, payload.reason, payload.finishReason);
  const error = firstString(payload.error, payload.message, payload.detail);
  const status = formatStatus(state ?? firstString(payload.status) ?? stopReason ?? "unknown");
  const stateTone = finishStateTone(status, stopReason, error);
  return {
    status,
    state: stateTone,
    label: finishStateLabel(stateTone),
    ...(stopReason ? { stopReason } : {}),
    ...(error ? { error: compactText(error) } : {}),
  };
}

function finishStateTone(
  status: string,
  stopReason: string | null,
  error: string | null,
): MossNormalizedFinishStateTone {
  switch (status) {
    case "completed":
    case "complete":
    case "finished":
    case "success":
    case "succeeded":
      return "completed";
    case "interrupted":
    case "cancelled":
    case "canceled":
    case "aborted":
    case "stopped":
      return "interrupted";
    case "failed":
    case "failure":
    case "error":
    case "errored":
      return "failed";
  }
  switch (formatStatus(stopReason ?? "")) {
    case "user interrupt":
    case "user interrupted":
    case "user canceled":
    case "user cancelled":
    case "user stopped":
    case "cancelled":
    case "canceled":
      return "interrupted";
  }
  return error ? "failed" : "unknown";
}

function finishStateLabel(state: MossNormalizedFinishStateTone): string {
  switch (state) {
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
    default:
      return assertNever(state);
  }
}

function finishStateClassName(state: MossNormalizedFinishStateTone): string {
  switch (state) {
    case "completed":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "interrupted":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    case "unknown":
      return "border-border/70 bg-muted/30 text-muted-foreground";
    default:
      return assertNever(state);
  }
}

function deriveMossNormalizedErrorSummaryFromPayload(
  payload: UnknownRecord,
): MossNormalizedErrorSummary {
  const data = asRecord(payload.data);
  const error = asRecord(payload.error);
  const message = firstString(
    payload.message,
    payload.detail,
    payload.reason,
    payload.error,
    data?.message,
    data?.detail,
    data?.reason,
    error?.message,
    error?.detail,
    error?.reason,
  );
  const errorClass = firstString(
    payload.errorClass,
    payload.class,
    payload.name,
    payload.type,
    data?.errorClass,
    data?.class,
    data?.name,
    data?.type,
    error?.errorClass,
    error?.class,
    error?.name,
    error?.type,
  );
  const code = firstString(
    payload.code,
    payload.errorCode,
    payload.statusCode,
    data?.code,
    data?.errorCode,
    data?.statusCode,
    error?.code,
    error?.errorCode,
    error?.statusCode,
  );
  const retryable = firstBoolean(
    payload.retryable,
    payload.isRetryable,
    data?.retryable,
    data?.isRetryable,
    error?.retryable,
    error?.isRetryable,
  );
  const recoverable = firstBoolean(
    payload.recoverable,
    payload.isRecoverable,
    data?.recoverable,
    data?.isRecoverable,
    error?.recoverable,
    error?.isRecoverable,
  );
  const severity = errorSeverityFromPayload(payload, data, error);

  return {
    severity,
    label: errorSeverityLabel(severity),
    ...(message ? { message: compactText(message) } : {}),
    ...(errorClass ? { errorClass: compactText(errorClass) } : {}),
    ...(code ? { code: compactText(code) } : {}),
    ...(retryable !== null ? { retryable } : {}),
    ...(recoverable !== null ? { recoverable } : {}),
  };
}

function errorSeverityFromPayload(
  payload: UnknownRecord,
  data: UnknownRecord | null,
  error: UnknownRecord | null,
): MossNormalizedErrorSeverity {
  const severity = firstString(
    payload.severity,
    payload.level,
    payload.status,
    data?.severity,
    data?.level,
    data?.status,
    error?.severity,
    error?.level,
    error?.status,
  );

  switch (formatStatus(severity ?? "")) {
    case "warning":
    case "warn":
      return "warning";
    case "fatal":
    case "critical":
    case "panic":
      return "fatal";
    case "error":
    case "failed":
    case "failure":
    case "errored":
      return "error";
    default:
      return "error";
  }
}

function errorSeverityLabel(severity: MossNormalizedErrorSeverity): string {
  switch (severity) {
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    case "fatal":
      return "Fatal";
    case "unknown":
      return "Unknown";
    default:
      return assertNever(severity);
  }
}

function errorSeverityClassName(severity: MossNormalizedErrorSeverity): string {
  switch (severity) {
    case "warning":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    case "fatal":
      return "border-red-700/50 bg-red-700/10 text-red-800 dark:text-red-200";
    case "unknown":
      return "border-border/70 bg-muted/30 text-muted-foreground";
    default:
      return assertNever(severity);
  }
}

function countRunningToolLifecycles(events: ReadonlyArray<MossNormalizedSessionEvent>): number {
  const runningLifecycleIds = new Set<string>();
  const lifecycleByEventId = deriveMossNormalizedToolLifecycleStates(events);
  for (const state of lifecycleByEventId.values()) {
    if (state.state === "running") {
      runningLifecycleIds.add(state.lifecycleId);
    }
  }
  return runningLifecycleIds.size;
}

function lastMossNormalizedFinishSummary(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): MossNormalizedFinishSummary | null {
  for (const event of events.toReversed()) {
    const summary = deriveMossNormalizedFinishSummary(event);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function sessionRunStateKind(input: {
  readonly lastEvent: MossNormalizedSessionEvent | undefined;
  readonly lastFinishState: MossNormalizedFinishStateTone | undefined;
  readonly pendingPermissionCount: number;
  readonly runningToolCount: number;
}): MossNormalizedSessionRunStateKind {
  if (!input.lastEvent) {
    return "idle";
  }
  if (input.lastEvent.type === "error") {
    return "failed";
  }
  if (input.lastEvent.type === "finish") {
    switch (input.lastFinishState) {
      case "completed":
        return "completed";
      case "interrupted":
        return "interrupted";
      case "failed":
        return "failed";
      case "unknown":
      case undefined:
        return "running";
      default:
        return assertNever(input.lastFinishState);
    }
  }
  if (input.pendingPermissionCount > 0) {
    return "waiting-for-permission";
  }
  if (input.runningToolCount > 0) {
    return "running";
  }
  return "running";
}

function sessionRunStateLabel(state: MossNormalizedSessionRunStateKind): string {
  switch (state) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "waiting-for-permission":
      return "Waiting for permission";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    default:
      return assertNever(state);
  }
}

function sessionRunStateClassName(state: MossNormalizedSessionRunStateKind): string {
  switch (state) {
    case "idle":
      return "border-border/70 bg-muted/30 text-muted-foreground";
    case "running":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "waiting-for-permission":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "completed":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "interrupted":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return assertNever(state);
  }
}

function formatCurrencyUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatStatus(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatTimelineTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Moss normalized event type: ${String(value)}`);
}
