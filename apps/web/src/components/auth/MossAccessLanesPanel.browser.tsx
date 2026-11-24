// FILE: MossAccessLanesPanel.browser.tsx
// Purpose: What a person reads under 设置 → 账号 → 登录方式 (WALK-12 #893): one sentence under the
//          heading, then each sign-in method with its models and network.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
}));

import { MossLocalizationProvider } from "~/localization";
import { MossAccessLanesPanel } from "./MossAccessLanesPanel";

describe("登录方式", () => {
  it("keeps one sentence under the heading and a line under each method", async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <MossAccessLanesPanel />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = document.body.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "登录方式",
      "同一时间只有一种方式为 Moss 提供模型。",
      "手机号",
      "国内模型 · 国内网络直连",
      "登录",
      "Google 账号",
      "全部模型 · 需要可访问海外的网络",
      "登录",
      "企业 API Key",
      "全部模型 · 国内网络直连",
      "登录",
    ]);
  });
});
