// FILE: ProfilePage.browser.tsx
// Purpose: Real Chromium browser tests covering the full Profile + Notion-style Moss
//          avatar + Settings → 账号 experience:
//          1) Clicking the bottom-left rail avatar opens `/profile` directly (no menu)
//             and `← 返回 Moss` returns to the previous chat.
//          2) Inline display name & `@handle` editing with live uniqueness feedback.
//          3) All 20 Notion-style Moss SVG presets load with real pixels and selecting
//             one updates the rendered avatar.
//          4) Settings → 账号 preserves every function from the removed `/account` page.
//          5) Light/dark theme + narrow viewport layout integrity.
// Layer: Browser UI test

import "../../index.css";

import type {
  MossAccountSessionState,
  MossProfileCheckHandleResult,
  MossProfileState,
  MossProfileUpdateInput,
  ProfileHeatmapCell,
  ProfileStats,
  ProfileTokenStats,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { AccountSettingsPanel } from "~/components/settings/AccountSettingsPanel";
import { ProfileContent } from "~/components/settings/ProfileSettingsPanel";
import { RailAccountMenu } from "~/components/SidebarAccountMenu";
import { useTheme } from "~/hooks/useTheme";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { MossLocaleScope } from "~/localization";
import { closeSettings } from "~/settingsDialogStore";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";
import { PROFILE_AVATAR_PRESETS } from "./profileAvatarPresets";
import { ProfilePage } from "./ProfilePage";

function sampleHeatmap(): ProfileHeatmapCell[] {
  const start = new Date("2025-11-25T00:00:00.000Z");
  return Array.from({ length: 274 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const count = index > 220 && index % 2 === 0 ? ((index * 197) % 18_000) + 1_200 : 0;
    return {
      day: date.toISOString().slice(0, 10),
      count,
      weekday: date.getUTCDay(),
      intensity: count === 0 ? 0 : Math.min(4, Math.ceil((count / 18_000) * 4)),
    };
  });
}

const RICH_STATS: ProfileStats = {
  generatedAt: "2026-08-25T00:00:00.000Z",
  timezone: { utcOffsetMinutes: 480, today: "2026-08-25" },
  identity: { homeDirBasename: "milo", initials: "MC", defaultHandle: "@milo" },
  activity: {
    currentStreakDays: 3,
    longestStreakDays: 14,
    totalPromptsSent: 1_280,
    totalThreads: 64,
    promptsToday: 9,
    longestTaskMs: (17 * 60 + 42) * 60_000,
    heatmapMetric: "prompts",
    heatmap: sampleHeatmap(),
  },
  activeHours: { startHour: 22, endHour: null, turnCount: 92, label: "10 PM" },
  insights: {
    topProvider: "claudeAgent",
    topProviderPercent: 62,
    topReasoning: "high",
    topReasoningPercent: 74,
    skillsExplored: 7,
    totalSkillsUsed: 320,
  },
  providerModels: [],
  skills: [
    { name: "superpowers", displayName: "$superpowers", kind: "skill", runCount: 142 },
    { name: "reviewer", displayName: "@reviewer", kind: "agent", runCount: 58 },
  ],
  mostUsedSkill: { name: "superpowers", displayName: "$superpowers", kind: "skill", runCount: 142 },
  mostWorkedProject: {
    projectId: "proj-moss",
    title: "Moss Desktop",
    workspaceRoot: "/workspace/moss",
    promptCount: 412,
    threadCount: 28,
    activeDays: 19,
    lastWorkedAt: "2026-08-25T08:00:00.000Z",
  },
  quota: {
    status: "unavailable",
    provider: null,
    window: null,
    usedPercent: null,
    resetsAt: null,
    planName: null,
  },
};

const RICH_TOKEN_STATS: ProfileTokenStats = {
  available: true,
  lifetimeTotalTokens: 11_230_000_000,
  peakDayTokens: 1_320_000_000,
  peakDay: "2026-08-20",
  providers: ["claudeAgent", "codex"],
  unavailableProviders: [],
  topProvider: "claudeAgent",
  topProviderPercent: 62,
  models: [
    {
      provider: "claudeAgent",
      instanceId: "claude",
      model: "Claude Sonnet 4.6",
      tokens: 6_962_600_000,
      percent: 62,
    },
    {
      provider: "codex",
      instanceId: "codex",
      model: "GPT-5.6",
      tokens: 4_267_400_000,
      percent: 38,
    },
  ],
  heatmapMetric: "tokens",
  heatmap: sampleHeatmap(),
};

function ThemeHarness() {
  useTheme();
  return null;
}

async function setThemeMode(mode: "light" | "dark") {
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await vi.waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(mode === "dark"),
  );
}

