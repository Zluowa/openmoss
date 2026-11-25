// FILE: EnterpriseAccountName.browser.tsx
// Purpose: Signed in with an enterprise API key (WALK-13 N13-11), Moss never exposes any part
//          of the key in 设置 → 账号, 设置 → 个人资料, the rail button, or the account menu —
//          every surface shows 「企业 API Key」 and the matching 「企」 avatar.
// Layer: Browser UI test

import "../../index.css";

import { mossEnterpriseApiKeyDisplayPrefix } from "@moss/shared/mossRealmCatalog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossPayCatalogQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { serverMossProfileQueryOptions } from "~/components/profile/profileReactQuery";
import { RailAccountMenu } from "~/components/SidebarAccountMenu";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { MossLocaleScope } from "~/localization";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { ProfileSettingsPanel } from "./ProfileSettingsPanel";

// Build a secret-shaped fake enterprise key from parts at runtime so the source holds no key literal.
const KEY_SCHEME = ["moss", "sk"].join("_");
const KEY_TAG = "CtHU";
const FAKE_KEY_PREFIX = mossEnterpriseApiKeyDisplayPrefix(
  `${KEY_SCHEME}_${[KEY_TAG, "9xQp", "2mVn", "8kLr"].join("")}`,
);

function createEnterpriseQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    session: null,
  } as never);
  client.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    account: null,
    session: null,
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
  } as never);
  client.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, { accounts: [] });
  client.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
    configured: true,
    authenticated: true,
    keyPrefix: FAKE_KEY_PREFIX,
    verifiedAt: "2026-11-25T00:00:00.000Z",
    modelCount: 6,
    active: true,
  } as never);
  client.setQueryData(serverMossPayCatalogQueryOptions().queryKey, {
    plans: [],
    pointPackages: [],
    paymentMethods: [],
    plansPurchasable: false,
  });
  client.setQueryData(serverMossProfileQueryOptions().queryKey, {
    scope: "account",
    realm: "cn",
    sync: "synced",
    editable: true,
    profile: {
      // Unsaved auto-derived profile name (e.g. from OS account); must not produce "PR" initials.
      displayName: "Project Runner",
      handle: "projectrunner",
      avatar: null,
      updatedAt: null,
    },
  } as never);
  client.setQueryData(serverProfileStatsQueryOptions().queryKey, {
    generatedAt: "2026-11-25T00:00:00.000Z",
    timezone: { utcOffsetMinutes: 480, today: "2026-11-25" },
    identity: { homeDirBasename: "project-runner", initials: "PR", defaultHandle: "@moss" },
    activity: {
      currentStreakDays: 0,
      longestStreakDays: 0,
      totalPromptsSent: 0,
      totalThreads: 0,
      promptsToday: 0,
      longestTaskMs: null,
      heatmapMetric: "prompts",
      heatmap: [],
    },
    activeHours: { startHour: 1, endHour: null, turnCount: 0, label: "1 AM" },
    insights: {
      topProvider: null,
      topProviderPercent: null,
      topReasoning: null,
      topReasoningPercent: null,
      skillsExplored: 0,
      totalSkillsUsed: 0,
    },
    providerModels: [],
    skills: [],
    mostUsedSkill: null,
    mostWorkedProject: null,
    quota: {
      status: "unavailable",
      provider: null,
      window: null,
      usedPercent: null,
      resetsAt: null,
      planName: null,
    },
  } as never);
  client.setQueryData(serverProfileTokenStatsQueryOptions().queryKey, {
    available: false,
    lifetimeTotalTokens: null,
    peakDayTokens: null,
    peakDay: null,
    providers: [],
    unavailableProviders: [],
    topProvider: null,
    topProviderPercent: null,
    models: [],
  } as never);
  return client;
}

async function renderWithEnterpriseRouter(node: ReactNode) {
  const client = createEnterpriseQueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocaleScope locale="zh-CN">
          <Outlet />
        </MossLocaleScope>
      </QueryClientProvider>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <>{node}</>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/login",
      component: () => <div>登录</div>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/login/api-key",
      component: () => <div>企业 Key 管理</div>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/login/email",
      component: () => <div>Google 登录</div>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/profile",
      component: () => <div>个人资料</div>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/membership",
      component: () => <div>会员</div>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

function assertNoKeyLeaked(text: string): void {
  expect(text).not.toContain(KEY_SCHEME);
  expect(text).not.toContain(KEY_TAG);
  expect(text).not.toContain(FAKE_KEY_PREFIX);
}

describe("N13-11: enterprise key account display never exposes any part of the key", () => {
  it("设置 → 账号 shows 「企业 API Key」 and 「企」 avatar instead of key prefix or PR initials", async () => {
    const screen = await renderWithEnterpriseRouter(<AccountSettingsPanel />);
    try {
      await expect.element(page.getByTestId("settings-account-enterprise")).toBeVisible();
      const summary = page.getByTestId("settings-account-summary").element();
      const text = summary.textContent ?? "";
      expect(text).toContain("企业 API Key");
      expect(text).toContain("企");
      expect(text).not.toContain("PR");
      assertNoKeyLeaked(text);
    } finally {
      await screen.unmount();
    }
  });

  it("rail button and account menu show 「企业 API Key」 and 「企」 without leaking the key prefix in labels or tooltips", async () => {
    const screen = await renderWithEnterpriseRouter(
      <div className="flex h-dvh items-end p-4">
        <RailAccountMenu />
      </div>,
    );
    try {
      const trigger = page.getByTestId("rail-account-menu-trigger").element();
      const disc = page.getByTestId("rail-account-avatar-disc").element();
      expect(disc.textContent?.trim()).toBe("企");
      assertNoKeyLeaked(trigger.getAttribute("title") ?? "");
      assertNoKeyLeaked(trigger.getAttribute("aria-label") ?? "");

      await page.getByTestId("rail-account-menu-trigger").click();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
      const menu = document.querySelector('[role="menu"]')!;
      const menuText = menu.textContent ?? "";
      expect(menuText).toContain("企业 API Key");
      expect(menuText).toContain("企");
      assertNoKeyLeaked(menuText);
      for (const titled of menu.querySelectorAll("[title]")) {
        assertNoKeyLeaked(titled.getAttribute("title") ?? "");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("设置 → 个人资料 shows 「企业 API Key」 instead of the key prefix", async () => {
    const screen = await renderWithEnterpriseRouter(<ProfileSettingsPanel />);
    try {
      await expect.element(page.getByText("企业 API Key")).toBeVisible();
      assertNoKeyLeaked(document.body.textContent ?? "");
    } finally {
      await screen.unmount();
    }
  });
});
