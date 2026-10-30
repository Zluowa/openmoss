import type {
  MossEnterpriseKeyState,
  MossCloudAccountId,
  MossCloudAccountState,
  MossCloudEmail,
} from "@synara/contracts";
import {
  serverMossAccountSessionQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
} from "./mossServerReactQuery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "~/localization";
import { MossCloudAccountEntry } from "./MossCloudAccountEntry";

const TIMESTAMP = "2026-08-13T00:00:00.000Z";

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

async function renderEntryWithCachedAccountError(): Promise<string> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const accountOptions = serverMossCloudAccountStateQueryOptions();
  const accountId = "account-cached" as MossCloudAccountId;
  const email = "cached@example.invalid" as MossCloudEmail;
  const accountState = {
    configured: true,
    authenticated: true,
    account: {
      id: accountId,
      email,
      emailVerified: true,
      displayName: "Cached test account",
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
  } satisfies MossCloudAccountState;
  const enterpriseKeyState = {
    configured: true,
    authenticated: false,
    keyPrefix: null,
    verifiedAt: null,
    modelCount: 0,
    active: false,
  } satisfies MossEnterpriseKeyState;

  queryClient.setQueryData(accountOptions.queryKey, accountState);
  queryClient
    .getQueryCache()
    .find({ queryKey: accountOptions.queryKey })
    ?.setState({
      error: new Error("private account backend failed at /internal/account.ts:42"),
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
  queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, enterpriseKeyState);

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <MossCloudAccountEntry />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <MossLocaleScope locale="zh-CN">
      <RouterProvider router={router} />
    </MossLocaleScope>,
  );
}

describe("MossCloudAccountEntry", () => {
  it("keeps cached account identity usable through a background query failure", async () => {
    const markup = await renderEntryWithCachedAccountError();
    const text = textContent(markup);

    expect(text).toContain("cached@example.invalid");
    expect(text).toContain("Moss 账号");
    expect(text).toContain("管理");
    expect(markup).toContain('aria-label="管理 Moss 账号"');
    expect(markup).toContain('aria-label="管理企业 API Key"');
    expect(text).not.toContain("账号不可用");
    expect(text).not.toContain("private account backend");
    expect(text).not.toContain("Account unavailable");
  });
});
