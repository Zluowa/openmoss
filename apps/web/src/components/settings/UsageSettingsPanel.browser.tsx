// FILE: UsageSettingsPanel.browser.tsx
// Purpose: Real-DOM browser verification for the redesigned Settings → Usage & limits surface:
//          free-tier percentage bar (zero currency), exhausted limit-hit banner, 7d/30d chart &
//          product/model breakdown, separated personal CLI limits, Feishu #3 retry recovery, and
//          Feishu #4 single home remaining-quota indicator.
// Layer: Browser UI test

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type MossPayCatalog,
  type MossPayQuota,
  type ServerProviderUsageSnapshot,
  type StatsGetUsageAnalyticsResult,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AppRailUsage } from "~/components/AppRailUsage";
import { MOSS_RAIL_USAGE_ID } from "~/components/AppRailUsage.logic";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { SidebarAccountMenu } from "~/components/SidebarAccountMenu";
import { SidebarProvider } from "~/components/ui/sidebar";
import { serverQueryKeys, serverUsageAnalyticsQueryOptions } from "~/lib/serverReactQuery";
import { MossLocaleScope } from "~/localization";
import { UsageSettingsPanel } from "./UsageSettingsPanel";
import { localDayKey, usageAnalyticsWindow } from "./usageAnalytics.logic";

const navHarness = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navHarness.navigate };
});

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
        disabledProviders: [],
        railUsageInstanceIds: [MOSS_RAIL_USAGE_ID],
        railUsageProviders: [MOSS_RAIL_USAGE_ID],
        railUsageWindow: "both" as const,
        usageDetailsDefaultOpen: false,
        usagePopoverShowResetCredits: true,
        usagePopoverShowUsageLines: true,
      },
      updateSettings: vi.fn(),
    }),
  };
});

vi.mock("~/store", () => ({
  useStore: () => [],
}));

const PHONE_SESSION = {
  configured: true,
  authenticated: true,
  session: {
    id: "phone-session-usage",
    user: {
      id: "free-user-usage",
      phoneNumber: "+8613800138000",
      displayName: "测试用户",
    },
  },
};

const CLOUD_SIGNED_OUT = {
  configured: false,
  authenticated: false,
  account: null,
  session: null,
  modelGatewayConfigured: false,
};

const ENTERPRISE_SIGNED_OUT = {
  configured: false,
  authenticated: false,
  active: false,
  keyPrefix: null,
};

const ACCOUNT_IDENTITY = "phone:free-user-usage:phone-session-usage";

