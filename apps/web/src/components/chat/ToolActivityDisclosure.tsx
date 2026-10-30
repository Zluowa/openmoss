// FILE: ToolActivityDisclosure.tsx
// Purpose: Codex tool activity header, running/settled state, and measured disclosure body.
// Layer: Web chat presentation component
// Exports: ToolActivityDisclosure

import { motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  disclosureChevronClassName,
  conversationDisclosureTransition,
  CONVERSATION_DISCLOSURE_CHEVRON_CLASS,
} from "~/lib/disclosureMotion";
import { ConversationShimmer } from "./ConversationShimmer";
import { useMeasuredElementHeight } from "./useMeasuredElementHeight";
import { toolActivityBodyClassName } from "./toolActivityLayout";

// tool-activity-disclosure-da11c409681c + app-initial's XV / ActivityHeader.
const SUMMARY_CLASS_NAME =
  "min-w-0 truncate text-size-chat text-text-tertiary/90 group-hover/activity-header:text-default";
const SUMMARY_HOVER_CLASS_NAME =
  "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:!text-default [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[&_*:not(button)]:!text-default";

export function ToolActivityDisclosure(props: {
  label: ReactNode;
  /** Rich native summaries shimmer only their action verb. */
  shimmerLabel?: boolean;
  leadingIcon: ReactNode;
  /** Controlled settled expansion; running collapse is deliberately independent. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  defaultExpanded?: boolean;
  status?: string;
  indentContent?: boolean;
  bodyVariant?: "default" | "grouped";
  /** CHIP multi-agent action rows use a single, initially collapsed toggle. */
  expandWhileRunning?: boolean;
  onExpand?: () => void;
  fontSizePx: number;
  renderChildren?: () => ReactNode;
}) {
  const {
    label,
    shimmerLabel = true,
    leadingIcon,
    open: controlledExpanded,
    onToggle,
    defaultExpanded = false,
    status,
    indentContent = true,
    bodyVariant = "default",
    expandWhileRunning = true,
    onExpand,
    fontSizePx,
    renderChildren,
  } = props;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const id = useId();
  const bodyId = `tool-group-body-${id}`;
  const summaryId = `tool-group-summary-${id}`;
  const [userCollapsedWhileRunning, setUserCollapsedWhileRunning] = useState(false);
  const [settledExpanded, setSettledExpanded] = useState(defaultExpanded);
  const { measuredHeight, measuredElementRef } = useMeasuredElementHeight<HTMLDivElement>();
  const running = status === "running";
  const children = renderChildren?.();
  const hasContent = children != null;
  const expanded =
    hasContent &&
    (running && expandWhileRunning
      ? !userCollapsedWhileRunning
      : (controlledExpanded ?? settledExpanded));

  const toggle = () => {
    if (!expanded) onExpand?.();
    if (running && expandWhileRunning) {
      setUserCollapsedWhileRunning((collapsed) => !collapsed);
    } else {
      setSettledExpanded(!expanded);
      onToggle?.(!expanded);
    }
  };

  return (
    <div
      className="relative min-w-0 overflow-visible py-0 text-size-chat"
      style={{ fontSize: `${fontSizePx}px` }}
      data-tool-group-disclosure="true"
      data-tool-group-phase={expanded ? "expanded" : "collapsed"}
    >
      <div className="flex min-w-0 flex-col">
        <div
          className="group/activity-header relative inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-start"
          data-tool-group-header="true"
        >
          {hasContent && (
            <button
              type="button"
              aria-labelledby={summaryId}
              aria-expanded={expanded}
              aria-controls={bodyId}
              data-tool-group-trigger="true"
              className="absolute inset-0 cursor-interaction rounded-md bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:ring-inset"
              onClick={toggle}
            />
          )}
          <span className="pointer-events-none relative inline-flex min-w-0 shrink items-center gap-1.5 truncate text-size-chat [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
            <span className="contents text-text/60" aria-hidden>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {leadingIcon}
              </span>
            </span>
            <span
              id={summaryId}
              className={cn(
                "min-w-0 flex-1 truncate text-text/60 [&_[data-conversation-shimmer]]:align-top [&_*:not(button)]:!text-text/60",
                hasContent && SUMMARY_HOVER_CLASS_NAME,
              )}
            >
              <ConversationShimmer
                active={running && shimmerLabel}
                data-tool-group-summary="true"
                className={SUMMARY_CLASS_NAME}
              >
                {label}
              </ConversationShimmer>
            </span>
          </span>
          {hasContent && (
            <span className="pointer-events-none relative flex">
              <ChevronRightIcon
                aria-hidden="true"
                data-tool-group-chevron="true"
                className={disclosureChevronClassName(
                  expanded,
                  cn(
                    "icon-2xs size-3.5 shrink-0 text-text/60 opacity-0",
                    CONVERSATION_DISCLOSURE_CHEVRON_CLASS,
                    "group-focus-visible/activity-header:opacity-100 group-focus-visible/activity-header:text-default",
                    "activity-header-focus:opacity-100 activity-header-focus:text-default",
                    "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:opacity-100",
                    expanded && "opacity-100",
                  ),
                )}
              />
            </span>
          )}
        </div>
        {hasContent && (
          <motion.div
            id={bodyId}
            data-tool-group-body="true"
            initial={false}
            animate={{ height: expanded ? measuredHeight : 0, opacity: expanded ? 1 : 0 }}
            transition={conversationDisclosureTransition(reducedMotion)}
            aria-hidden={!expanded}
            inert={!expanded}
            className={expanded ? "overflow-visible" : "overflow-hidden"}
            style={{ pointerEvents: expanded ? "auto" : "none" }}
          >
            <div
              ref={measuredElementRef}
              data-tool-group-content="true"
              className={toolActivityBodyClassName(bodyVariant, indentContent)}
            >
              {children}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
