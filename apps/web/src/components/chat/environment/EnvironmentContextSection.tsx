// FILE: EnvironmentContextSection.tsx
// Purpose: The Environment card's "Context" line, ported from the upstream thread-details
//          card: label, a 3px usage bar and "64k / 500k", with the exact token counts in
//          a tooltip. It shows only what the provider reported for this thread; with no
//          report there is no line at all, never a placeholder number.
// Layer: Environment panel section
// Exports: EnvironmentContextSection, resolveEnvironmentContextUsage

import { formatContextWindowTokens, type ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export interface EnvironmentContextUsage {
  /** Rounded 0–100, or null when the window size is unknown. */
  readonly percent: number | null;
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly tone: "error" | "warning" | null;
  /** "64k / 500k", or "64k" when the window size is unknown. */
  readonly value: string;
}

export function resolveEnvironmentContextUsage(
  usage: ContextWindowSnapshot | null,
): EnvironmentContextUsage | null {
  if (!usage) return null;
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const percent =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const used = formatContextWindowTokens(usage.usedTokens);
  return {
    percent,
    usedTokens: usage.usedTokens,
    maxTokens,
    tone: percent === null ? null : percent >= 90 ? "error" : percent >= 80 ? "warning" : null,
    value: maxTokens === null ? used : `${used} / ${formatContextWindowTokens(maxTokens)}`,
  };
}

export function EnvironmentContextSection({ usage }: { usage: ContextWindowSnapshot | null }) {
  const { format, t } = useTranslation();
  const resolved = resolveEnvironmentContextUsage(usage);
  if (!resolved) return null;
  const label = t("chat.environment.context");
  const summary =
    resolved.percent === null
      ? format("chat.environment.contextUsedTokens", {
          tokens: formatContextWindowTokens(resolved.usedTokens),
        })
      : format("chat.environment.contextUsedPercent", { percent: String(resolved.percent) });
  return (
    <div
      className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-ui-sm"
      data-environment-context
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              aria-label={`${label}: ${resolved.value}`}
              className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-row px-2.5 outline-none hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
            />
          }
        >
          <span className="max-w-28 truncate text-muted-foreground">{label}</span>
          {resolved.percent !== null ? (
            <span
              className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={resolved.percent}
              aria-label={summary}
            >
              {resolved.percent > 0 ? (
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    resolved.tone === "error"
                      ? "bg-destructive"
                      : resolved.tone === "warning"
                        ? "bg-warning"
                        : "bg-muted-foreground",
                  )}
                  style={{ width: `max(${resolved.percent}%, 6px)` }}
                />
              ) : null}
            </span>
          ) : null}
          <span
            className={cn(
              "text-end font-medium tabular-nums",
              resolved.percent === null && "col-span-2",
              resolved.tone === "error"
                ? "text-destructive-foreground"
                : resolved.tone === "warning"
                  ? "text-warning-foreground"
                  : resolved.percent === null
                    ? "text-muted-foreground"
                    : "text-[var(--color-text-foreground)]/80",
            )}
          >
            {resolved.value}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" sideOffset={16}>
          <div className="flex flex-col gap-0.5">
            <span>{summary}</span>
            {resolved.maxTokens !== null ? (
              <span className="text-muted-foreground">
                {format("chat.environment.contextTokensOf", {
                  used: resolved.usedTokens.toLocaleString("en-US"),
                  max: resolved.maxTokens.toLocaleString("en-US"),
                })}
              </span>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
