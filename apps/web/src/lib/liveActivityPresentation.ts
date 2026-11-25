// FILE: liveActivityPresentation.ts
// Purpose: Provider-agnostic labels and live timing for normalized transcript activity.
// Layer: Web presentation helper

import { useSyncExternalStore } from "react";

import type { WorkLogLiveActivity } from "../workLog";
import { formatClockDuration } from "../session-logic";
import {
  computeActiveWorkedDurationMs,
  type WorkedPauseInterval,
} from "../components/chat/workedForPresentation";
import { startVisibleInterval } from "./visibleInterval";

const NO_ACTIVITY_THRESHOLD_MS = 30_000;
const LIVE_ACTIVITY_TICK_MS = 1_000;
const liveActivityClockListeners = new Set<() => void>();
let stopLiveActivityClock: (() => void) | null = null;
let liveActivityClockNowMs = Date.now();

function emitLiveActivityClockTick(): void {
  liveActivityClockNowMs = Date.now();
  for (const listener of liveActivityClockListeners) {
    listener();
  }
}

function subscribeLiveActivityClock(listener: () => void): () => void {
  liveActivityClockListeners.add(listener);
  if (liveActivityClockListeners.size === 1) {
    liveActivityClockNowMs = Date.now();
    stopLiveActivityClock = startVisibleInterval(emitLiveActivityClockTick, LIVE_ACTIVITY_TICK_MS);
  }

  return () => {
    liveActivityClockListeners.delete(listener);
    if (liveActivityClockListeners.size === 0) {
      stopLiveActivityClock?.();
      stopLiveActivityClock = null;
    }
  };
}

function subscribeInactiveLiveActivityClock(): () => void {
  return () => {};
}

function getLiveActivityClockSnapshot(): number {
  return liveActivityClockNowMs;
}

export function isLiveActivityInProgress(activity: WorkLogLiveActivity): boolean {
  return (
    activity.state === "starting" ||
    activity.state === "thinking" ||
    activity.state === "running_tool" ||
    activity.state === "waiting" ||
    activity.state === "streaming"
  );
}

