// FILE: MossBillingSettingsPanel.tsx
// Purpose: Claude/ChatGPT-style Settings → Usage & limits section for Moss cloud plans,
//          rolling/lifetime quota progress bars, limit-hit recovery, and resilient retry UX.
// Layer: Settings UI components
// Exports: MossBillingSettingsPanel, mossQuotaRemainingPercent, resolveMossPlanPresentation,
//          isBuiltInFreeMossPlanCode

import type { MossPayBillingModel, MossPayCatalog, MossPayUsageLimit } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isBuiltInFreeMossPlanCode } from "~/components/auth/MossMembershipPage.logic";
import {
  formatMossPayCount,
  formatMossPayPrice,
  formatMossPayReset,
  isMossPayQuotaUnlimited,
  safeMossPayErrorMessage,
} from "~/components/auth/MossPayPanel";
import { serverMossPayCatalogQueryOptions } from "~/components/auth/mossServerReactQuery";
import { useMossPayQuotaQuery } from "~/components/auth/useMossPayQuotaQuery";
import { MossLogo } from "~/components/MossLogo";
import { SettingsCard } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { CircleAlertIcon, RotateCcwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { SETTINGS_SECTION_LABEL_CLASS_NAME } from "~/settingsPanelStyles";
import type { MossLocaleCode } from "~/uiLocale";
import {
  findExhaustedMossQuotaWindow,
  formatMossResetCountdown,
  mossUsageLimitRemainingPercent,
  mossUsageLimitTone,
  shouldShowLegacyCreditBalanceCard,
} from "./mossUsagePresentation.logic";

export function mossQuotaRemainingPercent(used: number, limit: number | null): number | null {
  return mossUsageLimitRemainingPercent(used, limit);
}

export { isBuiltInFreeMossPlanCode };

export function resolveMossPlanPresentation(input: {
  readonly planCode: string | null | undefined;
  readonly catalog: MossPayCatalog | undefined;
  readonly unavailableLabel: string;
  readonly freePlanLabel?: string;
}): {
  readonly name: string;
  readonly plan: MossPayCatalog["plans"][number] | null;
  readonly isBuiltInFreePlan: boolean;
} {
  const planCode = input.planCode?.trim() ?? "";
  const plan =
    planCode.length > 0
      ? (input.catalog?.plans.find((candidate) => candidate.code === planCode) ?? null)
      : null;
  const catalogName = plan?.displayName.trim() ?? "";
  if (!plan && isBuiltInFreeMossPlanCode(planCode) && input.freePlanLabel) {
    return {
      name: input.freePlanLabel,
      plan: null,
      isBuiltInFreePlan: true,
    };
  }
  return {
    name: catalogName || planCode || input.unavailableLabel,
    plan,
    isBuiltInFreePlan: false,
  };
}

function MossDisabledCapabilityRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[color:var(--color-border)] px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-ui-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function QuotaProgressBar({
  ariaLabel,
  remainingPercent,
}: {
  readonly ariaLabel: string;
  readonly remainingPercent: number;
}) {
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const tone = mossUsageLimitTone(clamped);
  const exhausted = tone === "exhausted";
  const fillClassName =
    tone === "critical" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-info";

  return (
    <div
      aria-label={ariaLabel}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full",
        exhausted
          ? "bg-destructive/18 ring-1 ring-inset ring-destructive/35"
          : "bg-foreground/[0.08]",
      )}
      data-quota-exhausted={exhausted ? "true" : "false"}
      role="progressbar"
    >
      {exhausted ? (
        <div className="h-full w-full rounded-full bg-destructive/75" />
      ) : (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
            fillClassName,
          )}
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  );
}

