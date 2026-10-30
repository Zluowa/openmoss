// FILE: DesktopPluginDeepLinkRouter.browser.tsx
// Purpose: Locks cold/warm desktop plugin deep links against real TanStack history.
// Layer: Browser integration test

import type { DesktopBridge, DesktopPluginDeepLinkNavigation } from "@synara/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DesktopPluginDeepLinkRouter } from "./DesktopPluginDeepLinkRouter";

type DeepLinkListener = (navigation: DesktopPluginDeepLinkNavigation) => boolean | Promise<boolean>;

const mountedScreens: Array<Awaited<ReturnType<typeof render>>> = [];
let previousDesktopBridge: DesktopBridge | undefined;

afterEach(async () => {
  while (mountedScreens.length > 0) await mountedScreens.pop()!.unmount();
  if (previousDesktopBridge) window.desktopBridge = previousDesktopBridge;
  else delete window.desktopBridge;
  previousDesktopBridge = undefined;
});

async function mountRouter(initialPath: string) {
  let listener: DeepLinkListener | undefined;
  const unsubscribe = vi.fn();
  previousDesktopBridge = window.desktopBridge;
  window.desktopBridge = {
    pluginDeepLinks: {
      onNavigate(next: DeepLinkListener) {
        listener = next;
        return unsubscribe;
      },
    },
  } as unknown as DesktopBridge;

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <DesktopPluginDeepLinkRouter />
        <Outlet />
      </>
    ),
  });
  const sourceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/source",
    component: () => <div>Source</div>,
  });
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => <div>Skills</div>,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/plugins/$pluginId",
    component: () => <div>Plugin detail</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sourceRoute, skillsRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await router.load();
  mountedScreens.push(await render(<RouterProvider router={router} />));
  await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
  return {
    listener: () => {
      if (!listener) throw new Error("Desktop plugin deep-link listener was not subscribed.");
      return listener;
    },
    router,
    unsubscribe,
  };
}

describe("DesktopPluginDeepLinkRouter history", () => {
  it("replaces a cold launch with /skills, then PUSHes detail so Back lands on /skills", async () => {
    const mounted = await mountRouter("/source");
    await expect(
      Promise.resolve(
        mounted.listener()({
          deliveryId: "plugin-deep-link-1",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: true,
          source: "initial-argv",
        }),
      ),
    ).resolves.toBe(true);
    expect(mounted.router.state.location.pathname).toBe("/skills/plugins/github%40openai-curated");
    const historyState = mounted.router.state.location.state as unknown as Record<string, unknown>;
    expect(historyState.desktopPluginDeepLink).toEqual({
      coldStart: true,
      source: "initial-argv",
    });
    expect(historyState).not.toHaveProperty("deliveryId");
    expect(historyState).not.toHaveProperty("route");

    mounted.router.history.back();
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/skills"));
  });

  it("PUSHes a warm delivery and preserves the current route as Back history", async () => {
    const mounted = await mountRouter("/source");
    await expect(
      Promise.resolve(
        mounted.listener()({
          deliveryId: "plugin-deep-link-2",
          route: "/skills/plugins/github%40openai-curated",
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(true);
    expect(mounted.router.state.location.pathname).toBe("/skills/plugins/github%40openai-curated");
    const historyState = mounted.router.state.location.state as unknown as Record<string, unknown>;
    expect(historyState.desktopPluginDeepLink).toEqual({
      coldStart: false,
      source: "second-instance",
    });
    expect(historyState).not.toHaveProperty("deliveryId");
    expect(historyState).not.toHaveProperty("route");

    mounted.router.history.back();
    await vi.waitFor(() => expect(mounted.router.state.location.pathname).toBe("/source"));
  });

  it("PUSHes a distinct warm activation on the same route so Back restores the original detail", async () => {
    const detailPath = "/skills/plugins/github%40openai-curated";
    const mounted = await mountRouter(detailPath);

    await expect(
      Promise.resolve(
        mounted.listener()({
          deliveryId: "plugin-deep-link-3",
          route: detailPath,
          coldStart: false,
          source: "second-instance",
        }),
      ),
    ).resolves.toBe(true);
    expect(mounted.router.state.location.pathname).toBe(detailPath);
    const pushedHistoryState = mounted.router.state.location.state as unknown as Record<
      string,
      unknown
    >;
    expect(pushedHistoryState.desktopPluginDeepLink).toEqual({
      coldStart: false,
      source: "second-instance",
    });

    mounted.router.history.back();
    await vi.waitFor(() => {
      expect(mounted.router.state.location.pathname).toBe(detailPath);
      const restoredHistoryState = mounted.router.state.location.state as unknown as Record<
        string,
        unknown
      >;
      expect(restoredHistoryState.desktopPluginDeepLink).toBeUndefined();
    });
  });
});
