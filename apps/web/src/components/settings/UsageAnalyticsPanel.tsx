// FILE: UsageAnalyticsPanel.tsx
// Purpose: Settings → Usage → Analytics: cost and tokens by day, provider, model, and
//          project, plus cache use, turn origin, and weekly rhythm. "In Moss" uses
//          Moss's own records; "This computer" also reads Claude Code and Codex
//          session files. Cost is at API rates: the provider's own figure when it
//          reports one, else the tokens at API list prices.
// Layer: Web settings feature
// Exports: UsageAnalyticsPanel

import type { StatsUsageAnalyticsScope } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";

import { serverUsageAnalyticsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { type TranslationKey, useTranslation } from "~/localization";
import { formatCompact, formatNumber } from "../profile/profileFormatting";
import { InsightRow, ModelUsageRow, StatTileGrid } from "../profile/ProfileStatRows";
import { SegmentedPicker } from "../SegmentedPicker";
import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { ChartLegend, DailyBarChart, ProviderLineChart, RhythmChart } from "./UsageAnalyticsCharts";
import {
  buildUsageAnalyticsView,
  localDayKey,
  percentChange,
  PROVIDER_SERIES_COLOR,
  providerLabel,
  type UsageAnalyticsMetric,
  type UsageAnalyticsProvider,
  type UsageAnalyticsProviderTotal,
  type UsageAnalyticsRange,
  type UsageAnalyticsView,
  type UsageAnalyticsWindow,
  usageAnalyticsWindow,
} from "./usageAnalytics.logic";
import { SettingsCard, SettingsListRow } from "./SettingsPanelPrimitives";

const RANGES: ReadonlyArray<UsageAnalyticsRange> = ["7d", "30d", "90d", "1y"];

const RANGE_LABEL_KEYS: Record<UsageAnalyticsRange, TranslationKey> = {
  "7d": "settings.usage.analytics.range.7d",
  "30d": "settings.usage.analytics.range.30d",
  "90d": "settings.usage.analytics.range.90d",
  "1y": "settings.usage.analytics.range.1y",
};

/** The server request for a window: it includes the period before, when fetched. */
function analyticsRequest(window: UsageAnalyticsWindow, scope: StatsUsageAnalyticsScope) {
  return {
    from: (window.previousFrom ?? window.from).toISOString(),
    to: window.to.toISOString(),
    scope,
  };
}

/** USD at API rates, in the interface language. */
function useMoneyFormat() {
  const { locale } = useTranslation();
  return useMemo(() => {
    const usd = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
    });
    return {
      full: (value: number) => usd.format(value),
      /** Axis and tooltip money: whole dollars once amounts are large. */
      short: (value: number) => {
        if (value >= 1000) return `$${formatCompact(value, locale)}`;
        if (value >= 10) return `$${Math.round(value)}`;
        return usd.format(value);
      },
    };
  }, [locale]);
}

/** A section heading with a one-line explanation and an optional control on the right. */
function SectionTitle(props: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-ui-lg font-medium text-foreground">{props.title}</h3>
        {props.detail ? <p className="text-ui text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.action}
    </div>
  );
}

function ChangeLabel(props: { change: number | null }) {
  const { format } = useTranslation();
  if (props.change === null) return null;
  const up = props.change >= 0;
  return (
    <span className={cn("text-ui-sm", up ? "text-info" : "text-muted-foreground")}>
      {format("settings.usage.analytics.change", {
        arrow: up ? "↑" : "↓",
        percent: Math.abs(props.change),
      })}
    </span>
  );
}

function ShareBar(props: { share: number; color: string }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.07]">
      <div
        className="h-1 rounded-full"
        style={{ width: `${Math.max(0, Math.min(100, props.share))}%`, background: props.color }}
      />
    </div>
  );
}

