import type {
  MossCloudAccountId,
  MossCloudAccountState,
  MossCloudEmail,
  MossCloudGoogleOAuthFlowId,
  MossCloudListAccountsResult,
} from "@synara/contracts";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "./mossServerReactQuery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossEnterpriseKeyPage } from "./MossEnterpriseKeyPage";
import {
  MossCloudAccountPage,
  MossCloudAuthCallbackPage,
  MossCloudLoginPage,
} from "./MossCloudAuthPages";
import { MossAccountPage, MossPhoneLoginPage } from "./MossPhoneAuth";

async function renderWithQueryClient(
  element: ReactNode,
  seed: (queryClient: QueryClient) => void,
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed(queryClient);

  const rootRoute = createRootRoute({
    component: () => <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("Moss auth pages", () => {
  it("makes mainland phone login primary and offers Google and enterprise keys with their reach", async () => {
    const markup = await renderWithQueryClient(<MossPhoneLoginPage />, (queryClient) => {
      queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
        configured: true,
        authenticated: false,
        session: null,
        smsProvider: "aliyun",
        aliyunSmsConfigured: true,
      });
    });
    const text = textContent(markup);

    expect(text).toContain("登录 Moss");
    expect(text).toContain("手机号");
    expect(text).toContain("获取验证码");
    expect(text).toContain("国内模型 · 国内网络直连");
    expect(text).toContain("其他登录方式");
    expect(text).toContain("使用 Google 继续");
    expect(text).toContain("全部模型 · 需要可访问海外的网络");
    expect(text).toContain("使用企业 API Key 登录");
    expect(markup).toContain('href="/login/api-key"');
    expect(text).not.toContain("邮箱登录");
    expect(text).not.toContain("Moss Key");
    expect(text).not.toMatch(/Aliyun.*Key|MemFire.*Key|service.?role|access.?token/iu);
  });

  it("keeps the phone form available when the session check fails", async () => {
    const markup = await renderWithQueryClient(<MossPhoneLoginPage />, (queryClient) => {
      const queryKey = serverMossAccountSessionQueryOptions().queryKey;
      queryClient.setQueryData(queryKey, {
        configured: true,
        authenticated: false,
        session: null,
        smsProvider: "aliyun",
        aliyunSmsConfigured: true,
      });
      queryClient
        .getQueryCache()
        .find({ queryKey })
        ?.setState({
          data: {
            configured: true,
            authenticated: false,
            session: null,
            smsProvider: "aliyun",
            aliyunSmsConfigured: true,
          },
          error: new Error("session unavailable"),
          fetchStatus: "idle",
          status: "error",
        });
    });
    const text = textContent(markup);

    expect(text).toContain("手机号");
    expect(text).toContain("获取验证码");
    expect(text).not.toContain("无法检查登录状态");
    expect(markup).toContain('id="moss-phone-number"');
  });

  it("shows the phone form immediately while the session check is pending", async () => {
    const markup = await renderWithQueryClient(<MossPhoneLoginPage />, (queryClient) => {
      const options = serverMossAccountSessionQueryOptions({ retry: 0 });
      queryClient.setQueryData(options.queryKey, null as never);
      queryClient.getQueryCache().find({ queryKey: options.queryKey })?.setState({
        data: undefined,
        error: null,
        fetchStatus: "fetching",
        status: "pending",
      });
    });
    const text = textContent(markup);

    expect(text).toContain("手机号");
    expect(text).toContain("获取验证码");
    expect(text).not.toContain("正在检查登录状态");
    expect(text).not.toContain("无法检查登录状态");
    expect(markup).toContain('id="moss-phone-number"');
  });

  it("keeps the unconfigured error when the server reports Moss phone auth is unavailable", async () => {
    const markup = await renderWithQueryClient(<MossPhoneLoginPage />, (queryClient) => {
      queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
        configured: false,
        authenticated: false,
        session: null,
        smsProvider: "aliyun",
        aliyunSmsConfigured: false,
      });
    });
    const text = textContent(markup);

    expect(text).toContain("手机号登录服务尚未配置。");
    expect(text).not.toContain("获取验证码");
  });

  it("shows a noninteractive entering state while an existing phone session redirects", async () => {
    const markup = await renderWithQueryClient(<MossPhoneLoginPage />, (queryClient) => {
      queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
        configured: true,
        authenticated: true,
        session: null,
        smsProvider: "aliyun",
        aliyunSmsConfigured: true,
      });
    });
    const text = textContent(markup);

    expect(text).toContain("正在进入 Moss…");
    expect(text).not.toContain("正在准备 Moss…");
    expect(text).not.toContain("获取验证码");
  });

  it("keeps unavailable email sign-in simple and routes back to phone login", async () => {
    const state = {
      configured: false,
      authenticated: false,
      account: null,
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: false,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState;

    const markup = await renderWithQueryClient(<MossCloudLoginPage />, (queryClient) => {
      queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, state);
    });
    const text = textContent(markup);

    expect(text).toContain("Sign in to Moss");
    expect(text).toContain("Moss account sign-in isn’t available right now.");
    expect(text).toContain("Use phone instead");
    expect(text).not.toContain("Moss Key");
    expect(text).not.toMatch(/Supabase|publishable key|RPC|BYOK|managed models/iu);
  });

  it("keeps add-account mode on the Google sign-in surface without exposing legacy credentials", async () => {
    const state = {
      configured: true,
      authenticated: true,
      account: null,
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState;

    const markup = await renderWithQueryClient(<MossCloudLoginPage addAccount />, (queryClient) => {
      queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, state);
    });
    const text = textContent(markup);

    expect(text).toContain("Add a Moss account");
    expect(text).toContain("Back to accounts");
    expect(text).toContain("使用 Google 继续");
    expect(markup).toContain('href="/account?accountView=google"');
    expect(markup).not.toMatch(/<input\b/u);
    expect(text).not.toMatch(/email address|password/iu);
    expect(text).not.toMatch(/access.?token|refresh.?token|session.?secret/iu);
  });

  it("renders compact saved-account controls from safe summaries", async () => {
    const accountId = "account-1" as MossCloudAccountId;
    const email = "person@example.com" as MossCloudEmail;
    const timestamp = "2026-07-12T00:00:00.000Z";
    const state = {
      configured: true,
      authenticated: true,
      account: {
        id: accountId,
        email,
        emailVerified: true,
        displayName: "Person",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastLoginAt: timestamp,
      },
      session: { accountId, expiresAt: timestamp, refreshedAt: timestamp },
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState;
    const saved = {
      accounts: [
        {
          id: accountId,
          email,
          emailVerified: true,
          displayName: "Person",
          status: "active",
          lastUsedAt: timestamp,
          selected: true,
          sessionAvailable: true,
        },
      ],
    } satisfies MossCloudListAccountsResult;

    const markup = await renderWithQueryClient(<MossCloudAccountPage />, (queryClient) => {
      queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, state);
      queryClient.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, saved);
    });
    const text = textContent(markup);

    expect(text).toContain("Saved accounts");
    expect(text).toContain("Add account");
    expect(markup).toContain('aria-label="Use person@example.com"');
    expect(markup).toContain('aria-label="Remove person@example.com"');
    expect(text).not.toMatch(/access.?token|refresh.?token|session.?secret/iu);
  });

  it("opens the global Google account surface without replacing an active phone session", async () => {
    const cloudState = {
      configured: true,
      authenticated: false,
      account: null,
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState;

    const markup = await renderWithQueryClient(<MossAccountPage view="google" />, (queryClient) => {
      queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
        configured: true,
        authenticated: true,
        session: null,
        smsProvider: "aliyun",
        aliyunSmsConfigured: true,
      });
      queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, cloudState);
      queryClient.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, { accounts: [] });
    });
    const text = textContent(markup);

    expect(text).toContain("Your accounts");
    expect(text).toContain("Add account");
    expect(text).not.toContain("国内账号服务");
    expect(text).not.toContain("手机号已验证");
  });

  it("signs in with an enterprise key alone, without a phone or Google account", async () => {
    const markup = await renderWithQueryClient(<MossEnterpriseKeyPage />, (queryClient) => {
      queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
        configured: true,
        authenticated: false,
        keyPrefix: null,
        verifiedAt: null,
        modelCount: 0,
        active: false,
      });
    });
    const text = textContent(markup);

    expect(text).toContain("使用企业 API Key 登录");
    expect(text).toContain("全部模型 · 国内网络直连");
    expect(text).toContain("企业 API Key");
    expect(text).toContain("使用其他方式登录");
    expect(markup.match(/<input\b/gu)).toHaveLength(1);
    expect(markup).toContain('placeholder="moss_sk_…"');
    expect(text).not.toMatch(/Moss account required|BYOK|OpenRouter|GPT‑5\.6/iu);
  });

  it("offers the saved enterprise key without showing the key itself", async () => {
    const markup = await renderWithQueryClient(<MossEnterpriseKeyPage />, (queryClient) => {
      queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
        configured: true,
        authenticated: true,
        keyPrefix: "moss_sk_AbCd",
        verifiedAt: "2026-10-28T00:00:00.000Z",
        modelCount: 18,
        active: false,
      });
    });
    const text = textContent(markup);

    expect(text).toContain("moss_sk_AbCd…");
    expect(text).toContain("使用已保存的 Key");
    expect(text).toContain("移除 Key");
  });

  it("fails closed unless a Google callback contains both code and flow id", async () => {
    const state = {
      configured: true,
      authenticated: false,
      account: null,
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
    } satisfies MossCloudAccountState;
    const codeOnlyMarkup = await renderWithQueryClient(
      <MossCloudAuthCallbackPage code="one-time-code" />,
      (queryClient) => {
        queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, state);
      },
    );
    const completeMarkup = await renderWithQueryClient(
      <MossCloudAuthCallbackPage
        code="one-time-code"
        flowId={"flow_abcdefghijklmnopqrstuvwxyz-0123456789" as MossCloudGoogleOAuthFlowId}
      />,
      (queryClient) => {
        queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, state);
      },
    );

    expect(textContent(codeOnlyMarkup)).toContain("This Google sign-in link is incomplete.");
    expect(textContent(completeMarkup)).toContain("Completing Google sign-in…");
    expect(textContent(completeMarkup)).not.toContain("email link");
  });
});
