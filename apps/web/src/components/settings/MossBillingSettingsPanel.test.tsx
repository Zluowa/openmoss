import type { MossPayCatalog, MossPayQuota } from "@synara/contracts";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope } from "~/localization";

function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>);
}

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

import {
  MossBillingSettingsPanel,
  mossQuotaRemainingPercent,
  resolveMossPlanPresentation,
} from "./MossBillingSettingsPanel";
import { formatMossPayPrice } from "~/components/auth/MossPayPanel";

const SESSION_REFRESHED_AT = "2026-08-13T00:00:00.000Z";
const ACCOUNT_IDENTITY = `cloud:cloud-account:${SESSION_REFRESHED_AT}`;

const quota = (overrides: Partial<MossPayQuota> = {}): MossPayQuota => ({
  planCode: "starter",
  billingModel: "weighted_credits_v1",
  usageLimits: [
    {
      key: "weekly",
      durationSeconds: 604_800,
      limit: 24,
      used: 3,
      resetsAt: "2026-08-17T00:00:00.000Z",
    },
  ],
  quotaPolicyMode: "metered",
  periodStart: "2026-08-10T00:00:00.000Z",
  periodEnd: "2026-08-17T00:00:00.000Z",
  windowId: "provider-window-2026-08-10",
  windowSource: "weekly",
  windowDurationSeconds: 604_800,
  tokenLimit: 100_000,
  tokensUsed: 12_345,
  requestLimit: 500,
  requestsUsed: 42,
  creditBalance: 8,
  realtimeConfigured: true,
  realtimeModelAllowlist: ["gpt-realtime"],
  realtimeCostLimitNanoUsd: 500_000_000,
  realtimeCostUsedNanoUsd: 100_000_000,
  realtimeCostReservedNanoUsd: 20_000_000,
  realtimeSessionLimit: 20,
  realtimeSessionsUsed: 3,
  realtimeEstimatedMinutesRemaining: 18,
  ...overrides,
});

const catalog = (planCode = "starter"): MossPayCatalog => ({
  plans: [
    {
      code: planCode,
      displayName: "Starter plan",
      monthlyPriceCny: 990,
      monthlyCreditLimit: 87,
      fiveHourCreditLimit: 12,
      weeklyCreditLimit: 24,
      standardTaskEstimate: 30,
      billingModel: "weighted_credits_v1",
      monthlyTokenLimit: 100_000,
      monthlyRequestLimit: 500,
      modelAllowlist: [],
      monthlyRealtimeCostLimitNanoUsd: 500_000_000,
      monthlyRealtimeSessionLimit: 20,
      realtimeModelAllowlist: [],
      estimatedRealtimeMinutes: 18,
      sortOrder: 0,
    },
  ],
  pointPackages: [],
  paymentMethods: [{ id: "wechat_pay", displayName: "微信支付", kind: "qr" }],
});

function renderSettings(
  input: {
    readonly snapshot?: MossPayQuota;
    readonly catalogSnapshot?: MossPayCatalog;
    readonly catalogError?: Error;
  } = {},
): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    session: null,
  } as never);
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: true,
    authenticated: true,
    account: { id: "cloud-account" },
    session: { accountId: "cloud-account", refreshedAt: SESSION_REFRESHED_AT },
    modelGatewayConfigured: true,
  } as never);
  queryClient.setQueryData(
    serverMossPayCatalogQueryOptions().queryKey,
    input.catalogSnapshot ?? catalog(),
  );
  if (input.catalogError) {
    queryClient
      .getQueryCache()
      .find({ queryKey: serverMossPayCatalogQueryOptions().queryKey })
      ?.setState({
        error: input.catalogError,
        fetchStatus: "idle",
        status: "error",
      });
  }
  if (input.snapshot) {
    queryClient.setQueryData(
      serverMossPayQuotaQueryOptions({ accountIdentity: ACCOUNT_IDENTITY }).queryKey,
      input.snapshot,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MossBillingSettingsPanel />
    </QueryClientProvider>,
  );
}

function renderBillingLoading(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
    configured: true,
    authenticated: true,
    session: { id: "phone-session", user: { id: "phone-user" } },
  } as never);
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: false,
    authenticated: false,
    account: null,
    session: null,
    modelGatewayConfigured: false,
  } as never);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MossBillingSettingsPanel />
    </QueryClientProvider>,
  );
}