export function useLiveActivityNow(
  activity: WorkLogLiveActivity | undefined,
  options?: {
    readonly paused?: boolean | undefined;
    readonly pausedAtMs?: number | null | undefined;
  },
): number {
  const inProgress = activity ? isLiveActivityInProgress(activity) : false;
  const paused = options?.paused === true;
  const pausedAtMs = options?.pausedAtMs ?? null;
  const shouldTick = inProgress && !paused;
  const nowMs = useSyncExternalStore(
    shouldTick ? subscribeLiveActivityClock : subscribeInactiveLiveActivityClock,
    getLiveActivityClockSnapshot,
    getLiveActivityClockSnapshot,
  );
  if (inProgress && paused) {
    if (pausedAtMs !== null) {
      return pausedAtMs;
    }
    const lastActivityMs = parseTimestamp(activity?.lastActivityAt);
    if (lastActivityMs !== null) {
      return lastActivityMs;
    }
    const startedMs = parseTimestamp(activity?.startedAt);
    if (startedMs !== null) {
      return startedMs;
    }
    return nowMs;
  }
  return shouldTick ? nowMs : Date.now();
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function liveActivityElapsedMs(
  activity: WorkLogLiveActivity,
  nowMs: number,
  pausedIntervals?: ReadonlyArray<WorkedPauseInterval> | null,
): number | null {
  const startedAtMs = parseTimestamp(activity.startedAt);
  const lastActivityAtMs = parseTimestamp(activity.lastActivityAt);
  const reportedElapsedMs =
    activity.elapsedSeconds !== undefined && activity.elapsedSeconds >= 0
      ? activity.elapsedSeconds * 1_000
      : null;

  if (isLiveActivityInProgress(activity)) {
    if (reportedElapsedMs !== null && lastActivityAtMs !== null) {
      const sinceLastActivityMs =
        pausedIntervals && pausedIntervals.length > 0 && nowMs > lastActivityAtMs
          ? (computeActiveWorkedDurationMs(lastActivityAtMs, nowMs, pausedIntervals) ?? 0)
          : Math.max(0, nowMs - lastActivityAtMs);
      return reportedElapsedMs + sinceLastActivityMs;
    }
    if (startedAtMs === null) return null;
    if (pausedIntervals && pausedIntervals.length > 0) {
      return computeActiveWorkedDurationMs(startedAtMs, nowMs, pausedIntervals);
    }
    return Math.max(0, nowMs - startedAtMs);
  }

  if (reportedElapsedMs !== null) return reportedElapsedMs;
  if (startedAtMs === null || lastActivityAtMs === null || lastActivityAtMs < startedAtMs) {
    return null;
  }
  if (pausedIntervals && pausedIntervals.length > 0) {
    return computeActiveWorkedDurationMs(startedAtMs, lastActivityAtMs, pausedIntervals);
  }
  return lastActivityAtMs - startedAtMs;
}

export function formatLiveActivityProgress(progress: number): string {
  const percent = progress >= 0 && progress <= 1 ? progress * 100 : progress;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function formatLiveActivityStateLabel(state: WorkLogLiveActivity["state"]): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "running_tool":
      return "Running tool";
    case "waiting":
      return "Waiting";
    case "streaming":
      return "Streaming";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function formatLiveActivityElapsed(
  activity: WorkLogLiveActivity,
  nowMs: number,
  locale = "en",
  pausedIntervals?: ReadonlyArray<WorkedPauseInterval> | null,
): string | null {
  const elapsedMs = liveActivityElapsedMs(activity, nowMs, pausedIntervals);
  return elapsedMs === null ? null : formatClockDuration(elapsedMs, locale);
}

export interface LiveActivityMetaOptions {
  // Subagent rows (Cursor/Claude `Task`, Codex collab) only hear back from the child
  // agent when it finishes, so quiet time is the expected state — never idleness.
  readonly subagent?: boolean;
  // A tool blocked on the user's own answer (a secret request card): the quiet
  // time is the user's to end, so it reads as waiting on them, never idleness.
  readonly awaitingUser?: boolean;
  // A running tool paused while the user decides an approval card: freeze/suppress
  // the idle stall counter so waiting on approval never reads as "no activity".
  readonly awaitingApproval?: boolean;
  // Closed approval/user-input pause intervals to exclude from active idle/elapsed time.
  readonly pausedIntervals?: ReadonlyArray<WorkedPauseInterval>;
  // The meta is one joined sentence, so it is written in the person's language here
  // instead of being left to the page translator. Defaults to English.
  readonly locale?: string;
}

const ZH_CN_LIVE_ACTIVITY_STATE_LABELS: Readonly<Record<WorkLogLiveActivity["state"], string>> = {
  starting: "正在启动",
  thinking: "正在思考",
  running_tool: "正在使用工具",
  waiting: "等待中",
  streaming: "正在输出",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

// Live meta only exists to explain work the row can't state on its own: how long
// something in flight has been running, or that it ended badly. A tool call that
// simply succeeded already reads as a finished sentence ("Searched for foo in
// src"), so it gets no status/elapsed tail — that detail lives in the disclosure.
export function formatLiveActivityMeta(
  activity: WorkLogLiveActivity,
  nowMs: number,
  options?: LiveActivityMetaOptions,
): string | null {
  if (activity.state === "completed") {
    return null;
  }

  const locale = options?.locale ?? "en";
  const zh = locale.toLowerCase().startsWith("zh");
  const parts: string[] = [];
  const elapsedMs = liveActivityElapsedMs(activity, nowMs, options?.pausedIntervals);
  const elapsed = elapsedMs === null ? null : formatClockDuration(elapsedMs, locale);
  const lastActivityAtMs = parseTimestamp(activity.lastActivityAt);

  if (isLiveActivityInProgress(activity)) {
    if (options?.subagent) {
      parts.push(zh ? "子智能体工作中" : "Subagent working");
    } else if (options?.awaitingApproval) {
      parts.push(zh ? "等待批准" : "Waiting for approval");
    } else if (options?.awaitingUser) {
      parts.push(zh ? "等你回答" : "Waiting for your answer");
    } else if (lastActivityAtMs !== null) {
      const idleMs =
        options?.pausedIntervals && options.pausedIntervals.length > 0 && nowMs > lastActivityAtMs
          ? (computeActiveWorkedDurationMs(lastActivityAtMs, nowMs, options.pausedIntervals) ?? 0)
          : Math.max(0, nowMs - lastActivityAtMs);
      const idle = formatClockDuration(idleMs, locale);
      parts.push(
        idleMs >= NO_ACTIVITY_THRESHOLD_MS
          ? zh
            ? `${idle}没有动静`
            : `No activity for ${idle}`
          : idleMs < 1_000
            ? zh
              ? "刚刚有动静"
              : "Active now"
            : zh
              ? `${idle}前有动静`
              : `Active ${idle} ago`,
      );
    }
  } else {
    parts.push(
      zh
        ? ZH_CN_LIVE_ACTIVITY_STATE_LABELS[activity.state]
        : formatLiveActivityStateLabel(activity.state),
    );
  }

  if (elapsed !== null) {
    parts.push(zh ? `已用时 ${elapsed}` : `${elapsed} elapsed`);
  }
  if (activity.progress !== undefined) {
    parts.push(formatLiveActivityProgress(activity.progress));
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