/** The provider's icon; a neutral dot when the provider is unknown. */
function ProviderMark(props: { provider: UsageAnalyticsProvider }) {
  return props.provider === "unknown" ? (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ background: PROVIDER_SERIES_COLOR.unknown }}
    />
  ) : (
    <ProviderIcon provider={props.provider} className="size-3.5 shrink-0" />
  );
}

function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export function UsageAnalyticsPanel() {
  const { t } = useTranslation();
  const [range, setRange] = useState<UsageAnalyticsRange>("30d");
  const [metricChoice, setMetricChoice] = useState<UsageAnalyticsMetric | null>(null);
  const [scope, setScope] = useState<StatsUsageAnalyticsScope>("moss");
  const todayKey = localDayKey(new Date());
  // Recomputed once a day so the query keys stay stable within a day.
  const windows = useMemo(() => {
    const noon = new Date(`${todayKey}T12:00:00`);
    return new Map(RANGES.map((option) => [option, usageAnalyticsWindow(option, noon)]));
  }, [todayKey]);
  const window = windows.get(range) ?? usageAnalyticsWindow(range, new Date());
  const query = useQuery(serverUsageAnalyticsQueryOptions(analyticsRequest(window, scope)));
  // While a new period loads, the previous result stays on screen with its own
  // window, so its numbers are never laid over the new period's days.
  const data = query.data;
  const dataWindow = useMemo(() => {
    if (!data) return window;
    return (
      [...windows.values()].find((candidate) => {
        const request = analyticsRequest(candidate, data.scope);
        return request.from === data.from && request.to === data.to;
      }) ?? window
    );
  }, [data, window, windows]);
  const view = useMemo(
    () => (data ? buildUsageAnalyticsView(data, dataWindow) : null),
    [data, dataWindow],
  );
  const loadingNewPeriod = query.isPlaceholderData;
  const metric: UsageAnalyticsMetric =
    metricChoice ?? (view && view.totals.costUsd > 0 ? "cost" : "tokens");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedPicker<UsageAnalyticsMetric>
            ariaLabel={t("settings.usage.analytics.metric")}
            className="w-36"
            value={metric}
            onValueChange={setMetricChoice}
            options={[
              { value: "cost", label: t("settings.usage.analytics.metric.cost") },
              { value: "tokens", label: t("settings.usage.analytics.metric.tokens") },
            ]}
          />
          <SegmentedPicker<UsageAnalyticsRange>
            ariaLabel={t("settings.usage.analytics.period")}
            className="w-60"
            value={range}
            onValueChange={setRange}
            options={RANGES.map((option) => ({
              value: option,
              label: t(RANGE_LABEL_KEYS[option]),
            }))}
          />
        </div>
        <SegmentedPicker<StatsUsageAnalyticsScope>
          ariaLabel={t("settings.usage.analytics.scope")}
          className="w-60"
          value={scope}
          onValueChange={setScope}
          options={[
            { value: "moss", label: t("settings.usage.analytics.scope.moss") },
            { value: "computer", label: t("settings.usage.analytics.scope.computer") },
          ]}
        />
      </div>
      {query.isError && !view ? (
        <SettingsCard>
          <SettingsListRow
            title={t("settings.usage.analytics.loadFailed")}
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("settings.usage.analytics.retry")}
              </Button>
            }
          />
        </SettingsCard>
      ) : !view ? (
        <SettingsCard>
          <SettingsListRow title={t("settings.usage.analytics.loading")} />
        </SettingsCard>
      ) : view.totals.tokens === 0 && view.totals.costUsd === 0 && view.totals.turns === 0 ? (
        <SettingsCard>
          <SettingsListRow
            title={t("settings.usage.analytics.empty.title")}
            description={t(
              scope === "computer"
                ? "settings.usage.analytics.empty.computer"
                : "settings.usage.analytics.empty.moss",
            )}
          />
        </SettingsCard>
      ) : (
        <div
          aria-busy={loadingNewPeriod}
          className={cn(
            "transition-opacity duration-150 motion-reduce:transition-none",
            loadingNewPeriod && "opacity-50",
          )}
        >
          <UsageAnalyticsBody view={view} metric={metric} rangeDays={dataWindow.days.length} />
        </div>
      )}
    </div>
  );
}

