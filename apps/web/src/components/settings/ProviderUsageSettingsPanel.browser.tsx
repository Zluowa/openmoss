// FILE: ProviderUsageSettingsPanel.browser.tsx
// Purpose: Mounted accessibility coverage for provider-owned usage cards.
// Layer: Browser UI test

import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, type ProviderKind } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";

const harness = vi.hoisted(() => ({
  catalogFailure: false,
  navigate: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  resetOrder: vi.fn(),
  refresh: vi.fn(),
}));

const BILLING_RECEIPT_PATH =
  "src/components/settings/__screenshots__/moss-hel51-billing-parity-20260901.png";
const COMMERCE_RECEIPT_PATH =
  "src/components/settings/__screenshots__/moss-hel51-membership-codex-kimi-20260901.png";
const PAYMENT_DIALOG_RECEIPT_PATH =
  "src/components/settings/__screenshots__/moss-hel51-payment-dialog-centered-20260901.png";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => harness.navigate };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  // Account observers subscribe to the real query and mutation caches even when
  // the surrounding provider-usage responses use deterministic fixtures.
  const queryClient = new actual.QueryClient();
  return {
    ...actual,
    useIsMutating: () => 0,
    useMutation: (options: { mutationKey?: readonly unknown[] }) => {
      const isCreateMossPayOrder =
        JSON.stringify(options.mutationKey) ===
        JSON.stringify(["server", "mutation", "mossPay", "createOrder"]);
      return {
        error: undefined,
        isPending: false,
        mutate: isCreateMossPayOrder
          ? (
              payload: { orderType: "plan" | "points"; itemCode: string },
              callbacks?: { onSuccess?: (order: Record<string, unknown>) => void },
            ) => {
              harness.refresh(payload);
              callbacks?.onSuccess?.({
                amountCny: 9_900,
                amountMinor: 9_900,
                currency: "CNY",
                checkoutUrl: null,
                codeUrl: "weixin://wxpay/bizpayurl?pr=moss-dialog-test",
                itemCode: payload.itemCode,
                orderType: payload.orderType,
                outTradeNo: "MOSS-DIALOG-ORDER",
                rail: "wechat_pay",
                status: "pending",
              });
            }
          : harness.refresh,
        reset: harness.resetOrder,
      };
    },
    useQueryClient: () => queryClient,
    useQuery: (options: { queryKey: readonly unknown[] }) => {
      const queryKey = JSON.stringify(options.queryKey);
      // The upstream panel queries the unscoped batch key; serve the same fixture set.
      if (queryKey === JSON.stringify(["server", "allProviderUsage", null, null])) {
        return {
          data: [
            {
              provider: "codex",
              providerInstanceId: "codex",
              accountRef: "opaque-test-account",
              status: "error",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [],
              usageLines: [],
              source: "test",
            },
            {
              provider: "cursor",
              status: "ok",
              planName: "Pro",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [],
              usageLines: [],
              source: "test",
            },
          ],
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "allProviderUsage", "codex", null])) {
        return {
          data: [
            {
              provider: "codex",
              providerInstanceId: "codex",
              accountRef: "opaque-test-account",
              status: "error",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [],
              usageLines: [],
              source: "test",
            },
          ],
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (
        queryKey === JSON.stringify(["server", "allProviderUsage", "codex", "opaque-test-account"])
      ) {
        return {
          data: [
            {
              provider: "codex",
              providerInstanceId: "codex",
              accountRef: "opaque-test-account",
              status: "error",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [],
              usageLines: [],
              source: "test",
            },
            {
              provider: "cursor",
              status: "ok",
              planName: "Pro",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [],
              usageLines: [],
              source: "test",
            },
          ],
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "config"])) {
        return {
          data: {
            providers: [
              {
                provider: "codex",
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                status: "error",
                available: false,
                authStatus: "authenticated",
                checkedAt: "2026-08-12T12:00:00.000Z",
              },
            ],
          },
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "mossAccount", "session"])) {
        return {
          data: {
            configured: true,
            authenticated: true,
            session: { id: "phone-session", user: { id: "phone-user" } },
          },
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "mossCloudAccount", "state"])) {
        return {
          data: {
            configured: true,
            authenticated: true,
            account: { id: "cloud-account" },
            session: { refreshedAt: "2026-08-13T00:00:00.000Z" },
            modelGatewayConfigured: true,
          },
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "mossPay", "catalog"])) {
        return {
          data: harness.catalogFailure
            ? undefined
            : {
                plans: [
                  {
                    code: "basic",
                    displayName: "Basic",
                    monthlyPriceCny: 4_900,
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
                  {
                    code: "plus",
                    displayName: "Plus",
                    monthlyPriceCny: 9_900,
                    monthlyCreditLimit: 174,
                    fiveHourCreditLimit: 24,
                    weeklyCreditLimit: 48,
                    standardTaskEstimate: 60,
                    billingModel: "weighted_credits_v1",
                    monthlyTokenLimit: 250_000,
                    monthlyRequestLimit: 1_000,
                    modelAllowlist: [],
                    monthlyRealtimeCostLimitNanoUsd: 1_000_000_000,
                    monthlyRealtimeSessionLimit: 40,
                    realtimeModelAllowlist: [],
                    estimatedRealtimeMinutes: 36,
                    sortOrder: 1,
                  },
                  {
                    code: "pro",
                    displayName: "Pro",
                    monthlyPriceCny: 19_900,
                    monthlyCreditLimit: 435,
                    fiveHourCreditLimit: 60,
                    weeklyCreditLimit: 120,
                    standardTaskEstimate: 150,
                    billingModel: "weighted_credits_v1",
                    monthlyTokenLimit: 750_000,
                    monthlyRequestLimit: 2_500,
                    modelAllowlist: [],
                    monthlyRealtimeCostLimitNanoUsd: 2_000_000_000,
                    monthlyRealtimeSessionLimit: 80,
                    realtimeModelAllowlist: [],
                    estimatedRealtimeMinutes: 72,
                    sortOrder: 2,
                  },
                  {
                    code: "max",
                    displayName: "Max",
                    monthlyPriceCny: 69_900,
                    monthlyCreditLimit: 1_044,
                    fiveHourCreditLimit: 144,
                    weeklyCreditLimit: 288,
                    standardTaskEstimate: 360,
                    billingModel: "weighted_credits_v1",
                    monthlyTokenLimit: 2_000_000,
                    monthlyRequestLimit: 5_000,
                    modelAllowlist: [],
                    monthlyRealtimeCostLimitNanoUsd: 5_000_000_000,
                    monthlyRealtimeSessionLimit: 160,
                    realtimeModelAllowlist: [],
                    estimatedRealtimeMinutes: 180,
                    sortOrder: 3,
                  },
                ],
                pointPackages: [
                  {
                    code: "credits-100",
                    displayName: "100 积分",
                    priceCny: 100,
                    points: 100,
                    tokensPerPoint: 100,
                    sortOrder: 0,
                  },
                ],
                paymentMethods: [],
              },
          isPending: false,
          isFetching: false,
          isError: harness.catalogFailure,
          error: harness.catalogFailure ? new Error("catalog unavailable") : undefined,
        };
      }
      if (
        queryKey ===
        JSON.stringify(["server", "mossPay", "quota", "phone:phone-user:phone-session"])
      ) {
        return {
          data: {
            planCode: "basic",
            billingModel: "weighted_credits_v1",
            usageLimits: [
              {
                key: "five_hour",
                durationSeconds: 18_000,
                limit: 12,
                used: 2.4,
                resetsAt: "2026-08-10T05:00:00.000Z",
              },
              {
                key: "weekly",
                durationSeconds: 604_800,
                limit: 24,
                used: 6,
                resetsAt: "2026-08-17T00:00:00.000Z",
              },
              {
                key: "monthly",
                durationSeconds: 2_592_000,
                limit: 87,
                used: 17.4,
                resetsAt: "2026-09-10T00:00:00.000Z",
              },
            ],
            quotaPolicyMode: "metered",
            periodStart: "2026-08-10T00:00:00.000Z",
            periodEnd: "2026-08-17T00:00:00.000Z",
            windowId: "provider-window-2026-08-10",
            windowSource: "weekly",
            windowDurationSeconds: 604800,
            tokenLimit: 100000,
            tokensUsed: 12345,
            requestLimit: 500,
            requestsUsed: 42,
            creditBalance: 4_855,
            realtimeConfigured: true,
            realtimeModelAllowlist: ["gpt-realtime"],
            realtimeCostLimitNanoUsd: 500000000,
            realtimeCostUsedNanoUsd: 100000000,
            realtimeCostReservedNanoUsd: 20000000,
            realtimeSessionLimit: 20,
            realtimeSessionsUsed: 3,
            realtimeEstimatedMinutesRemaining: 18,
          },
          isPending: false,
          isFetching: false,
          isError: false,
        };
      }
      if (queryKey === JSON.stringify(["server", "mossPay", "order", "MOSS-DIALOG-ORDER"])) {
        return {
          data: {
            amountCny: 9_900,
            amountMinor: 9_900,
            currency: "CNY",
            checkoutUrl: null,
            codeUrl: "weixin://wxpay/bizpayurl?pr=moss-dialog-test",
            itemCode: "plus",
            orderType: "plan",
            outTradeNo: "MOSS-DIALOG-ORDER",
            rail: "wechat_pay",
            status: "pending",
          },
          isPending: false,
          isFetching: false,
          isError: false,
          error: undefined,
        };
      }
      return {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
      };
    },
  };
});

