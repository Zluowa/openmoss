// FILE: MossMembershipPage.tsx
// Purpose: Full-page Moss membership catalog aligned with the quiet Codex/Kimi plan picker.
// The server remains authoritative for purchasable SKUs and the account-specific payment rail.

import type { MossPayPlan } from "@synara/contracts";
import { isMossPayOrderSettled } from "@synara/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  formatMossPayCount,
  formatMossPayPrice,
  isMossPayAccountTransitionPending,
  resolveMossPayQuotaAccountIdentity,
} from "~/components/auth/MossPayPanel";
import {
  formatMossMembershipPriceNumber,
  isCurrentMossPlan,
  mossMembershipAgentUsageMultiplier,
  mossMembershipPlanName,
  visibleMossMembershipPlans,
} from "~/components/auth/MossMembershipPage.logic";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { MossPayOrderDialog as MembershipOrderStatus } from "./MossPayOrderDialog";
import {
  ArrowLeftIcon,
  BrainIcon,
  MessageCircleIcon,
  UsersIcon,
  ZapIcon,
  type LucideIcon,
} from "~/lib/icons";
import { GaugeIcon } from "./mossIcons";
import { serverMutationKeys } from "~/lib/serverReactQuery";
import {
  mossServerMutationKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayCreateOrderMutationOptions,
  serverMossPayOrderQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./mossServerReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

export type MossMembershipFocus = "plans" | "credits";

function PlanFeature({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <li className="flex items-start gap-3 text-ui leading-5 text-foreground/85">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 stroke-[1.6]" />
      <span>{children}</span>
    </li>
  );
}

function MembershipCatalogSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("mossPay.catalog.loading")}
      className="grid min-w-0 grid-cols-1 justify-center gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-6"
      data-testid="moss-membership-skeleton"
      role="status"
    >
      {["basic", "plus", "pro", "max"].map((key) => (
        <article
          className="flex min-h-[560px] flex-col rounded-2xl border border-border/70 bg-background px-7 py-7"
          key={key}
        >
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-7 w-24 rounded-lg" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <Skeleton className="mt-10 h-12 w-40 rounded-lg" />
          <Skeleton className="mt-5 h-4 w-44 rounded-full" />
          <Skeleton className="mt-8 h-11 w-full rounded-full" />
          <div className="mt-8 space-y-4">
            <Skeleton className="h-4 w-32 rounded-full" />
            <Skeleton className="h-4 w-11/12 rounded-full" />
            <Skeleton className="h-4 w-10/12 rounded-full" />
            <Skeleton className="h-4 w-9/12 rounded-full" />
            <Skeleton className="h-4 w-8/12 rounded-full" />
          </div>
        </article>
      ))}
    </div>
  );
}

function MembershipBusinessSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("mossPay.catalog.loading")}
      className="mx-auto mt-7 grid max-w-[960px] gap-5 md:grid-cols-2"
      data-testid="moss-membership-business-skeleton"
      role="status"
    >
      {["current", "business"].map((key) => (
        <article
          className="flex min-h-[560px] flex-col rounded-2xl border border-border/70 bg-background px-7 py-7"
          key={key}
        >
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-7 w-32 rounded-lg" />
            <Skeleton className="h-5 w-5 rounded-full" />
          </div>
          <Skeleton className="mt-16 h-12 w-40 rounded-lg" />
          <Skeleton className="mt-8 h-4 w-48 rounded-full" />
          <div className="mt-8 space-y-4">
            <Skeleton className="h-4 w-40 rounded-full" />
            <Skeleton className="h-4 w-11/12 rounded-full" />
            <Skeleton className="h-4 w-10/12 rounded-full" />
          </div>
          <Skeleton className="mt-auto h-11 w-full rounded-full" />
        </article>
      ))}
    </div>
  );
}

