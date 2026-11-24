// FILE: noticeCards.tsx
// Purpose: The transcript's notice cards, drawn the way the desktop chat draws its events
//          and notices: a compaction and a user stop are one quiet event line; a turn
//          error is the warning line (icon in the danger tone, label in the secondary
//          tone, at most 480px wide). The model-changed and model-rerouted dividers keep
//          Moss's own design; the rerouted one is a single line with its one link.
// Layer: Chat transcript UI
// Exports: ModelChangedTimelineRow, ModelReroutedTimelineRow, UserStoppedTimelineRow,
//          TurnErrorTimelineRow, ContextCompactionLine

import type { ProviderInstanceId } from "@moss/contracts";
import { memo, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { InfoIcon, ModelCubeIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "../../../../localization";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../ui/tooltip";
import { TextLink } from "../../../ui/text-link";
import { openExternalLink } from "~/lib/linkChips";
import {
  isMossLegacySourceInstanceId,
  isMossManagedSourceInstanceId,
} from "../../providerAccountSources";
import type { WorkLogEntry } from "../../../../session-logic";
import {
  contextCompactionPresentationState,
  resolveTranscriptModelDisplayName,
} from "../../MessagesTimeline.logic";
import { TRANSCRIPT_DIVIDER_CLASS_NAME } from "../../TranscriptDivider";
import { computeWorkedDurationMs, formatWorkedDuration } from "../../workedForPresentation";
import { TranscriptEventLine } from "../TranscriptDisclosureRow";

export const ModelChangedTimelineRow = memo(function ModelChangedTimelineRow(props: {
  fromModel: string;
  toModel: string;
  fromModelDisplayName?: string;
  toModelDisplayName?: string;
  customModelLabel: string;
  fontSizePx: number;
  status?: "optimistic" | "durable" | "failed";
}) {
  const { format, t } = useTranslation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const fromModel = resolveTranscriptModelDisplayName({
    model: props.fromModel,
    ...(props.fromModelDisplayName ? { displayName: props.fromModelDisplayName } : {}),
    customLabel: props.customModelLabel,
  });
  const toModel = resolveTranscriptModelDisplayName({
    model: props.toModel,
    ...(props.toModelDisplayName ? { displayName: props.toModelDisplayName } : {}),
    customLabel: props.customModelLabel,
  });
  const message = format("localConversation.modelChanged", {
    fromModel,
    toModel,
  });
  const tooltipLabel = `${t("localConversation.modelChanged.warning.line1")} ${t("localConversation.modelChanged.warning.line2")}`;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-[var(--color-text-foreground-secondary)]",
        props.status === "failed" ? "opacity-75" : null,
      )}
      data-model-change-status={props.status ?? "durable"}
      role="status"
      aria-label={message}
    >
      <span
        aria-hidden="true"
        className={TRANSCRIPT_DIVIDER_CLASS_NAME}
        data-model-change-divider="leading"
      />
      <div className="flex min-w-0 shrink items-center gap-1.5" data-model-change-center="true">
        <span
          aria-hidden="true"
          className="inline-flex size-2.5 shrink-0 items-center justify-center"
          data-model-change-icon="true"
        >
          <ModelCubeIcon aria-hidden="true" className="size-full" />
        </span>
        <span className="min-w-0 truncate" style={{ fontSize: `${props.fontSizePx}px` }}>
          {message}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/55 transition-colors duration-150 hover:bg-muted/50 hover:text-foreground active:scale-[0.96] active:bg-muted focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transform-none motion-reduce:transition-none"
                aria-label={tooltipLabel}
                data-model-change-tooltip-trigger="true"
              />
            }
          >
            <InfoIcon aria-hidden="true" className="size-3" />
          </TooltipTrigger>
          <TooltipPopup
            side="top"
            align="start"
            className={cn(
              "max-w-3xs text-center motion-reduce:transition-none",
              reducedMotion ? "transition-none" : null,
            )}
            {...(reducedMotion
              ? { positionerClassName: "transition-none", style: { transition: "none" } }
              : {})}
          >
            <div data-model-change-tooltip-line="1">
              {t("localConversation.modelChanged.warning.line1")}
            </div>
            <div data-model-change-tooltip-line="2">
              {t("localConversation.modelChanged.warning.line2")}
            </div>
          </TooltipPopup>
        </Tooltip>
      </div>
      <span
        aria-hidden="true"
        className={TRANSCRIPT_DIVIDER_CLASS_NAME}
        data-model-change-divider="trailing"
      />
    </div>
  );
});

/**
 * 申请复核 is offered only where the person can ask: a chat on their own Codex sign-in. A
 * Moss-managed lane (or the retired key lane), or a chat whose lane is unknown, has none.
 */
export function modelReroutedReviewLinkShown(instanceId: ProviderInstanceId | undefined): boolean {
  return (
    instanceId !== undefined &&
    !isMossManagedSourceInstanceId(instanceId) &&
    !isMossLegacySourceInstanceId(instanceId)
  );
}

/** Where a person asks for a rerouted request to be reviewed (opened outside the app). */
export const MODEL_REROUTED_REVIEW_URL = "https://chatgpt.com/cyber";