const appSettingsHarness = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  railOverride: null as null | {
    disabledProviders: ReadonlyArray<string>;
    railUsageProviders: ReadonlyArray<string>;
    railUsageInstanceIds: null;
    railUsageWindow: "both";
  },
}));

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
        railUsageInstanceIds: [],
        railUsageProviders: [],
        ...(appSettingsHarness.railOverride ?? {}),
      },
      updateSettings: appSettingsHarness.updateSettings,
    }),
  };
});

vi.mock("~/hooks/useProviderUsageSummary", () => ({
  useProviderUsageSummary: ({ provider }: { provider: ProviderKind }) => ({
    rateLimits:
      provider === "cursor"
        ? [
            {
              provider: "cursor",
              updatedAt: "2026-08-12T12:00:00.000Z",
              limits: [
                {
                  window: "Current",
                  usedPercent: 0,
                  resetsAt: "2099-08-12T13:00:00.000Z",
                },
              ],
            },
          ]
        : [],
    usageLines: [],
    usageNotice: undefined,
  }),
}));

vi.mock("~/store", () => ({
  useStore: () => [],
}));

import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";
import { MossLocalizationProvider } from "~/localization";
import { MossMembershipPage } from "~/components/auth/MossMembershipPage";

function describedByElements(group: Element): Element[] {
  const descriptionIds = group.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
  return descriptionIds.flatMap((descriptionId) => {
    const element = document.getElementById(descriptionId);
    return element ? [element] : [];
  });
}

