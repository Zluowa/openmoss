// FILE: zhCNPresentation.test.ts
// Purpose: Locks the merged-shell zh-CN coverage added for the welcome tour, provider-update
//          banner, import banner, Inbox, Safari onboarding, settings panels, and Moss Beta card.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("translateZhCnPresentationText merged-shell coverage", () => {
  it("translates the provider-update toast through the shared chain", () => {
    expect(translateZhCnPresentationText("4 provider updates available")).toBe(
      "4 个服务商有可用更新",
    );
    expect(
      translateZhCnPresentationText("OpenCode and 3 more providers have newer versions available."),
    ).toBe("OpenCode 和另外 3 个服务商有新版本可用。");
    expect(translateZhCnPresentationText("Review updates")).toBe("查看更新");
    expect(translateZhCnPresentationText("Update all")).toBe("全部更新");
  });

  it("translates the welcome-tour local-first tile as a whole sentence", () => {
    expect(translateZhCnPresentationText("No account. Workspace data stays on this machine.")).toBe(
      "不需要账号。工作区数据留在这台电脑上。",
    );
  });

  it("keeps the date in empty activity-heatmap days", () => {
    expect(translateZhCnPresentationText("No prompts on Jul 17, 2026")).toBe(
      "Jul 17, 2026：无提示词",
    );
    expect(translateZhCnPresentationText("No tokens on Jul 17, 2026")).toBe(
      "Jul 17, 2026：无 token",
    );
  });

  it("translates the project-import landing banner", () => {
    expect(translateZhCnPresentationText("Import your Claude Code and Codex projects")).toBe(
      "导入你的 Claude Code 和 Codex 项目",
    );
    expect(translateZhCnPresentationText("Bring your chats and continue them in Moss")).toBe(
      "带上你的聊天记录，在 Moss 中继续",
    );
  });

  it("translates the welcome tour slides and controls", () => {
    expect(translateZhCnPresentationText("A new home for your work")).toBe("你的工作新家");
    expect(
      translateZhCnPresentationText(
        "A slimmer rail, open-chat tabs, and refreshed icons put your workspace within reach.",
      ),
    ).toBe("更窄的导航栏、已打开对话的标签页和焕然一新的图标，让你的工作区触手可及。");
    expect(
      translateZhCnPresentationText("Customize the rail and keep your favorite tools close."),
    ).toBe("自定义导航栏，让常用工具近在咫尺。");
    expect(translateZhCnPresentationText("Move between open chats or work in split panes.")).toBe(
      "在已打开的对话之间切换，或使用分屏窗格工作。",
    );
    expect(
      translateZhCnPresentationText(
        "Make it yours with project icons, colors, and window appearance.",
      ),
    ).toBe("通过项目图标、颜色和窗口外观，打造属于你的风格。");
    expect(translateZhCnPresentationText("Skip tour")).toBe("跳过导览");
    expect(translateZhCnPresentationText("Start exploring")).toBe("开始探索");
  });

  it("translates the Inbox greeting, summary tail, and empty state", () => {
    expect(translateZhCnPresentationText("Good morning")).toBe("早上好");
    expect(translateZhCnPresentationText("Good afternoon")).toBe("下午好");
    expect(translateZhCnPresentationText("Good evening")).toBe("晚上好");
    expect(translateZhCnPresentationText("10月8日星期四. You’re all caught up.")).toBe(
      "10月8日星期四。一切都已处理完毕。",
    );
    expect(translateZhCnPresentationText("10月8日星期四. 2 things need you.")).toBe(
      "10月8日星期四。有 2 件事需要你处理。",
    );
    expect(translateZhCnPresentationText("10月8日星期四. 1 thing needs you. 3 tasks to do.")).toBe(
      "10月8日星期四。有 1 件事需要你处理。还有 3 项任务待办。",
    );
    expect(translateZhCnPresentationText("10月8日星期四. 3 tasks to do.")).toBe(
      "10月8日星期四。有 3 项任务待办。",
    );
    expect(
      translateZhCnPresentationText("Nothing ran yet today. This fills in as your agents work."),
    ).toBe("今天还没有任何运行记录。随着智能体工作，这里会自动填充。");
    expect(translateZhCnPresentationText("Mark all read")).toBe("全部标为已读");
    expect(translateZhCnPresentationText("Left on Cursor, current")).toBe("Cursor（current）剩余");
  });

  it("translates automation, plugin, and Kanban chrome through the shared chain", () => {
    expect(
      translateZhCnPresentationText(
        "Pick an automation in the panel to see its runs, or schedule a new one.",
      ),
    ).toBe("在面板中选择一个自动化工作流即可查看其运行记录，也可以新建定时任务。");
    expect(translateZhCnPresentationText("No installed plugins yet.")).toBe("还没有已安装的插件。");
    expect(translateZhCnPresentationText("Installed")).toBe("已安装");
    expect(translateZhCnPresentationText("Attention")).toBe("关注");
    expect(translateZhCnPresentationText("Classic")).toBe("经典");
    expect(translateZhCnPresentationText("Awaiting you")).toBe("待你处理");
  });

  it("translates General settings rows and navigation descriptions", () => {
    expect(
      translateZhCnPresentationText(
        "Choose defaults for new chats, navigation, and the Environment panel.",
      ),
    ).toBe("为新对话、导航和环境面板选择默认设置。");
    expect(
      translateZhCnPresentationText(
        "Provider used for new chats until you pick a model. New chats then reuse your most recent model and options.",
      ),
    ).toBe("在你选择模型之前，新对话使用此服务商；之后新对话会沿用你最近使用的模型和选项。");
    expect(
      translateZhCnPresentationText(
        "After Archive's Undo period, remove a clean worktree only if the task has stopped and no other task uses it. Its branch remains available for recovery.",
      ),
    ).toBe(
      "归档的撤销期过后，仅当任务已停止且没有其他任务使用时，才移除干净的工作树；其分支仍会保留以便恢复。",
    );
    expect(
      translateZhCnPresentationText(
        "Move each sent message to the top of the conversation. Turn off to keep it at the bottom and follow replies as they stream.",
      ),
    ).toBe("将每条已发送消息移到对话顶部；关闭后消息保留在底部，可跟随回复流式滚动。");
    expect(
      translateZhCnPresentationText(
        "Replay the first-run setup: feature tour, provider selection, appearance, and first project.",
      ),
    ).toBe("重玩首次启动设置：功能导览、服务商选择、外观和第一个项目。");
    expect(translateZhCnPresentationText("Working and unread on top")).toBe("进行中和未读置顶");
    expect(
      translateZhCnPresentationText(
        "With Recently active order, move working and unread threads above the rest. The list holds still while your pointer is over it.",
      ),
    ).toBe(
      "在“最近活跃”排序下，把进行中和未读的对话排到其余对话前面。指针悬停在列表上时，顺序保持不动。",
    );
    expect(translateZhCnPresentationText("Open welcome tour")).toBe("打开欢迎导览");
    expect(translateZhCnPresentationText("Welcome to Moss")).toBe("欢迎使用 Moss");
    expect(translateZhCnPresentationText("No account. Workspace data stays on this machine.")).toBe(
      "不需要账号。工作区数据留在这台电脑上。",
    );
    expect(translateZhCnPresentationText("Skip setup")).toBe("跳过设置");
    expect(translateZhCnPresentationText("Replay feature tour")).toBe("重播功能导览");
    expect(translateZhCnPresentationText("Activity scope")).toBe("活动范围");
    expect(translateZhCnPresentationText("Loading activity...")).toBe("正在加载活动…");
    expect(translateZhCnPresentationText("Drafts")).toBe("草稿");
    expect(translateZhCnPresentationText("Earlier")).toBe("更早");
    expect(translateZhCnPresentationText("Snoozed")).toBe("已暂停");
    expect(translateZhCnPresentationText("Return now")).toBe("立即返回");
    expect(translateZhCnPresentationText("Safari import setup")).toBe("Safari 导入设置");
  });

  it("translates the Moss Beta card and its install lifecycle", () => {
    expect(
      translateZhCnPresentationText(
        "Try new features before everyone else. Moss Beta is a separate app with its own data, and this app stays exactly as it is. Beta shares crash reports and anonymous usage stats to help us improve it.",
      ),
    ).toBe(
      "先于所有人体验新功能。Moss Beta 是独立的应用，拥有独立数据，此应用保持原样。Beta 会分享崩溃报告和匿名使用统计，以帮助我们改进。",
    );
    expect(translateZhCnPresentationText("Install Moss Beta")).toBe("安装 Moss Beta");
    expect(translateZhCnPresentationText("Copy my data and open")).toBe("复制我的数据并打开");
    expect(translateZhCnPresentationText("Download page")).toBe("下载页面");
    expect(translateZhCnPresentationText("Downloading Moss Beta — 37%")).toBe(
      "正在下载 Moss Beta——37%",
    );
    expect(translateZhCnPresentationText("Last import failed: ENOENT")).toBe(
      "上次导入失败：ENOENT",
    );
  });

  it("translates the Safari access onboarding dialog", () => {
    expect(translateZhCnPresentationText("Bring your Safari logins along?")).toBe(
      "要把 Safari 的登录状态带过来吗？",
    );
    expect(
      translateZhCnPresentationText(
        "Moss's browser can pick up sites you're already signed into in Safari, so you don't have to log in twice. It's optional, and nothing is copied until you ask.",
      ),
    ).toBe(
      "Moss 的浏览器可以沿用你在 Safari 中已登录的网站，无需重复登录。这完全可选，在你主动要求之前不会复制任何内容。",
    );
    expect(
      translateZhCnPresentationText(
        "Full Disk Access is a broad macOS permission that reaches beyond Safari. If you'd rather not, that's fine. You can find this again under Settings › General.",
      ),
    ).toBe(
      "“完全磁盘访问”是一个范围很广的 macOS 权限，不仅限于 Safari。如果你不想开启也没关系，之后可以在“设置 › 通用”中再次找到此选项。",
    );
  });

  it("translates connector catalog copy and named sign-in sentences", () => {
    expect(translateZhCnPresentationText("Search connectors")).toBe("搜索连接器");
    expect(translateZhCnPresentationText("Add custom")).toBe("添加自定义");
    expect(translateZhCnPresentationText("Popular")).toBe("常用");
    expect(
      translateZhCnPresentationText("Query Postgres, manage projects, and deploy Edge Functions."),
    ).toBe("查询 Postgres、管理项目，并部署 Edge Functions。");
    expect(translateZhCnPresentationText("No connectors match “linear”.")).toBe(
      "没有匹配「linear」的连接器。",
    );
    expect(translateZhCnPresentationText("Connect Supabase")).toBe("连接 Supabase");
    expect(translateZhCnPresentationText("Continue to Linear")).toBe("继续前往 Linear");
    expect(
      translateZhCnPresentationText(
        "Connect Codex, Claude, or another local MCP agent to create and follow Moss tasks.",
      ),
    ).toBe("连接 Codex、Claude 或其他本地 MCP 智能体，以创建和跟进 Moss 任务。");
  });

  it("keeps runtime values, env names, and diagnostics unchanged", () => {
    const values = [
      "ANTHROPIC_API_KEY",
      "OpenAI gpt-5.4",
      "/Users/moss/project",
      "feature/zh-cn",
      "My English project title",
    ];
    for (const value of values) {
      expect(translateZhCnPresentationText(value)).toBe(value);
    }
  });
});
