// FILE: MossControlPlanePanel.tsx
// Purpose: Low-risk internal shell for Moss session timeline and launch-plan inspection.
// Layer: Web chat control-plane presentation
// Exports: MossControlPlanePanel, MossControlPlanePanelView

import { type ReactNode, useEffect, useState } from "react";
import { ThreadId, type MossNormalizedSessionEvent, type ProviderSession } from "@synara/contracts";

import {
  HistoryIcon,
  ListChecksIcon,
  ListTodoIcon,
  PlayIcon,
  RefreshCwIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../nativeApi";
import type {
  MossShellProductizationSource,
  MossShellProductizationState,
} from "../../mossShellProductization";
import { MossLaunchPlanInspectorForThread } from "./mossLaunchPlanInspector";
import {
  MossLoopLedgerDashboard,
  MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
  type MossLoopLedgerDashboardStatus,
  type MossLoopLedgerDashboardSnapshot,
} from "./mossLoopLedgerDashboard";
import {
  MossNormalizedEventTimeline,
  type MossNormalizedEventTimelineScope,
  type MossNormalizedTimelineSubscriptionState,
  useMossNormalizedSessionEvents,
} from "./mossNormalizedTimeline";
import {
  CHAT_SURFACE_CHIP_CLASS_NAME,
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  ChatHeaderIconButton,
  SurfaceChipIcon,
  SurfaceTabChip,
} from "./chatHeaderControls";

export type MossControlPlaneSurface = "sessions" | "events" | "launch-plan" | "ledger";

interface MossControlPlaneSurfaceDescriptor {
  readonly id: MossControlPlaneSurface;
  readonly label: string;
  readonly icon: LucideIcon;
}

const MOSS_CONTROL_PLANE_SURFACES: ReadonlyArray<MossControlPlaneSurfaceDescriptor> = [
  { id: "sessions", label: "Sessions", icon: ListTodoIcon },
  { id: "events", label: "Events", icon: HistoryIcon },
  { id: "launch-plan", label: "Launch", icon: PlayIcon },
  { id: "ledger", label: "Ledger", icon: ListChecksIcon },
];

export interface MossControlPlanePanelProps {
  readonly threadId: ThreadId;
  readonly className?: string | undefined;
  readonly defaultSurface?: MossControlPlaneSurface | undefined;
  readonly activeSurface?: MossControlPlaneSurface | undefined;
  readonly onSurfaceChange?: ((surface: MossControlPlaneSurface) => void) | undefined;
  readonly productShellMode?: boolean | undefined;
  readonly loopLedgerDashboardSnapshot?: MossLoopLedgerDashboardSnapshot | undefined;
}

export interface MossNativeShellAccessStripProps {
  readonly activeSurface: MossControlPlaneSurface;
  readonly threadId: ThreadId;
  readonly providerLabel?: string | null | undefined;
  readonly sessionStatus?: string | null | undefined;
  readonly productizationMode?: MossShellProductizationState["mode"] | undefined;
  readonly productizationSource?: MossShellProductizationSource | undefined;
  readonly className?: string | undefined;
  readonly onSurfaceChange?: ((surface: MossControlPlaneSurface) => void) | undefined;
}

export type MossLoopLedgerDashboardSnapshotSource = "provided" | "runtime" | "fallback";
export type MossLoopLedgerDashboardLoadStatus = "idle" | "loading" | "ready" | "missing" | "error";
export type MossProviderSessionListSource = "runtime" | "fallback";
export type MossProviderSessionListLoadStatus = "idle" | "loading" | "ready" | "missing" | "error";

type NativeProviderApi = NonNullable<ReturnType<typeof readNativeApi>>["provider"];

export interface UseMossLoopLedgerDashboardSnapshotInput {
  readonly threadId: ThreadId | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly refreshKey?: unknown;
  readonly providedSnapshot?: MossLoopLedgerDashboardSnapshot | undefined;
  readonly fallbackSnapshot?: MossLoopLedgerDashboardSnapshot | undefined;
}

export interface UseMossLoopLedgerDashboardSnapshotState {
  readonly snapshot: MossLoopLedgerDashboardSnapshot;
  readonly source: MossLoopLedgerDashboardSnapshotSource;
  readonly status: MossLoopLedgerDashboardLoadStatus;
  readonly error: string | null;
}

export interface UseMossProviderSessionListInput {
  readonly enabled?: boolean | undefined;
  readonly refreshKey?: unknown;
}

export interface UseMossProviderSessionListState {
  readonly sessions: ReadonlyArray<ProviderSession>;
  readonly source: MossProviderSessionListSource;
  readonly status: MossProviderSessionListLoadStatus;
  readonly error: string | null;
}

export interface MossControlPlaneSessionListModelInput {
  readonly activeThreadId?: ThreadId | null | undefined;
  readonly events: ReadonlyArray<MossNormalizedSessionEvent>;
  readonly sessions?: ReadonlyArray<ProviderSession> | undefined;
  readonly source: MossProviderSessionListSource;
  readonly status: MossProviderSessionListLoadStatus;
  readonly error?: string | null | undefined;
}

export interface MossControlPlaneSessionListItem {
  readonly key: string;
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly providerLabel: string;
  readonly statusLabel: string;
  readonly status: string;
  readonly runtimeModeLabel: string;
  readonly active: boolean;
  readonly eventCount: number;
  readonly modelLabel: string | null;
  readonly cwdLabel: string | null;
  readonly launchPlanHash: string | null;
  readonly updatedAtLabel: string | null;
  readonly lastError: string | null;
  readonly source: MossProviderSessionListSource;
}

export interface MossControlPlaneSessionListModel {
  readonly rows: ReadonlyArray<MossControlPlaneSessionListItem>;
  readonly source: MossProviderSessionListSource;
  readonly status: MossProviderSessionListLoadStatus;
  readonly error: string | null;
  readonly emptyLabel: string;
}

export interface MossControlPlaneSessionListProps {
  readonly model: MossControlPlaneSessionListModel;
  readonly compact?: boolean | undefined;
  readonly selectedSessionKey?: string | null | undefined;
  readonly onSelectSession?: ((row: MossControlPlaneSessionListItem) => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly refreshDisabled?: boolean | undefined;
}

export interface MossLoopLedgerDashboardSurfaceProps {
  readonly snapshot: MossLoopLedgerDashboardSnapshot;
  readonly source: MossLoopLedgerDashboardSnapshotSource;
  readonly status: MossLoopLedgerDashboardLoadStatus;
  readonly error?: string | null | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly refreshDisabled?: boolean | undefined;
}

export interface MossControlPlaneSessionSummaryProps {
  readonly activeSurface: MossControlPlaneSurface;
  readonly normalizedEventCount: number;
  readonly ledgerSnapshot: MossLoopLedgerDashboardSnapshot;
  readonly ledgerSource: MossLoopLedgerDashboardSnapshotSource;
  readonly ledgerStatus: MossLoopLedgerDashboardLoadStatus;
}

export interface MossControlPlaneSessionSummaryModel {
  readonly surfaceLabel: string;
  readonly normalizedEventCountLabel: string;
  readonly ledgerSourceLabel: string;
  readonly ledgerStatusLabel: string;
  readonly releaseGateLabel: string;
  readonly releaseGateStatus: MossLoopLedgerDashboardStatus;
}

export interface MossControlPlanePanelViewProps {
  readonly activeSurface: MossControlPlaneSurface;
  readonly events: ReadonlyArray<MossNormalizedSessionEvent>;
  readonly eventScope?: MossNormalizedEventTimelineScope | undefined;
  readonly eventSubscription?: MossNormalizedTimelineSubscriptionState | undefined;
  readonly launchPlanInspector: ReactNode;
  readonly loopLedgerDashboard: ReactNode;
  readonly providerSessionList?: ReactNode | undefined;
  readonly providerSessionListSummary?: ReactNode | undefined;
  readonly productShellMode?: boolean | undefined;
  readonly sessionSummary?: ReactNode | undefined;
  readonly threadLabel?: string | null | undefined;
  readonly className?: string | undefined;
  readonly onSurfaceChange?: ((surface: MossControlPlaneSurface) => void) | undefined;
}

export function MossControlPlanePanel({
  threadId,
  className,
  defaultSurface = "events",
  activeSurface: controlledActiveSurface,
  onSurfaceChange,
  productShellMode = false,
  loopLedgerDashboardSnapshot,
}: MossControlPlanePanelProps) {
  const [uncontrolledActiveSurface, setUncontrolledActiveSurface] =
    useState<MossControlPlaneSurface>(defaultSurface);
  const [loopLedgerRefreshToken, setLoopLedgerRefreshToken] = useState(0);
  const [sessionListRefreshToken, setSessionListRefreshToken] = useState(0);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const activeSurface = controlledActiveSurface ?? uncontrolledActiveSurface;
  const handleSurfaceChange = (surface: MossControlPlaneSurface) => {
    if (controlledActiveSurface === undefined) {
      setUncontrolledActiveSurface(surface);
    }
    onSurfaceChange?.(surface);
  };
  const normalizedTimeline = useMossNormalizedSessionEvents({
    threadId,
    enabled: true,
  });
  const loopLedgerDashboardState = useMossLoopLedgerDashboardSnapshot({
    threadId,
    enabled: activeSurface === "ledger",
    refreshKey: `${activeSurface}:${loopLedgerRefreshToken}`,
    providedSnapshot: loopLedgerDashboardSnapshot,
  });
  const providerSessionListState = useMossProviderSessionList({
    enabled: true,
    refreshKey: sessionListRefreshToken,
  });
  const providerSessionListModel = deriveMossControlPlaneSessionListModel({
    activeThreadId: threadId,
    events: normalizedTimeline.events,
    sessions: providerSessionListState.sessions,
    source: providerSessionListState.source,
    status: providerSessionListState.status,
    error: providerSessionListState.error,
  });
  const selectedSessionRow = selectMossControlPlaneSessionRow(
    providerSessionListModel,
    selectedSessionKey,
  );
  const selectedTimelineThreadId =
    selectedSessionRow && selectedSessionRow.threadId !== String(threadId)
      ? ThreadId.makeUnsafe(selectedSessionRow.threadId)
      : null;
  const selectedNormalizedTimeline = useMossNormalizedSessionEvents({
    threadId: selectedTimelineThreadId,
    enabled: activeSurface === "events" && selectedTimelineThreadId !== null,
  });
  const timelineEvents = selectedTimelineThreadId
    ? selectedNormalizedTimeline.events
    : normalizedTimeline.events;
  const timelineSubscription: MossNormalizedTimelineSubscriptionState = {
    ...(selectedTimelineThreadId
      ? selectedNormalizedTimeline.subscription
      : normalizedTimeline.subscription),
    scope: selectedTimelineThreadId ? "selected-session" : "active-thread",
    scopeLabel: selectedTimelineThreadId ? "Selected session" : "Active thread",
  };
  const eventScope = selectedSessionRow
    ? deriveMossControlPlaneEventScope({
        activeThreadId: threadId,
        row: selectedSessionRow,
        onClear: () => setSelectedSessionKey(null),
      })
    : undefined;
  const selectedLaunchPlanThreadId = selectedSessionRow
    ? ThreadId.makeUnsafe(selectedSessionRow.threadId)
    : threadId;

  return (
    <MossControlPlanePanelView
      activeSurface={activeSurface}
      className={className}
      eventScope={eventScope}
      eventSubscription={timelineSubscription}
      events={timelineEvents}
      launchPlanInspector={
        <MossLaunchPlanInspectorForThread
          enabled={activeSurface === "launch-plan"}
          refreshKey={`${activeSurface}:${selectedSessionRow?.key ?? String(threadId)}`}
          threadId={selectedLaunchPlanThreadId}
        />
      }
      loopLedgerDashboard={
        <MossLoopLedgerDashboardSurface
          error={loopLedgerDashboardState.error}
          onRefresh={() => setLoopLedgerRefreshToken((token) => token + 1)}
          refreshDisabled={
            loopLedgerDashboardState.status === "loading" ||
            loopLedgerDashboardState.source === "provided"
          }
          snapshot={loopLedgerDashboardState.snapshot}
          source={loopLedgerDashboardState.source}
          status={loopLedgerDashboardState.status}
        />
      }
      providerSessionList={
        <MossControlPlaneSessionList
          model={providerSessionListModel}
          onRefresh={() => setSessionListRefreshToken((token) => token + 1)}
          onSelectSession={(row) => setSelectedSessionKey(row.key)}
          refreshDisabled={providerSessionListState.status === "loading"}
          selectedSessionKey={selectedSessionRow?.key ?? null}
        />
      }
      providerSessionListSummary={
        <MossControlPlaneSessionList
          compact
          model={providerSessionListModel}
          onRefresh={() => setSessionListRefreshToken((token) => token + 1)}
          onSelectSession={(row) => setSelectedSessionKey(row.key)}
          refreshDisabled={providerSessionListState.status === "loading"}
          selectedSessionKey={selectedSessionRow?.key ?? null}
        />
      }
      sessionSummary={
        <MossControlPlaneSessionSummary
          activeSurface={activeSurface}
          ledgerSnapshot={loopLedgerDashboardState.snapshot}
          ledgerSource={loopLedgerDashboardState.source}
          ledgerStatus={loopLedgerDashboardState.status}
          normalizedEventCount={normalizedTimeline.events.length}
        />
      }
      onSurfaceChange={handleSurfaceChange}
      productShellMode={productShellMode}
      threadLabel={String(threadId)}
    />
  );
}

export function MossNativeShellAccessStrip({
  activeSurface,
  threadId,
  providerLabel,
  sessionStatus,
  productizationMode = "explicit-toggle",
  productizationSource = "feature-flag",
  className,
  onSurfaceChange,
}: MossNativeShellAccessStripProps) {
  const provider = providerLabel ?? "unknown";
  const status = sessionStatus ?? "not-started";

  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--app-surface-divider)] bg-background px-3 py-1.5 text-ui-sm sm:px-5",
        className,
      )}
      data-moss-native-active-surface={activeSurface}
      data-moss-native-shell-access="true"
      data-moss-native-shell-provider={provider}
      data-moss-native-shell-session-status={status}
      data-moss-native-shell-thread-id={String(threadId)}
      data-moss-shell-productization-mode={productizationMode}
      data-moss-shell-productization-source={productizationSource}
    >
      <div
        className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground"
        data-moss-native-session-context="true"
      >
        <span className="font-medium text-foreground">Moss</span>
        <span className="truncate">{provider}</span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          /
        </span>
        <span className="truncate">{status}</span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          /
        </span>
        <span className="truncate">{String(threadId)}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Moss shell surfaces">
        {MOSS_CONTROL_PLANE_SURFACES.map((surface) => {
          const active = activeSurface === surface.id;

          return (
            <button
              key={surface.id}
              type="button"
              title={surface.label}
              aria-pressed={active}
              className={cn(
                CHAT_SURFACE_CHIP_CLASS_NAME,
                active && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
                "inline-flex min-w-0 items-center pr-2.5",
              )}
              data-active-surface={active ? "true" : "false"}
              data-moss-native-launch-plan-access={
                surface.id === "launch-plan" ? "true" : undefined
              }
              data-moss-native-loop-ledger-access={surface.id === "ledger" ? "true" : undefined}
              data-moss-native-normalized-event-timeline-access={
                surface.id === "events" ? "true" : undefined
              }
              data-moss-native-session-list-access={surface.id === "sessions" ? "true" : undefined}
              data-moss-native-shell-surface={surface.id}
              onClick={() => onSurfaceChange?.(surface.id)}
            >
              <SurfaceChipIcon icon={surface.icon} />
              <span className="truncate">{surface.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function useMossProviderSessionList({
  enabled = true,
  refreshKey,
}: UseMossProviderSessionListInput = {}): UseMossProviderSessionListState {
  const [state, setState] = useState<UseMossProviderSessionListState>(() => ({
    sessions: [],
    source: "fallback",
    status: "idle",
    error: null,
  }));

  useEffect(() => {
    if (!enabled) {
      setState({
        sessions: [],
        source: "fallback",
        status: "idle",
        error: null,
      });
      return;
    }

    const api = readNativeApi();
    const providerApi = api?.provider as
      | (NativeProviderApi & {
          listSessions?: () => Promise<{ sessions: ReadonlyArray<ProviderSession> }>;
        })
      | undefined;
    if (typeof providerApi?.listSessions !== "function") {
      setState({
        sessions: [],
        source: "fallback",
        status: "missing",
        error: null,
      });
      return;
    }

    let cancelled = false;
    setState({
      sessions: [],
      source: "fallback",
      status: "loading",
      error: null,
    });

    void providerApi
      .listSessions()
      .then((result) => {
        if (cancelled) return;
        setState({
          sessions: result.sessions,
          source: "runtime",
          status: "ready",
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          sessions: [],
          source: "fallback",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return state;
}

export function useMossLoopLedgerDashboardSnapshot({
  threadId,
  enabled = true,
  refreshKey,
  providedSnapshot,
  fallbackSnapshot = MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
}: UseMossLoopLedgerDashboardSnapshotInput): UseMossLoopLedgerDashboardSnapshotState {
  const [state, setState] = useState<UseMossLoopLedgerDashboardSnapshotState>(() => ({
    snapshot: providedSnapshot ?? fallbackSnapshot,
    source: providedSnapshot ? "provided" : "fallback",
    status: providedSnapshot ? "ready" : "idle",
    error: null,
  }));

  useEffect(() => {
    if (providedSnapshot) {
      setState({
        snapshot: providedSnapshot,
        source: "provided",
        status: "ready",
        error: null,
      });
      return;
    }

    if (!enabled || !threadId) {
      setState({
        snapshot: fallbackSnapshot,
        source: "fallback",
        status: "idle",
        error: null,
      });
      return;
    }

    const api = readNativeApi();
    const providerApi = api?.provider as
      | (NativeProviderApi & {
          getLoopLedgerDashboardSnapshot?: (input: {
            threadId: ThreadId;
          }) => Promise<{ snapshot: MossLoopLedgerDashboardSnapshot }>;
        })
      | undefined;
    if (typeof providerApi?.getLoopLedgerDashboardSnapshot !== "function") {
      setState({
        snapshot: fallbackSnapshot,
        source: "fallback",
        status: "missing",
        error: null,
      });
      return;
    }

    let cancelled = false;
    setState({
      snapshot: fallbackSnapshot,
      source: "fallback",
      status: "loading",
      error: null,
    });

    void providerApi
      .getLoopLedgerDashboardSnapshot({ threadId })
      .then((result) => {
        if (cancelled) return;
        setState({
          snapshot: result.snapshot,
          source: "runtime",
          status: "ready",
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          snapshot: fallbackSnapshot,
          source: "fallback",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, fallbackSnapshot, providedSnapshot, refreshKey, threadId]);

  return state;
}

export function MossLoopLedgerDashboardSurface({
  snapshot,
  source,
  status,
  error,
  onRefresh,
  refreshDisabled,
}: MossLoopLedgerDashboardSurfaceProps) {
  return (
    <div
      data-moss-loop-ledger-surface=""
      data-source={source}
      data-status={status}
      className="min-h-0"
    >
      <div
        className="flex items-start justify-between gap-2 border-b border-[var(--app-surface-divider)] px-3 py-2"
        data-moss-loop-ledger-snapshot-state=""
        data-source={source}
        data-status={status}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-ui-sm">
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-medium",
                ledgerSnapshotSourceClassName(source),
              )}
              data-moss-ledger-snapshot-source=""
            >
              {ledgerSnapshotSourceLabel(source)}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-medium",
                ledgerSnapshotStatusClassName(status),
              )}
              data-moss-ledger-snapshot-status=""
            >
              {ledgerSnapshotStatusLabel(status)}
            </span>
          </div>
          {status === "missing" ? (
            <p
              className="text-ui-sm leading-5 text-muted-foreground"
              data-moss-ledger-bridge-missing=""
            >
              Runtime bridge missing
            </p>
          ) : null}
          {status === "error" && error ? (
            <p className="text-ui-sm leading-5 text-destructive" data-moss-ledger-bridge-error="">
              {error}
            </p>
          ) : null}
        </div>
        <ChatHeaderIconButton
          disabled={refreshDisabled}
          label="Refresh ledger snapshot"
          onClick={onRefresh}
          title="Refresh ledger snapshot"
          type="button"
        >
          <RefreshCwIcon
            aria-hidden
            className={cn("size-3.5", status === "loading" && "animate-spin")}
          />
        </ChatHeaderIconButton>
      </div>
      <MossLoopLedgerDashboard snapshot={snapshot} />
    </div>
  );
}

export function deriveMossControlPlaneSessionListModel({
  activeThreadId,
  events,
  sessions = [],
  source,
  status,
  error = null,
}: MossControlPlaneSessionListModelInput): MossControlPlaneSessionListModel {
  const activeThreadKey = activeThreadId ? String(activeThreadId) : null;
  const rollupsByThread = new Map<
    string,
    {
      providerLabel: string;
      eventCount: number;
      launchPlanHash: string | null;
      updatedAtLabel: string | null;
    }
  >();
  const fallbackRowsBySession = new Map<string, MossControlPlaneSessionListItem>();

  for (const event of events) {
    const threadKey = String(event.threadId);
    const sessionKey = String(event.sessionId);
    const payload = event.payload as Record<string, unknown>;
    const launchPlanHash = firstString(payload.launchPlanHash);
    const existingRollup = rollupsByThread.get(threadKey);
    rollupsByThread.set(threadKey, {
      providerLabel: providerLabel(String(event.provider)),
      eventCount: (existingRollup?.eventCount ?? 0) + 1,
      launchPlanHash: launchPlanHash ?? existingRollup?.launchPlanHash ?? null,
      updatedAtLabel: event.createdAt,
    });

    const existingFallbackRow = fallbackRowsBySession.get(sessionKey);
    fallbackRowsBySession.set(sessionKey, {
      key: `event:${sessionKey}`,
      threadId: threadKey,
      sessionId: sessionKey,
      providerLabel: providerLabel(String(event.provider)),
      status: "event-replay",
      statusLabel: "Event replay",
      runtimeModeLabel: "Normalized",
      active: activeThreadKey === threadKey,
      eventCount: (existingFallbackRow?.eventCount ?? 0) + 1,
      modelLabel: null,
      cwdLabel: null,
      launchPlanHash: launchPlanHash ?? existingFallbackRow?.launchPlanHash ?? null,
      updatedAtLabel: event.createdAt,
      lastError: null,
      source: "fallback",
    });
  }

  const rows =
    sessions.length > 0
      ? sessions.map((session) => {
          const threadKey = String(session.threadId);
          const rollup = rollupsByThread.get(threadKey);
          return {
            key: `runtime:${session.provider}:${threadKey}:${session.createdAt}`,
            threadId: threadKey,
            sessionId: null,
            providerLabel: providerLabel(String(session.provider)),
            status: session.status,
            statusLabel: providerSessionStatusLabel(session.status),
            runtimeModeLabel: runtimeModeLabel(String(session.runtimeMode)),
            active: activeThreadKey === threadKey,
            eventCount: rollup?.eventCount ?? 0,
            modelLabel: session.model ? String(session.model) : null,
            cwdLabel: session.cwd ? String(session.cwd) : null,
            launchPlanHash: rollup?.launchPlanHash ?? null,
            updatedAtLabel: String(session.updatedAt),
            lastError: session.lastError ? String(session.lastError) : null,
            source: "runtime" as const,
          };
        })
      : Array.from(fallbackRowsBySession.values());

  if (rows.length === 0 && activeThreadKey) {
    rows.push({
      key: `active:${activeThreadKey}`,
      threadId: activeThreadKey,
      sessionId: null,
      providerLabel: "Unknown",
      status,
      statusLabel: providerSessionListStatusLabel(status),
      runtimeModeLabel: "Unknown",
      active: true,
      eventCount: 0,
      modelLabel: null,
      cwdLabel: null,
      launchPlanHash: null,
      updatedAtLabel: null,
      lastError: null,
      source: "fallback",
    });
  }

  return {
    rows: rows.toSorted(compareSessionListRows),
    source,
    status,
    error,
    emptyLabel: providerSessionListEmptyLabel(status),
  };
}

export function selectMossControlPlaneSessionRow(
  model: MossControlPlaneSessionListModel,
  selectedSessionKey?: string | null | undefined,
): MossControlPlaneSessionListItem | null {
  if (selectedSessionKey) {
    const selectedRow = model.rows.find((row) => row.key === selectedSessionKey);
    if (selectedRow) {
      return selectedRow;
    }
  }

  return model.rows.find((row) => row.active) ?? model.rows[0] ?? null;
}

export function deriveMossControlPlaneEventScope({
  activeThreadId,
  row,
  onClear,
}: {
  readonly activeThreadId: ThreadId | string;
  readonly row: MossControlPlaneSessionListItem;
  readonly onClear?: (() => void) | undefined;
}): MossNormalizedEventTimelineScope {
  const activeThread = row.threadId === String(activeThreadId);
  return {
    threadId: row.threadId,
    sessionId: row.sessionId,
    label: `${row.providerLabel} / ${row.threadId}`,
    activeThread,
    onClear,
  };
}

export function MossControlPlaneSessionList({
  model,
  compact = false,
  selectedSessionKey,
  onSelectSession,
  onRefresh,
  refreshDisabled,
}: MossControlPlaneSessionListProps) {
  const visibleRows = compact ? model.rows.slice(0, 3) : model.rows;
  const selectedRow = selectMossControlPlaneSessionRow(model, selectedSessionKey);
  const resolvedSelectedSessionKey = selectedRow?.key ?? null;
  return (
    <div
      className={cn(
        "border-b border-[var(--app-surface-divider)] bg-background",
        compact ? "px-3 py-2" : "px-3 py-3",
      )}
      data-compact={compact ? "true" : "false"}
      data-moss-control-plane-session-list=""
      data-source={model.source}
      data-status={model.status}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-2xs uppercase tracking-normal text-muted-foreground">
            Sessions
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-sm">
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-medium",
                providerSessionListSourceClassName(model.source),
              )}
              data-moss-session-list-source=""
            >
              {providerSessionListSourceLabel(model.source)}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-medium",
                providerSessionListStatusClassName(model.status),
              )}
              data-moss-session-list-status=""
            >
              {providerSessionListStatusLabel(model.status)}
            </span>
          </div>
        </div>
        <ChatHeaderIconButton
          disabled={refreshDisabled}
          label="Refresh provider sessions"
          onClick={onRefresh}
          title="Refresh provider sessions"
          type="button"
        >
          <RefreshCwIcon
            aria-hidden
            className={cn("size-3.5", model.status === "loading" && "animate-spin")}
          />
        </ChatHeaderIconButton>
      </div>
      {model.error ? (
        <p className="mb-2 text-ui-sm leading-5 text-destructive" data-moss-session-list-error="">
          {model.error}
        </p>
      ) : null}
      {visibleRows.length > 0 ? (
        <div className="space-y-1.5">
          {visibleRows.map((row) => (
            <button
              key={row.key}
              aria-current={row.active ? "true" : undefined}
              aria-pressed={resolvedSelectedSessionKey === row.key}
              className={cn(
                "block w-full min-w-0 rounded border px-2 py-1.5 text-left text-ui-sm transition-colors",
                resolvedSelectedSessionKey === row.key
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : row.active
                    ? "border-sky-500/40 bg-sky-500/10"
                    : "border-border/60 bg-background hover:border-border",
              )}
              data-active-thread={row.active ? "true" : "false"}
              data-event-count={row.eventCount}
              data-moss-session-list-row=""
              data-moss-session-select={row.key}
              data-provider={row.providerLabel}
              data-session-id={row.sessionId ?? ""}
              data-selected-session={resolvedSelectedSessionKey === row.key ? "true" : "false"}
              data-session-source={row.source}
              data-session-status={row.status}
              data-thread-id={row.threadId}
              onClick={() => onSelectSession?.(row)}
              type="button"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 truncate font-medium text-foreground">
                  {row.providerLabel}
                  {row.active ? (
                    <span className="ml-1 rounded bg-sky-500/15 px-1 py-0.5 text-ui-2xs text-sky-700 dark:text-sky-300">
                      Active
                    </span>
                  ) : null}
                </div>
                <span className="shrink-0 text-ui-2xs text-muted-foreground">
                  {row.statusLabel}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-ui-xs text-muted-foreground">
                <span className="truncate">Events {row.eventCount}</span>
                <span className="truncate">{row.runtimeModeLabel}</span>
                {row.modelLabel ? <span className="truncate">{row.modelLabel}</span> : null}
                {row.cwdLabel ? <span className="truncate">{row.cwdLabel}</span> : null}
                {row.launchPlanHash ? (
                  <span className="col-span-2 truncate">Launch {row.launchPlanHash}</span>
                ) : null}
                {row.updatedAtLabel ? (
                  <span className="col-span-2 truncate">Updated {row.updatedAtLabel}</span>
                ) : null}
                {row.lastError ? (
                  <span className="col-span-2 truncate text-destructive">{row.lastError}</span>
                ) : null}
              </div>
            </button>
          ))}
          {!compact && selectedRow ? <MossControlPlaneSessionDrilldown row={selectedRow} /> : null}
        </div>
      ) : (
        <p className="text-ui-sm leading-5 text-muted-foreground" data-moss-session-list-empty="">
          {model.emptyLabel}
        </p>
      )}
    </div>
  );
}

function MossControlPlaneSessionDrilldown({
  row,
}: {
  readonly row: MossControlPlaneSessionListItem;
}) {
  return (
    <div
      className="space-y-1.5 rounded border border-border/60 bg-background px-2 py-2 text-ui-sm"
      data-launch-plan-hash={row.launchPlanHash ?? ""}
      data-moss-session-drilldown=""
      data-selected-session-id={row.sessionId ?? ""}
      data-selected-session-key={row.key}
      data-selected-thread-id={row.threadId}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="font-medium text-foreground">Selected session</span>
        <span className="shrink-0 text-ui-2xs text-muted-foreground">{row.statusLabel}</span>
      </div>
      <dl className="grid grid-cols-[5.25rem_1fr] gap-x-2 gap-y-1 text-ui-xs">
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="min-w-0 truncate text-foreground">{row.providerLabel}</dd>
        <dt className="text-muted-foreground">Thread</dt>
        <dd className="min-w-0 truncate text-foreground">{row.threadId}</dd>
        <dt className="text-muted-foreground">Runtime</dt>
        <dd className="min-w-0 truncate text-foreground">{row.runtimeModeLabel}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="min-w-0 truncate text-foreground">{row.modelLabel ?? "not specified"}</dd>
        <dt className="text-muted-foreground">CWD</dt>
        <dd className="min-w-0 truncate text-foreground">{row.cwdLabel ?? "not specified"}</dd>
        <dt className="text-muted-foreground">Launch</dt>
        <dd className="min-w-0 truncate text-foreground">{row.launchPlanHash ?? "not loaded"}</dd>
      </dl>
    </div>
  );
}

export function deriveMossControlPlaneSessionSummaryModel({
  activeSurface,
  normalizedEventCount,
  ledgerSnapshot,
  ledgerSource,
  ledgerStatus,
}: MossControlPlaneSessionSummaryProps): MossControlPlaneSessionSummaryModel {
  return {
    surfaceLabel: surfaceLabel(activeSurface),
    normalizedEventCountLabel: String(normalizedEventCount),
    ledgerSourceLabel: ledgerSnapshotSourceLabel(ledgerSource),
    ledgerStatusLabel: ledgerSnapshotStatusLabel(ledgerStatus),
    releaseGateLabel: releaseGateLabel(ledgerSnapshot.releaseGate.status),
    releaseGateStatus: ledgerSnapshot.releaseGate.status,
  };
}

export function MossControlPlaneSessionSummary(props: MossControlPlaneSessionSummaryProps) {
  const model = deriveMossControlPlaneSessionSummaryModel(props);

  return (
    <div
      className="grid grid-cols-2 gap-1.5 border-b border-[var(--app-surface-divider)] px-3 py-2 text-ui-sm"
      data-moss-control-plane-summary=""
      data-ledger-source={props.ledgerSource}
      data-ledger-status={props.ledgerStatus}
      data-release-gate-status={model.releaseGateStatus}
      data-surface={props.activeSurface}
    >
      <SummaryCell label="Surface" value={model.surfaceLabel} />
      <SummaryCell label="Events" value={model.normalizedEventCountLabel} />
      <SummaryCell
        label="Ledger"
        tone={
          props.ledgerStatus === "error"
            ? "danger"
            : props.ledgerStatus === "missing"
              ? "warning"
              : "default"
        }
        value={`${model.ledgerSourceLabel} / ${model.ledgerStatusLabel}`}
      />
      <SummaryCell
        label="Gate"
        tone={releaseGateTone(model.releaseGateStatus)}
        value={model.releaseGateLabel}
      />
    </div>
  );
}

export function MossControlPlanePanelView({
  activeSurface,
  events,
  eventScope,
  eventSubscription,
  launchPlanInspector,
  loopLedgerDashboard,
  providerSessionList,
  providerSessionListSummary,
  sessionSummary,
  threadLabel,
  productShellMode = false,
  className,
  onSurfaceChange,
}: MossControlPlanePanelViewProps) {
  return (
    <aside
      className={cn(
        "hidden min-h-0 w-[22rem] max-w-[42vw] shrink-0 flex-col border-l border-[var(--app-surface-divider)] bg-background text-foreground min-[980px]:flex",
        className,
      )}
      data-moss-control-plane=""
      data-moss-product-shell-control-plane={productShellMode ? "true" : undefined}
    >
      <header className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-2 px-3")}>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium text-foreground">Moss Control</span>
          {threadLabel ? (
            <span className="truncate text-ui-xs text-muted-foreground">{threadLabel}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1" aria-label="Moss control surfaces">
          {MOSS_CONTROL_PLANE_SURFACES.map((surface) => (
            <SurfaceTabChip
              key={surface.id}
              active={activeSurface === surface.id}
              icon={<SurfaceChipIcon icon={surface.icon} />}
              label={surface.label}
              labelClassName="max-w-[4.5rem]"
              onSelect={() => onSurfaceChange?.(surface.id)}
              title={surface.label}
            />
          ))}
        </div>
      </header>
      {sessionSummary}
      {activeSurface === "sessions" ? null : providerSessionListSummary}
      <div className="min-h-0 flex-1 overflow-auto">
        {activeSurface === "sessions" ? (
          <section data-moss-control-plane-sessions="">
            {providerSessionList ?? providerSessionListSummary}
          </section>
        ) : null}
        {activeSurface === "events" ? (
          <section
            data-moss-control-plane-events=""
            data-moss-product-shell-events-viewport={productShellMode ? "true" : undefined}
          >
            <MossNormalizedEventTimeline
              emptyLabel="No normalized events for this thread"
              scope={eventScope}
              subscription={eventSubscription}
              events={events}
            />
          </section>
        ) : null}
        {activeSurface === "launch-plan" ? (
          <section data-moss-control-plane-launch-plan="">{launchPlanInspector}</section>
        ) : null}
        {activeSurface === "ledger" ? (
          <section data-moss-control-plane-ledger="">{loopLedgerDashboard}</section>
        ) : null}
      </div>
    </aside>
  );
}

function SummaryCell({
  label,
  value,
  tone = "default",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "muted" | "warning" | "danger" | undefined;
}) {
  return (
    <div className="min-w-0 rounded border border-border/60 bg-background px-2 py-1.5">
      <div className="text-ui-2xs uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate font-medium", summaryToneClassName(tone))}>{value}</div>
    </div>
  );
}

function surfaceLabel(surface: MossControlPlaneSurface): string {
  switch (surface) {
    case "sessions":
      return "Sessions";
    case "events":
      return "Events";
    case "launch-plan":
      return "Launch";
    case "ledger":
      return "Ledger";
  }
}

function ledgerSnapshotSourceLabel(source: MossLoopLedgerDashboardSnapshotSource): string {
  switch (source) {
    case "runtime":
      return "Runtime";
    case "provided":
      return "Provided";
    case "fallback":
      return "Fallback";
  }
}

function ledgerSnapshotStatusLabel(status: MossLoopLedgerDashboardLoadStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "missing":
      return "Bridge missing";
    case "error":
      return "Error";
  }
}

function releaseGateLabel(status: MossLoopLedgerDashboardStatus): string {
  switch (status) {
    case "pass":
      return "Pass";
    case "pending":
      return "Pending";
    case "blocked":
      return "Blocked";
  }
}

function releaseGateTone(status: MossLoopLedgerDashboardStatus): "default" | "warning" | "danger" {
  switch (status) {
    case "pass":
      return "default";
    case "pending":
      return "warning";
    case "blocked":
      return "danger";
  }
}

function summaryToneClassName(tone: "default" | "muted" | "warning" | "danger"): string {
  switch (tone) {
    case "default":
      return "text-foreground";
    case "muted":
      return "text-muted-foreground";
    case "warning":
      return "text-amber-700 dark:text-amber-300";
    case "danger":
      return "text-destructive";
  }
}

function compareSessionListRows(
  left: MossControlPlaneSessionListItem,
  right: MossControlPlaneSessionListItem,
): number {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }
  if (left.updatedAtLabel && right.updatedAtLabel && left.updatedAtLabel !== right.updatedAtLabel) {
    return right.updatedAtLabel.localeCompare(left.updatedAtLabel);
  }
  if (left.eventCount !== right.eventCount) {
    return right.eventCount - left.eventCount;
  }
  return left.threadId.localeCompare(right.threadId);
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    case "antigravity":
      return "Antigravity";
    case "devin":
      return "Devin";
    case "acp":
      return "ACP";
    case "hermes":
      return "Hermes";
    case "kimi":
      return "Kimi Code";
    case "minimax":
      return "MiniMax Code";
    case "zcode":
      return "ZCode";
    default:
      return provider || "Unknown";
  }
}

function runtimeModeLabel(runtimeMode: string): string {
  if (runtimeMode === "full-access") {
    return "Full access";
  }
  return runtimeMode
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerSessionStatusLabel(status: string): string {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    default:
      return providerSessionListStatusLabel(status as MossProviderSessionListLoadStatus);
  }
}

function providerSessionListSourceLabel(source: MossProviderSessionListSource): string {
  switch (source) {
    case "runtime":
      return "Runtime";
    case "fallback":
      return "Fallback";
  }
}

function providerSessionListStatusLabel(
  status: MossProviderSessionListLoadStatus | string,
): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "missing":
      return "Bridge missing";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}

function providerSessionListEmptyLabel(status: MossProviderSessionListLoadStatus): string {
  switch (status) {
    case "loading":
      return "Loading provider sessions";
    case "missing":
      return "Runtime session bridge missing";
    case "error":
      return "Provider sessions unavailable";
    default:
      return "No provider sessions";
  }
}

function providerSessionListSourceClassName(source: MossProviderSessionListSource): string {
  switch (source) {
    case "runtime":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "fallback":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function providerSessionListStatusClassName(status: MossProviderSessionListLoadStatus): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "loading":
    case "idle":
      return "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
    case "missing":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive";
  }
}

function ledgerSnapshotSourceClassName(source: MossLoopLedgerDashboardSnapshotSource): string {
  switch (source) {
    case "runtime":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "provided":
      return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "fallback":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function ledgerSnapshotStatusClassName(status: MossLoopLedgerDashboardLoadStatus): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "loading":
    case "idle":
      return "border-muted-foreground/30 bg-muted/40 text-muted-foreground";
    case "missing":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive";
  }
}