describe("ProviderUsageSettingsPanel", () => {
  beforeEach(() => {
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: { shell: { openExternal: harness.openExternal } },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    harness.catalogFailure = false;
    vi.clearAllMocks();
  });

  it("owns each quota and availability state in a named provider group", async () => {
    const mounted = await render(
      <div style={{ width: 320 }}>
        <ProviderUsageSettingsPanel />
      </div>,
    );

    try {
      const codexGroup = page.getByRole("group", { name: "Codex" });
      const cursorGroup = page.getByRole("group", { name: "Cursor" });

      await expect.element(codexGroup).toBeInTheDocument();
      await expect.element(cursorGroup).toBeInTheDocument();

      const codexDescriptions = describedByElements(codexGroup.element());
      const cursorDescriptions = describedByElements(cursorGroup.element());
      expect(codexDescriptions).toHaveLength(2);
      expect(cursorDescriptions).toHaveLength(1);
      expect(
        codexDescriptions.every((description) => codexGroup.element().contains(description)),
      ).toBe(true);
      expect(
        cursorDescriptions.every((description) => cursorGroup.element().contains(description)),
      ).toBe(true);

      expect(
        cursorGroup.element().querySelector('[role="progressbar"][aria-valuenow="100"]'),
      ).not.toBeNull();
      expect(
        codexGroup.element().querySelector('[role="progressbar"][aria-valuenow="100"]'),
      ).toBeNull();

      for (const group of [codexGroup.element(), cursorGroup.element()]) {
        expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);
      }
    } finally {
      await mounted.unmount();
    }
  });

  it("routes from Codex-style usage into the full Moss plan picker", async () => {
    await page.viewport(1280, 1000);
    const settingsMounted = await render(
      <MossLocalizationProvider>
        <div style={{ width: 960 }}>
          <header className="mb-8">
            <h1 className="text-xl font-medium tracking-tight text-foreground">使用情况和计费</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              查看 Moss 套餐、积分和已连接模型的用量。
            </p>
          </header>
          <ProviderUsageSettingsPanel />
        </div>
      </MossLocalizationProvider>,
    );

    try {
      await expect
        .element(page.getByRole("heading", { name: "使用情况和计费", level: 1 }))
        .toBeInTheDocument();
      await expect.element(page.getByRole("heading", { name: "当前套餐" })).toBeInTheDocument();
      await expect.element(page.getByRole("heading", { name: "积分余额" })).toBeInTheDocument();
      await expect.element(page.getByRole("heading", { name: "通用使用限额" })).toBeInTheDocument();
      await expect.element(page.getByText("Basic", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("4,855", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("5 小时使用限额", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("每周使用限额", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("每月使用限额", { exact: true })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Tokens");
      expect(document.body.textContent).not.toContain("token/月");

      expect(await page.screenshot({ path: BILLING_RECEIPT_PATH })).toContain(
        BILLING_RECEIPT_PATH.split("/").at(-1)!,
      );

      await page.getByTestId("moss-pricing-view-plans").click();
      expect(harness.navigate).toHaveBeenLastCalledWith({
        to: "/membership",
        search: { focus: "plans" },
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await page.getByTestId("moss-pricing-buy-credits").click();
      expect(harness.navigate).toHaveBeenLastCalledWith({
        to: "/membership",
        search: { focus: "credits" },
      });
      expect(harness.refresh).not.toHaveBeenCalled();
      expect(harness.openExternal).not.toHaveBeenCalled();
    } finally {
      await settingsMounted.unmount();
    }

    const membershipMounted = await render(
      <MossLocalizationProvider>
        <MossMembershipPage onBack={vi.fn()} />
      </MossLocalizationProvider>,
    );
    try {
      await expect
        .element(page.getByRole("heading", { name: "选择套餐", level: 1 }))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("moss-membership-audience-personal"))
        .toHaveAttribute("aria-selected", "true");
      await expect.element(page.getByTestId("moss-membership-plans")).toBeInTheDocument();
      for (const plan of ["Basic", "Plus", "Pro", "Max"]) {
        await expect.element(page.getByText(plan, { exact: true })).toBeInTheDocument();
      }
      await expect
        .element(page.getByText("1 倍 Agent 使用额度", { exact: true }))
        .toBeInTheDocument();
      expect(page.getByTestId("moss-payment-method").element().textContent).toContain(
        "提市微信支付",
      );
      await expect.element(page.getByTestId("moss-membership-subscribe-basic")).toBeDisabled();
      await expect.element(page.getByTestId("moss-membership-subscribe-plus")).not.toBeDisabled();
      expect(await page.screenshot({ path: COMMERCE_RECEIPT_PATH })).toContain(
        COMMERCE_RECEIPT_PATH.split("/").at(-1)!,
      );

      await page.getByTestId("moss-membership-subscribe-plus").click();
      const paymentDialog = page.getByTestId("moss-membership-order");
      await expect.element(paymentDialog).toHaveAttribute("role", "dialog");
      await expect.element(page.getByText("微信扫码支付 ¥99", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByRole("img", { name: "微信支付二维码" })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="dialog-backdrop"]')).not.toBeNull();

      const dialogRect = paymentDialog.element().getBoundingClientRect();
      expect(Math.abs(dialogRect.left + dialogRect.width / 2 - window.innerWidth / 2)).toBeLessThan(
        2,
      );
      expect(
        Math.abs(dialogRect.top + dialogRect.height / 2 - window.innerHeight / 2),
      ).toBeLessThan(2);
      expect(await page.screenshot({ path: PAYMENT_DIALOG_RECEIPT_PATH })).toContain(
        PAYMENT_DIALOG_RECEIPT_PATH.split("/").at(-1)!,
      );

      await paymentDialog.getByRole("button", { name: "关闭" }).click();
      await expect.element(paymentDialog).not.toBeInTheDocument();
      expect(harness.resetOrder).toHaveBeenCalledTimes(1);

      await page.getByTestId("moss-membership-audience-business").click();
      await expect
        .element(page.getByTestId("moss-membership-audience-business"))
        .toHaveAttribute("aria-selected", "true");
      await expect.element(page.getByText("团队套餐即将开放", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByTestId("moss-membership-business-unavailable")).toBeDisabled();
      expect(harness.refresh).toHaveBeenCalledTimes(1);
      expect(harness.refresh).toHaveBeenLastCalledWith({ orderType: "plan", itemCode: "plus" });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
    } finally {
      await membershipMounted.unmount();
    }
  });

  it("keeps the plan fallback and homepage CTA visible when catalog loading fails", async () => {
    harness.catalogFailure = true;
    await page.viewport(1280, 1000);
    const mounted = await render(
      <MossLocalizationProvider>
        <div style={{ width: 960 }}>
          <ProviderUsageSettingsPanel />
        </div>
      </MossLocalizationProvider>,
    );

    try {
      await expect.element(page.getByText("basic", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("档位暂时不可用")).toBeInTheDocument();
      await page.getByTestId("moss-pricing-view-plans").click();
      expect(harness.navigate).toHaveBeenLastCalledWith({
        to: "/membership",
        search: { focus: "plans" },
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(harness.openExternal).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});

describe("rail usage account selection", () => {
  it("keeps disabled sidebar preferences when selecting another provider", async () => {
    appSettingsHarness.railOverride = {
      disabledProviders: ["codex", "claudeAgent"],
      railUsageProviders: ["codex", "claudeAgent"],
      railUsageInstanceIds: null,
      railUsageWindow: "both",
    };
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, enabled: false } },
      });
      client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS);
      client.setQueryData(serverQueryKeys.allProviderUsage(), []);
      await render(
        <QueryClientProvider client={client}>
          <ProviderUsageSettingsPanel />
        </QueryClientProvider>,
      );
      await page
        .getByRole("switch", { name: "Show OpenCode usage at the bottom of the sidebar" })
        .click();
      expect(appSettingsHarness.updateSettings).toHaveBeenCalledWith({
        railUsageInstanceIds: ["codex", "claudeAgent", "opencode"],
      });
    } finally {
      appSettingsHarness.railOverride = null;
    }
  });
});