function createSignedInPhoneSession(): MossAccountSessionState {
  return {
    configured: true,
    authenticated: true,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    session: {
      id: "moss_phone_session_profile_test",
      user: {
        id: "phone-user-1",
        phoneNumber: "+8613800138000",
        displayName: "小林",
        role: "member",
        status: "active",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastLoginAt: "2026-08-25T00:00:00.000Z",
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-09-25T00:00:00.000Z",
      lastSeenAt: "2026-08-25T00:00:00.000Z",
    },
  } as unknown as MossAccountSessionState;
}

function seedBaseQueries(queryClient: QueryClient, signedInPhone = false) {
  queryClient.setQueryData(
    serverMossAccountSessionQueryOptions().queryKey,
    signedInPhone
      ? createSignedInPhoneSession()
      : {
          configured: true,
          authenticated: false,
          session: null,
          smsProvider: "aliyun",
          aliyunSmsConfigured: true,
        },
  );
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    account: null,
    session: null,
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
  });
  queryClient.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, { accounts: [] });
  queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    keyPrefix: null,
    verifiedAt: null,
    modelCount: 0,
    active: false,
  });
  queryClient.setQueryData(serverMossPayCatalogQueryOptions().queryKey, {
    plans: [],
    pointPackages: [],
    paymentMethods: [],
    plansPurchasable: false,
  });
  queryClient.setQueryData(
    serverMossPayQuotaQueryOptions({
      accountIdentity: signedInPhone ? "phone:phone-user-1" : null,
    }).queryKey,
    {
      planCode: "free",
      billingModel: "wallet_credits_v1",
      creditBalance: 0,
      periodStart: null,
      periodEnd: null,
      quotaPolicyMode: "metered",
      requestLimit: null,
      requestsUsed: 0,
      tokenLimit: null,
      tokensUsed: 0,
      usageLimits: [
        { key: "lifetime", used: 20, limit: 100, resetsAt: null, durationSeconds: null },
      ],
      windowId: null,
      windowSource: null,
      windowDurationSeconds: null,
      realtimeConfigured: false,
      realtimeModelAllowlist: [],
      realtimeCostLimitNanoUsd: null,
      realtimeCostUsedNanoUsd: 0,
      realtimeCostReservedNanoUsd: 0,
      realtimeEstimatedMinutesRemaining: null,
      realtimeSessionLimit: null,
      realtimeSessionsUsed: 0,
    },
  );
  queryClient.setQueryData(serverProfileStatsQueryOptions().queryKey, RICH_STATS);
  queryClient.setQueryData(serverProfileTokenStatsQueryOptions().queryKey, RICH_TOKEN_STATS);
}

afterEach(() => {
  closeSettings();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  document.body.replaceChildren();
});