function UsageAnalyticsBody(props: {
  view: UsageAnalyticsView;
  metric: UsageAnalyticsMetric;
  rangeDays: number;
}) {
  const { view, metric } = props;
  const { t, format: formatText, locale } = useTranslation();
  const money = useMoneyFormat();
  const [hidden, setHidden] = useState<ReadonlySet<UsageAnalyticsProvider>>(() => new Set());
  const otherLabel = t("settings.usage.analytics.otherProvider");
  const nameOf = (provider: UsageAnalyticsProvider) => providerLabel(provider, otherLabel);
  const formatTokens = (value: number) => formatCompact(value, locale);
  const format = metric === "cost" ? money.short : formatTokens;
  const valueOf = (amount: { tokens: number; costUsd: number }) =>
    metric === "cost" ? amount.costUsd : amount.tokens;
  const total = valueOf(view.totals);
  const providers = view.providers.filter((provider) => valueOf(provider) > 0);
  const legendProviders = providers.map((provider) => provider.provider);
  const seriesProviders = legendProviders.filter((provider) => !hidden.has(provider));
  const toggleProvider = (provider: UsageAnalyticsProvider) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  const legend = (
    <ChartLegend providers={legendProviders} hidden={hidden} onToggle={toggleProvider} />
  );
  const peakDay = view.days.reduce<(typeof view.days)[number] | null>(
    (best, day) => (!best || valueOf(day) > valueOf(best) ? day : best),
    null,
  );
  const weekdays = view.days.filter((day) => day.date.getDay() !== 0 && day.date.getDay() !== 6);
  const weekdayAverage = weekdays.length
    ? weekdays.reduce((sum, day) => sum + valueOf(day), 0) / weekdays.length
    : 0;
  const listSeparator = t("settings.usage.analytics.listSeparator");
  const providerNames = (source: UsageAnalyticsProviderTotal["costSource"]) =>
    view.providers
      .filter(
        (provider) =>
          provider.costSource === source &&
          (provider.tokens > 0 || provider.costUsd > 0) &&
          provider.provider !== "unknown",
      )
      .map((provider) => nameOf(provider.provider))
      .join(listSeparator);
  const reportedNames = providerNames("reported");
  const estimatedNames = providerNames("estimated");
  // Providers with unpriced tokens are explained by the notes about those tokens.
  const tokenOnlyNames = view.providers
    .filter(
      (provider) =>
        provider.costSource === null &&
        provider.tokens > 0 &&
        provider.provider !== "unknown" &&
        !view.unpriced.providers.has(provider.provider),
    )
    .map((provider) => nameOf(provider.provider))
    .join(listSeparator);
  const shortDate = (date: Date) =>
    date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const pricesUpdated = view.pricing.fetchedAt ? shortDate(new Date(view.pricing.fetchedAt)) : null;
  const originTotal = view.origins.user + view.origins.automation + view.origins.agent;
  // Ranked by the metric on screen, so "Cost" shows the most expensive first.
  const byMetric = <T extends { tokens: number; costUsd: number }>(left: T, right: T) =>
    valueOf(right) - valueOf(left) || right.tokens - left.tokens;
  const models = view.models.toSorted(byMetric);
  const projects = view.projects.filter((project) => valueOf(project) > 0).toSorted(byMetric);
  const modelMax = Math.max(1, ...models.map((model) => valueOf(model)));
  const projectTotal = projects.reduce((sum, project) => sum + valueOf(project), 0);
  const modelGrid =
    "grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-center gap-3 px-3 @md:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_5.5rem] @xl:grid-cols-[minmax(0,1fr)_4rem_5rem_6rem_6rem]";

  return (
    // Layout follows the settings column, not the window: the sidebar takes a
    // varying share of the window.
    <div className="@container flex flex-col gap-12">
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-8 @3xl:flex-row @3xl:gap-10">
          <div className="flex flex-col gap-1.5 @3xl:w-60 @3xl:shrink-0">
            <span className="text-ui-sm text-muted-foreground">
              {t(
                metric === "cost"
                  ? "settings.usage.analytics.apiCost"
                  : "settings.usage.analytics.tokensProcessed",
              )}
            </span>
            <span className="text-title font-medium text-foreground tabular-nums">
              {metric === "cost" ? money.full(total) : formatNumber(total)}
            </span>
            <ChangeLabel
              change={
                // Claude Code deletes old session files, so an earlier period on
                // this computer can look emptier than it was.
                view.scope === "computer"
                  ? null
                  : percentChange(total, view.previous ? valueOf(view.previous) : null)
              }
            />
            <span className="text-ui-sm text-muted-foreground">
              {metric === "cost"
                ? t("settings.usage.analytics.costNote")
                : formatText("settings.usage.analytics.cacheNote", {
                    tokens: formatTokens(view.totals.cacheReadTokens),
                  })}
            </span>
            <ul className="mt-4 flex flex-col gap-3.5">
              {providers.map((provider) => (
                <ModelUsageRow
                  key={provider.provider}
                  icon={<ProviderMark provider={provider.provider} />}
                  model={nameOf(provider.provider)}
                  detail={formatText("settings.usage.analytics.turnsCount", {
                    count: formatNumber(provider.turns),
                  })}
                  percent={percentOf(valueOf(provider), total)}
                  stat={`${format(valueOf(provider))} · ${percentOf(valueOf(provider), total)}%`}
                  barColor={PROVIDER_SERIES_COLOR[provider.provider]}
                />
              ))}
            </ul>
          </div>
          <div className="@container/daily flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ui font-medium text-foreground">
                {t(
                  metric === "cost"
                    ? "settings.usage.analytics.dailyCost"
                    : "settings.usage.analytics.dailyTokens",
                )}
              </span>
              {legend}
            </div>
            <DailyBarChart
              days={view.days}
              providers={seriesProviders}
              metric={metric}
              format={format}
              width={540}
              height={200}
            />
            <dl className="grid gap-x-6 gap-y-1.5 border-t pt-3 @md/daily:grid-cols-3">
              <InsightRow
                label={t("settings.usage.analytics.peakDay")}
                value={
                  peakDay && valueOf(peakDay) > 0
                    ? `${shortDate(peakDay.date)} · ${format(valueOf(peakDay))}`
                    : "—"
                }
              />
              <InsightRow
                label={t("settings.usage.analytics.weekdayAverage")}
                value={format(weekdayAverage)}
              />
              <InsightRow
                label={t("settings.usage.analytics.activeDays")}
                value={formatText("settings.usage.analytics.activeDaysOf", {
                  active: view.activeDays,
                  total: props.rangeDays,
                })}
              />
            </dl>
          </div>
        </div>
        <StatTileGrid
          fitContainer
          tiles={[
            {
              label: t("settings.usage.analytics.tile.tokens"),
              value: formatTokens(view.totals.tokens),
              detail: formatText("settings.usage.analytics.tile.perActiveDay", {
                value: formatTokens(view.activeDays ? view.totals.tokens / view.activeDays : 0),
              }),
            },
            {
              label: t("settings.usage.analytics.tile.cacheReads"),
              value: formatTokens(view.totals.cacheReadTokens),
              detail: formatText("settings.usage.analytics.tile.shareOfTokens", {
                percent: percentOf(view.totals.cacheReadTokens, view.totals.tokens),
              }),
            },
            {
              label: t("settings.usage.analytics.tile.turns"),
              value: formatNumber(view.totals.turns),
              detail: formatText("settings.usage.analytics.tile.failedTurns", {
                count: formatNumber(view.totals.failedTurns),
              }),
            },
            {
              label: t("settings.usage.analytics.apiCost"),
              value: money.full(view.totals.costUsd),
              detail:
                view.totals.turns > 0
                  ? formatText("settings.usage.analytics.tile.perTurn", {
                      value: money.full(view.totals.costUsd / view.totals.turns),
                    })
                  : t("settings.usage.analytics.tile.noTurns"),
            },
            {
              label: t("settings.usage.analytics.activeDays"),
              value: `${view.activeDays}`,
              detail: formatText("settings.usage.analytics.tile.ofPeriod", {
                days: props.rangeDays,
              }),
            },
          ]}
        />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title={t(
            metric === "cost"
              ? "settings.usage.analytics.costByProvider"
              : "settings.usage.analytics.tokensByProvider",
          )}
          detail={t("settings.usage.analytics.byProviderDetail")}
          action={legend}
        />
        <ProviderLineChart
          days={view.days}
          providers={seriesProviders}
          metric={metric}
          format={format}
        />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title={t("settings.usage.analytics.models")}
          detail={
            models[0]
              ? formatText(
                  metric === "cost"
                    ? "settings.usage.analytics.models.mostCost"
                    : "settings.usage.analytics.models.mostWork",
                  { model: models[0].model },
                )
              : t("settings.usage.analytics.models.none")
          }
        />
        <SettingsCard>
          <div className={cn(modelGrid, "py-2 text-ui-sm text-muted-foreground")}>
            <span>{t("settings.usage.analytics.column.model")}</span>
            <span className="hidden text-right @md:block">
              {t("settings.usage.analytics.tile.turns")}
            </span>
            <span className="text-right">{t("settings.usage.analytics.metric.tokens")}</span>
            <span className="text-right">{t("settings.usage.analytics.metric.cost")}</span>
            <span className="hidden @xl:block">{t("settings.usage.analytics.column.share")}</span>
          </div>
          {models.slice(0, 12).map((model) => (
            <div
              key={`${model.provider}-${model.model}`}
              className={cn(modelGrid, "border-t py-2.5 text-ui")}
            >
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                <ProviderMark provider={model.provider} />
                <span className="truncate" title={model.model}>
                  {model.model}
                </span>
              </span>
              <span className="hidden text-right tabular-nums text-foreground @md:block">
                {formatNumber(model.turns)}
              </span>
              <span className="text-right tabular-nums text-foreground">
                {formatTokens(model.tokens)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {model.costUsd > 0 ? money.full(model.costUsd) : "—"}
              </span>
              <span className="hidden @xl:block">
                <ShareBar
                  share={(valueOf(model) / modelMax) * 100}
                  color={PROVIDER_SERIES_COLOR[model.provider]}
                />
              </span>
            </div>
          ))}
        </SettingsCard>
      </section>

      <section className="grid gap-10 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <SectionTitle
            title={t("settings.usage.analytics.projects")}
            detail={t("settings.usage.analytics.projects.detail")}
          />
          <ul className="flex flex-col gap-3.5">
            {projects.slice(0, 8).map((project) => (
              <ModelUsageRow
                key={project.projectId ?? "chats"}
                icon={null}
                model={project.projectId ? project.title : t("settings.usage.analytics.chats")}
                {...(project.projectId
                  ? {}
                  : { detail: t("settings.usage.analytics.outsideProjects") })}
                percent={percentOf(valueOf(project), projectTotal)}
                stat={`${format(valueOf(project))} · ${percentOf(valueOf(project), projectTotal)}%`}
                barColor="var(--foreground)"
              />
            ))}
          </ul>
        </div>
        {originTotal > 0 ? (
          <div className="flex flex-col gap-4">
            <SectionTitle
              title={t("settings.usage.analytics.origin")}
              detail={t(
                view.scope === "computer"
                  ? "settings.usage.analytics.origin.detailComputer"
                  : "settings.usage.analytics.origin.detail",
              )}
            />
            <dl className="flex flex-col gap-2.5">
              {(
                [
                  ["user", "settings.usage.analytics.origin.user"],
                  ["agent", "settings.usage.analytics.origin.agent"],
                  ["automation", "settings.usage.analytics.origin.automation"],
                ] as const
              ).map(([origin, labelKey]) => (
                <InsightRow
                  key={origin}
                  label={t(labelKey)}
                  value={`${formatTokens(view.origins[origin])} · ${percentOf(view.origins[origin], originTotal)}%`}
                />
              ))}
            </dl>
          </div>
        ) : null}
      </section>

      <section className="grid gap-10 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <SectionTitle
            title={t("settings.usage.analytics.rhythm")}
            detail={t("settings.usage.analytics.rhythm.detail")}
          />
          <RhythmChart rhythm={view.rhythm} format={formatTokens} />
        </div>
        <div className="flex flex-col gap-4">
          <SectionTitle title={t("settings.usage.analytics.about")} />
          <ul className="flex list-disc flex-col gap-2 pl-4 text-ui text-muted-foreground marker:text-foreground/30">
            <li>{t("settings.usage.analytics.about.apiRates")}</li>
            {reportedNames ? (
              <li>
                {formatText("settings.usage.analytics.about.reported", {
                  providers: reportedNames,
                })}
              </li>
            ) : null}
            {estimatedNames ? (
              <li>
                {view.pricing.status === "bundled" && view.pricing.fetchedAt
                  ? formatText("settings.usage.analytics.about.estimatedBundled", {
                      providers: estimatedNames,
                      // The list's own day, so read in UTC.
                      date: new Date(view.pricing.fetchedAt).toLocaleDateString(locale, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      }),
                    })
                  : pricesUpdated
                    ? formatText("settings.usage.analytics.about.estimatedUpdated", {
                        providers: estimatedNames,
                        date: pricesUpdated,
                      })
                    : formatText("settings.usage.analytics.about.estimated", {
                        providers: estimatedNames,
                      })}
              </li>
            ) : null}
            {view.unpriced.tokens > 0 ? (
              <li>
                {view.pricing.status === "unavailable"
                  ? formatText("settings.usage.analytics.about.pricesUnavailable", {
                      tokens: formatTokens(view.unpriced.tokens),
                    })
                  : formatText("settings.usage.analytics.about.noPrice", {
                      models:
                        view.unpriced.models.join(listSeparator) ||
                        t("settings.usage.analytics.about.someModels"),
                      tokens: formatTokens(view.unpriced.tokens),
                    })}
              </li>
            ) : null}
            {view.unpriced.unsplitTokens > 0 ? (
              <li>
                {formatText("settings.usage.analytics.about.unsplit", {
                  tokens: formatTokens(view.unpriced.unsplitTokens),
                })}
              </li>
            ) : null}
            {tokenOnlyNames ? (
              <li>
                {formatText("settings.usage.analytics.about.tokensOnly", {
                  providers: tokenOnlyNames,
                })}
              </li>
            ) : null}
            {view.unavailableProviders.length > 0 ? (
              <li>
                {formatText("settings.usage.analytics.about.unavailable", {
                  providers: view.unavailableProviders.map(nameOf).join(listSeparator),
                })}
              </li>
            ) : null}
            {view.scope === "computer" && view.sessionFileProviders.length > 0 ? (
              <li>
                {formatText("settings.usage.analytics.about.sessionFiles", {
                  providers: view.sessionFileProviders.map(nameOf).join(listSeparator),
                })}
              </li>
            ) : (
              <li>{t("settings.usage.analytics.about.mossOnly")}</li>
            )}
            {view.scope === "computer" && view.sessionFileProviders.includes("claudeAgent") ? (
              <li>{t("settings.usage.analytics.about.claudeRetention")}</li>
            ) : null}
          </ul>
        </div>
      </section>
    </div>
  );
}