describe("MossBillingSettingsPanel", () => {
  it("shows one package usage allowance without separate credit or media purchases", () => {
    const markup = renderSettings({ snapshot: quota({ billingModel: "cost_budget_v1" }) });
    expect(markup).toContain('data-testid="moss-pricing-view-plans"');
    expect(markup).toContain("剩余");
    expect(markup).not.toContain('data-testid="moss-pricing-buy-credits"');
    expect(markup).not.toContain("媒体积分");
    expect(markup).not.toContain("自动充值");
    expect(markup).not.toContain("赠送额度");
  });
  it("formats authoritative plan prices without inventing a fallback price", () => {
    expect(formatMossPayPrice(990, "zh-CN")).toBe("¥9.90");
    expect(
      resolveMossPlanPresentation({
        planCode: "starter-trial",
        catalog: undefined,
        unavailableLabel: "Unavailable",
      }).plan,
    ).toBeNull();
  });

  it("reports remaining quota percentages only for numeric bounds", () => {
    expect(mossQuotaRemainingPercent(12_345, 100_000)).toBe(88);
    expect(mossQuotaRemainingPercent(0, 0)).toBe(100);
    expect(mossQuotaRemainingPercent(1, null)).toBeNull();
  });

  it("uses the catalog display name when it matches the authoritative quota plan", () => {
    const presentation = resolveMossPlanPresentation({
      planCode: "starter",
      catalog: catalog(),
      unavailableLabel: "Unavailable",
    });

    expect(presentation.name).toBe("Starter plan");
    expect(presentation.plan?.code).toBe("starter");
  });

  it("falls back to the quota plan code when catalog data is unavailable", () => {
    expect(
      resolveMossPlanPresentation({
        planCode: "starter-trial",
        catalog: undefined,
        unavailableLabel: "Unavailable",
      }),
    ).toMatchObject({ name: "starter-trial", plan: null });
    expect(
      resolveMossPlanPresentation({
        planCode: null,
        catalog: undefined,
        unavailableLabel: "Unavailable",
      }),
    ).toMatchObject({ name: "Unavailable", plan: null });
  });

  it("keeps real credits and quota visible while routing both CTAs to the commerce home", () => {
    const markup = renderSettings({ snapshot: quota() });

    expect(markup).toContain("Starter plan");
    expect(markup).toContain("8");
    expect(markup).toContain("每周使用限额");
    expect(markup).toContain("剩余 88%");
    expect(markup).not.toContain("100,000");
    expect(markup).toContain('data-testid="moss-pricing-view-plans"');
    expect(markup).toContain('data-testid="moss-pricing-buy-credits"');
    expect(markup).toContain("自动充值");
    expect(markup).toContain("赠送额度");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("订阅档位");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("mossPay.order");
  });

  it("shows a lightweight catalog failure while retaining the quota plan fallback", () => {
    const markup = renderSettings({
      snapshot: quota({ planCode: "starter-trial" }),
      catalogSnapshot: catalog("other-plan"),
      catalogError: new Error("catalog unavailable"),
    });

    expect(markup).toContain("starter-trial");
    expect(markup).toContain("套餐代码：starter-trial");
    expect(markup).not.toContain("{code}");
    expect(markup).toContain("档位暂时不可用");
    expect(markup).toContain('data-testid="moss-pricing-view-plans"');
    expect(markup).toContain('data-testid="moss-pricing-buy-credits"');
  });

  it("keeps null metered limits unavailable instead of treating them as unlimited", () => {
    const markup = renderSettings({
      snapshot: quota({
        quotaPolicyMode: "metered",
        usageLimits: [
          {
            key: "weekly",
            durationSeconds: 604_800,
            limit: null,
            used: 0,
            resetsAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        tokenLimit: null,
        requestLimit: null,
        realtimeConfigured: false,
        realtimeCostLimitNanoUsd: null,
        realtimeSessionLimit: null,
      }),
    });

    expect(markup).toContain("每周使用限额");
    expect(markup).not.toContain("不限");
  });

  it("keeps the billing surface on skeletons while catalog and quota are pending", () => {
    const markup = renderBillingLoading();

    expect(markup).toContain('data-testid="moss-billing-skeleton"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("套餐暂不可用");
    expect(markup).not.toContain("暂不可用");
  });
});
