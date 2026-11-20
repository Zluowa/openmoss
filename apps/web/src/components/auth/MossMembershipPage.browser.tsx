// FILE: MossMembershipPage.browser.tsx
// Purpose: The full-page 选择套餐 and Moss 账号 screens as a person meets them: 「← 返回 Moss」
//          returns to the chat they came from, and the plan picker reads in the dark theme
//          (visible 订阅 buttons, all four plans in one row, a plain price unit).
// Layer: Browser UI test

import "../../index.css";

import type { MossPayCatalog } from "@moss/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTheme } from "~/hooks/useTheme";
import { MossLocaleScope } from "~/localization";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";
import { MossMembershipPage } from "./MossMembershipPage";
import { MossPhoneAccountPage } from "./MossPhoneAuth";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
} from "./mossServerReactQuery";

// Kept beside the test (git-ignored) for the lead to review.
const SHOTS = "__screenshots__/devs-1120";

function plan(code: string, displayName: string, priceCny: number, sortOrder: number) {
  return {
    code,
    displayName,
    monthlyPriceCny: priceCny,
    monthlyCreditLimit: priceCny / 10,
    fiveHourCreditLimit: 0,
    weeklyCreditLimit: 0,
    standardTaskEstimate: 60,
    billingModel: "cost_budget_v1",
    monthlyTokenLimit: 0,
    monthlyRequestLimit: 0,
    modelAllowlist: [],
    monthlyRealtimeCostLimitNanoUsd: 0,
    monthlyRealtimeSessionLimit: 0,
    realtimeModelAllowlist: [],
    estimatedRealtimeMinutes: 0,
    sortOrder,
  } satisfies MossPayCatalog["plans"][number];
}

// The four personal plans the free-plan user saw (prices come from the server).
const CATALOG: MossPayCatalog = {
  plans: [
    plan("basic", "Basic", 4_900, 1),
    plan("plus", "Plus", 9_900, 2),
    plan("pro", "Pro", 19_900, 3),
    plan("max", "Max", 69_900, 4),
  ],
  pointPackages: [],
  paymentMethods: [{ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" }],
  plansPurchasable: true,
};

function seededQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    session: null,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
  });
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    account: null,
    session: null,
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
  });
  queryClient.setQueryData(serverMossPayCatalogQueryOptions().queryKey, CATALOG);
  return queryClient;
}

// The page runs inside the app's theme store, as in the app; switch it the way Settings does.
function ThemeHarness() {
  useTheme();
  return null;
}

async function switchAppTheme(mode: "light" | "dark") {
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await vi.waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(mode === "dark"),
  );
}

async function mount(initialEntries: string[]) {
  const queryClient = seededQueryClient();
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
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>对话首页</p> }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/thread-1",
      component: () => <p>正在进行的对话</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/membership",
      component: () => <MossMembershipPage />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/account",
      component: MossPhoneAccountPage,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries, initialIndex: initialEntries.length - 1 }),
  });
  await router.load();
  const screen = await render(<RouterProvider router={router} />);
  return { router, screen };
}

function channels(color: string): [number, number, number] {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

afterEach(() => {
  localStorage.removeItem("moss:theme");
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

describe("「← 返回 Moss」 on the full-page account screens", () => {
  it("returns from 选择套餐 to the chat the person came from", async () => {
    const { router, screen } = await mount(["/thread-1", "/membership"]);
    const back = page.getByTestId("moss-membership-back");
    await expect.element(back).toHaveTextContent("返回 Moss");
    await back.click();
    await expect.element(page.getByText("正在进行的对话")).toBeVisible();
    expect(router.state.location.pathname).toBe("/thread-1");
    await screen.unmount();
  });

  it("goes to the chats when 选择套餐 was opened directly", async () => {
    const { router, screen } = await mount(["/membership"]);
    await page.getByTestId("moss-membership-back").click();
    await expect.element(page.getByText("对话首页")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    await screen.unmount();
  });

  it("returns from the Moss 账号 page to the chat the person came from", async () => {
    const { router, screen } = await mount(["/thread-1", "/account"]);
    const back = page.getByRole("button", { name: "返回 Moss" });
    await expect.element(back).toBeVisible();
    const box = back.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThan(40);
    expect(box.left).toBeLessThan(window.innerWidth / 2);
    await back.click();
    await expect.element(page.getByText("正在进行的对话")).toBeVisible();
    expect(router.state.location.pathname).toBe("/thread-1");
    await screen.unmount();
  });
});

describe("选择套餐 in the dark theme", () => {
  it("shows four plans in one row with readable 订阅 buttons and a plain price unit", async () => {
    await page.viewport(1593, 1014);
    const { screen } = await mount(["/thread-1", "/membership"]);
    try {
      await switchAppTheme("dark");
      const max = page.getByTestId("moss-membership-plan-max");
      await expect.element(max).toBeVisible();

      // All four cards sit in the first screen: Max is not pushed below the fold.
      const scroller = page.getByTestId("moss-membership-scroll").element();
      const viewportBottom = scroller.getBoundingClientRect().bottom;
      const tops = ["basic", "plus", "pro", "max"].map((code) => {
        const card = page.getByTestId(`moss-membership-plan-${code}`).element();
        const rect = card.getBoundingClientRect();
        expect(rect.bottom).toBeLessThanOrEqual(viewportBottom);
        return rect.top;
      });
      expect(new Set(tops.map(Math.round)).size).toBe(1);

      // The 订阅 button is a visible filled control on the dark card, not a hairline.
      const card = page.getByTestId("moss-membership-plan-plus").element();
      const subscribe = page.getByTestId("moss-membership-subscribe-plus").element();
      const cardBackground = getComputedStyle(card).backgroundColor;
      const buttonStyle = getComputedStyle(subscribe);
      expect(subscribe.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
      expect(contrast(buttonStyle.backgroundColor, cardBackground)).toBeGreaterThan(3);
      expect(contrast(buttonStyle.color, buttonStyle.backgroundColor)).toBeGreaterThan(4.5);

      // The price says what is bought: a one-time pack, not 「/份」.
      expect(card.textContent).toContain("一次性");
      expect(document.body.textContent).not.toContain("/份");
      // The audience switch is Chinese.
      await expect
        .element(page.getByTestId("moss-membership-audience-business"))
        .toHaveTextContent("团队");

      // The header keeps 返回 Moss in the title bar, clear of the window buttons.
      const back = page.getByTestId("moss-membership-back").element().getBoundingClientRect();
      expect(back.top).toBeLessThan(44);
      expect(back.left).toBeLessThan(40);

      await page.screenshot({ path: `${SHOTS}/membership-dark-1593.png` });
      await switchAppTheme("light");
      expect(
        contrast(
          getComputedStyle(subscribe).backgroundColor,
          getComputedStyle(card).backgroundColor,
        ),
      ).toBeGreaterThan(3);
      await page.screenshot({ path: `${SHOTS}/membership-light-1593.png` });
    } finally {
      await screen.unmount();
    }
  });
});
