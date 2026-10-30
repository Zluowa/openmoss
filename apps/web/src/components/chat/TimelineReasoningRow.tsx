// FILE: TimelineReasoningRow.tsx
// Purpose: Render Codex-style reasoning as an independent transcript primitive.
// Layer: Web chat presentation component
// Exports: TimelineReasoningRow

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { WorkLogEntry } from "../../workLog";
import { formatClockDuration } from "../../session-logic";
import { useTranslation } from "../../localization";
import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  DISCLOSURE_CLEANUP_BUFFER_MS,
  CONVERSATION_DISCLOSURE_MS,
  CONVERSATION_DISCLOSURE_CHEVRON_CLASS,
  conversationDisclosureStyle,
} from "~/lib/disclosureMotion";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import ChatMarkdown from "../ChatMarkdown";
import { ConversationShimmer } from "./ConversationShimmer";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { useMeasuredElementHeight } from "./useMeasuredElementHeight";
import {
  isReasoningPresentationActive,
  reasoningEntryContent,
  resolveReasoningBody,
} from "./reasoningPresentation";

const REASONING_BODY_MAX_HEIGHT = "8.75rem";
const REASONING_EDGE_FADE_DISTANCE = "1rem";

const REASONING_SUMMARY_TEXT_CLASS_NAME =
  "text-text/30 !text-[var(--color-text-tertiary,var(--color-text-foreground-tertiary,var(--muted-foreground)))] group-hover/activity-header:!text-[var(--foreground)] group-hover/activity-header:text-default";
const REASONING_BODY_TEXT_COLOR = "var(--color-text-foreground-secondary, var(--muted-foreground))";

const reasoningBodyStyle: CSSProperties = { maxHeight: REASONING_BODY_MAX_HEIGHT };

function useReasoningElapsed(active: boolean): number | null {
  const startedAtMsRef = useRef<number | null>(active ? Date.now() : null);
  const previousActiveRef = useRef(active);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (active) {
      if (!previousActiveRef.current) {
        startedAtMsRef.current = Date.now();
      }
      setElapsedMs(null);
    } else if (previousActiveRef.current && startedAtMsRef.current !== null) {
      const elapsedMs = Date.now() - startedAtMsRef.current;
      setElapsedMs(elapsedMs > 0 ? elapsedMs : null);
    }
    previousActiveRef.current = active;
  }, [active]);

  return elapsedMs;
}

function ReasoningDisclosure(props: {
  open: boolean;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const { measuredHeight, measuredElementRef } = useMeasuredElementHeight<HTMLDivElement>();
  const shellStyle: CSSProperties = {
    height: props.open ? `${measuredHeight}px` : "0px",
    opacity: props.open ? 1 : 0,
    overflow: props.open ? "visible" : "hidden",
    pointerEvents: props.open ? "auto" : "none",
    ...conversationDisclosureStyle(props.reducedMotion),
  };

  return (
    <div
      data-reasoning-disclosure="true"
      aria-hidden={props.open ? undefined : true}
      inert={!props.open}
      className="min-w-0"
      style={shellStyle}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          ref={measuredElementRef}
          className={cn("min-w-0 pt-1", props.reducedMotion && "transition-none duration-0")}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}

function ReasoningBody(props: {
  body: string;
  active: boolean;
  open: boolean;
  renderBody: boolean;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  textFontSizePx: number;
  bodyId: string;
  bodyLabel: string;
  reducedMotion: boolean;
}) {
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.active) return;
    const scrollRegion = bodyScrollRef.current;
    if (scrollRegion) {
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    }
  }, [props.active, props.body]);

  if (!props.renderBody) {
    return null;
  }

  return (
    <ReasoningDisclosure open={props.open} reducedMotion={props.reducedMotion}>
      <div
        id={props.bodyId}
        ref={bodyScrollRef}
        data-reasoning-body="true"
        data-reasoning-active={props.active ? "true" : "false"}
        role="region"
        aria-label={props.bodyLabel}
        tabIndex={0}
        className="scroll-fade-y overflow-y-auto overscroll-contain text-text/60 [--scroll-fade-size:1rem]"
        style={{ ...reasoningBodyStyle, fontSize: `${props.textFontSizePx}px` }}
      >
        <ChatMarkdown
          text={props.body}
          cwd={props.markdownCwd}
          isStreaming={props.active}
          className="break-words text-[length:inherit] [&>h1]:mt-2 [&>h2]:mt-2 [&>h3]:mt-2 [&>h1+*]:mt-1 [&>h2+*]:mt-1 [&>h3+*]:mt-1 [&>p+p]:mt-1"
          style={{
            color: REASONING_BODY_TEXT_COLOR,
            fontSize: `${props.textFontSizePx}px`,
            lineHeight: "1.45",
          }}
          onImageExpand={props.onImageExpand}
        />
      </div>
    </ReasoningDisclosure>
  );
}

