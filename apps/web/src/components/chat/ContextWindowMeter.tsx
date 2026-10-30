import {
  CONTEXT_WINDOW_METER_GEOMETRY,
  type ContextWindowSnapshot,
  contextWindowMeterSectorPath,
  deriveContextWindowMeterDisplay,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { useTranslation } from "~/localization";
import { useState } from "react";
import { useNowMs } from "~/hooks/useNowMs";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ClaudeCacheDetails } from "./ClaudeCacheDetails";
import { Button } from "../ui/button";

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
  showClaudeCache?: boolean;
  onOpenChange?: (open: boolean) => void;
  compactAction?: {
    disabledReason: string | null;
    isSubmitting: boolean;
    onCompact: () => Promise<boolean>;
  };
}) {
  const { format, t } = useTranslation();
  const { usage, cumulativeCostUsd, activeWindowLabel, pendingWindowLabel } = props;
  const [open, setOpen] = useState(false);
  const nowMs = useNowMs(open && usage.claudeCache != null, 10_000);
  const display = deriveContextWindowMeterDisplay(usage);
  // Never an empty dial once anything is used: a sliver keeps "some" distinct from "none".
  const sectorPath = contextWindowMeterSectorPath(
    display.normalizedPercentage > 0 ? Math.max(display.normalizedPercentage, 4) : 0,
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        props.onOpenChange?.(nextOpen);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-opacity hover:opacity-80"
            aria-label={
              display.usedPercentageLabel
                ? format("chat.contextWindow.aria.percentage", {
                    percentage: display.usedPercentageLabel,
                  })
                : format("chat.contextWindow.aria.tokens", { tokens: display.tokenUsageLabel })
            }
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <svg
                viewBox="0 0 16 16"
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
                data-context-window-meter-glyph=""
              >
                <circle
                  cx={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  cy={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  r={CONTEXT_WINDOW_METER_GEOMETRY.outlineRadius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="text-muted-foreground/45 dark:text-muted-foreground/55"
                />
                {/* The faint disc is the remaining window, so the sector reads as a share of it. */}
                <circle
                  cx={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  cy={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  r={CONTEXT_WINDOW_METER_GEOMETRY.pieRadius}
                  fill="currentColor"
                  className="text-muted-foreground/20 dark:text-muted-foreground/30"
                />
                {sectorPath ? (
                  <path
                    d={sectorPath}
                    fill="currentColor"
                    className="text-primary dark:text-[var(--color-text-foreground)]"
                  />
                ) : null}
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-ui-sm font-medium text-muted-foreground">
            {t("chat.contextWindow.title")}
          </div>
          {pendingWindowLabel ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {format("chat.contextWindow.currentSession", {
                window: activeWindowLabel ?? t("chat.contextWindow.unknown"),
              })}
            </div>
          ) : null}
          {display.usedPercentageLabel ? (
            <div className="whitespace-nowrap text-ui leading-snug font-medium text-foreground">
              <span>{display.usedPercentageLabel}</span>
              {display.hasReliableTokenRatio ? (
                <>
                  <span className="mx-1">⋅</span>
                  <span>{display.tokenUsageLabel}</span>
                  <span>/</span>
                  <span>
                    {formatContextWindowTokens(usage.maxTokens)}{" "}
                    {t("chat.contextWindow.contextUsed")}
                  </span>
                </>
              ) : (
                <span className="ml-1">{t("chat.contextWindow.contextUsed")}</span>
              )}
            </div>
          ) : (
            <div className="text-ui leading-snug text-foreground">
              {format("chat.contextWindow.tokensUsedSoFar", { tokens: display.tokenUsageLabel })}
            </div>
          )}
          {usage.maxTokens !== null ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {format("chat.contextWindow.modelWindow", {
                tokens: formatContextWindowTokens(usage.maxTokens),
              })}
            </div>
          ) : null}
          {props.showClaudeCache && activeWindowLabel ? (
            <div className="max-w-72 space-y-1 text-ui leading-snug text-muted-foreground">
              <div>Auto-compact target: {activeWindowLabel}</div>
              <p className="leading-relaxed">
                The session's auto-compact target can be lower than the model's supported window.
              </p>
            </div>
          ) : null}
          {pendingWindowLabel ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {format("chat.contextWindow.nextTurn", { window: pendingWindowLabel })}
            </div>
          ) : null}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {format("chat.contextWindow.totalProcessed", {
                tokens: formatContextWindowTokens(usage.totalProcessedTokens ?? null),
              })}
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {t("chat.contextWindow.compactsAutomatically")}
            </div>
          ) : null}
          {cumulativeCostUsd !== null && cumulativeCostUsd !== undefined ? (
            <div className="text-ui leading-snug text-muted-foreground">
              {format("chat.contextWindow.sessionCost", { cost: formatCostUsd(cumulativeCostUsd) })}
            </div>
          ) : null}
          {usage.claudeCache || props.showClaudeCache ? (
            <ClaudeCacheDetails observation={usage.claudeCache ?? undefined} nowMs={nowMs} />
          ) : null}
          {props.compactAction ? (
            <div className="max-w-72 space-y-1.5 border-t border-border/50 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  props.compactAction.disabledReason !== null || props.compactAction.isSubmitting
                }
                onClick={() => {
                  void props.compactAction?.onCompact();
                }}
              >
                {props.compactAction.isSubmitting ? "Starting compaction..." : "Compact now"}
              </Button>
              <p className="text-ui leading-relaxed text-muted-foreground">
                {props.compactAction.disabledReason ??
                  "Compaction processes this conversation and consumes usage. Later turns use its summary."}
              </p>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