function PersonalPlanCard({
  plan,
  basicMonthlyPriceCny,
  current,
  paymentMethod,
  pending,
  onSelect,
}: {
  readonly plan: MossPayPlan;
  readonly basicMonthlyPriceCny: number;
  readonly current: boolean;
  readonly paymentMethod: string | null;
  readonly pending: boolean;
  readonly onSelect: () => void;
}) {
  const { format, locale, t } = useTranslation();
  const agentUsageMultiplier = mossMembershipAgentUsageMultiplier(plan, basicMonthlyPriceCny);
  const lead = (() => {
    switch (plan.code) {
      case "basic":
        return t("mossPay.membership.basicLead");
      case "plus":
        return t("mossPay.membership.plusLead");
      case "pro":
        return t("mossPay.membership.proLead");
      case "max":
        return t("mossPay.membership.maxLead");
      default:
        return t("mossPay.membership.defaultLead");
    }
  })();
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border bg-background px-6 py-7",
        "border-border/70 md:min-h-[620px]",
      )}
      data-plan-code={plan.code}
      data-testid={`moss-membership-plan-${plan.code}`}
    >
      <h2
        className="truncate text-[28px] leading-8 font-semibold tracking-[-0.03em]"
        data-translation-skip="true"
      >
        {mossMembershipPlanName(plan)}
      </h2>
      <div className="mt-8 flex min-h-14 items-end gap-1.5">
        <span className="pb-1 text-[18px] text-muted-foreground">¥</span>
        <span className="text-[48px] leading-none font-semibold tracking-[-0.05em] tabular-nums">
          {formatMossMembershipPriceNumber(plan.monthlyPriceCny, locale)}
        </span>
        <span className="pb-1 text-ui-sm text-muted-foreground">
          {t("mossPay.catalog.perMonth")}
        </span>
      </div>
      <p className="mt-4 min-h-10 text-[15px] leading-5 font-medium">{lead}</p>
      <button
        className={cn(
          "mt-5 flex h-11 w-full items-center justify-center rounded-full border px-4 text-ui-lg font-medium transition-colors",
          current
            ? "cursor-default border-transparent bg-muted text-muted-foreground"
            : "border-border bg-background hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
        data-testid={`moss-membership-subscribe-${plan.code}`}
        disabled={current || pending}
        onClick={onSelect}
        type="button"
      >
        {current ? t("mossPay.membership.currentButton") : t("mossPay.catalog.subscribe")}
      </button>
      <p className="mt-2 min-h-4 text-center text-ui-xs text-muted-foreground">
        {paymentMethod
          ? format("mossPay.membership.paymentVia", { method: paymentMethod })
          : t("mossPay.catalog.paymentMethodUnavailable")}
      </p>
      <div className="mt-6 border-t border-border/55 pt-5">
        <p className="mb-4 text-ui font-medium">{t("mossPay.membership.included")}</p>
        <ul className="space-y-4">
          <PlanFeature icon={BrainIcon}>{t("mossPay.membership.allModels")}</PlanFeature>
          <PlanFeature icon={MessageCircleIcon}>
            {format("mossPay.membership.agentUsageMultiplier", {
              value: formatMossPayCount(agentUsageMultiplier, locale),
            })}
          </PlanFeature>
          <PlanFeature icon={GaugeIcon}>{t("mossPay.membership.weightedUsage")}</PlanFeature>
          <PlanFeature icon={GaugeIcon}>{t("mossPay.membership.rollingWindows")}</PlanFeature>
          <PlanFeature icon={ZapIcon}>{t("mossPay.membership.codingAgent")}</PlanFeature>
          {plan.estimatedRealtimeMinutes > 0 ? (
            <PlanFeature icon={ZapIcon}>
              {format("mossPay.catalog.realtimePlan", {
                minutes: formatMossPayCount(plan.estimatedRealtimeMinutes, locale),
                sessions: formatMossPayCount(plan.monthlyRealtimeSessionLimit, locale),
              })}
            </PlanFeature>
          ) : null}
        </ul>
      </div>
    </article>
  );
}

