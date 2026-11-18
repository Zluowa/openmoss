// FILE: AgentRuntimePreparingPanel.tsx
// Purpose: Shown on top of the composer while the agent this chat needs is still downloading in a
//          `download` build: progress with time left, what went wrong with 重试, and the message
//          the person already sent, which goes out by itself once the agent is ready.
// Layer: Chat composer UI
// Exports: AgentRuntimePreparingPanel

import type { DesktopAgentRuntimeState } from "@moss/contracts";

import { describeAgentRuntimePreparation } from "~/lib/agentRuntimePreparation";
import { CircleAlertIcon, ClockIcon, Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { Button } from "../ui/button";

import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
  ComposerStackedPanel,
} from "./ComposerStackedPanel";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

export function AgentRuntimePreparingPanel({
  state,
  held,
  onRetry,
  onCancelHeld,
  attachedToPrevious = false,
}: {
  state: DesktopAgentRuntimeState;
  /** The person's message waits for the agent and is sent by itself. */
  held: boolean;
  onRetry: () => void;
  onCancelHeld: () => void;
  attachedToPrevious?: boolean;
}) {
  const { format } = useTranslation();
  const text = describeAgentRuntimePreparation(state, format);
  const message = format(text.key, text.values);
  const problem = text.tone === "problem";
  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious} className="flex flex-col">
      <ComposerStackedPanelRow
        role="status"
        aria-live="polite"
        data-testid="agent-runtime-preparing"
        data-agent-runtime-phase={state.phase}
        className={problem ? "bg-warning/8" : undefined}
      >
        <ComposerStackedPanelRowMain className="flex-col items-stretch gap-1.5">
          <span className="flex min-w-0 items-center gap-2">
            {problem ? (
              <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />
            ) : (
              <Loader2Icon
                aria-hidden
                className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")}
              />
            )}
            <span className="min-w-0 text-ui-sm text-muted-foreground" title={message}>
              {message}
            </span>
          </span>
          {text.percent !== null && !problem ? (
            <span
              className="relative ml-6 h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={text.percent}
              aria-label={message}
              data-testid="agent-runtime-progress"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground"
                style={{ width: `max(${text.percent}%, 6px)` }}
              />
            </span>
          ) : null}
        </ComposerStackedPanelRowMain>
        {text.canRetry ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {format("agentRuntime.retry", {})}
            </Button>
          </div>
        ) : null}
      </ComposerStackedPanelRow>
      {held ? (
        <ComposerStackedPanelRow
          compact
          data-testid="agent-runtime-held-send"
          className={COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME}
        >
          <ComposerStackedPanelRowMain>
            <ClockIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
            <span className="min-w-0 truncate text-ui-sm text-muted-foreground">
              {format("agentRuntime.held", {})}
            </span>
          </ComposerStackedPanelRowMain>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={onCancelHeld}>
              {format("agentRuntime.held.cancel", {})}
            </Button>
          </div>
        </ComposerStackedPanelRow>
      ) : null}
    </ComposerStackedPanel>
  );
}
