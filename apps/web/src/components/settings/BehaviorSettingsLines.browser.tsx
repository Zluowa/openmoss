// FILE: BehaviorSettingsLines.browser.tsx
// Purpose: What a person reads on 设置 → 对话行为 (WALK-12 N12-4). A line under a setting stays only
//          when the label alone does not say what the control does or what it costs.
// Layer: Browser UI test

import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { installZhCnUiLocalization } from "~/localization/zhCN";
import { SettingsContent } from "./SettingsContent";

describe("设置 → 对话行为", () => {
  it("keeps only the lines a person needs and drops those that repeat their label", async () => {
    installZhCnUiLocalization();
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <SettingsContent location={{ section: "behavior" }} onNavigate={() => {}} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const lines = document.body.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "对话行为",
      "恢复默认",
      "对话",
      "后续消息处理",
      "Moss 工作时发送的消息：排队，或者引导当前任务。",
      "排队",
      "引导",
      "侧边对话过期",
      "1 小时",
      "24 小时",
      "从未",
      "听写时的 Enter 键",
      "停止",
      "停止并发送",
      "边写边显示回复",
      "折叠已完成的回合",
      "思考强度滑块",
      "速率限制提醒",
      "关闭后，达到上限时仍会提示。",
      "自动打开模拟器",
      "审阅",
      "差异布局",
      "堆叠",
      "并排",
      "打开拉取请求和议题",
      "在 Moss 中",
      "拉取请求差异着色",
      "包含复刻的上游仓库",
      "差异行换行",
      "议题来源",
      "Linear",
      "正在检查…",
      "Jira",
      "正在检查…",
      "安全确认",
      "删除对话前确认",
      "归档对话前确认",
      "关闭终端标签前确认",
      "关闭标签会清除它的历史。",
    ]);
  });
});