/**
 * A request routed to another model to reduce cyber-abuse risk: one line with the reason, and
 * the one way forward (申请复核) when the chat runs on the person's own Codex sign-in.
 */
export const ModelReroutedTimelineRow = memo(function ModelReroutedTimelineRow(props: {
  toModel: string;
  customModelLabel: string;
  fontSizePx: number;
  /** Only on the person's own Codex sign-in; a Moss-managed lane has no review to ask for. */
  reviewLink: boolean;
}) {
  const { format, t } = useTranslation();
  const toModel = resolveTranscriptModelDisplayName({
    model: props.toModel,
    customLabel: props.customModelLabel,
  });
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-[var(--color-text-foreground-secondary)]"
      data-model-rerouted-reason="highRiskCyberActivity"
      style={{ fontSize: String(props.fontSizePx) + "px" }}
    >
      <span
        aria-hidden="true"
        className={TRANSCRIPT_DIVIDER_CLASS_NAME}
        data-model-rerouted-divider="leading"
      />
      <p className="flex min-w-0 shrink items-baseline gap-1.5" data-model-rerouted-center="true">
        <span className="min-w-0 truncate">
          {format("localConversation.modelRerouted", { toModel })}
        </span>
        {props.reviewLink ? (
          <TextLink
            className="shrink-0"
            href={MODEL_REROUTED_REVIEW_URL}
            rel="noreferrer"
            target="_blank"
            onClick={(event) => {
              event.preventDefault();
              openExternalLink(MODEL_REROUTED_REVIEW_URL);
            }}
          >
            {t("localConversation.modelRerouted.requestReview")}
          </TextLink>
        ) : null}
      </p>
      <span
        aria-hidden="true"
        className={TRANSCRIPT_DIVIDER_CLASS_NAME}
        data-model-rerouted-divider="trailing"
      />
    </div>
  );
});

const USER_STOPPED_EASE = "cubic-bezier(0.19, 1, 0.22, 1)";
const USER_STOPPED_TRANSITION = `grid-template-rows 300ms ${USER_STOPPED_EASE}, opacity 300ms ${USER_STOPPED_EASE}`;

export const UserStoppedTimelineRow = memo(function UserStoppedTimelineRow(props: {
  startedAt: string;
  completedAt: string;
}) {
  const { locale, format } = useTranslation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [entered, setEntered] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const measure = () => {
      const nextHeight = contentRef.current?.scrollHeight ?? 0;
      setContentHeight(nextHeight);
    };
    const frame = window.requestAnimationFrame(() => {
      measure();
      setEntered(true);
    });
    const ResizeObserverCtor = window.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(measure) : null;
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);
  const durationMs = computeWorkedDurationMs(props.startedAt, props.completedAt) ?? 0;
  const label = format("localConversation.userStoppedAfter", {
    time: formatWorkedDuration(durationMs, locale),
  });
  return (
    <div
      className="min-w-0"
      style={{
        display: "grid",
        height: entered ? `${contentHeight}px` : "0px",
        gridTemplateRows: entered ? "1fr" : "0fr",
        opacity: entered ? 1 : 0,
        transition: reducedMotion ? "none" : USER_STOPPED_TRANSITION,
      }}
      data-user-stopped-row="true"
      data-user-stopped-phase={entered ? "entered" : "mounting"}
      data-user-stopped-transition="true"
      role="status"
      aria-label={label}
    >
      <div ref={contentRef} className="min-h-0 overflow-hidden">
        <TranscriptEventLine verb={<span className="tabular-nums">{label}</span>} />
      </div>
    </div>
  );
});

/** The desktop chat's turn-error line: warning glyph, then the message in secondary text. */
export const TurnErrorTimelineRow = memo(function TurnErrorTimelineRow(props: { message: string }) {
  return (
    <div
      className="flex w-full max-w-[480px] flex-col items-start gap-1 self-start text-size-chat"
      role="alert"
      data-turn-error="true"
    >
      <div className="flex min-w-0 max-w-full items-center gap-1.25 select-text">
        <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 break-words text-[var(--color-text-foreground-secondary)]">
          {props.message}
        </span>
      </div>
    </div>
  );
});

/** Compaction as the desktop chat words it: Compacting session… / Compacted session. */
export function ContextCompactionLine(props: { entry: WorkLogEntry }) {
  const { t } = useTranslation();
  const { entry } = props;
  const state = contextCompactionPresentationState({
    liveState: entry.liveActivity?.state,
    toolStatus: entry.toolStatus,
    label: entry.label,
  });
  const mode = entry.compactionMode ?? entry.compactionSource;
  const verb =
    state === "failed"
      ? t("transcript.event.compactionFailed")
      : state === "cancelled"
        ? t("transcript.event.compactionStopped")
        : mode === "work"
          ? t(state === "active" ? "transcript.event.optimizing" : "transcript.event.optimized")
          : t(state === "active" ? "transcript.event.compacting" : "transcript.event.compacted");
  return (
    <TranscriptEventLine
      role="status"
      data-context-compaction={state}
      verb={verb}
      busy={state === "active"}
    />
  );
}
