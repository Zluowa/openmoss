// FILE: AppearanceSettingsLines.browser.tsx
// Purpose: What a person reads on 设置 → 外观 under 字体排版与间距 and 时间与阅读 (WALK-12, #892).
//          A line under a setting stays only when the label alone does not say what the control
//          does or costs; these six only repeated their label.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { SettingsContent } from "./SettingsContent";

describe("设置 → 外观", () => {
  it("shows the typography and time settings as labels and controls, without lines that repeat them", async () => {
    installZhCnUiLocalization();
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "appearance" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const lines = document.body.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.slice(lines.indexOf("字体排版与间距"))).toEqual([
      "字体排版与间距",
      "使用默认界面字体",
      "界面密度",
      "紧凑",
      "舒适",
      "宽松",
      "对话宽度",
      "标准",
      "宽",
      "全宽",
      "基础字号",
      "px",
      "终端字号",
      "px",
      "终端字体",
      "时间与阅读",
      "时间格式",
      "跟随系统",
    ]);
  });
});