const CATALOG: MossPayCatalog = {
  plans: [
    {
      code: "basic",
      displayName: "Basic",
      monthlyPriceCny: 4_900,
      monthlyCreditLimit: 87,
      fiveHourCreditLimit: 12,
      weeklyCreditLimit: 24,
      standardTaskEstimate: 30,
      billingModel: "cost_budget_v1",
      monthlyTokenLimit: 0,
      monthlyRequestLimit: 0,
      modelAllowlist: [],
      monthlyRealtimeCostLimitNanoUsd: 500_000_000,
      monthlyRealtimeSessionLimit: 20,
      realtimeModelAllowlist: [],
      estimatedRealtimeMinutes: 18,
      sortOrder: 0,
    },
    {
      code: "plus",
      displayName: "Plus",
      monthlyPriceCny: 9_900,
      monthlyCreditLimit: 174,
      fiveHourCreditLimit: 24,
      weeklyCreditLimit: 48,
      standardTaskEstimate: 60,
      billingModel: "cost_budget_v1",
      monthlyTokenLimit: 0,
      monthlyRequestLimit: 0,
      modelAllowlist: [],
      monthlyRealtimeCostLimitNanoUsd: 1_000_000_000,
      monthlyRealtimeSessionLimit: 40,
      realtimeModelAllowlist: [],
      estimatedRealtimeMinutes: 36,
      sortOrder: 1,
    },
  ],
  pointPackages: [],
  paymentMethods: [{ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" }],
};

function freeQuota(used = 1): MossPayQuota {
  return {
    planCode: "starter-trial",
    billingModel: "wallet_credits_v1",
    usageLimits: [
      {
        key: "lifetime",
        durationSeconds: null,
        limit: 5,
        used,
        resetsAt: null,
      },
    ],
    quotaPolicyMode: "metered",
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: null,
    windowId: "free-window-1",
    windowSource: null,
    windowDurationSeconds: null,
    tokenLimit: null,
    tokensUsed: 0,
    requestLimit: null,
    requestsUsed: 0,
    creditBalance: Math.max(0, 5 - used),
    realtimeConfigured: false,
    realtimeModelAllowlist: [],
    realtimeCostLimitNanoUsd: 0,
    realtimeCostUsedNanoUsd: 0,
    realtimeCostReservedNanoUsd: 0,
    realtimeSessionLimit: null,
    realtimeSessionsUsed: 0,
    realtimeEstimatedMinutesRemaining: null,
  };
}

function makeAnalyticsFixture(range: "7d" | "30d"): {
  readonly request: { readonly from: string; readonly to: string; readonly scope: "moss" };
  readonly result: StatsGetUsageAnalyticsResult;
} {
  const todayKey = localDayKey(new Date());
  const noon = new Date(`${todayKey}T12:00:00`);
  const window = usageAnalyticsWindow(range, noon);
  const request = {
    from: (window.previousFrom ?? window.from).toISOString(),
    to: window.to.toISOString(),
    scope: "moss" as const,
  };
  const todayHour = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), 10).toISOString();
  const yesterday = new Date(
    noon.getFullYear(),
    noon.getMonth(),
    noon.getDate() - 1,
    14,
  ).toISOString();
  return {
    request,
    result: {
      generatedAt: "2026-11-22T00:00:00.000Z",
      scope: "moss",
      from: request.from,
      to: request.to,
      projects: [{ projectId: "proj-1", title: "Moss Workspace" }],
      tokens: [
        {
          hour: todayHour,
          origin: "user",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          projectId: "proj-1",
          tokens: 62_000,
          cacheReadTokens: 12_000,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
        {
          hour: yesterday,
          origin: "user",
          provider: "codex",
          model: "gpt-5.4",
          projectId: "proj-1",
          tokens: 28_000,
          cacheReadTokens: 3_000,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
        {
          hour: todayHour,
          origin: "user",
          provider: "codex",
          model: "doubao-seedream-4",
          projectId: "proj-1",
          tokens: 10_000,
          cacheReadTokens: 0,
          unpricedTokens: 0,
          unsplitTokens: 0,
        },
      ],
      turns: [
        {
          hour: todayHour,
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          projectId: "proj-1",
          turns: 14,
          failedTurns: 0,
        },
        {
          hour: yesterday,
          provider: "codex",
          model: "gpt-5.4",
          projectId: "proj-1",
          turns: 7,
          failedTurns: 0,
        },
        {
          hour: todayHour,
          provider: "codex",
          model: "doubao-seedream-4",
          projectId: "proj-1",
          turns: 3,
          failedTurns: 0,
        },
      ],
      costs: [],
      unavailableProviders: [],
      sessionFileProviders: [],
      pricing: { status: "bundled", fetchedAt: null },
    },
  };
}

const PERSONAL_PROVIDERS: readonly ServerProviderUsageSnapshot[] = [
  {
    provider: "codex",
    providerInstanceId: "codex",
    status: "ok",
    planName: "Plus",
    updatedAt: "2026-11-22T00:00:00.000Z",
    limits: [
      {
        window: "5h",
        usedPercent: 18,
        resetsAt: "2099-11-22T05:00:00.000Z",
      },
      {
        window: "Weekly",
        usedPercent: 32,
        resetsAt: "2099-11-28T00:00:00.000Z",
      },
    ],
    usageLines: [],
    source: "test",
  },
];

function createSeededClient(input: {
  readonly quota?: MossPayQuota;
  readonly providers?: readonly ServerProviderUsageSnapshot[];
  readonly enabled?: boolean;
  readonly retryOnMount?: boolean;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        enabled: input.enabled ?? false,
        staleTime: Number.POSITIVE_INFINITY,
        ...(input.retryOnMount === undefined ? {} : { retryOnMount: input.retryOnMount }),
      },
    },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS);
  client.setQueryData(serverQueryKeys.allProviderUsage(), input.providers ?? PERSONAL_PROVIDERS);
  client.setQueryData(serverMossAccountSessionQueryOptions().queryKey, PHONE_SESSION as never);
  client.setQueryData(
    serverMossCloudAccountStateQueryOptions().queryKey,
    CLOUD_SIGNED_OUT as never,
  );
  client.setQueryData(
    serverMossEnterpriseKeyStateQueryOptions().queryKey,
    ENTERPRISE_SIGNED_OUT as never,
  );
  client.setQueryData(serverMossPayCatalogQueryOptions().queryKey, CATALOG);
  if (input.quota) {
    client.setQueryData(
      serverMossPayQuotaQueryOptions({ accountIdentity: ACCOUNT_IDENTITY }).queryKey,
      input.quota,
    );
  }
  const sevenDay = makeAnalyticsFixture("7d");
  const thirtyDay = makeAnalyticsFixture("30d");
  client.setQueryData(serverUsageAnalyticsQueryOptions(sevenDay.request).queryKey, sevenDay.result);
  client.setQueryData(
    serverUsageAnalyticsQueryOptions(thirtyDay.request).queryKey,
    thirtyDay.result,
  );
  return client;
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.replaceChildren();
  navHarness.navigate.mockReset();
});

