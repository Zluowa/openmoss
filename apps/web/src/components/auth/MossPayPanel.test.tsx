import type {
  MossAccountSessionId,
  MossAccountUserId,
  MossCloudAccountId,
  MossPayQuota,
} from "@synara/contracts";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./mossServerReactQuery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope, translateMoss } from "~/localization";

function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(<MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>);
}
import {
  formatMossPayCount,
  formatMossPayReset,
  isMossPayAccountTransitionPending,
  isMossPayQuotaUnlimited,
  isWeeklyMossQuotaWindow,
  MossPayPanel,
  mossPayQuotaIdentityKey,
  resolveMossPayQuotaAccountIdentity,
  safeMossPayErrorMessage,
} from "./MossPayPanel";
import { safeMossPayOrderErrorMessage } from "./MossMembershipPage.logic";

const SESSION_REFRESHED_AT = "2026-08-13T00:00:00.000Z";

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
  windowSource: "provider-defined",
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

function renderPanel(input: {
  readonly selectedAccountId?: string;
  readonly phoneAccountId?: string;
  readonly phoneSessionId?: string;
  readonly phoneAccountResolution?: "authenticated" | "signed-out" | "unknown";
  readonly quotaAccountId?: string;
  readonly quotaIdentity?: string;
  readonly snapshot?: MossPayQuota;
  readonly quotaError?: Error;
  readonly showCatalog?: boolean;
  readonly catalogPlanName?: string;
}): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const phoneAccountResolution =
    input.phoneAccountResolution ??
    (input.phoneAccountId && input.phoneSessionId ? "authenticated" : "signed-out");
  if (phoneAccountResolution === "authenticated" && input.phoneAccountId && input.phoneSessionId) {
    queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
      configured: true,
      authenticated: true,
      session: {
        id: input.phoneSessionId as MossAccountSessionId,
        user: {
          id: input.phoneAccountId as MossAccountUserId,
          phoneNumber: "+8613800138000",
          displayName: "Test",
          role: "member",
          status: "active",
          createdAt: SESSION_REFRESHED_AT,
          updatedAt: SESSION_REFRESHED_AT,
          lastLoginAt: SESSION_REFRESHED_AT,
        },
        createdAt: SESSION_REFRESHED_AT,
        expiresAt: "2026-09-13T00:00:00.000Z",
        lastSeenAt: SESSION_REFRESHED_AT,
      },
      smsProvider: "aliyun",
      aliyunSmsConfigured: true,
    });
  } else if (phoneAccountResolution === "signed-out") {
    queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
      configured: true,
      authenticated: false,
      session: null,
      smsProvider: "aliyun",
      aliyunSmsConfigured: true,
    });
  }
  if (input.selectedAccountId) {
    queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
      configured: true,
      authenticated: true,
      account: {
        id: input.selectedAccountId as MossCloudAccountId,
        email: "test@example.com",
        emailVerified: true,
        displayName: "Test",
        status: "active",
        createdAt: SESSION_REFRESHED_AT,
        updatedAt: SESSION_REFRESHED_AT,
        lastLoginAt: SESSION_REFRESHED_AT,
      },
      session: {
        accountId: input.selectedAccountId as MossCloudAccountId,
        expiresAt: "2026-09-13T00:00:00.000Z",
        refreshedAt: SESSION_REFRESHED_AT,
      },
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    });
  }
  queryClient.setQueryData(serverMossPayCatalogQueryOptions().queryKey, {
    plans: input.catalogPlanName
      ? [
          {
            code: "test-plan",
            displayName: input.catalogPlanName,
            monthlyPriceCny: 100,
            monthlyCreditLimit: 87,
            fiveHourCreditLimit: 12,
            weeklyCreditLimit: 24,
            standardTaskEstimate: 30,
            billingModel: "weighted_credits_v1",
            monthlyTokenLimit: 1_000,
            monthlyRequestLimit: 100,
            modelAllowlist: [],
            monthlyRealtimeCostLimitNanoUsd: 0,
            monthlyRealtimeSessionLimit: 0,
            realtimeModelAllowlist: [],
            estimatedRealtimeMinutes: 0,
            sortOrder: 0,
          },
        ]
      : [],
    pointPackages: [],
    paymentMethods: [{ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" }],
  });
  if (input.snapshot) {
    const queryKey = mossPayQuotaIdentityKey(
      input.quotaIdentity ??
        `cloud:${input.quotaAccountId ?? input.selectedAccountId}:${SESSION_REFRESHED_AT}`,
    );
    queryClient.setQueryData(queryKey, input.snapshot);
    if (input.quotaError) {
      queryClient.getQueryCache().find({ queryKey })?.setState({
        error: input.quotaError,
        fetchStatus: "idle",
        status: "error",
      });
    }
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MossPayPanel
        {...(input.showCatalog === undefined ? {} : { showCatalog: input.showCatalog })}
      />
    </QueryClientProvider>,
  );
}

describe("MossPayPanel quota presentation", () => {
  it("presents a paid cost package as shared remaining usage instead of a separate wallet", () => {
    const markup = renderPanel({
      selectedAccountId: "account-a",
      showCatalog: true,
      snapshot: quota({
        billingModel: "cost_budget_v1",
        usageLimits: [
          { key: "lifetime", limit: 800, used: 200, durationSeconds: null, resetsAt: null },
        ],
      }),
    });
    expect(markup).toContain("剩余 75%");
    expect(markup).not.toContain("积分余额");
    expect(markup).not.toContain("媒体积分");
    expect(markup).not.toContain("自动充值");
  });
  it("calls a window weekly only for an explicit server role or an exact seven-day duration", () => {
    expect(isWeeklyMossQuotaWindow(quota())).toBe(true);
    expect(
      isWeeklyMossQuotaWindow(quota({ windowSource: "weekly", windowDurationSeconds: 2_678_400 })),
    ).toBe(true);
    expect(
      isWeeklyMossQuotaWindow(quota({ windowSource: "monthly", windowDurationSeconds: 2_678_400 })),
    ).toBe(false);
    expect(
      isWeeklyMossQuotaWindow(quota({ windowSource: null, windowDurationSeconds: 604_799 })),
    ).toBe(false);
  });

  it("formats numbers and reset dates with the selected locale", () => {
    expect(formatMossPayCount(12_345, "en")).toBe("12,345");
    expect(formatMossPayCount(12_345, "zh-CN")).toBe("12,345");
    expect(
      formatMossPayReset("2026-08-17T00:00:00.000Z", "en", Date.parse("2026-08-16T00:00:00.000Z")),
    ).toMatchObject({
      valid: true,
      remainingSeconds: 86_400,
    });
    expect(translateMoss("en", "mossPay.quota.weekly")).toBe("Weekly allowance");
    expect(translateMoss("zh-CN", "mossPay.quota.weekly")).toBe("周额度");
  });

  it("keys quota data by exact account identity so a switch cannot flash the old snapshot", () => {
    expect(mossPayQuotaIdentityKey("account-a")).not.toEqual(mossPayQuotaIdentityKey("account-b"));
    expect(mossPayQuotaIdentityKey(null)).toContain(null);
  });

  it("binds quota identity to the current phone session before any cloud account", () => {
    expect(
      resolveMossPayQuotaAccountIdentity(
        {
          authenticated: true,
          session: { id: "phone-session", user: { id: "phone-user" } },
        } as never,
        {
          authenticated: true,
          account: { id: "cloud-account" },
          session: { refreshedAt: SESSION_REFRESHED_AT },
        } as never,
      ),
    ).toBe("phone:phone-user:phone-session");
  });

  it("blocks cloud fallback until the phone query has an explicit signed-out snapshot", () => {
    const cloudState = {
      authenticated: true,
      account: { id: "cloud-account" },
      session: { refreshedAt: SESSION_REFRESHED_AT },
    } as never;

    expect(resolveMossPayQuotaAccountIdentity(undefined, cloudState)).toBeNull();
    expect(resolveMossPayQuotaAccountIdentity(null, cloudState)).toBeNull();
    const unresolvedIdentity = resolveMossPayQuotaAccountIdentity(undefined, cloudState);
    const unresolvedQuery = serverMossPayQuotaQueryOptions({
      enabled: unresolvedIdentity !== null,
      accountIdentity: unresolvedIdentity,
    });
    expect(unresolvedQuery.enabled).toBe(false);
    expect(unresolvedQuery.queryKey).toEqual(mossPayQuotaIdentityKey(null));
    expect(
      resolveMossPayQuotaAccountIdentity(
        { authenticated: true, session: null } as never,
        cloudState,
      ),
    ).toBeNull();
    expect(
      resolveMossPayQuotaAccountIdentity(
        { authenticated: false, session: { id: "stale-phone-session" } } as never,
        cloudState,
      ),
    ).toBeNull();
    expect(
      resolveMossPayQuotaAccountIdentity(
        { authenticated: false, session: null } as never,
        cloudState,
      ),
    ).toBe(`cloud:cloud-account:${SESSION_REFRESHED_AT}`);
  });

  it("suppresses every account identity during login, switching, or logout transitions", () => {
    const phoneState = {
      authenticated: true,
      session: { id: "phone-session", user: { id: "phone-user" } },
    } as never;
    const cloudState = {
      authenticated: true,
      account: { id: "cloud-account" },
      session: { refreshedAt: SESSION_REFRESHED_AT },
    } as never;

    expect(resolveMossPayQuotaAccountIdentity(phoneState, cloudState, true)).toBeNull();
    expect(
      isMossPayAccountTransitionPending({
        phoneLoginCount: 0,
        phoneLogoutCount: 0,
        cloudAccountSwitchCount: 0,
        cloudLogoutCount: 0,
      }),
    ).toBe(false);
    for (const transition of [
      "phoneLoginCount",
      "phoneLogoutCount",
      "cloudAccountSwitchCount",
      "cloudLogoutCount",
    ] as const) {
      expect(
        isMossPayAccountTransitionPending({
          phoneLoginCount: transition === "phoneLoginCount" ? 1 : 0,
          phoneLogoutCount: transition === "phoneLogoutCount" ? 1 : 0,
          cloudAccountSwitchCount: transition === "cloudAccountSwitchCount" ? 1 : 0,
          cloudLogoutCount: transition === "cloudLogoutCount" ? 1 : 0,
        }),
      ).toBe(true);
    }
  });

  it("never renders raw upstream error text", () => {
    const raw = new Error("postgres relation secret_schema.internal_quota does not exist");
    expect(safeMossPayErrorMessage(raw, "en")).toBe("Moss quota is temporarily unavailable.");
    expect(safeMossPayErrorMessage(raw, "zh-CN")).toBe("Moss 额度暂时不可用。");
    expect(safeMossPayErrorMessage(raw, "en")).not.toContain(raw.message);
    expect(safeMossPayOrderErrorMessage(raw, "en")).toBe(
      "The payment service is temporarily unavailable. Try again shortly.",
    );
    expect(safeMossPayOrderErrorMessage(raw, "zh-CN")).toBe("支付服务暂时不可用，请稍后重试。");
    expect(safeMossPayOrderErrorMessage(raw, "en")).not.toContain(raw.message);
  });

  it("renders weighted windows, reset metadata, and Realtime Voice separately", () => {
    const markup = renderPanel({ selectedAccountId: "account-a", snapshot: quota() });

    expect(markup).toContain("周额度");
    expect(markup).toContain("每周使用限额");
    expect(markup).toContain("剩余 87%");
    expect(markup).not.toContain("12,345 / 100,000");
    expect(markup).toContain("重置时间");
    expect(markup).toContain("Realtime Voice");
    expect(markup).toContain('role="progressbar"');
  });

  it("shows Unlimited only for an explicit unlimited policy with null bounds", () => {
    const unlimited = quota({
      quotaPolicyMode: "unlimited",
      tokenLimit: null,
      requestLimit: null,
      realtimeCostLimitNanoUsd: null,
      realtimeSessionLimit: null,
    });
    expect(isMossPayQuotaUnlimited(unlimited)).toBe(true);
    const markup = renderPanel({ selectedAccountId: "account-a", snapshot: unlimited });

    expect(markup).toContain("不限");
    expect(markup).not.toContain("12,345 / 100,000");
    expect(markup).not.toContain('role="progressbar"');
  });

  it("does not label Realtime Voice unlimited when the relay reports it unconfigured", () => {
    const markup = renderPanel({
      selectedAccountId: "account-a",
      snapshot: quota({
        quotaPolicyMode: "unlimited",
        tokenLimit: null,
        requestLimit: null,
        realtimeConfigured: false,
        realtimeCostLimitNanoUsd: null,
        realtimeSessionLimit: null,
      }),
    });

    expect(markup).toContain("当前档位未开通");
  });

  it("keeps null bounds unavailable when the policy is not explicitly unlimited", () => {
    const unavailable = quota({
      quotaPolicyMode: "unavailable",
      usageLimits: [],
      tokenLimit: null,
      requestLimit: null,
      realtimeConfigured: false,
      realtimeCostLimitNanoUsd: null,
      realtimeSessionLimit: null,
    });
    expect(isMossPayQuotaUnlimited(unavailable)).toBe(false);
    expect(
      isMossPayQuotaUnlimited(
        quota({ quotaPolicyMode: "metered", tokenLimit: null, requestLimit: null }),
      ),
    ).toBe(false);
    const markup = renderPanel({ selectedAccountId: "account-a", snapshot: unavailable });

    expect(markup).toContain("暂不可用");
    expect(markup).not.toContain("不限");
    expect(markup).not.toContain('role="progressbar"');
  });

  it("shows the commerce catalog on the account surface when requested", () => {
    const markup = renderPanel({
      selectedAccountId: "account-a",
      snapshot: quota(),
      showCatalog: true,
      catalogPlanName: "Plus",
    });

    expect(markup).toContain("Plus");
    expect(markup).toContain("订阅档位");
  });

  it("hides unfinished commerce by default while keeping quota visible", () => {
    const markup = renderPanel({
      selectedAccountId: "account-a",
      snapshot: quota(),
      catalogPlanName: "Catalog must stay hidden",
    });

    expect(markup).toContain("每周使用限额");
    expect(markup).toContain("Realtime Voice");
    expect(markup).not.toContain("Catalog must stay hidden");
  });

  it("renders weekly quota for a phone-only account session", () => {
    const markup = renderPanel({
      phoneAccountId: "phone-user",
      phoneSessionId: "phone-session",
      quotaIdentity: "phone:phone-user:phone-session",
      snapshot: quota(),
    });

    expect(markup).toContain("周额度");
    expect(markup).toContain("每周使用限额");
  });

  it("does not render a selected cloud account snapshot while a phone session owns quota", () => {
    const markup = renderPanel({
      selectedAccountId: "cloud-account",
      phoneAccountId: "phone-user",
      phoneSessionId: "phone-session",
      quotaIdentity: `cloud:cloud-account:${SESSION_REFRESHED_AT}`,
      snapshot: quota(),
    });

    expect(markup).not.toContain("每周使用限额");
    expect(markup).not.toContain("周额度");
  });

  it("does not read or render a cloud-keyed snapshot while phone resolution is unknown", () => {
    const markup = renderPanel({
      selectedAccountId: "cloud-account",
      phoneAccountResolution: "unknown",
      quotaIdentity: `cloud:cloud-account:${SESSION_REFRESHED_AT}`,
      snapshot: quota(),
    });

    expect(markup).not.toContain("每周使用限额");
    expect(markup).not.toContain("周额度");
  });

  it("uses current-period copy for an unknown/non-weekly window", () => {
    const markup = renderPanel({
      selectedAccountId: "account-a",
      snapshot: quota({
        windowSource: null,
        windowDurationSeconds: null,
        periodStart: null,
        periodEnd: null,
        usageLimits: [
          {
            key: "monthly",
            durationSeconds: null,
            limit: 24,
            used: 3,
            resetsAt: null,
          },
        ],
      }),
    });

    expect(markup).toContain("本期额度");
    expect(markup).not.toContain("周额度");
    expect(markup).toContain("暂未提供重置时间");
  });

  it("does not render a cached snapshot from a different account identity", () => {
    const markup = renderPanel({
      selectedAccountId: "account-b",
      quotaAccountId: "account-a",
      snapshot: quota(),
    });

    expect(markup).not.toContain("每周使用限额");
    expect(markup).not.toContain("周额度");
  });

  it("keeps a last-known-good quota visible when a background refresh fails", () => {
    const raw = "private quota endpoint failed at /internal/quota.ts:42";
    const markup = renderPanel({
      selectedAccountId: "account-a",
      snapshot: quota(),
      quotaError: new Error(raw),
    });

    expect(markup).toContain("周额度");
    expect(markup).toContain("每周使用限额");
    expect(markup).not.toContain("额度加载失败");
    expect(markup).not.toContain(raw);
  });
});