function MossUsageLimitRow({
  label,
  limit,
  locale,
  unlimited,
  isFreeLifetime,
}: {
  readonly label: string;
  readonly limit: MossPayUsageLimit;
  readonly locale: MossLocaleCode;
  readonly unlimited: boolean;
  readonly isFreeLifetime: boolean;
}) {
  const { format, t } = useTranslation();
  const reset = formatMossPayReset(limit.resetsAt, locale);
  const countdown = formatMossResetCountdown(limit.resetsAt, locale);
  const remainingPercent = unlimited ? null : mossQuotaRemainingPercent(limit.used, limit.limit);
  const usedPercent = remainingPercent === null ? null : Math.max(0, 100 - remainingPercent);
  const tone = remainingPercent === null ? null : mossUsageLimitTone(remainingPercent);
  const remainingLabel =
    remainingPercent === null
      ? null
      : format("mossPay.settings.remainingPercent", {
          value: formatMossPayCount(remainingPercent, locale),
        });

  return (
    <div className="space-y-2 px-4 py-3.5" data-testid={`moss-limit-row-${limit.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <p className="text-ui font-medium text-foreground">{label}</p>
          {countdown ? (
            <span className="text-ui-xs text-muted-foreground tabular-nums">{countdown}</span>
          ) : isFreeLifetime ? (
            <span className="text-ui-xs text-muted-foreground">
              {t("mossPay.quota.noCycleReset")}
            </span>
          ) : null}
        </div>
        {unlimited ? (
          <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-ui-xs font-medium text-muted-foreground">
            {t("mossPay.quota.unlimited")}
          </span>
        ) : remainingPercent === null ? (
          <span className="shrink-0 text-ui-sm text-muted-foreground">
            {t("mossPay.quota.unknown")}
          </span>
        ) : (
          <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
            {tone === "exhausted" ? (
              <span className="rounded-full bg-destructive/12 px-2 py-0.5 text-ui-xs font-medium text-destructive">
                {t("mossPay.settings.limitReachedBadge")}
              </span>
            ) : null}
            <span
              className={cn(
                "text-ui font-medium whitespace-nowrap tabular-nums",
                tone === "exhausted" || tone === "critical"
                  ? "text-destructive"
                  : "text-foreground",
              )}
            >
              {remainingLabel}
            </span>
          </div>
        )}
      </div>

      {!unlimited && remainingPercent !== null ? (
        <QuotaProgressBar
          ariaLabel={`${label}: ${remainingLabel ?? `${remainingPercent}%`}`}
          remainingPercent={remainingPercent}
        />
      ) : null}

      {reset.valid || (!unlimited && usedPercent !== null) ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-ui-xs text-muted-foreground tabular-nums">
          <span>
            {reset.valid
              ? `${t("mossPay.quota.reset")} ${reset.formattedAt}`
              : isFreeLifetime
                ? ""
                : t("mossPay.quota.noReset")}
          </span>
          {!unlimited && usedPercent !== null ? (
            <span>
              {format("mossPay.settings.usedPercent", {
                value: formatMossPayCount(usedPercent, locale),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function usageWindowLabel(
  key: MossPayUsageLimit["key"],
  t: ReturnType<typeof useTranslation>["t"],
  billingModel: MossPayBillingModel,
  isBuiltInFreePlan: boolean,
) {
  switch (key) {
    case "lifetime":
      return t(
        billingModel === "wallet_credits_v1" || isBuiltInFreePlan
          ? "mossPay.settings.freeAllowance"
          : billingModel === "cost_budget_v1"
            ? "mossPay.settings.generalLimits"
            : "mossPay.creditBalance",
      );
    case "five_hour":
      return t("mossPay.settings.fiveHourLimit");
    case "weekly":
      return t("mossPay.settings.weeklyLimit");
    case "monthly":
      return t("mossPay.settings.monthlyLimit");
  }
}

function MossBillingSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("mossPay.catalog.loading")}
      className="space-y-6"
      data-testid="moss-billing-skeleton"
      role="status"
    >
      <section aria-labelledby="moss-billing-skeleton-plan-heading" className="space-y-1.5">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-billing-skeleton-plan-heading">
          {t("mossPay.settings.currentPlan")}
        </h2>
        <SettingsCard divided={false}>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-24 rounded-full" />
              <Skeleton className="h-3 w-40 max-w-full rounded-full" />
            </div>
            <Skeleton className="h-8 w-24 rounded-control" />
          </div>
        </SettingsCard>
      </section>

      <section aria-labelledby="moss-billing-skeleton-limit-heading" className="space-y-1.5">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-billing-skeleton-limit-heading">
          {t("mossPay.settings.generalLimits")}
        </h2>
        <SettingsCard divided={false}>
          <div className="space-y-4 px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-32 rounded-full" />
              <Skeleton className="h-3 w-20 rounded-full" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-28 rounded-full" />
              <Skeleton className="h-3 w-20 rounded-full" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        </SettingsCard>
      </section>
    </div>
  );
}

export function MossBillingSettingsPanel() {
  const { format, locale, t } = useTranslation();
  const navigate = useNavigate();
  const {
    accountTransitionPending,
    accountIdentity,
    quotaQuery,
    quota,
    accountLoading,
    quotaLoading,
  } = useMossPayQuotaQuery();
  const catalogQuery = useQuery(serverMossPayCatalogQueryOptions());
  const catalogStatePending = catalogQuery.isPending && !catalogQuery.data;

  if (accountLoading || catalogStatePending || quotaLoading) {
    return <MossBillingSkeleton />;
  }

  const planPresentation = resolveMossPlanPresentation({
    planCode: quota?.planCode,
    catalog: catalogQuery.data,
    unavailableLabel: t("mossPay.settings.planUnavailable"),
    freePlanLabel: t("mossPay.settings.freePlan"),
  });
  const isFreePlan =
    planPresentation.isBuiltInFreePlan ||
    quota?.billingModel === "wallet_credits_v1" ||
    isBuiltInFreeMossPlanCode(quota?.planCode);
  const planPrice = planPresentation.plan
    ? `${formatMossPayPrice(planPresentation.plan.monthlyPriceCny, locale)} ${t("mossPay.catalog.perMonth")}`
    : null;
  const quotaIsUnlimited = quota ? isMossPayQuotaUnlimited(quota) : false;
  const exhaustedWindow = findExhaustedMossQuotaWindow(quota, quotaIsUnlimited);
  const exhaustedReset = formatMossPayReset(exhaustedWindow?.resetsAt ?? null, locale);
  const showLegacyCredits = shouldShowLegacyCreditBalanceCard(quota);
  const pointPurchasesAvailable = (catalogQuery.data?.pointPackages.length ?? 0) > 0;
  const isRefreshing = quotaQuery.isFetching || catalogQuery.isFetching;

  const meteredRealtimeCostLimit =
    quota?.quotaPolicyMode === "metered" &&
    quota.realtimeConfigured &&
    quota.realtimeCostLimitNanoUsd !== null
      ? quota.realtimeCostLimitNanoUsd
      : null;
  const realtimeQuotaIsUnlimited = quotaIsUnlimited && quota?.realtimeConfigured === true;
  const realtimeRemainingPercent =
    quota && meteredRealtimeCostLimit !== null && meteredRealtimeCostLimit > 0
      ? Math.max(
          0,
          100 -
            Math.min(
              100,
              Math.round(
                ((quota.realtimeCostUsedNanoUsd + quota.realtimeCostReservedNanoUsd) /
                  meteredRealtimeCostLimit) *
                  100,
              ),
            ),
        )
      : null;

  const openCommerce = (focus: "plans" | "credits") => {
    void navigate({ to: "/membership", search: { focus } });
  };
  const refreshQuota = () => {
    if (accountIdentity !== null) {
      void quotaQuery.refetch();
    }
    if (catalogQuery.isError) {
      void catalogQuery.refetch();
    }
  };

  const planStatusBadge = exhaustedWindow
    ? {
        label: t("mossPay.settings.limitReachedBadge"),
        className: "bg-destructive/12 text-destructive",
      }
    : quotaIsUnlimited
      ? {
          label: t("mossPay.settings.unlimitedBadge"),
          className: "bg-info/12 text-info-foreground",
        }
      : isFreePlan
        ? {
            label: t("mossPay.settings.freePlanBadge"),
            className: "bg-foreground/[0.06] text-muted-foreground",
          }
        : quota?.planCode
          ? {
              label: t("mossPay.settings.planActiveBadge"),
              className: "bg-success/12 text-success-foreground",
            }
          : null;

  return (
    <div className="space-y-6" data-testid="moss-billing-settings-panel">
      <section aria-labelledby="moss-current-plan-heading" className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-current-plan-heading">
            {t("mossPay.settings.currentPlan")}
          </h2>
          <Button
            className="shrink-0"
            data-testid="moss-quota-refresh"
            disabled={isRefreshing}
            onClick={refreshQuota}
            size="xs"
            variant="ghost"
          >
            <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
            {t("mossPay.quota.refresh")}
          </Button>
        </div>
        <SettingsCard divided={false}>
          <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control border border-[color:var(--color-border)] bg-foreground/[0.03]">
                <MossLogo className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-ui-lg font-medium text-foreground">
                    {planPresentation.name}
                  </p>
                  {planStatusBadge ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-ui-xs font-medium leading-none",
                        planStatusBadge.className,
                      )}
                    >
                      {planStatusBadge.label}
                    </span>
                  ) : null}
                </div>
                {planPrice ? (
                  <p className="mt-0.5 text-ui-sm text-muted-foreground tabular-nums">
                    {planPrice}
                  </p>
                ) : isFreePlan ? (
                  <p className="mt-0.5 text-ui-sm text-muted-foreground">
                    {t("mossPay.settings.freePlanSummary")}
                  </p>
                ) : quota?.planCode ? (
                  <p className="mt-0.5 text-ui-sm text-muted-foreground">
                    {format("mossPay.settings.planCode", { code: quota.planCode })}
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              aria-label={t("mossPay.settings.viewPlans")}
              data-testid="moss-pricing-view-plans"
              onClick={() => openCommerce("plans")}
              size="sm"
              variant="outline"
            >
              {isFreePlan || exhaustedWindow
                ? t("mossPay.settings.upgradePlan")
                : t("mossPay.settings.viewPlans")}
            </Button>
          </div>
        </SettingsCard>
        {catalogQuery.isError ? (
          <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground" role="status">
            {t("mossPay.catalog.failed")}
          </p>
        ) : null}
      </section>

      {exhaustedWindow ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-destructive/30 bg-destructive/[0.06] px-4 py-3.5"
          data-testid="moss-usage-limit-hit-banner"
          role="status"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-ui font-medium text-destructive">
                {t("mossQuota.exhausted.title")}
              </p>
              <p className="text-ui-sm text-muted-foreground">
                {t("mossQuota.exhausted.description")}
                {exhaustedReset.valid && exhaustedReset.formattedAt
                  ? ` · ${format("mossQuota.exhausted.reset", { resetAt: exhaustedReset.formattedAt })}`
                  : ""}
              </p>
            </div>
          </div>
          <Button
            data-testid="moss-usage-limit-hit-upgrade"
            onClick={() => openCommerce("plans")}
            size="sm"
            variant="outline"
          >
            {t("mossQuota.exhausted.openPlans")}
          </Button>
        </div>
      ) : null}

      {showLegacyCredits ? (
        <section aria-labelledby="moss-credit-balance-heading" className="space-y-1.5">
          <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-credit-balance-heading">
            {t("mossPay.settings.creditBalance")}
          </h2>
          <SettingsCard divided={false}>
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-ui-lg font-medium text-foreground tabular-nums">
                  {quota
                    ? formatMossPayCount(quota.creditBalance, locale)
                    : t("mossPay.quota.unknown")}
                </p>
                <p className="mt-0.5 text-ui-sm text-muted-foreground">
                  {t("mossPay.settings.creditBalanceDescription")}
                </p>
              </div>
              <Button
                aria-label={t("mossPay.settings.buyCredits")}
                data-testid="moss-pricing-buy-credits"
                disabled={!pointPurchasesAvailable}
                onClick={() => openCommerce("credits")}
                size="sm"
                variant="outline"
              >
                {pointPurchasesAvailable
                  ? t("mossPay.settings.buyCredits")
                  : t("mossPay.settings.notAvailable")}
              </Button>
            </div>
            <MossDisabledCapabilityRow
              description={t("mossPay.settings.autoTopUpDescription")}
              title={t("mossPay.settings.autoTopUp")}
            >
              <span className="rounded-full bg-foreground/[0.06] px-2 py-1 text-ui-xs text-muted-foreground">
                {t("mossPay.settings.notAvailable")}
              </span>
              <Switch aria-label={t("mossPay.settings.autoTopUp")} checked={false} disabled />
            </MossDisabledCapabilityRow>
            <MossDisabledCapabilityRow
              description={t("mossPay.settings.giftDescription")}
              title={t("mossPay.settings.giftCredits")}
            >
              <Button disabled size="sm" variant="outline">
                {t("mossPay.settings.giftCreditsAction")}
              </Button>
            </MossDisabledCapabilityRow>
          </SettingsCard>
        </section>
      ) : null}

      <section aria-labelledby="moss-general-limits-heading" className="space-y-1.5">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-general-limits-heading">
          {t("mossPay.settings.generalLimits")}
        </h2>
        <SettingsCard divided={false}>
          {accountTransitionPending ? (
            <p
              aria-live="polite"
              className="px-4 py-4 text-ui-sm text-muted-foreground"
              role="status"
            >
              {t("mossPay.quota.switching")}
            </p>
          ) : quota && quota.usageLimits.length > 0 ? (
            <div className="divide-y divide-[color:var(--color-border)]">
              {quota.usageLimits.map((limit) => (
                <MossUsageLimitRow
                  isFreeLifetime={isFreePlan && limit.key === "lifetime"}
                  key={limit.key}
                  label={usageWindowLabel(limit.key, t, quota.billingModel, isFreePlan)}
                  limit={limit}
                  locale={locale}
                  unlimited={quotaIsUnlimited}
                />
              ))}
              {quota.realtimeConfigured &&
              (realtimeQuotaIsUnlimited || realtimeRemainingPercent !== null) ? (
                <div className="space-y-2 px-4 py-3.5" data-testid="moss-limit-row-realtime">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="text-ui font-medium text-foreground">
                      {t("mossPay.realtime.title")}
                    </p>
                    <span className="shrink-0 text-ui font-medium text-foreground tabular-nums">
                      {realtimeQuotaIsUnlimited
                        ? t("mossPay.quota.unlimited")
                        : format("mossPay.settings.remainingPercent", {
                            value: formatMossPayCount(realtimeRemainingPercent ?? 0, locale),
                          })}
                    </span>
                  </div>
                  {!realtimeQuotaIsUnlimited && realtimeRemainingPercent !== null ? (
                    <QuotaProgressBar
                      ariaLabel={`${t("mossPay.realtime.title")}: ${realtimeRemainingPercent}%`}
                      remainingPercent={realtimeRemainingPercent}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-ui-xs text-muted-foreground tabular-nums">
                    <span>
                      {quota.realtimeEstimatedMinutesRemaining !== null
                        ? format("mossPay.realtime.minutesRemaining", {
                            value: formatMossPayCount(
                              quota.realtimeEstimatedMinutesRemaining,
                              locale,
                            ),
                          })
                        : t("mossPay.realtime.usageNote")}
                    </span>
                    {quota.realtimeSessionLimit !== null ? (
                      <span>
                        {format("mossPay.realtime.sessions", {
                          used: formatMossPayCount(quota.realtimeSessionsUsed, locale),
                          limit: formatMossPayCount(quota.realtimeSessionLimit, locale),
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : quotaQuery.isError && !quota ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"
              data-testid="moss-quota-error-state"
              role="status"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <CircleAlertIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-ui font-medium text-foreground">
                    {t("mossPay.quota.loadFailedTitle")}
                  </p>
                  <p className="text-ui-sm text-muted-foreground">
                    {safeMossPayErrorMessage(quotaQuery.error, locale)}
                  </p>
                </div>
              </div>
              <Button
                data-testid="moss-quota-retry"
                disabled={quotaQuery.isFetching}
                onClick={refreshQuota}
                size="sm"
                variant="outline"
              >
                {quotaQuery.isFetching ? t("mossPay.quota.retrying") : t("mossPay.quota.retry")}
              </Button>
            </div>
          ) : quotaQuery.isPending ? (
            <p className="px-4 py-4 text-ui-sm text-muted-foreground" role="status">
              {t("mossPay.quota.switching")}
            </p>
          ) : (
            <div
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-4"
              role="status"
            >
              <p className="text-ui-sm text-muted-foreground">
                {quota ? t("mossPay.quota.emptyLimits") : t("mossPay.quota.unknown")}
              </p>
              <Button
                disabled={quotaQuery.isFetching}
                onClick={refreshQuota}
                size="xs"
                variant="outline"
              >
                {t("mossPay.quota.refresh")}
              </Button>
            </div>
          )}
        </SettingsCard>
        <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
          {isFreePlan
            ? t("mossPay.settings.freeAllowanceDescription")
            : quota?.billingModel === "legacy_tokens"
              ? t("mossPay.settings.legacyTransition")
              : t("mossPay.settings.weightedDescription")}
        </p>
      </section>
    </div>
  );
}
