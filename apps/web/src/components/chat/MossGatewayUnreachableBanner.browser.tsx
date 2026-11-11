// FILE: MossGatewayUnreachableBanner.browser.tsx
// Purpose: A chat on a Moss lane says Moss can't be reached while the gateway is down, in
//          Chinese, and a chat on a local account says nothing.
// Layer: Chat status browser test

import type { ProviderInstanceId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import { mossServerQueryKeys } from "../auth/mossServerReactQuery";
import { MossGatewayUnreachableBanner } from "./MossGatewayUnreachableBanner";
import { MossLocalizationProvider } from "~/localization";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({ settings: { localeOverride: "zh-CN" } }),
  };
});

function renderBanner(instanceId: string, modelGatewayStatus: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    configured: true,
    authenticated: true,
    session: null,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    modelGatewayStatus,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <MossGatewayUnreachableBanner instanceId={instanceId as ProviderInstanceId} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("MossGatewayUnreachableBanner", () => {
  it("says Moss can't be reached on a Moss lane while the gateway is down", async () => {
    await renderBanner("claude_moss", "transport-degraded");
    await expect.element(page.getByText("Moss 服务暂时连不上")).toBeVisible();
    await expect.element(page.getByText("稍后会自动恢复，你的登录状态不受影响。")).toBeVisible();
  });

  it("stays silent on a local account, and once the gateway is ready", async () => {
    const local = await renderBanner("claudeAgent", "transport-degraded");
    expect(document.querySelector("[data-moss-gateway-unreachable]")).toBeNull();
    await local.unmount();
    await renderBanner("claude_moss", "ready");
    expect(document.querySelector("[data-moss-gateway-unreachable]")).toBeNull();
  });
});