describe("UsageSettingsPanel redesign & Feishu #3/#4", () => {
  it("renders free-tier quota bar without currency, 7d/30d chart, product/model breakdown, and separated personal CLI limits in light and dark", async () => {
    await page.viewport(980, 900);
    const client = createSeededClient({ quota: freeQuota(1) });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <div className="mx-auto max-w-[760px] bg-background p-6 text-foreground">
            <UsageSettingsPanel />
          </div>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      const billing = page.getByTestId("moss-billing-settings-panel");
      await expect.element(billing).toBeVisible();
      await expect.element(billing.getByText("免费版", { exact: true })).toBeVisible();
      await expect.element(billing.getByText("免费额度", { exact: true })).toBeVisible();
      await expect.element(billing.getByText("剩余 80%", { exact: true })).toBeVisible();

      const progressBar = billing.getByRole("progressbar");
      await expect.element(progressBar).toHaveAttribute("aria-valuenow", "80");
      expect(progressBar.element().getBoundingClientRect().width).toBeGreaterThan(200);

      // 7d/30d chart + breakdown bars visible with real rendered bars
      const activity = page.getByTestId("usage-overview-activity-content");
      await expect.element(activity).toBeVisible();
      expect(activity.element().querySelectorAll("svg rect").length).toBeGreaterThan(0);

      const productBreakdown = page.getByTestId("usage-breakdown-products");
      await expect.element(productBreakdown).toBeVisible();
      await expect.element(productBreakdown.getByText("Claude", { exact: true })).toBeVisible();
      await expect.element(productBreakdown.getByText("Codex", { exact: true })).toBeVisible();
      await expect.element(productBreakdown.getByText("图片与视频", { exact: true })).toBeVisible();

      const modelBreakdown = page.getByTestId("usage-breakdown-models");
      await expect.element(modelBreakdown).toBeVisible();
      await expect
        .element(modelBreakdown.getByText("claude-opus-4-6", { exact: true }))
        .toBeVisible();

      // Switch 7d -> 30d range
      await page.getByTestId("usage-overview-range-picker").getByText("30 天").click();
      await expect.element(activity).toBeVisible();

      // Personal CLI section clearly separated from Moss cloud quota
      const personalSection = page.getByTestId("usage-personal-cli-section");
      await expect.element(personalSection).toBeVisible();
      await expect.element(personalSection.getByText("个人模型账号限额")).toBeVisible();
      await expect.element(personalSection.getByRole("group", { name: "Codex" })).toBeVisible();

      // Zero currency text for free starter allowance
      const fullText = document.body.textContent ?? "";
      expect(fullText).not.toMatch(/5\s*元|[¥￥]\s*5|5\s*RMB|CNY\s*5/i);
      expect(fullText).not.toContain("starter-trial");
      expect(fullText).not.toContain("积分余额");

      // Dark mode & narrow viewport check: zero horizontal overflow
      document.documentElement.classList.add("dark");
      await page.viewport(420, 840);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth + 1,
      );

      // CTA opens membership plans
      await page.getByTestId("moss-pricing-view-plans").click();
      expect(navHarness.navigate).toHaveBeenCalledWith({
        to: "/membership",
        search: { focus: "plans" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows Claude-style exhausted limit alert matching composer wording when free quota reaches 0%", async () => {
    await page.viewport(900, 800);
    const client = createSeededClient({ quota: freeQuota(5) });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <div className="mx-auto max-w-[760px] bg-background p-6 text-foreground">
            <UsageSettingsPanel />
          </div>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      const alertBanner = page.getByTestId("moss-usage-limit-hit-banner");
      await expect.element(alertBanner).toBeVisible();
      await expect.element(alertBanner.getByText("Moss 额度已用完")).toBeVisible();
      await expect.element(alertBanner.getByText(/开通会员继续使用/)).toBeVisible();

      const progressBar = page.getByTestId("moss-billing-settings-panel").getByRole("progressbar");
      await expect.element(progressBar).toHaveAttribute("aria-valuenow", "0");
      await expect.element(progressBar).toHaveAttribute("data-quota-exhausted", "true");
      expect(document.body.textContent ?? "").not.toContain("额度加载失败");
    } finally {
      await screen.unmount();
    }
  });

  it("recovers from a real quota load failure when the user clicks Retry (Feishu #3)", async () => {
    await page.viewport(900, 800);
    let shouldFail = true;
    const getMossPayQuota = vi.fn(async () => {
      if (shouldFail) {
        throw new Error("gateway_unavailable");
      }
      return freeQuota(1);
    });
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        server: {
          getMossAccountSession: async () => PHONE_SESSION,
          getMossCloudAccountState: async () => CLOUD_SIGNED_OUT,
          getMossPayCatalog: async () => CATALOG,
          getMossPayQuota,
          getSettings: async () => DEFAULT_SERVER_SETTINGS,
          getAllProviderUsage: async () => [],
          getUsageAnalytics: async () => makeAnalyticsFixture("7d").result,
        },
      },
    });

    const client = createSeededClient({
      providers: [],
      enabled: true,
      retryOnMount: false,
    });
    const quotaOptions = serverMossPayQuotaQueryOptions({
      accountIdentity: ACCOUNT_IDENTITY,
      retry: false,
    });
    // Force initial failed state so the real error card renders first.
    client
      .getQueryCache()
      .build(client, client.defaultQueryOptions(quotaOptions))
      .setState({
        data: undefined,
        error: new Error("gateway_unavailable"),
        errorUpdatedAt: Date.now(),
        errorUpdateCount: 1,
        fetchStatus: "idle",
        status: "error",
      });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <div className="mx-auto max-w-[760px] bg-background p-6 text-foreground">
            <UsageSettingsPanel />
          </div>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      const errorBox = page.getByTestId("moss-quota-error-state");
      await expect.element(errorBox).toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("积分余额");

      // Next fetch succeeds when user clicks Retry.
      shouldFail = false;
      await page.getByTestId("moss-quota-retry").click();

      await vi.waitFor(() => {
        expect(getMossPayQuota).toHaveBeenCalledTimes(1);
      });
      await expect
        .element(
          page.getByTestId("moss-billing-settings-panel").getByText("剩余 80%", { exact: true }),
        )
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("displays remaining quota percentage in ONE place on the home surface without repeating it in the account menu (Feishu #4)", async () => {
    await page.viewport(900, 700);
    const client = createSeededClient({ quota: freeQuota(1), providers: [] });
    client.setQueryData(
      serverMossCloudAccountStateQueryOptions().queryKey,
      CLOUD_SIGNED_OUT as never,
    );

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <SidebarProvider open>
            <div className="flex items-start gap-6 p-6">
              <div
                className="flex w-12 flex-col items-center gap-2 rounded-card bg-sidebar py-2"
                data-testid="home-rail-surface"
              >
                <AppRailUsage onOpenUsageSettings={vi.fn()} />
              </div>
              <div className="w-64">
                <SidebarAccountMenu />
              </div>
            </div>
          </SidebarProvider>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      // The rail keeps the ONE home-surface remaining-quota indicator.
      const mossRing = page.getByRole("button", { name: /Moss, 剩余 80%/ });
      await expect.element(mossRing).toBeVisible();

      // Open the account menu: clean "查看用量" entry with zero duplicate "剩余 80%" badge!
      await userEvent.click(page.getByTestId("sidebar-account-menu-trigger"));
      const usageItem = page.getByRole("menuitem", { name: "查看用量" });
      await expect.element(usageItem).toBeVisible();
      expect(usageItem.element().textContent).not.toContain("剩余 80%");
      expect(document.querySelector('[role="menu"]')?.textContent ?? "").not.toContain("剩余 80%");
    } finally {
      await screen.unmount();
    }
  });

  it("recognizes an authenticated Enterprise API Key cleanly instead of showing 未登录", async () => {
    await page.viewport(900, 800);
    const client = createSeededClient({ providers: [] });
    client.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
      configured: true,
      authenticated: false,
      session: null,
    } as never);
    client.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
      ...CLOUD_SIGNED_OUT,
      configured: true,
    } as never);
    client.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
      configured: true,
      authenticated: true,
      active: true,
      keyPrefix: null,
      verifiedAt: "2026-11-26T00:00:00.000Z",
      modelCount: 6,
      modelGatewayStatus: "ready",
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <div className="mx-auto max-w-[760px] bg-background p-6 text-foreground">
            <UsageSettingsPanel />
          </div>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      const mossSection = page.getByTestId("usage-moss-cloud-section");
      await expect.element(mossSection).toBeVisible();
      await expect.element(mossSection.getByText("可用", { exact: true })).toBeVisible();
      await expect.element(mossSection.getByText(/企业 API Key · 6 个可用模型/)).toBeVisible();
      const text = mossSection.element().textContent ?? "";
      expect(text).not.toContain("未登录");
      expect(text).not.toContain("登录 Moss 后即可使用内置模型");
      expect(document.querySelector('[data-testid="moss-usage-sign-in"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
