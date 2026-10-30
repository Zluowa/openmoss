// FILE: MossBillingSettingsPanel.tsx
// Purpose: Codex-parity Settings -> Usage and billing for Moss-owned plans and credits.

import type { MossPayCatalog, MossPayUsageLimit } from "@synara/contracts";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  formatMossPayCount,
  formatMossPayPrice,
  formatMossPayReset,
  isMossPayAccountTransitionPending,
  isMossPayQuotaUnlimited,
  resolveMossPayQuotaAccountIdentity,
  safeMossPayErrorMessage,
} from "~/components/auth/MossPayPanel";
import { SettingsCard } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { serverMutationKeys } from "~/lib/serverReactQuery";
import {
  mossServerMutationKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";

const SETTINGS_SECTION_LABEL_CLASS_NAME = "px-2 py-1 text-ui-sm font-medium text-foreground";

export function mossQuotaRemainingPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return used <= 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((1 - used / limit) * 100)));
}

export function resolveMossPlanPresentation(input: {
  readonly planCode: string | null | undefined;
  readonly catalog: MossPayCatalog | undefined;
  readonly unavailableLabel: string;
}): {
  readonly name: string;
  readonly plan: MossPayCatalog["plans"][number] | null;
} {
  const planCode = input.planCode?.trim() ?? "";
  const plan =
    planCode.length > 0
      ? (input.catalog?.plans.find((candidate) => candidate.code === planCode) ?? null)
      : null;
  const catalogName = plan?.displayName.trim() ?? "";
  return {
    name: catalogName || planCode || input.unavailableLabel,
    plan,
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
    <div className="flex items-center justify-between gap-4 border-t border-[color:var(--color-border)] px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-ui-lg font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-ui-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function MossUsageLimitRow({
  label,
  limit,
  locale,
  unlimited,
}: {
  readonly label: string;
  readonly limit: MossPayUsageLimit;
  readonly locale: MossLocaleCode;
  readonly unlimited: boolean;
}) {
  const { format, t } = useTranslation();
  const reset = formatMossPayReset(limit.resetsAt, locale);
  const remainingPercent = unlimited ? null : mossQuotaRemainingPercent(limit.used, limit.limit);
  const remainingLabel =
    remainingPercent === null
      ? null
      : format("mossPay.settings.remainingPercent", {
          value: formatMossPayCount(remainingPercent, locale),
        });

  return (
    <div className="flex min-h-15 items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-ui-lg font-medium text-foreground">{label}</p>
        {reset.valid ? (
          <p className="mt-0.5 truncate text-ui-sm text-muted-foreground">
            {t("mossPay.quota.reset")} {reset.formattedAt}
          </p>
        ) : null}
      </div>
      {unlimited ? (
        <span className="shrink-0 text-ui-lg text-muted-foreground">
          {t("mossPay.quota.unlimited")}
        </span>
      ) : remainingPercent === null ? (
        <span className="shrink-0 text-ui-lg text-muted-foreground">
          {t("mossPay.quota.unknown")}
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <div
            aria-label={`${label}: ${remainingLabel ?? `${remainingPercent}%`}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={remainingPercent}
            className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className={cn(
                "h-full rounded-full",
                remainingPercent <= 10 ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${remainingPercent}%` }}
            />
          </div>
          <span className="min-w-[72px] text-right text-ui-lg whitespace-nowrap text-muted-foreground tabular-nums">
            {remainingLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function usageWindowLabel(
  key: MossPayUsageLimit["key"],
  t: ReturnType<typeof useTranslation>["t"],
  packageCost: boolean,
) {
  switch (key) {
    case "lifetime":
      return t(packageCost ? "mossPay.settings.generalLimits" : "mossPay.creditBalance");
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
              <Skeleton className="h-3 w-16 rounded-full" />
            </div>
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </SettingsCard>
      </section>

      <section aria-labelledby="moss-billing-skeleton-credit-heading" className="space-y-1.5">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-billing-skeleton-credit-heading">
          {t("mossPay.settings.creditBalance")}
        </h2>
        <SettingsCard divided={false}>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="h-3 w-48 max-w-full rounded-full" />
            </div>
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
          <div className="border-t border-[color:var(--color-border)] px-4 py-3.5">
            <Skeleton className="h-4 w-36 rounded-full" />
            <Skeleton className="mt-2 h-3 w-64 max-w-full rounded-full" />
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
              <Skeleton className="h-3 w-24 rounded-full" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
            <div className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-28 rounded-full" />
              <Skeleton className="h-3 w-24 rounded-full" />
            </div>
          </div>
        </SettingsCard>
      </section>
    </div>
  );
}

export function MossBillingSettingsPanel() {
  const { format, locale, t } = useTranslation();
  const navigate = useNavigate();
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const phoneLoginCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossPhoneLogin() });
  const phoneLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossLogout() });
  const cloudAccountSwitchCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudSelect(),
  });
  const cloudLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossCloudLogout() });
  const accountTransitionPending = isMossPayAccountTransitionPending({
    phoneLoginCount,
    phoneLogoutCount,
    cloudAccountSwitchCount,
    cloudLogoutCount,
  });
  const accountIdentity = resolveMossPayQuotaAccountIdentity(
    phoneAccountQuery.data,
    accountQuery.data,
    accountTransitionPending,
  );
  const catalogQuery = useQuery(serverMossPayCatalogQueryOptions());
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: accountIdentity !== null,
      accountIdentity,
    }),
  );
  const accountStatePending =
    accountTransitionPending ||
    (accountIdentity === null &&
      (phoneAccountQuery.isPending ||
        phoneAccountQuery.isFetching ||
        accountQuery.isPending ||
        accountQuery.isFetching));
  const catalogStatePending = catalogQuery.isPending && !catalogQuery.data;
  const quotaStatePending = accountIdentity !== null && quotaQuery.isPending && !quotaQuery.data;
  if (accountStatePending || catalogStatePending || quotaStatePending) {
    return <MossBillingSkeleton />;
  }
  const quota = accountTransitionPending ? undefined : quotaQuery.data;
  const planPresentation = resolveMossPlanPresentation({
    planCode: quota?.planCode,
    catalog: catalogQuery.data,
    unavailableLabel: t("mossPay.settings.planUnavailable"),
  });
  const planPrice = planPresentation.plan
    ? `${formatMossPayPrice(planPresentation.plan.monthlyPriceCny, locale)}${t("mossPay.catalog.perMonth")}`
    : null;
  const quotaIsUnlimited = quota ? isMossPayQuotaUnlimited(quota) : false;
  const pointPurchasesAvailable = (catalogQuery.data?.pointPackages.length ?? 0) > 0;
  const openCommerce = (focus: "plans" | "credits") => {
    void navigate({ to: "/membership", search: { focus } });
  };

  return (
    <div className="space-y-6" data-testid="moss-billing-settings-panel">
      <section aria-labelledby="moss-current-plan-heading" className="space-y-1.5">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-current-plan-heading">
          {t("mossPay.settings.currentPlan")}
        </h2>
        <SettingsCard divided={false}>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-ui-lg font-medium text-foreground">{planPresentation.name}</p>
              {planPrice ? (
                <p className="mt-0.5 text-ui-sm text-muted-foreground">{planPrice}</p>
              ) : quota?.planCode ? (
                <p className="mt-0.5 text-ui-sm text-muted-foreground">
                  {format("mossPay.settings.planCode", { code: quota.planCode })}
                </p>
              ) : null}
            </div>
            <Button
              aria-label={t("mossPay.settings.viewPlans")}
              data-testid="moss-pricing-view-plans"
              onClick={() => openCommerce("plans")}
              size="sm"
              variant="outline"
            >
              {t("mossPay.settings.viewPlans")}
            </Button>
          </div>
        </SettingsCard>
        {catalogQuery.isError ? (
          <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground" role="status">
            {t("mossPay.catalog.failed")}
          </p>
        ) : null}
      </section>

      {quota?.billingModel !== "cost_budget_v1" && (
        <section aria-labelledby="moss-credit-balance-heading" className="space-y-1.5">
          <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME} id="moss-credit-balance-heading">
            {t("mossPay.settings.creditBalance")}
          </h2>
          <SettingsCard divided={false}>
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <p className="text-ui-lg font-medium text-foreground">
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
              <span className="rounded-full bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
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
      )}

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
                  key={limit.key}
                  label={usageWindowLabel(limit.key, t, quota.billingModel === "cost_budget_v1")}
                  limit={limit}
                  locale={locale}
                  unlimited={quotaIsUnlimited}
                />
              ))}
            </div>
          ) : quotaQuery.isError ? (
            <p className="px-4 py-4 text-ui-sm text-muted-foreground" role="status">
              {safeMossPayErrorMessage(quotaQuery.error, locale)}
            </p>
          ) : quotaQuery.isPending ? (
            <p className="px-4 py-4 text-ui-sm text-muted-foreground" role="status">
              {t("mossPay.quota.switching")}
            </p>
          ) : (
            <p className="px-4 py-4 text-ui-sm text-muted-foreground" role="status">
              {t("mossPay.quota.unknown")}
            </p>
          )}
        </SettingsCard>
        <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
          {quota?.billingModel === "legacy_tokens"
            ? t("mossPay.settings.legacyTransition")
            : t("mossPay.settings.weightedDescription")}
        </p>
      </section>
    </div>
  );
}