export function MossMembershipPage({
  initialFocus = "plans",
  onBack,
}: {
  readonly initialFocus?: MossMembershipFocus;
  readonly onBack?: () => void;
}) {
  const { format, locale, t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [audience, setAudience] = useState<"personal" | "business">("personal");
  const [activeOrderNo, setActiveOrderNo] = useState<string | null>(null);
  const creditsRef = useRef<HTMLElement | null>(null);
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const phoneLoginCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossPhoneLogin() });
  const phoneLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossLogout() });
  const cloudSwitchCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossCloudSelect() });
  const cloudLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossCloudLogout() });
  const accountTransitionPending = isMossPayAccountTransitionPending({
    phoneLoginCount,
    phoneLogoutCount,
    cloudAccountSwitchCount: cloudSwitchCount,
    cloudLogoutCount,
  });
  const accountIdentity = resolveMossPayQuotaAccountIdentity(
    phoneAccountQuery.data,
    cloudAccountQuery.data,
    accountTransitionPending,
  );
  const catalogQuery = useQuery(serverMossPayCatalogQueryOptions());
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: accountIdentity !== null,
      accountIdentity,
    }),
  );
  const createOrder = useMutation(serverMossPayCreateOrderMutationOptions({ queryClient }));
  const orderQuery = useQuery(serverMossPayOrderQueryOptions(activeOrderNo));
  const catalog = catalogQuery.data;
  const quota = accountTransitionPending ? undefined : quotaQuery.data;
  const catalogLoading = catalogQuery.isPending && !catalog;
  const accountLoading =
    accountTransitionPending ||
    (accountIdentity === null &&
      (phoneAccountQuery.isPending ||
        phoneAccountQuery.isFetching ||
        cloudAccountQuery.isPending ||
        cloudAccountQuery.isFetching));
  const quotaLoading = accountIdentity !== null && quotaQuery.isPending && !quota;
  const membershipLoading = catalogLoading || accountLoading || quotaLoading;
  const rail =
    catalog?.paymentMethods[0] ??
    (phoneAccountQuery.data?.authenticated
      ? ({ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" } as const)
      : cloudAccountQuery.data?.authenticated
        ? ({ id: "stripe_checkout", displayName: "Stripe", kind: "hosted" } as const)
        : null);
  const plans = useMemo(() => visibleMossMembershipPlans(catalog?.plans ?? []), [catalog?.plans]);
  const basicMonthlyPriceCny =
    plans.find((plan) => plan.code === "basic")?.monthlyPriceCny ?? 4_900;
  const currentPlan = quota?.planCode
    ? (catalog?.plans.find((plan) => plan.code === quota.planCode) ?? null)
    : null;
  const currentPlanName =
    (currentPlan ? mossMembershipPlanName(currentPlan) : null) ??
    quota?.planCode ??
    t("mossPay.settings.planUnavailable");

  useEffect(() => {
    if (
      orderQuery.data &&
      isMossPayOrderSettled(orderQuery.data.status, orderQuery.data.refundReviewRequired)
    ) {
      void quotaQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderQuery.data?.status]);

  useEffect(() => {
    if (initialFocus !== "credits" || !catalog || !creditsRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      creditsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [catalog, initialFocus]);

  const startOrder = (orderType: "plan" | "points", itemCode: string) => {
    createOrder.mutate(
      { orderType, itemCode },
      {
        onSuccess: (created) => setActiveOrderNo(created.outTradeNo || null),
      },
    );
  };
  const clearOrder = () => {
    setActiveOrderNo(null);
    createOrder.reset();
  };
  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    void navigate({ to: "/settings", search: { section: "usage" } });
  };

  return (
    <main
      className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground"
      data-testid="moss-membership-page"
    >
      <header className="drag-region relative z-10 flex h-[46px] shrink-0 items-center border-b border-border/55 bg-background pl-[92px] pr-6">
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-ui-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          data-testid="moss-membership-back"
          onClick={handleBack}
          type="button"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          {t("mossPay.membership.back")}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="moss-membership-scroll">
        <div className="mx-auto w-full max-w-[1480px] px-4 pt-10 pb-20 sm:px-8">
          <h1 className="text-center text-[28px] leading-9 font-semibold tracking-[-0.035em]">
            {t("mossPay.membership.title")}
          </h1>
          <div
            aria-label={t("mossPay.membership.audienceLabel")}
            className="mx-auto mt-6 grid h-11 w-full max-w-[352px] grid-cols-2 rounded-full bg-muted p-1"
            role="tablist"
          >
            {(["personal", "business"] as const).map((value) => {
              const selected = audience === value;
              return (
                <button
                  aria-controls={`moss-membership-${value}`}
                  aria-selected={selected}
                  className={cn(
                    "rounded-full text-ui-lg font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`moss-membership-audience-${value}`}
                  key={value}
                  onClick={() => setAudience(value)}
                  role="tab"
                  type="button"
                >
                  {value === "personal"
                    ? t("mossPay.membership.personal")
                    : t("mossPay.membership.business")}
                </button>
              );
            })}
          </div>
          {membershipLoading && !rail ? (
            <Skeleton
              aria-label={t("mossPay.catalog.loading")}
              className="mx-auto mt-3 h-3.5 w-32 rounded-full"
              data-testid="moss-membership-payment-skeleton"
            />
          ) : (
            <p
              className="mt-3 text-center text-ui-sm text-muted-foreground"
              data-testid="moss-payment-method"
            >
              {rail?.displayName ?? t("mossPay.catalog.paymentMethodUnavailable")}
            </p>
          )}

          {audience === "personal" ? (
            <section
              aria-labelledby="moss-membership-personal-heading"
              className="mt-7"
              data-testid="moss-membership-personal"
              id="moss-membership-personal"
              role="tabpanel"
            >
              <h2 className="sr-only" id="moss-membership-personal-heading">
                {t("mossPay.membership.personal")}
              </h2>
              {membershipLoading ? (
                <MembershipCatalogSkeleton />
              ) : catalogQuery.isError ? (
                <p className="py-20 text-center text-ui-lg text-muted-foreground" role="status">
                  {t("mossPay.catalog.failed")}
                </p>
              ) : plans.length > 0 ? (
                <div
                  className="grid min-w-0 grid-cols-1 justify-center gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-6"
                  data-testid="moss-membership-plans"
                >
                  {plans.map((plan) => (
                    <PersonalPlanCard
                      basicMonthlyPriceCny={basicMonthlyPriceCny}
                      current={isCurrentMossPlan(quota?.planCode, plan.code)}
                      key={plan.code}
                      onSelect={() => startOrder("plan", plan.code)}
                      paymentMethod={rail?.displayName ?? null}
                      pending={createOrder.isPending}
                      plan={plan}
                    />
                  ))}
                </div>
              ) : (
                <p className="py-20 text-center text-ui-lg text-muted-foreground" role="status">
                  {t("mossPay.membership.noPlans")}
                </p>
              )}
            </section>
          ) : membershipLoading ? (
            <MembershipBusinessSkeleton />
          ) : (
            <section
              aria-labelledby="moss-membership-business-heading"
              className="mx-auto mt-7 grid max-w-[960px] gap-5 md:grid-cols-2"
              data-testid="moss-membership-business"
              id="moss-membership-business"
              role="tabpanel"
            >
              <article className="flex min-h-[560px] flex-col rounded-2xl border border-border/70 bg-background px-7 py-7">
                <h2 className="text-[26px] font-semibold tracking-[-0.025em]">{currentPlanName}</h2>
                {currentPlan ? (
                  <p className="mt-16 text-[42px] leading-none font-semibold tracking-[-0.04em]">
                    {formatMossPayPrice(currentPlan.monthlyPriceCny, locale)}
                    <span className="ml-1.5 text-ui-sm font-normal text-muted-foreground">
                      {t("mossPay.catalog.perMonth")}
                    </span>
                  </p>
                ) : (
                  <p className="mt-16 text-2xl font-semibold">
                    {t("mossPay.membership.personalPlan")}
                  </p>
                )}
                <p className="mt-8 text-ui-lg font-semibold">
                  {format("mossPay.membership.currentSummary", { plan: currentPlanName })}
                </p>
                {currentPlan ? (
                  <ul className="mt-8 space-y-4">
                    <PlanFeature icon={MessageCircleIcon}>
                      {format("mossPay.membership.agentUsageMultiplier", {
                        value: formatMossPayCount(
                          mossMembershipAgentUsageMultiplier(currentPlan, basicMonthlyPriceCny),
                          locale,
                        ),
                      })}
                    </PlanFeature>
                    <PlanFeature icon={GaugeIcon}>
                      {t("mossPay.membership.weightedUsage")}
                    </PlanFeature>
                    <PlanFeature icon={ZapIcon}>{t("mossPay.membership.codingAgent")}</PlanFeature>
                  </ul>
                ) : null}
                <button
                  className="mt-auto h-11 w-full cursor-default rounded-full bg-muted text-ui-lg font-medium text-muted-foreground"
                  disabled
                  type="button"
                >
                  {t("mossPay.membership.currentButton")}
                </button>
              </article>
              <article className="flex min-h-[560px] flex-col rounded-2xl border border-blue-300/70 bg-blue-50/70 px-7 py-7 text-slate-950 dark:border-blue-700/70 dark:bg-blue-950/25 dark:text-foreground">
                <div className="flex items-start justify-between gap-3">
                  <h2
                    className="text-[26px] font-semibold tracking-[-0.025em]"
                    id="moss-membership-business-heading"
                  >
                    {t("mossPay.membership.businessTitle")}
                  </h2>
                  <UsersIcon
                    aria-hidden="true"
                    className="size-5 text-blue-600 dark:text-blue-300"
                  />
                </div>
                <p className="mt-10 text-lg font-semibold">
                  {t("mossPay.membership.businessSoon")}
                </p>
                <p className="mt-3 text-ui-lg leading-6 text-slate-600 dark:text-muted-foreground">
                  {t("mossPay.membership.businessDescription")}
                </p>
                <p className="mt-8 text-ui-lg font-medium">
                  {t("mossPay.membership.businessLead")}
                </p>
                <button
                  className="mt-auto h-11 w-full cursor-default rounded-full bg-blue-600 text-ui-lg font-semibold text-white opacity-55"
                  data-testid="moss-membership-business-unavailable"
                  disabled
                  type="button"
                >
                  {t("mossPay.membership.businessUnavailable")}
                </button>
              </article>
            </section>
          )}

          {audience === "personal" && plans.length > 0 ? (
            <p className="mx-auto mt-5 max-w-3xl text-center text-ui-xs leading-4 text-muted-foreground">
              {t("mossPay.membership.weightedEstimateNote")}
            </p>
          ) : null}

          <MembershipOrderStatus
            activeOrderNo={activeOrderNo}
            clearOrder={clearOrder}
            createError={createOrder.error}
            order={orderQuery.data}
            orderError={orderQuery.error}
            orderIsFetching={orderQuery.isFetching}
            railKind={rail?.kind ?? null}
          />

          {catalog && catalog.pointPackages.length > 0 ? (
            <section
              className="mt-16 scroll-mt-8 border-t border-border/60 pt-10"
              data-testid="moss-membership-credits"
              id="moss-credit-packs"
              ref={creditsRef}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">
                    {t("mossPay.membership.pointsHeading")}
                  </h2>
                  <p className="mt-1.5 text-ui-lg text-muted-foreground">
                    {t("mossPay.membership.pointsLead")}
                  </p>
                </div>
                <p className="mt-2 text-ui-sm text-muted-foreground sm:mt-0">
                  {rail?.displayName ?? t("mossPay.catalog.paymentMethodUnavailable")}
                </p>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {catalog.pointPackages
                  .toSorted((left, right) => left.sortOrder - right.sortOrder)
                  .map((pointPackage) => (
                    <article
                      className="rounded-2xl border border-border/70 bg-background p-5"
                      key={pointPackage.code}
                    >
                      <h3 className="text-base font-semibold">{pointPackage.displayName}</h3>
                      <p className="mt-3 text-3xl font-semibold tracking-tight">
                        {formatMossPayPrice(pointPackage.priceCny, locale)}
                      </p>
                      <p className="mt-2 text-ui-sm text-muted-foreground">
                        {format("mossPay.catalog.flexibleCredits", {
                          points: formatMossPayCount(pointPackage.points, locale),
                        })}
                      </p>
                      <Button
                        className="mt-5 w-full rounded-full"
                        data-testid={`moss-membership-buy-${pointPackage.code}`}
                        disabled={createOrder.isPending}
                        onClick={() => startOrder("points", pointPackage.code)}
                        variant="outline"
                      >
                        {t("mossPay.catalog.buy")}
                      </Button>
                    </article>
                  ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
