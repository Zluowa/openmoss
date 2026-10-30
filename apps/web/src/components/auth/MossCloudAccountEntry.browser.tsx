// FILE: MossCloudAccountEntry.browser.tsx
// Purpose: Mounted zh-CN and stale-cache accessibility coverage for the account entry.
// Layer: Browser UI test

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type MossEnterpriseKeyState,
  type MossCloudAccountId,
  type MossCloudAccountState,
  type MossCloudEmail,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  serverMossAccountSessionQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
} from "./mossServerReactQuery";
import { MossLocalizationProvider } from "~/localization";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";
import { MossCloudAccountEntry } from "./MossCloudAccountEntry";

const TIMESTAMP = "2026-08-13T00:00:00.000Z";

describe("MossCloudAccountEntry", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  });

  it("keeps a cached signed-in account usable and localized when refresh fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    const accountOptions = serverMossCloudAccountStateQueryOptions();
    const accountId = "account-browser-cache" as MossCloudAccountId;
    const email = "cached-browser@example.invalid" as MossCloudEmail;
    queryClient.setQueryData(accountOptions.queryKey, {
      configured: true,
      authenticated: true,
      account: {
        id: accountId,
        email,
        emailVerified: true,
        displayName: "Cached browser account",
        status: "active",
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        lastLoginAt: TIMESTAMP,
      },
      session: {
        accountId,
        expiresAt: "2026-09-13T00:00:00.000Z",
        refreshedAt: TIMESTAMP,
      },
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState);
    queryClient
      .getQueryCache()
      .find({ queryKey: accountOptions.queryKey })
      ?.setState({
        error: new Error("private backend path /internal/account.ts token TOKEN_SENTINEL"),
        fetchStatus: "idle",
        status: "error",
      });
    queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
      configured: true,
      authenticated: false,
      session: null,
      smsProvider: "aliyun",
      aliyunSmsConfigured: true,
    });
    queryClient.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, { accounts: [] });
    queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
      configured: true,
      authenticated: false,
      keyPrefix: null,
      verifiedAt: null,
      modelCount: 0,
      active: false,
    } satisfies MossEnterpriseKeyState);

    const rootRoute = createRootRoute({ component: MossCloudAccountEntry });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const mounted = await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <RouterProvider router={router} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    try {
      await expect.element(page.getByText(email)).toBeVisible();
      await expect.element(page.getByRole("link", { name: "管理 Moss 账号" })).toBeVisible();
      await expect.element(page.getByRole("link", { name: "管理企业 API Key" })).toBeVisible();
      expect(document.body.textContent ?? "").not.toMatch(
        /TOKEN_SENTINEL|internal\/account|账号不可用|Account unavailable/u,
      );
    } finally {
      await mounted.unmount();
      queryClient.clear();
    }
  });
});
