// Moss quota panel with an optional commerce catalog. Production callers keep
// commerce hidden until a regional payment backend is explicitly available;
// quota remains readable directly from the authenticated account authority.

import type { MossPayOrder, MossPayQuota } from "@synara/contracts";
import { isMossPayOrderSettled } from "@synara/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { serverMutationKeys, serverQueryKeys } from "~/lib/serverReactQuery";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayCreateOrderMutationOptions,
  serverMossPayOrderQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./mossServerReactQuery";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  isMossPayAccountTransitionPending,
  resolveMossPayQuotaAccountIdentity,
} from "~/lib/mossPayQuotaIdentity";
import type { MossLocaleCode } from "~/uiLocale";
import { safeMossPayOrderErrorMessage } from "./MossMembershipPage.logic";

export {
  isMossPayAccountTransitionPending,
  resolveMossPayQuotaAccountIdentity,
} from "~/lib/mossPayQuotaIdentity";

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export function formatMossPayPrice(cents: number, locale: MossLocaleCode): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(Math.max(0, cents) / 100);
}

function formatCny(cents: number, locale: MossLocaleCode): string {
  return formatMossPayPrice(cents, locale);
}

export function formatMossPayOrderAmount(
  order: Pick<MossPayOrder, "amountMinor" | "currency">,
  locale: MossLocaleCode,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: order.currency,
    minimumFractionDigits: order.amountMinor % 100 === 0 ? 0 : 2,
  }).format(Math.max(0, order.amountMinor) / 100);
}

export function formatMossPayCount(value: number, locale: MossLocaleCode): string {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(normalized);
}

export function isWeeklyMossQuotaWindow(
  quota: Pick<MossPayQuota, "windowSource" | "windowDurationSeconds">,
): boolean {
  const explicitSource = quota.windowSource?.trim().toLocaleLowerCase("en-US") ?? "";
  return (
    explicitSource === "weekly" ||
    explicitSource === "week" ||
    quota.windowDurationSeconds === SEVEN_DAYS_SECONDS
  );
}
export function isMossPayQuotaUnlimited(
  quota: Pick<MossPayQuota, "quotaPolicyMode" | "requestLimit" | "tokenLimit">,
): boolean {
  return (
    quota.quotaPolicyMode === "unlimited" &&
    quota.requestLimit === null &&
    quota.tokenLimit === null
  );
}

export function formatMossPayReset(
  periodEnd: string | null,
  locale: MossLocaleCode,
  nowMs = Date.now(),
): {
  readonly valid: boolean;
  readonly formattedAt: string | null;
  readonly remainingSeconds: number | null;
} {
  if (periodEnd === null) return { valid: false, formattedAt: null, remainingSeconds: null };
  const resetMs = Date.parse(periodEnd);
  if (!Number.isFinite(resetMs)) {
    return { valid: false, formattedAt: null, remainingSeconds: null };
  }
  return {
    valid: true,
    formattedAt: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(resetMs)),
    remainingSeconds: Math.max(0, Math.ceil((resetMs - nowMs) / 1_000)),
  };
}

export function mossPayQuotaIdentityKey(accountId: string | null) {
  return mossServerQueryKeys.mossPayQuota(accountId);
}

export function safeMossPayErrorMessage(_error: unknown, locale: MossLocaleCode): string {
  return locale === "zh-CN" ? "Moss 额度暂时不可用。" : "Moss quota is temporarily unavailable.";
}

function quotaPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit === 0) return used === 0 ? 0 : 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

// ---------- 二维码（qrcode 库，带正确纠错码，微信可扫） ----------
export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const { t } = useTranslation();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: size })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (failed) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-center text-ui-sm text-muted-foreground">
        {t("mossPay.qr.failed")}
      </p>
    );
  }
  if (!dataUrl) {
    return (
      <div
        className="animate-pulse rounded-lg border bg-muted"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <img
      alt={t("mossPay.qr.alt")}
      className="rounded-lg border bg-white"
      height={size}
      src={dataUrl}
      width={size}
    />
  );
}

function MossQuotaSkeleton({ compact = false }: { readonly compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("mossPay.quota.switching")}
      className={cn("space-y-3", compact ? "mt-4" : "mt-4 rounded-lg bg-muted/50 p-3")}
      data-testid="moss-quota-skeleton"
      role="status"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-3.5 w-32 rounded-full" />
        <Skeleton className="h-3 w-20 rounded-full" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-3.5 w-28 rounded-full" />
        <Skeleton className="h-3 w-24 rounded-full" />
      </div>
    </div>
  );
}

function MossPayCatalogSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("mossPay.catalog.loading")}
      className="grid min-w-0 gap-3 px-5 py-6 sm:grid-cols-2 sm:px-6 xl:grid-cols-4"
      data-testid="moss-pay-catalog-skeleton"
      role="status"
    >
      {["one", "two", "three", "four"].map((key) => (
        <div className="rounded-2xl border bg-card p-4" key={key}>
          <Skeleton className="h-4 w-24 rounded-full" />
          <Skeleton className="mt-5 h-8 w-28 rounded-lg" />
          <div className="mt-4 space-y-2">
            <Skeleton className="h-3 w-32 rounded-full" />
            <Skeleton className="h-3 w-28 rounded-full" />
            <Skeleton className="h-3 w-24 rounded-full" />
          </div>
          <Skeleton className="mt-5 h-8 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

// ---------- 支付面板 ----------
export function MossPayPanel({ showCatalog = false }: { showCatalog?: boolean } = {}) {
  const { format, locale, t } = useTranslation();
  const queryClient = useQueryClient();
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
  const selectedAccountIdentity = resolveMossPayQuotaAccountIdentity(
    phoneAccountQuery.data,
    accountQuery.data,
    accountTransitionPending,
  );
  const catalogQuery = useQuery(serverMossPayCatalogQueryOptions({ enabled: showCatalog }));
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: selectedAccountIdentity !== null,
      accountIdentity: selectedAccountIdentity,
    }),
  );
  const createOrder = useMutation(serverMossPayCreateOrderMutationOptions({ queryClient }));
  const [activeOrderNo, setActiveOrderNo] = useState<string | null>(null);
  const [commerceTab, setCommerceTab] = useState<"plans" | "usage">("plans");
  const orderQuery = useQuery(serverMossPayOrderQueryOptions(activeOrderNo));

  const catalog = catalogQuery.data;
  const quota = accountTransitionPending ? undefined : quotaQuery.data;
  const order = orderQuery.data;
  const accountLoading =
    accountTransitionPending ||
    (selectedAccountIdentity === null &&
      (phoneAccountQuery.isPending ||
        phoneAccountQuery.isFetching ||
        accountQuery.isPending ||
        accountQuery.isFetching));
  const catalogLoading = showCatalog && catalogQuery.isPending && !catalog;
  const quotaLoading = selectedAccountIdentity !== null && quotaQuery.isPending && !quota;

  const rail =
    catalog?.paymentMethods[0] ??
    (phoneAccountQuery.data?.authenticated
      ? ({ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" } as const)
      : accountQuery.data?.authenticated
        ? ({ id: "stripe_checkout", displayName: "Stripe", kind: "hosted" } as const)
        : null);
  const orderSettled = order
    ? isMossPayOrderSettled(order.status, order.refundReviewRequired)
    : false;

  useEffect(() => {
    if (orderSettled) {
      void quotaQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSettled]);

  const openHostedCheckout = (url: string) => openExternalLink(url);

  const startOrder = (orderType: "plan" | "points", itemCode: string) => {
    createOrder.mutate(
      { orderType, itemCode },
      {
        onSuccess: (created) => {
          setActiveOrderNo(created.outTradeNo || null);
        },
      },
    );
  };

  const quotaIsUnlimited = quota ? isMossPayQuotaUnlimited(quota) : false;
  const realtimeQuotaIsUnlimited = quotaIsUnlimited && quota?.realtimeConfigured === true;
  const meteredRealtimeCostLimit =
    quota?.quotaPolicyMode === "metered" &&
    quota.realtimeConfigured &&
    quota.realtimeCostLimitNanoUsd !== null
      ? quota.realtimeCostLimitNanoUsd
      : null;
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
  const reset = formatMossPayReset(quota?.periodEnd ?? null, locale);
  const quotaHeading =
    quota && isWeeklyMossQuotaWindow(quota)
      ? t("mossPay.quota.weekly")
      : t("mossPay.quota.current");
  const currentPlanName =
    (quota?.planCode
      ? (catalog?.plans.find((plan) => plan.code === quota.planCode)?.displayName ?? quota.planCode)
      : null) ?? t("mossPay.settings.planUnavailable");

  const packageCost = quota?.billingModel === "cost_budget_v1";
  const packageLimit = quota?.usageLimits.find((limit) => limit.key === "lifetime");
  const packageUsedPercent = packageLimit
    ? quotaPercent(packageLimit.used, packageLimit.limit)
    : null;
  const packageRemainingLabel =
    packageUsedPercent === null
      ? t("mossPay.quota.unknown")
      : format("mossPay.settings.remainingPercent", {
          value: Math.max(0, 100 - packageUsedPercent),
        });

  return (
    <section
      aria-labelledby="moss-pay-heading"
      className={cn(
        "min-w-0 overflow-x-hidden rounded-dialog border bg-background shadow-sm",
        showCatalog ? "overflow-y-auto" : "p-4",
      )}
    >
      <div className={showCatalog ? "border-b bg-muted/20 px-5 py-5 sm:px-6" : ""}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="moss-pay-heading"
              className={
                showCatalog ? "text-xl font-semibold tracking-tight" : "text-ui-lg font-medium"
              }
            >
              {t("mossPay.heading")}
            </h2>
            <p className="mt-1 text-ui-lg leading-relaxed text-muted-foreground">
              {rail?.id === "stripe_checkout" || selectedAccountIdentity?.startsWith("cloud:")
                ? t("mossPay.descriptionStripe")
                : t("mossPay.description")}
            </p>
          </div>
          {!showCatalog && (quota || quotaLoading) ? (
            <div className="shrink-0 text-right">
              <p className="text-ui-sm text-muted-foreground">
                {t(packageCost ? "mossPay.settings.generalLimits" : "mossPay.creditBalance")}
              </p>
              {quota ? (
                <p className="text-lg font-semibold tabular-nums">
                  {packageCost
                    ? packageRemainingLabel
                    : formatMossPayCount(quota.creditBalance, locale)}
                </p>
              ) : (
                <Skeleton className="ml-auto mt-1 h-6 w-14 rounded-lg" />
              )}
            </div>
          ) : null}
        </div>

        {showCatalog ? (
          <>
            <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <div className="min-w-0 rounded-2xl bg-foreground p-4 text-background shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-ui-sm font-medium text-background/65">
                      {t(packageCost ? "mossPay.settings.generalLimits" : "mossPay.catalog.wallet")}
                    </p>
                    <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
                      {quota ? (
                        packageCost ? (
                          packageRemainingLabel
                        ) : (
                          formatMossPayCount(quota.creditBalance, locale)
                        )
                      ) : quotaLoading || accountLoading ? (
                        <Skeleton className="h-9 w-24 rounded-lg bg-background/20" />
                      ) : (
                        t("mossPay.quota.unknown")
                      )}
                    </p>
                    <p className="mt-1 text-ui-sm text-background/65">
                      {t(packageCost ? "mossPay.quota.current" : "mossPay.creditBalance")}
                    </p>
                  </div>
                  <div className="shrink-0 rounded-full border border-background/20 px-2.5 py-1 text-ui-xs text-background/75">
                    {t("mossPay.catalog.monthlyOnly")}
                  </div>
                </div>
                <div className="mt-5 border-t border-background/15 pt-3">
                  <p className="text-ui-sm text-background/65">
                    {t("mossPay.catalog.currentPlan")}
                  </p>
                  {quotaLoading || accountLoading ? (
                    <Skeleton className="mt-2 h-4 w-28 rounded-full bg-background/20" />
                  ) : (
                    <p className="mt-1 truncate text-ui-lg font-medium">{currentPlanName}</p>
                  )}
                </div>
              </div>
              <div className="min-w-0 rounded-2xl border bg-background p-4">
                <p className="text-ui-sm font-medium text-muted-foreground">
                  {t("mossPay.catalog.paymentMethod")}
                </p>
                {catalogLoading && !rail ? (
                  <Skeleton
                    aria-label={t("mossPay.catalog.loading")}
                    className="mt-2 h-5 w-32 rounded-full"
                    data-testid="moss-pay-method-skeleton"
                  />
                ) : (
                  <p
                    className="mt-2 truncate text-base font-semibold"
                    data-testid="moss-payment-method"
                  >
                    {rail?.displayName ?? t("mossPay.catalog.paymentMethodUnavailable")}
                  </p>
                )}
                {catalogLoading && !rail ? (
                  <Skeleton className="mt-2 h-3 w-48 max-w-full rounded-full" />
                ) : (
                  <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
                    {rail
                      ? t("mossPay.catalog.serverPaymentMethod")
                      : t("mossPay.catalog.paymentMethodUnavailable")}
                  </p>
                )}
                {quota ? (
                  <p className="mt-4 text-ui-sm text-muted-foreground">
                    {quotaHeading} ·{" "}
                    {reset.valid
                      ? `${t("mossPay.quota.reset")} ${reset.formattedAt}`
                      : t("mossPay.quota.noReset")}
                  </p>
                ) : null}
              </div>
            </div>
            <div
              aria-label={t("mossPay.catalog.tabsLabel")}
              className="mt-5 inline-flex max-w-full rounded-xl border bg-background p-1"
              role="tablist"
            >
              {(["plans", "usage"] as const).map((tab) => {
                const selected = commerceTab === tab;
                return (
                  <button
                    aria-selected={selected}
                    className={cn(
                      "min-h-9 rounded-lg px-4 text-ui-sm transition-colors",
                      selected
                        ? "bg-foreground font-medium text-background"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    data-testid={`moss-commerce-tab-${tab}`}
                    key={tab}
                    onClick={() => setCommerceTab(tab)}
                    role="tab"
                    type="button"
                  >
                    {tab === "plans"
                      ? t("mossPay.catalog.plansTab")
                      : t("mossPay.catalog.usageTab")}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      {!showCatalog || commerceTab === "usage" ? (
        accountLoading || quotaLoading ? (
          <MossQuotaSkeleton compact />
        ) : quotaQuery.isError && !quota ? (
          <Alert className="mt-4" variant="error">
            <AlertTitle>{t("mossPay.quota.loadFailedTitle")}</AlertTitle>
            <AlertDescription>{safeMossPayErrorMessage(quotaQuery.error, locale)}</AlertDescription>
          </Alert>
        ) : quota ? (
          <div className="mt-4 space-y-3 rounded-lg bg-muted/50 p-3">
            <div aria-labelledby="moss-pay-text-quota-heading">
              <div className="flex items-center justify-between text-ui-sm text-muted-foreground">
                <span id="moss-pay-text-quota-heading">
                  {quotaHeading}
                  {quota.planCode ? ` (${quota.planCode})` : ""}
                </span>
              </div>
              <div className="mt-2 divide-y divide-border/60">
                {quota.usageLimits.length === 0 ? (
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <p className="text-ui-sm font-medium text-foreground">
                      {t("mossPay.quota.current")}
                    </p>
                    <span className="text-ui-sm text-muted-foreground">
                      {t("mossPay.quota.unknown")}
                    </span>
                  </div>
                ) : null}
                {quota.usageLimits.map((limit) => {
                  const label =
                    limit.key === "lifetime"
                      ? t(packageCost ? "mossPay.settings.generalLimits" : "mossPay.creditBalance")
                      : limit.key === "five_hour"
                        ? t("mossPay.settings.fiveHourLimit")
                        : limit.key === "weekly"
                          ? t("mossPay.settings.weeklyLimit")
                          : t("mossPay.settings.monthlyLimit");
                  const limitValue = limit.limit;
                  const usedPercent =
                    limitValue === null ? null : (quotaPercent(limit.used, limitValue) ?? 0);
                  const remainingPercent =
                    quotaIsUnlimited || usedPercent === null
                      ? null
                      : Math.max(0, 100 - usedPercent);
                  const windowReset = formatMossPayReset(limit.resetsAt, locale);
                  return (
                    <div className="flex items-center justify-between gap-4 py-2.5" key={limit.key}>
                      <div className="min-w-0">
                        <p className="text-ui-sm font-medium text-foreground">{label}</p>
                        <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
                          {windowReset.valid
                            ? `${t("mossPay.quota.reset")} ${windowReset.formattedAt}`
                            : t("mossPay.quota.noReset")}
                        </p>
                      </div>
                      {quotaIsUnlimited ? (
                        <span className="text-ui-sm text-muted-foreground">
                          {t("mossPay.quota.unlimited")}
                        </span>
                      ) : remainingPercent === null ? (
                        <span className="text-ui-sm text-muted-foreground">
                          {t("mossPay.quota.unknown")}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div
                            aria-label={`${label} ${remainingPercent}%`}
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={remainingPercent}
                            className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
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
                          <span className="min-w-14 text-right text-ui-sm text-muted-foreground tabular-nums">
                            {format("mossPay.settings.remainingPercent", {
                              value: formatMossPayCount(remainingPercent, locale),
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border-t border-border/60 pt-3">
              <div className="flex items-center justify-between gap-3 text-ui-sm text-muted-foreground">
                <span>{t("mossPay.realtime.title")}</span>
                <span className="text-right tabular-nums">
                  {realtimeQuotaIsUnlimited
                    ? t("mossPay.quota.unlimited")
                    : realtimeRemainingPercent !== null
                      ? format("mossPay.settings.remainingPercent", {
                          value: formatMossPayCount(realtimeRemainingPercent, locale),
                        })
                      : !quota.realtimeConfigured
                        ? t("mossPay.realtime.notIncluded")
                        : quota.quotaPolicyMode === "unavailable"
                          ? t("mossPay.quota.unknown")
                          : t("mossPay.realtime.notIncluded")}
                </span>
              </div>
              {realtimeRemainingPercent !== null ? (
                <div
                  aria-label={`${t("mossPay.realtime.title")} ${realtimeRemainingPercent}%`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={realtimeRemainingPercent}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      realtimeRemainingPercent <= 10 ? "bg-destructive" : "bg-violet-500",
                    )}
                    style={{ width: `${realtimeRemainingPercent}%` }}
                  />
                </div>
              ) : null}
              {quota.realtimeConfigured ? (
                <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-1 text-ui-xs text-muted-foreground">
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
                    <span className="tabular-nums">
                      {format("mossPay.realtime.sessions", {
                        used: formatMossPayCount(quota.realtimeSessionsUsed, locale),
                        limit: formatMossPayCount(quota.realtimeSessionLimit, locale),
                      })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null
      ) : null}

      {showCatalog && createOrder.error ? (
        <Alert className="mt-4" variant="error">
          <AlertTitle>{t("mossPay.order.createFailed")}</AlertTitle>
          <AlertDescription>
            {safeMossPayOrderErrorMessage(createOrder.error, locale)}
          </AlertDescription>
        </Alert>
      ) : null}

      {showCatalog && activeOrderNo && orderQuery.isError ? (
        <Alert className="mt-4" variant="error">
          <AlertTitle>{t("mossPay.order.statusFailed")}</AlertTitle>
          <AlertDescription>
            {safeMossPayOrderErrorMessage(orderQuery.error, locale)}
          </AlertDescription>
          <Button
            className="mt-2"
            onClick={() => setActiveOrderNo(null)}
            size="sm"
            variant="outline"
          >
            {t("mossPay.order.close")}
          </Button>
        </Alert>
      ) : showCatalog &&
        activeOrderNo &&
        order &&
        (order.refundReviewRequired || order.status === "paid") ? (
        <Alert className="mt-4" variant="default">
          <AlertTitle>
            {t(
              order.refundReviewRequired
                ? "mossPay.order.refundReview"
                : "mossPay.order.fulfillmentPending",
            )}
          </AlertTitle>
          <AlertDescription>
            {t(
              order.refundReviewRequired
                ? "mossPay.order.refundReviewDescription"
                : "mossPay.order.fulfillmentPendingDescription",
            )}
          </AlertDescription>
        </Alert>
      ) : showCatalog && activeOrderNo && order && !orderSettled ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border p-4">
          {rail?.kind === "hosted" || order.checkoutUrl ? (
            <>
              <p className="text-ui-lg font-medium">
                {format("mossPay.order.stripe", {
                  amount: formatMossPayOrderAmount(order, locale),
                })}
              </p>
              <Button
                disabled={!order.checkoutUrl}
                onClick={() => {
                  if (order.checkoutUrl) void openHostedCheckout(order.checkoutUrl);
                }}
              >
                {t("mossPay.order.openStripe")}
              </Button>
            </>
          ) : (
            <>
              <p className="text-ui-lg font-medium">
                {format("mossPay.order.scan", {
                  amount: formatMossPayOrderAmount(order, locale),
                })}
              </p>
              {order.codeUrl ? (
                <QrCode size={220} value={order.codeUrl} />
              ) : (
                <p className="text-ui-sm text-muted-foreground">
                  {t("mossPay.order.generatingQr")}
                </p>
              )}
            </>
          )}
          <p className="text-ui-sm text-muted-foreground">
            {orderQuery.isFetching ? t("mossPay.order.waiting") : t("mossPay.order.autoCredit")}
          </p>
          <Button onClick={() => setActiveOrderNo(null)} size="sm" variant="ghost">
            {t("mossPay.order.cancel")}
          </Button>
        </div>
      ) : showCatalog && orderSettled ? (
        <Alert className="mt-4" variant="default">
          <AlertTitle>{t("mossPay.order.paid")}</AlertTitle>
          <AlertDescription>{t("mossPay.order.received")}</AlertDescription>
        </Alert>
      ) : null}

      {showCatalog && commerceTab === "plans" && catalogLoading ? (
        <MossPayCatalogSkeleton />
      ) : showCatalog && commerceTab === "plans" && catalogQuery.isError ? (
        <p className="px-5 py-6 text-ui-lg text-muted-foreground sm:px-6">
          {t("mossPay.catalog.failed")}
        </p>
      ) : showCatalog && commerceTab === "plans" && catalog ? (
        <div className="space-y-6 px-5 py-6 sm:px-6" data-testid="moss-commerce-plans">
          {catalog.plans.length > 0 ? (
            <div>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("mossPay.catalog.plans")}
                  </p>
                  <p className="mt-1 text-ui-sm text-muted-foreground">
                    {t("mossPay.catalog.monthlyOnly")}
                  </p>
                </div>
                <p className="shrink-0 text-ui-sm text-muted-foreground">
                  {rail?.displayName ?? t("mossPay.catalog.paymentMethodUnavailable")}
                </p>
              </div>
              <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {catalog.plans
                  .filter((plan) => plan.monthlyPriceCny > 0)
                  .map((plan) => (
                    <article
                      className="flex min-w-0 flex-col rounded-2xl border bg-card p-4"
                      key={plan.code}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-ui-lg font-semibold">
                          {plan.displayName}
                        </p>
                        {quota?.planCode === plan.code ? (
                          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-ui-2xs font-medium text-muted-foreground">
                            {t("mossPay.catalog.current")}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-4 text-2xl font-semibold tracking-tight">
                        {formatCny(plan.monthlyPriceCny, locale)}
                        <span className="ml-1 text-ui-sm font-normal text-muted-foreground">
                          {t("mossPay.catalog.perMonth")}
                        </span>
                      </p>
                      <div className="mt-4 space-y-2 text-ui-sm text-muted-foreground">
                        {plan.billingModel !== "cost_budget_v1" && (
                          <p>
                            {format("mossPay.membership.standardTasks", {
                              value: formatMossPayCount(plan.standardTaskEstimate, locale),
                            })}
                          </p>
                        )}
                        <p>{t("mossPay.membership.weightedUsage")}</p>
                        {plan.billingModel !== "cost_budget_v1" &&
                        plan.estimatedRealtimeMinutes > 0 ? (
                          <p>
                            {format("mossPay.catalog.realtimePlan", {
                              minutes: formatMossPayCount(plan.estimatedRealtimeMinutes, locale),
                              sessions: formatMossPayCount(
                                plan.monthlyRealtimeSessionLimit,
                                locale,
                              ),
                            })}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        className="mt-5 w-full"
                        disabled={createOrder.isPending || !rail}
                        onClick={() => startOrder("plan", plan.code)}
                        size="sm"
                        variant={quota?.planCode === plan.code ? "default" : "outline"}
                      >
                        {t("mossPay.catalog.subscribe")}
                      </Button>
                    </article>
                  ))}
              </div>
            </div>
          ) : null}

          {!packageCost && catalog.pointPackages.length > 0 ? (
            <div className="rounded-2xl border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {t("mossPay.catalog.points")}
                  </p>
                  <p className="mt-1 text-ui-sm text-muted-foreground">
                    {t("mossPay.catalog.pointsDescription")}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-background px-2 py-1 text-ui-2xs text-muted-foreground">
                  {t("mossPay.creditBalance")}
                </span>
              </div>
              <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {catalog.pointPackages.map((pkg) => (
                  <div
                    className="flex min-w-0 flex-col rounded-xl border bg-background p-3"
                    key={pkg.code}
                  >
                    <p className="truncate text-ui-lg font-medium">{pkg.displayName}</p>
                    <p className="mt-2 text-lg font-semibold">{formatCny(pkg.priceCny, locale)}</p>
                    <p className="mt-1 text-ui-sm text-muted-foreground">
                      {format("mossPay.catalog.flexibleCredits", {
                        points: formatMossPayCount(pkg.points, locale),
                      })}
                    </p>
                    <Button
                      className="mt-3 w-full"
                      disabled={createOrder.isPending || !rail}
                      onClick={() => startOrder("points", pkg.code)}
                      size="sm"
                      variant="outline"
                    >
                      {t("mossPay.catalog.buy")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