describe("Profile page, avatar presets, and Settings → 账号", () => {
  it("opens /profile directly when clicking the bottom-left rail avatar and returns with ← 返回 Moss", async () => {
    await page.viewport(1280, 860);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    seedBaseQueries(queryClient, true);

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <ThemeHarness />
          <MossLocaleScope locale="zh-CN">
            <Outlet />
          </MossLocaleScope>
        </QueryClientProvider>
      ),
    });
    const routeTree = rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/thread-1",
        component: () => (
          <div className="flex h-dvh items-end p-4">
            <RailAccountMenu />
            <p>当前对话页</p>
          </div>
        ),
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/profile",
        component: ProfilePage,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <p>对话首页</p>,
      }),
    ]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/thread-1"] }),
    });
    await router.load();
    const screen = await render(<RouterProvider router={router} />);

    try {
      await page.getByTestId("rail-account-menu-trigger").click();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
      expect(router.state.location.pathname).toBe("/thread-1");
      await expect.element(page.getByRole("menuitem", { name: "个人资料" })).toBeVisible();
      await page.getByRole("menuitem", { name: "个人资料" }).click();
      await expect.poll(() => router.state.location.pathname).toBe("/profile");
      await expect.element(page.getByTestId("moss-profile-page")).toBeVisible();

      // Verify ChatGPT-style 5 stats row rendered in Simplified Chinese.
      const statsRow = page.getByTestId("profile-stats-row");
      await expect.element(statsRow).toBeVisible();
      expect(statsRow.element().textContent).toContain("112.3亿");
      expect(statsRow.element().textContent).toContain("累计 Token 数");
      expect(statsRow.element().textContent).toContain("13.2亿");
      expect(statsRow.element().textContent).toContain("Token 使用峰值");
      expect(statsRow.element().textContent).toContain("17 小时 42 分");
      expect(statsRow.element().textContent).toContain("最长任务用时");
      expect(statsRow.element().textContent).toContain("14 天");
      expect(statsRow.element().textContent).toContain("最长连续天数");
      expect(statsRow.element().textContent).toContain("3 天");
      expect(statsRow.element().textContent).toContain("当前连续天数");

      // Token activity heatmap shows Chinese labels and daily/weekly/cumulative toggles.
      await expect.element(page.getByRole("heading", { name: "Token 活动" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "每天" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "每周" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "累计总量" })).toBeVisible();

      // Recent project and popular plugins rendered from Moss data.
      await expect.element(page.getByText("Moss Desktop")).toBeVisible();
      await expect.element(page.getByText("$superpowers")).toBeVisible();

      // Back button returns directly to the previous chat.
      const back = page.getByTestId("moss-profile-back");
      await expect.element(back).toHaveTextContent("返回 Moss");
      await back.click();
      await expect.poll(() => router.state.location.pathname).toBe("/thread-1");
      await expect.element(page.getByText("当前对话页")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("supports inline display name, live @handle uniqueness validation, and all 20 Notion-style SVG presets", async () => {
    await page.viewport(1200, 860);
    const updates: MossProfileUpdateInput[] = [];
    const checkedHandles: string[] = [];

    function InteractiveProfileHarness() {
      const [profileState, setProfileState] = useState<MossProfileState>({
        scope: "account",
        realm: "cn",
        sync: "synced",
        editable: true,
        profile: {
          displayName: "Milo charis",
          handle: "milo_init",
          avatar: { kind: "preset", id: "moss-pinwheel" },
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      });

      return (
        <MossLocaleScope locale="zh-CN">
          <ThemeHarness />
          <div className="mx-auto max-w-3xl bg-background p-6 text-foreground">
            <ProfileContent
              account="signedIn"
              planName="免费版"
              accountSummary="+86 138****8000"
              presentation="page"
              profileState={profileState}
              stats={RICH_STATS}
              tokenStats={RICH_TOKEN_STATS}
              tokensPending={false}
              onSignIn={() => undefined}
              onCheckHandle={async (rawHandle): Promise<MossProfileCheckHandleResult> => {
                checkedHandles.push(rawHandle);
                if (rawHandle === "taken_id") {
                  return { handle: rawHandle, status: "taken" };
                }
                return { handle: rawHandle, status: "available" };
              }}
              onUpdateProfile={async (input) => {
                updates.push(input);
                setProfileState((prev) => ({
                  ...prev,
                  profile: {
                    ...prev.profile,
                    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
                    ...(input.handle !== undefined ? { handle: input.handle } : {}),
                    ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
                    updatedAt: "2026-08-25T01:00:00.000Z",
                  },
                }));
              }}
            />
          </div>
        </MossLocaleScope>
      );
    }

    const screen = await render(<InteractiveProfileHarness />);

    try {
      // 1. Inline display name edit.
      await page.getByTestId("profile-name-trigger").click();
      const nameInput = page.getByTestId("profile-name-input");
      await expect.element(nameInput).toBeVisible();
      await nameInput.fill("小林同学");
      await page.getByTestId("profile-name-save").click();
      await expect.element(page.getByRole("heading", { level: 2, name: "小林同学" })).toBeVisible();
      expect(updates).toContainEqual({ displayName: "小林同学" });

      // 2. Inline @handle edit with taken + valid live availability checks.
      await page.getByTestId("profile-handle-trigger").click();
      const handleInput = page.getByTestId("profile-handle-input");
      await handleInput.fill("taken_id");
      await expect
        .element(page.getByTestId("profile-handle-feedback"))
        .toHaveTextContent("这个 ID 已被占用，换一个试试");
      await expect.element(page.getByTestId("profile-handle-save")).toBeDisabled();

      await handleInput.fill("lin_moss_01");
      await expect
        .element(page.getByTestId("profile-handle-feedback"))
        .toHaveTextContent("这个 ID 可以使用");
      await expect.element(page.getByTestId("profile-handle-save")).toBeEnabled();
      await page.getByTestId("profile-handle-save").click();
      await expect.element(page.getByText("@lin_moss_01")).toBeVisible();
      expect(checkedHandles).toContain("taken_id");
      expect(checkedHandles).toContain("lin_moss_01");
      expect(updates).toContainEqual({ handle: "lin_moss_01" });

      // 3. Avatar picker loads all 20 Notion-style SVG presets with real rendered dimensions.
      await page.getByTestId("profile-avatar-trigger").click();
      await expect.element(page.getByTestId("avatar-picker-dialog")).toBeVisible();
      const presetGrid = page.getByTestId("avatar-preset-grid").element();
      const presetButtons = presetGrid.querySelectorAll("[data-avatar-preset]");
      expect(presetButtons.length).toBe(PROFILE_AVATAR_PRESETS.length);
      expect(presetButtons.length).toBe(20);

      // Assert every SVG preset actually loaded into real pixels.
      await vi.waitFor(() => {
        const imgs = Array.from(presetGrid.querySelectorAll("img"));
        expect(imgs.length).toBe(20);
        for (const img of imgs) {
          expect(img.complete).toBe(true);
          expect(img.naturalWidth).toBeGreaterThan(0);
          const rect = img.getBoundingClientRect();
          expect(rect.width).toBeGreaterThanOrEqual(44);
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(Math.abs(rect.width - rect.height)).toBeLessThanOrEqual(2);
        }
      });

      // Pick "moss-cat" preset and save.
      await userEvent.click(
        presetGrid.querySelector<HTMLElement>('[data-avatar-preset="moss-cat"]')!,
      );
      await page.getByTestId("avatar-picker-save").click();
      await expect.element(page.getByTestId("avatar-picker-dialog")).not.toBeInTheDocument();
      expect(updates).toContainEqual({ avatar: { kind: "preset", id: "moss-cat" } });

      await vi.waitFor(() => {
        const heroImg = page.getByTestId("profile-avatar-trigger").element().querySelector("img");
        expect(heroImg?.getAttribute("src")).toBe("/avatars/moss-cat.svg");
        expect(heroImg?.getBoundingClientRect().width).toBeGreaterThanOrEqual(80);
      });

      // 4. Verify dark theme + narrow 390px viewport have no horizontal overflow.
      await setThemeMode("dark");
      await page.viewport(390, 800);
      await expect.element(page.getByRole("heading", { level: 2, name: "小林同学" })).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("preserves every account function inside Settings → 账号 (phone, login lanes, credits, usage, sign out)", async () => {
    await page.viewport(1024, 820);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    seedBaseQueries(queryClient, true);
    const navigatedSections: string[] = [];

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <MossLocaleScope locale="zh-CN">
            <div className="mx-auto max-w-2xl bg-background p-6 text-foreground">
              <AccountSettingsPanel
                onNavigate={(request) => {
                  if (request.section) navigatedSections.push(request.section);
                }}
              />
            </div>
          </MossLocaleScope>
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const screen = await render(<RouterProvider router={router} />);

    try {
      await expect.element(page.getByTestId("settings-account-phone")).toBeVisible();
      await expect.element(page.getByText("+8613800138000 · 手机号已验证")).toBeVisible();
      await expect.element(page.getByText("国内账号服务")).toBeVisible();
      await expect.element(page.getByText("登录方式")).toBeVisible();
      await expect.element(page.getByText("会员与积分")).toBeVisible();
      // Settings one-set 3/5: one line under the header says how usage is charged.
      await expect
        .element(page.getByText("用量按实际上游成本计费。", { exact: true }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("实际周期");
      // Explaining lines removed from this page stay removed.
      expect(document.body.textContent).not.toContain("登录状态已安全保存在本机");
      expect(document.body.textContent).not.toContain("在设置 → 用量与限额查看剩余额度并充值");
      await expect.element(page.getByText("用量与充值")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "打开个人资料" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "退出登录" })).toBeVisible();

      await page.getByRole("button", { name: "打开用量" }).click();
      expect(navigatedSections).toEqual(["usage"]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps 未登录 heading when only a preset avatar is saved while signed out", async () => {
    await page.viewport(1024, 820);

    function SignedOutAvatarHarness() {
      const [profileState, setProfileState] = useState<MossProfileState>({
        scope: "account",
        realm: "cn",
        sync: "local",
        editable: true,
        profile: {
          displayName: "milo",
          handle: null,
          avatar: { kind: "initials" },
          updatedAt: null,
        },
      });

      return (
        <MossLocaleScope locale="zh-CN">
          <div className="mx-auto max-w-3xl bg-background p-6 text-foreground">
            <ProfileContent
              account="signedOut"
              planName={null}
              accountSummary={null}
              presentation="page"
              profileState={profileState}
              stats={RICH_STATS}
              tokenStats={RICH_TOKEN_STATS}
              tokensPending={false}
              onSignIn={() => undefined}
              onCheckHandle={async (rawHandle) => ({ handle: rawHandle, status: "available" })}
              onUpdateProfile={async (input) => {
                setProfileState((prev) => ({
                  ...prev,
                  profile: {
                    ...prev.profile,
                    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
                    ...(input.handle !== undefined ? { handle: input.handle } : {}),
                    ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
                    updatedAt: "2026-08-25T01:00:00.000Z",
                  },
                }));
              }}
            />
          </div>
        </MossLocaleScope>
      );
    }

    const screen = await render(<SignedOutAvatarHarness />);
    try {
      await expect.element(page.getByRole("heading", { level: 2, name: "未登录" })).toBeVisible();
      await page.getByTestId("profile-avatar-trigger").click();
      await expect.element(page.getByTestId("avatar-picker-dialog")).toBeVisible();
      const presetGrid = page.getByTestId("avatar-preset-grid").element();
      await userEvent.click(
        presetGrid.querySelector<HTMLElement>('[data-avatar-preset="moss-cat"]')!,
      );
      await page.getByTestId("avatar-picker-save").click();
      await expect.element(page.getByTestId("avatar-picker-dialog")).not.toBeInTheDocument();

      await vi.waitFor(() => {
        const heroImg = page.getByTestId("profile-avatar-trigger").element().querySelector("img");
        expect(heroImg?.getAttribute("src")).toBe("/avatars/moss-cat.svg");
      });
      await expect.element(page.getByRole("heading", { level: 2, name: "未登录" })).toBeVisible();
      expect(page.getByRole("heading", { level: 2, name: "milo" }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("opens Settings → 插件 from standalone /profile without SidebarProvider crashing", async () => {
    await page.viewport(1280, 860);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    seedBaseQueries(queryClient, true);

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <ThemeHarness />
          <MossLocaleScope locale="zh-CN">
            <Outlet />
          </MossLocaleScope>
        </QueryClientProvider>
      ),
    });
    const routeTree = rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/profile",
        component: ProfilePage,
      }),
    ]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/profile"] }),
    });
    await router.load();
    const screen = await render(<RouterProvider router={router} />);

    try {
      await expect.element(page.getByTestId("moss-profile-page")).toBeVisible();
      await page.getByTestId("moss-profile-open-settings").click();
      await expect.element(page.getByTestId("settings-dialog")).toBeVisible();

      const nav = page.getByTestId("settings-dialog-nav");
      await expect.element(nav).toBeVisible();
      await nav.getByRole("button", { name: "插件", exact: true }).click();

      await expect
        .element(nav.getByRole("button", { name: "插件", exact: true }))
        .toHaveAttribute("aria-current", "page");
      await expect
        .element(page.getByTestId("settings-dialog-page").getByRole("heading", { name: "插件" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