export function TimelineReasoningRow(props: {
  entry: WorkLogEntry;
  active?: boolean;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { t, format } = useTranslation();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const active = props.active ?? isReasoningPresentationActive(props.entry);
  const body = resolveReasoningBody(
    reasoningEntryContent(props.entry),
    active ? "active" : "settled",
  );
  const hasBody = body.length > 0;
  const elapsedMs = useReasoningElapsed(active);
  const [expanded, setExpanded] = useState(false);
  const [renderBody, setRenderBody] = useState(active && hasBody);
  const bodyId = `reasoning-body-${useId().replace(/:/gu, "")}`;
  const textFontSizePx = props.textFontSizePx ?? props.chatMetaFontSizePx;
  const open = active || expanded;

  useEffect(() => {
    if (active && hasBody) {
      setRenderBody(true);
      return;
    }
    if (expanded && hasBody) {
      setRenderBody(true);
      return;
    }
    if (!renderBody) return;
    const cleanup = window.setTimeout(
      () => setRenderBody(false),
      CONVERSATION_DISCLOSURE_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(cleanup);
  }, [active, expanded, hasBody, renderBody]);

  const headerLabel = active
    ? t("localConversation.reasoning.thinking")
    : elapsedMs !== null
      ? format("localConversation.reasoning.thoughtWithElapsed", {
          elapsed: formatClockDuration(elapsedMs),
        })
      : t("localConversation.reasoning.thought");
  const headerClassName = cn("text-[length:inherit] truncate", REASONING_SUMMARY_TEXT_CLASS_NAME);
  const headerStyle = { fontSize: `${textFontSizePx}px` };
  const reasoningHeaderClassName =
    "group/activity-header min-w-0 max-w-full self-start items-center gap-1 p-0 text-start";
  const reasoningHeaderDisplayClassName = active ? "inline-block" : "inline-flex";
  const reasoningDisclosureChevronClassName = cn(
    "icon-2xs size-3 shrink-0 text-text/60 !text-[var(--color-text-foreground-secondary,var(--muted-foreground))] opacity-0 transition-transform [@media(hover:hover)]:group-hover/activity-header:opacity-100 [@media(hover:hover)]:group-hover/activity-header:!text-[var(--foreground)] [@media(hover:hover)]:group-hover/activity-header:text-default group-focus-visible/activity-header:opacity-100 group-focus-visible/activity-header:!text-[var(--foreground)] group-focus-visible/activity-header:text-default",
    CONVERSATION_DISCLOSURE_CHEVRON_CLASS,
    expanded && "rotate-90 opacity-100",
    reducedMotion && "transition-none duration-0",
  );
  const headerContent =
    hasBody && !active ? (
      <button
        type="button"
        className={cn(
          reasoningHeaderClassName,
          reasoningHeaderDisplayClassName,
          REASONING_SUMMARY_TEXT_CLASS_NAME,
          "cursor-interaction rounded-md bg-transparent focus-visible:px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-inset",
        )}
        aria-expanded={expanded}
        aria-controls={bodyId}
        data-reasoning-trigger="true"
        onClick={() => setExpanded((current) => !current)}
        style={headerStyle}
      >
        <span>{headerLabel}</span>
        <DisclosureChevron open={expanded} className={reasoningDisclosureChevronClassName} />
      </button>
    ) : (
      <ConversationShimmer
        active={active}
        className={cn(reasoningHeaderClassName, reasoningHeaderDisplayClassName, headerClassName)}
        style={headerStyle}
        data-reasoning-header="true"
      >
        {headerLabel}
      </ConversationShimmer>
    );

  return (
    <div
      className="group/reasoning min-w-0 pt-1 text-codex-secondary"
      data-reasoning-row="true"
      data-codex-status-row="true"
      data-reasoning-state={active ? "active" : "settled"}
      data-reasoning-body-max-height={REASONING_BODY_MAX_HEIGHT}
      data-reasoning-edge-fade={REASONING_EDGE_FADE_DISTANCE}
    >
      <div className={headerClassName} style={headerStyle}>
        {headerContent}
      </div>
      {hasBody ? (
        <ReasoningBody
          body={body}
          active={active}
          open={open}
          renderBody={renderBody}
          markdownCwd={props.markdownCwd}
          onImageExpand={props.onImageExpand}
          textFontSizePx={textFontSizePx}
          bodyId={bodyId}
          bodyLabel={t("localConversation.reasoning.details")}
          reducedMotion={reducedMotion}
        />
      ) : null}
    </div>
  );
}
