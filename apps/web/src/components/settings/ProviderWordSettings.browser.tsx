// FILE: ProviderWordSettings.browser.tsx
// Purpose: 设置 → 通用 names the provider setting with the glossary's word, 服务商, the same word the
//          model menu and 模型与智能体 use (WALK-12 N12-7).
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { SettingsContent } from "./SettingsContent";

describe("设置 → 通用", () => {
  it("says 服务商, never 提供商", async () => {
    installZhCnUiLocalization();
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "general" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const text = document.body.innerText;
    expect(text).toContain("默认服务商");
    expect(text).not.toContain("提供商");
  });
});
