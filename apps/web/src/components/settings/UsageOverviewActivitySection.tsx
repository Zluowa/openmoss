// FILE: UsageOverviewActivitySection.tsx
// Purpose: Settings → Usage & limits Overview section showing a 7d/30d daily activity chart
//          and per-product / top-model usage breakdown bars (Claude & ChatGPT style).
// Layer: Settings UI components
// Exports: UsageOverviewActivitySection

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useMossPayQuotaQuery } from "~/components/auth/useMossPayQuotaQuery";
import { ProviderIcon } from "~/components/ProviderIcon";
import { formatCompact, formatNumber } from "~/components/profile/profileFormatting";
import { SegmentedPicker } from "~/components/SegmentedPicker";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ChevronRightIcon, CircleAlertIcon, ImageIcon, MicIcon } from "~/lib/icons";
import { serverUsageAnalyticsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { buildUsageBreakdownRows } from "./mossUsagePresentation.logic";
import { SettingsCard, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { ChartLegend, DailyBarChart } from "./UsageAnalyticsCharts";
import {
  buildUsageAnalyticsView,
  localDayKey,
  PROVIDER_SERIES_COLOR,
  type UsageAnalyticsProvider,
  usageAnalyticsWindow,
} from "./usageAnalytics.logic";

type OverviewRange = "7d" | "30d";

function ProductMark(props: {
  readonly kind: "provider" | "media" | "voice";
  readonly provider?: UsageAnalyticsProvider | undefined;
}) {
  if (props.kind === "media") {
    return <ImageIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (props.kind === "voice") {
    return <MicIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (!props.provider || props.provider === "unknown") {
    return (
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ background: PROVIDER_SERIES_COLOR.unknown }}
      />
    );
  }
  return <ProviderIcon provider={props.provider} className="size-3.5 shrink-0" />;
}

export function UsageOverviewActivitySection({
  onOpenAnalytics,
}: {
  readonly onOpenAnalytics?: (() => void) | undefined;
}) {
  const { format: formatText, locale, t } = useTranslation();
  const [range, setRange] = useState<OverviewRange>("7d");
  const [hidden, setHidden] = useState<ReadonlySet<UsageAnalyticsProvider>>(() => new Set());
  const { quota } = useMossPayQuotaQuery();

  const todayKey = localDayKey(new Date());
  const windows = useMemo(() => {
    const noon = new Date(`${todayKey}T12:00:00`);
    return {
      "7d": usageAnalyticsWindow("7d", noon),
      "30d": usageAnalyticsWindow("30d", noon),
    };
  }, [todayKey]);

  const activeWindow = windows[range];
  const analyticsQuery = useQuery(
    serverUsageAnalyticsQueryOptions({
      from: (activeWindow.previousFrom ?? activeWindow.from).toISOString(),
      to: activeWindow.to.toISOString(),
      scope: "moss",
    }),
  );

  const data = analyticsQuery.data;
  const dataWindow = useMemo(() => {
    if (!data) return activeWindow;
    const matched = Object.values(windows).find((candidate) => {
      const from = (candidate.previousFrom ?? candidate.from).toISOString();
      return from === data.from && candidate.to.toISOString() === data.to;
    });
    return matched ?? activeWindow;
  }, [activeWindow, data, windows]);

  const view = useMemo(
    () => (data ? buildUsageAnalyticsView(data, dataWindow) : null),
    [data, dataWindow],
  );
  const breakdown = useMemo(
    () =>
      view
        ? buildUsageBreakdownRows({
            view,
            otherLabel: t("settings.usage.analytics.otherProvider"),
            mediaLabel: t("settings.usage.activity.mediaProduct"),
            voiceLabel: t("settings.usage.activity.voiceProduct"),
            realtimeSessionsUsed: quota?.realtimeConfigured ? quota.realtimeSessionsUsed : 0,
            maxModels: 5,
          })
        : null,
    [quota?.realtimeConfigured, quota?.realtimeSessionsUsed, t, view],
  );

  const formatTokens = (value: number) => formatCompact(value, locale);
  const legendProviders = useMemo(
    () =>
      view
        ? view.providers.filter((provider) => provider.tokens > 0).map((entry) => entry.provider)
        : [],
    [view],
  );
  const seriesProviders = useMemo(
    () => legendProviders.filter((provider) => !hidden.has(provider)),
    [hidden, legendProviders],
  );
  const toggleProvider = (provider: UsageAnalyticsProvider) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });

  const rangeDays = range === "7d" ? 7 : 30;
  const hasActivity = Boolean(
    view &&
    (view.totals.tokens > 0 ||
      view.totals.turns > 0 ||
      (breakdown && breakdown.products.length > 0)),
  );

  return (
    <SettingsSectionShell
      title={t("settings.usage.activity.title")}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div data-testid="usage-overview-range-picker">
            <SegmentedPicker<OverviewRange>
              ariaLabel={t("settings.usage.activity.rangeLabel")}
              className="w-32"
              onValueChange={setRange}
              options={[
                { value: "7d", label: t("settings.usage.analytics.range.7d") },
                { value: "30d", label: t("settings.usage.analytics.range.30d") },
              ]}
              value={range}
            />
          </div>
          {onOpenAnalytics ? (
            <Button
              data-testid="usage-overview-open-analytics"
              onClick={onOpenAnalytics}
              size="xs"
              variant="ghost"
            >
              {t("settings.usage.activity.viewAnalytics")}
              <ChevronRightIcon aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
        </div>
      }
    >
      {analyticsQuery.isPending && !view ? (
        <SettingsCard divided={false}>
          <div
            aria-busy="true"
            className="space-y-4 px-4 py-4"
            data-testid="usage-overview-activity-skeleton"
            role="status"
          >
            <div className="grid grid-cols-3 gap-4">
              <Skeleton className="h-10 w-full rounded-control" />
              <Skeleton className="h-10 w-full rounded-control" />
              <Skeleton className="h-10 w-full rounded-control" />
            </div>
            <Skeleton className="h-36 w-full rounded-control" />
          </div>
        </SettingsCard>
      ) : analyticsQuery.isError && !view ? (
        <SettingsCard divided={false}>
          <div
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"
            data-testid="usage-overview-activity-error"
            role="status"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-sm text-muted-foreground">
              <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
              <span>{t("settings.usage.activity.loadFailed")}</span>
            </div>
            <Button
              disabled={analyticsQuery.isFetching}
              onClick={() => void analyticsQuery.refetch()}
              size="xs"
              variant="outline"
            >
              {t("mossPay.quota.retry")}
            </Button>
          </div>
        </SettingsCard>
      ) : !view || !hasActivity ? (
        <SettingsCard divided={false}>
          <div className="space-y-1 px-4 py-5" data-testid="usage-overview-activity-empty">
            <p className="text-ui font-medium text-foreground">
              {formatText("settings.usage.activity.emptyTitle", { days: rangeDays })}
            </p>
          </div>
        </SettingsCard>
      ) : (
        <div
          aria-busy={analyticsQuery.isPlaceholderData}
          className={cn(
            "space-y-3 transition-opacity duration-150 motion-reduce:transition-none",
            analyticsQuery.isPlaceholderData && "opacity-60",
          )}
          data-testid="usage-overview-activity-content"
        >
          <SettingsCard divided={false}>
            <div className="space-y-4 px-4 py-4">
              <div className="grid grid-cols-3 gap-3 border-b border-[color:var(--color-border)] pb-3.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-ui-xs text-muted-foreground">
                    {t("settings.usage.activity.turns")}
                  </p>
                  <p className="text-ui-lg font-medium text-foreground tabular-nums">
                    {formatNumber(view.totals.turns)}
                  </p>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-ui-xs text-muted-foreground">
                    {t("settings.usage.activity.tokens")}
                  </p>
                  <p className="text-ui-lg font-medium text-foreground tabular-nums">
                    {formatTokens(view.totals.tokens)}
                  </p>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-ui-xs text-muted-foreground">
                    {t("settings.usage.activity.activeDays")}
                  </p>
                  <p className="text-ui-lg font-medium text-foreground tabular-nums">
                    {formatText("settings.usage.analytics.activeDaysOf", {
                      active: view.activeDays,
                      total: dataWindow.days.length,
                    })}
                  </p>
                </div>
              </div>

              {legendProviders.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ui-sm font-medium text-foreground">
                    {t("settings.usage.analytics.dailyTokens")}
                  </span>
                  <ChartLegend
                    hidden={hidden}
                    onToggle={toggleProvider}
                    providers={legendProviders}
                  />
                </div>
              ) : null}

              <DailyBarChart
                days={view.days}
                format={formatTokens}
                height={156}
                metric="tokens"
                providers={seriesProviders}
                width={520}
              />
            </div>
          </SettingsCard>

          {breakdown && (breakdown.products.length > 0 || breakdown.models.length > 0) ? (
            <SettingsCard divided={false}>
              <div className="divide-y divide-[color:var(--color-border)]">
                {breakdown.products.length > 0 ? (
                  <div className="space-y-3 px-4 py-4" data-testid="usage-breakdown-products">
                    <h3 className="text-ui-sm font-medium text-foreground">
                      {t("settings.usage.activity.byProduct")}
                    </h3>
                    <ul className="space-y-2.5">
                      {breakdown.products.map((row) => (
                        <li
                          className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-3"
                          key={row.id}
                        >
                          <span className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground">
                            <ProductMark kind={row.kind} provider={row.provider} />
                            <span className="truncate">{row.label}</span>
                          </span>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
                            <div
                              className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                              style={{
                                width: `${Math.max(row.percent > 0 ? 2 : 0, Math.min(100, row.percent))}%`,
                                background: row.color,
                              }}
                            />
                          </div>
                          <span className="min-w-14 text-right text-ui-xs text-muted-foreground tabular-nums">
                            {row.sessions !== undefined
                              ? formatText("settings.usage.activity.sessionsCount", {
                                  count: formatNumber(row.sessions),
                                })
                              : `${row.percent}%`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {breakdown.models.length > 0 ? (
                  <div className="space-y-3 px-4 py-4" data-testid="usage-breakdown-models">
                    <h3 className="text-ui-sm font-medium text-foreground">
                      {t("settings.usage.activity.byModel")}
                    </h3>
                    <ul className="space-y-2.5">
                      {breakdown.models.map((row) => (
                        <li
                          className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3"
                          key={row.id}
                        >
                          <span
                            className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground"
                            title={row.model}
                          >
                            <ProductMark kind="provider" provider={row.provider} />
                            <span className="truncate">{row.model}</span>
                          </span>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]">
                            <div
                              className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                              style={{
                                width: `${Math.max(row.percent > 0 ? 2 : 0, Math.min(100, row.percent))}%`,
                                background: row.color,
                              }}
                            />
                          </div>
                          <span className="min-w-20 text-right text-ui-xs text-muted-foreground tabular-nums">
                            {formatTokens(row.tokens)} · {row.percent}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </SettingsCard>
          ) : null}
        </div>
      )}
    </SettingsSectionShell>
  );
}
