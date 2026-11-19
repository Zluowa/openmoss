// FILE: MossLoginBack.browser.tsx
// Purpose: The 登录 Moss page reached from inside the app (the composer's sign-in notice)
//          offers a way back: to where the person was, or to the chats when opened directly.
// Layer: Browser UI test

import "../../index.css";

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
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "~/localization";
import { mossServerQueryKeys } from "./mossServerReactQuery";
import { MossPhoneLoginPage } from "./MossPhoneAuth";

async function mountLogin(initialEntries: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: false,
    session: null,
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
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
      path: "/images",
      component: () => <p>图像页</p>,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: MossPhoneLoginPage }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries, initialIndex: initialEntries.length - 1 }),
  });
  await router.load();
  const screen = await render(<RouterProvider router={router} />);
  return { router, screen };
}

describe("登录 Moss page", () => {
  it("goes back to where the person was", async () => {
    const { router, screen } = await mountLogin(["/images", "/login"]);
    await expect.element(page.getByRole("heading", { name: "登录 Moss" })).toBeVisible();
    const back = page.getByRole("button", { name: "返回", exact: true });
    await expect.element(back).toBeVisible();
    // In the title bar, clear of the window buttons on the right.
    const box = back.element().getBoundingClientRect();
    expect(box.top).toBeLessThan(44);
    expect(box.left).toBeLessThan(window.innerWidth / 2);
    await back.click();
    await expect.element(page.getByText("图像页")).toBeVisible();
    expect(router.state.location.pathname).toBe("/images");
    await screen.unmount();
  });

  it("goes to the chats when the page was opened directly", async () => {
    const { router, screen } = await mountLogin(["/login"]);
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect.element(page.getByText("对话首页")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    await screen.unmount();
  });
});
