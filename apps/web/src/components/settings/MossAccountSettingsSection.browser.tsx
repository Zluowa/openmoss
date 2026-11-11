// FILE: MossAccountSettingsSection.browser.tsx
// Purpose: Settings → 模型账号 has a Moss row that says, in Chinese, whether Moss is
//          connected, can't be reached right now, or isn't signed in.
// Layer: Settings browser test

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import { mossServerQueryKeys } from "../auth/mossServerReactQuery";
import { MossAccountSettingsSection } from "./MossAccountSettingsSection";
import { MossLocalizationProvider } from "~/localization";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({ settings: { localeOverride: "zh-CN" } }),
  };
});

function renderRow(phone: { authenticated: boolean; modelGatewayStatus?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    configured: true,
    session: null,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    ...phone,
  });
  queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), {
    configured: true,
    authenticated: false,
  });
  queryClient.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), {
    configured: true,
    authenticated: false,
    keyPrefix: null,
    verifiedAt: null,
    modelCount: 0,
    active: false,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <MossAccountSettingsSection />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("MossAccountSettingsSection", () => {
  it("says 已连接 while the gateway is ready", async () => {
    await renderRow({ authenticated: true, modelGatewayStatus: "ready" });
    await expect.element(page.getByText("已连接", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Moss 账号已可直接使用。")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "登录 Moss" })).not.toBeInTheDocument();
  });

  it("says 暂时连不上 while the gateway can't be reached, with no sign-in button", async () => {
    await renderRow({ authenticated: true, modelGatewayStatus: "transport-degraded" });
    await expect.element(page.getByText("暂时连不上", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Moss 服务暂时连不上，稍后会自动恢复。")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "登录 Moss" })).not.toBeInTheDocument();
  });

  it("offers 登录 Moss when no account is signed in", async () => {
    await renderRow({ authenticated: false });
    await expect.element(page.getByRole("button", { name: "登录 Moss" })).toBeVisible();
    expect(document.querySelector("[data-moss-account-row='signed-out']")).not.toBeNull();
  });
});
