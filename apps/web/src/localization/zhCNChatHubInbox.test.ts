// FILE: zhCNChatHubInbox.test.ts
// Purpose: Locks the zh-CN copy of the chat screen, hub settings, the library, the sidebar, the
//          inbox and the settings labels that were still English.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";
import { APPEARANCE_OPTION_NAMES } from "./zhCNHubCopy";

function expectTranslations(rows: ReadonlyArray<readonly [string, string]>): void {
  for (const [english, chinese] of rows) {
    expect(translateZhCnPresentationText(english)).toBe(chinese);
  }
}

describe("the chat screen in zh-CN", () => {
  it("translates questions and approvals", () => {
    expectTranslations([
      ["Answered", "已回答"],
      ["Answer", "回答"],
      ["Answer: Which branch?", "回答：Which branch?"],
      ["Submitting…", "正在提交…"],
      ["Cancelling...", "正在取消…"],
      ["Recheck", "重新检查"],
      ["Enable", "启用"],
      ["Computer task approval requested", "电脑任务正在等待批准"],
      ["Device task approved", "设备任务已批准"],
      ["Computer task declined", "电脑任务已拒绝"],
      ["Device task approval cancelled", "设备任务批准已取消"],
    ]);
  });

  it("translates timeline rows around what the agent wrote", () => {
    expectTranslations([
      ["failed · exit 127", "失败 · 退出码 127"],
      ["Browser annotation 2: Header, moss.dev", "浏览器标注 2：Header，moss.dev"],
      ["Review changes to src/app.ts", "查看 src/app.ts 的更改"],
      ["Goal achieved in 2m 10s", "目标已达成，用时 2m 10s"],
      ["Message 4: fix the login", "消息 4：fix the login"],
      ["Open source chat Login fix", "打开来源对话 Login fix"],
      ["Inspect Bash", "查看 Bash"],
      ["Loading Sales chart", "正在加载 Sales chart"],
      ["Started", "开始时间"],
      ["Elapsed", "已用时间"],
      ["Progress", "进度"],
      ["- hash abc123", "- 哈希 abc123"],
      ["Resumed: “Run delayed echo” finished ·", "已恢复：“Run delayed echo”已完成 ·"],
      ["Resumed: “Run delayed echo” failed", "已恢复：“Run delayed echo”失败"],
      ["Resumed: 2 background tasks ended ·", "已恢复：2 个后台任务已结束 ·"],
      ["Subagent finished: Cedar", "子智能体已完成：Cedar"],
      ["Background task failed", "后台任务失败"],
    ]);
  });

  it("translates subagent counts and names", () => {
    expectTranslations([
      ["3 running", "3 个运行中"],
      ["2 done", "2 个已完成"],
      ["1 failed", "1 个失败"],
      ["2 stopped", "2 个已停止"],
      ["1 interrupted", "1 个已中断"],
      ["launched 2 subagents", "启动了 2 个子智能体"],
      ["1 subagent running, show it", "1 个子智能体正在运行，点击查看"],
      ["3 subagents running, show them", "3 个子智能体正在运行，点击查看"],
      ["→ was running", "→ 之前正在运行"],
      ["stopped", "已停止"],
      ["failed", "失败"],
      ["· 1.2k tokens · 3 tool calls", "· 1.2k tokens · 3 次工具调用"],
      ["background · Bash · 1.2k tokens", "后台 · Bash · 1.2k tokens"],
      ["1 tool call", "1 次工具调用"],
      ["Open subagent Cedar (Running)", "打开子智能体 Cedar（运行中）"],
      ["Open subagent Cedar", "打开子智能体 Cedar"],
      ["Open subagents: 2 running, 3 done", "打开子智能体：2 个运行中，3 个已完成"],
      ["Back to main thread", "返回主对话"],
      ["Back to Login fix", "返回 Login fix"],
      ["This answer went back to Login fix", "这个回答已返回给 Login fix"],
      ["Open parent thread Login fix", "打开上级对话 Login fix"],
    ]);
  });

  it("translates side chats, tabs and automations", () => {
    expectTranslations([
      ["Expired", "已过期"],
      ["Open side chat Notes", "打开侧边对话 Notes"],
      ["Open side chat Notes (expired)", "打开侧边对话 Notes（已过期）"],
      ["Delete side chat Notes", "删除侧边对话 Notes"],
      ['Delete side chat "Notes"?', "删除侧边对话“Notes”？"],
      ["3 more tabs", "还有 3 个标签页"],
      ["1 more tab", "还有 1 个标签页"],
      ["Open automation Nightly", "打开自动化工作流 Nightly"],
    ]);
  });

  it("translates pull request repairs and keeps the numbers", () => {
    expectTranslations([
      ["Repair", "修复"],
      ["Everything", "全部"],
      ["Reopen", "重新打开"],
      ["Repair PR #42", "修复 PR #42"],
      ["2 review comments", "2 条审查评论"],
      ["10+ review comments", "10+ 条审查评论"],
      ["1 failing check", "1 项检查失败"],
      ["Pull request in Zluowa/moss-synara", "Zluowa/moss-synara 中的拉取请求"],
      ["Issue in Zluowa/moss-synara", "Zluowa/moss-synara 中的问题"],
      ["Auto-fix CI for #42", "为 #42 自动修复 CI"],
      ["Open #42 on GitHub", "在 GitHub 上打开 #42"],
      [
        "Paused: checks still failed after 3 fix attempts. Turn it on again to retry.",
        "已暂停：尝试修复 3 次后检查仍未通过。重新开启即可重试。",
      ],
    ]);
  });

  it("translates the composer, model picker and permissions", () => {
    expectTranslations([
      ["Optimizing image…", "正在优化图片…"],
      ["Optimizing images…", "正在优化图片…"],
      ["Check", "检查"],
      ["Remove Opus 5.5 from favourites", "从收藏中移除 Opus 5.5"],
      ["Add Opus 5.5 to favourites", "将 Opus 5.5 加入收藏"],
      ["Cannot switch to Claude yet", "暂时无法切换到 Claude"],
      [
        "Send a message to switch to Claude first, then choose this access mode.",
        "请先发送一条消息切换到 Claude，再选择这个访问模式。",
      ],
      ["Expired terminal context won't be sent", "已过期的终端上下文不会发送"],
      ["Expired terminal contexts omitted from message", "已过期的终端上下文未包含在消息中"],
      ["Context window 12% used", "已使用上下文窗口 12%"],
      ["Context window 1.2k tokens used", "已使用上下文窗口 1.2k tokens"],
      [
        "Fast mode is not active: this model does not support it. Requests run at standard speed.",
        "快速模式未生效：这个模型不支持快速模式。请求会以标准速度运行。",
      ],
      [
        "Claude uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
        "Claude 在此应用中使用自定义本地二进制路径。开始会话时会确认是否可用。",
      ],
      ["Approve permission", "批准权限"],
      ["Weekly remaining", "每周剩余额度"],
      ["Session remaining", "Session 剩余额度"],
    ]);
  });

  it("translates the file editor, references and the prompt cache", () => {
    expectTranslations([
      ["Editing", "正在编辑"],
      ["Redo", "重做"],
      ["Overwrite", "覆盖"],
      ["vs abc1234", "对比 abc1234"],
      ["Reference lines 3-5 in chat", "在聊天中引用第 3-5 行"],
      ["Reference line 21:5-12 in chat", "在聊天中引用第 21:5-12 行"],
      ["Ask why line 3 changed", "询问第 3 行为何更改"],
      ["Likely warm", "可能仍有效"],
      ["Likely expired", "可能已过期"],
      ["Observed lifetime: 5m to 1h", "观察到的有效期：5m 到 1h"],
      ["Observed lifetime: 1h", "观察到的有效期：1h"],
      ["Last response: 5m ago", "上次回复：5m前"],
    ]);
  });

  it("translates the default-branch dialog around the branch name", () => {
    expectTranslations([
      [
        'This action will commit and push changes on "main". You can continue on this branch or create a feature branch and run the same action there.',
        "此操作会在“main”上提交并推送更改。你可以继续使用此分支，也可以创建功能分支并在那里执行相同操作。",
      ],
      [
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
        "此操作会在“main”上推送本地提交。你可以继续使用此分支，也可以创建功能分支并在那里执行相同操作。",
      ],
      ["Pulling...", "正在拉取…"],
    ]);
  });

  it("translates transport errors and keeps the method name", () => {
    expectTranslations([
      ["Unknown RPC method: thread.get", "未知的 RPC 方法：thread.get"],
      [
        "WebSocket RPC thread.get timed out after 30000ms. The server did not finish this request in time. Try again when the server responds.",
        "WebSocket RPC thread.get 等待 30000 毫秒后超时。服务器没有及时完成这个请求。请等服务器恢复响应后再试。",
      ],
      [
        "WebSocket RPC command.dispatch timed out after 5000ms. The server did not finish this request in time. Check the result before retrying; the command may have been applied.",
        "WebSocket RPC command.dispatch 等待 5000 毫秒后超时。服务器没有及时完成这个请求。请先检查结果再重试，这条命令可能已经生效。",
      ],
      ["WebSocket RPC thread.get was cancelled.", "WebSocket RPC thread.get 已取消。"],
      [
        "WebSocket RPC thread.get was interrupted by a transport reconnect.",
        "WebSocket RPC thread.get 因连接重连而中断。",
      ],
      ["Could not open the conversation cache.", "无法打开对话缓存。"],
      ["The composer image database upgrade was blocked.", "输入框图片数据库的升级被阻止。"],
    ]);
  });
});

describe("hub settings and the library in zh-CN", () => {
  it("translates hub settings", () => {
    expectTranslations([
      ["Set up your hub", "设置你的 Hub"],
      ["The outcome you want the coordinator to work toward.", "你希望协调者达成的结果。"],
      [
        '"Moss" has no threads, files, or linked repositories yet. Deleting it removes the hub entirely — or keep it and finish setup later.',
        "“Moss”还没有对话、文件或关联的代码仓库。删除后这个 Hub 会被彻底移除；你也可以保留它，稍后再完成设置。",
      ],
      ["Hide threads in Moss", "隐藏 Moss 中的对话"],
      ["Show threads in Moss", "显示 Moss 中的对话"],
      ["Location", "位置"],
      ["Change…", "更改…"],
      ["Execution", "执行"],
      ["Deleting...", "正在删除…"],
      ["Type Moss to confirm", "输入 Moss 以确认"],
      ["Thread memory (3)", "对话记忆（3）"],
      ["Not available for gpt-5.", "不适用于 gpt-5。"],
      ["Resume hub Moss", "恢复 Hub Moss"],
      ["Work: Fix login", "工作项：Fix login"],
      ["Show progress for Fix login", "显示 Fix login 的进度"],
      ["Hide progress for Fix login", "隐藏 Fix login 的进度"],
      ["Copy library path", "复制资料库路径"],
      ["Copied hub folder path", "已复制 Hub 文件夹路径"],
    ]);
  });

  it("names hub icons and colors whole", () => {
    expectTranslations([
      ["Hub icon Bot", "Hub 图标：机器人"],
      ["Hub icon Fast mode", "Hub 图标：快速模式"],
      ["Hub icon color Violet", "Hub 图标颜色：紫罗兰色"],
      ["Hub icon color Default", "Hub 图标颜色：默认"],
    ]);
  });

  it("translates the library and keeps file names", () => {
    expectTranslations([
      ["Grid", "网格"],
      ["Documents", "文档"],
      ["History", "历史记录"],
      ["Restored", "已恢复"],
      ["Back to library from history", "从历史返回资料库"],
      ["Back to library from docs/plan.md", "从 docs/plan.md 返回资料库"],
      ["History — docs/plan.md", "历史记录 — docs/plan.md"],
      ["docs/plan.md was restored from abc1234.", "已从 abc1234 恢复 docs/plan.md。"],
      ["Sort by Name", "按名称排序"],
      ["Sort by Date modified", "按修改日期排序"],
      ["Rename plan.md", "重命名 plan.md"],
      ["7 B · now", "7 B · 刚刚"],
      ["1.2 MB · 5m", "1.2 MB · 5 分钟前"],
      ["Moss events - On project events", "Moss events - 项目事件发生时"],
    ]);
  });

  it("translates the project panel", () => {
    expectTranslations([
      ["Suggestions", "建议"],
      ["Add a goal", "添加目标"],
      ["Write instructions", "编写指令"],
      ["Coordinator is ready.", "协调者已就绪。"],
      ["Pin coordinator", "固定协调者"],
      ["On project events", "项目事件发生时"],
      ["GPT-6 Astra · Medium", "GPT-6 Astra · 中"],
      ["now", "刚刚"],
      ["Open Fixture Hub 31", "打开 Fixture Hub 31"],
      ["Updating…", "正在更新…"],
      ["Open Coordinator", "打开 Coordinator"],
      ["Blocked: Ship it — waiting on CI", "受阻：Ship it — waiting on CI"],
      ["Last run 5m", "上次运行：5 分钟前"],
      ["Last run now", "上次运行：刚刚"],
    ]);
  });

  it("leaves icon and color names to the pickers", () => {
    for (const name of ["Art", "Music", "Server", "Tools", "Blue", "Rose", "Target", "Book"]) {
      expect(APPEARANCE_OPTION_NAMES[name]).toBeTruthy();
      expect(translateZhCnPresentationText(name)).toBe(name);
    }
  });
});

describe("the sidebar and inbox in zh-CN", () => {
  it("translates the inbox's day and recap", () => {
    expectTranslations([
      ["Morning", "上午"],
      ["Afternoon", "下午"],
      ["Evening", "晚上"],
      [", now", "，现在"],
      ["same as yesterday", "与昨天相同"],
      ["12% more than this time yesterday", "比昨天此时多 12%"],
      ["12% less than this time yesterday", "比昨天此时少 12%"],
      ["Mostly morning", "主要集中在上午"],
      ["Mostly evening, 3 failed", "主要集中在晚上，3 轮失败"],
      ["3 prompts, mostly Opus 5.5", "3 条提示词，主要使用 Opus 5.5"],
      ["1 turn, mostly Opus 5.5", "1 轮，主要使用 Opus 5.5"],
      ["Mostly Opus 5.5", "主要使用 Opus 5.5"],
      ["45% of tokens, 3 turns", "占 tokens 的 45%，共 3 轮"],
      ["3 pull requests to review", "3 个拉取请求待审查"],
      ["9+ pull requests to review", "9+ 个拉取请求待审查"],
      ["1 automation run to check", "1 次自动化运行待查看"],
      [", approve a command", "，需要批准命令"],
      [", has a question", "，有一个问题"],
      [", plan ready", "，计划已就绪"],
      [", turn failed", "，这一轮失败了"],
    ]);
  });

  it("translates thread menus and toasts", () => {
    expectTranslations([
      ["Claude in this thread", "在当前对话中交接给 Claude"],
      ["Claude Code in a new thread", "在新对话中交接给 Claude Code"],
      ["Handoff to Claude in this thread", "在当前对话中交接给 Claude"],
      ['Could not delete 2 threads in "Moss".', "无法删除“Moss”中的 2 个对话。"],
      ["Deleted 2 threads and removed the project.", "已删除 2 个对话并移除项目。"],
      ["Failed to archive 1 thread.", "归档 1 个对话失败。"],
      ['Could not archive 2 threads in "Moss".', "无法归档“Moss”中的 2 个对话。"],
      ["Failed to delete 2 threads.", "删除 2 个对话失败。"],
      ["Work was created, but the project was not moved", "已创建 Work，但项目没有移动"],
      ["More actions for Login fix", "Login fix 的更多操作"],
      ["Make D:/work primary", "将 D:/work 设为主文件夹"],
      ["Features", "功能"],
    ]);
  });

  it("translates the rail, the search palette and snoozed chats", () => {
    expectTranslations([
      ["Explore", "探索"],
      ["Quick actions", "快捷操作"],
      ["Go to Inbox", "前往收信箱"],
      ["Go to Kanban", "前往看板"],
      ["Go to 定时任务", "前往定时任务"],
      ["Open Inbox.", "打开收信箱。"],
      ["Open 定时任务.", "打开定时任务。"],
      ["Explore destinations", "探索目的地"],
      ["Pin to sidebar", "固定到侧边栏"],
      ["Unpin from sidebar", "从侧边栏取消固定"],
      ["Move Tasks up", "上移 Tasks"],
      ["Move Tasks down", "下移 Tasks"],
      ["Enter to open · Ctrl+Enter to add", "按 Enter 打开 · 按 Ctrl+Enter 添加"],
      ["Add highlighted folder (Ctrl Enter)", "添加高亮文件夹（Ctrl Enter）"],
      ["Add (Enter)", "添加（Enter）"],
      [
        "Returns Oct 31, 3:00 PM · 2 hr 30 min left",
        "恢复时间：Oct 31, 3:00 PM · 还剩 2 小时 30 分钟",
      ],
      ["Returns Oct 31, 3:00 PM · 1 day 2 hr left", "恢复时间：Oct 31, 3:00 PM · 还剩 1 天 2 小时"],
      ["Returns Oct 31, 3:00 PM · Returning…", "恢复时间：Oct 31, 3:00 PM · 即将恢复…"],
      [
        "Returns Oct 31, 3:00 PM · Less than a minute left",
        "恢复时间：Oct 31, 3:00 PM · 还剩不到 1 分钟",
      ],
    ]);
  });

  it("translates plugin toasts and keeps the plugin's name", () => {
    expectTranslations([
      ["Linear app enabled", "已启用 Linear 应用"],
      ["Linear app disabled", "已停用 Linear 应用"],
      ["Removed Official", "已移除 Official"],
      ["Could not remove Official", "无法移除 Official"],
      ["Upgraded Official", "已升级 Official"],
      ["Could not upgrade Official", "无法升级 Official"],
      ["Write", "写入"],
      ["Share to X", "分享到 X"],
    ]);
  });
});

describe("table lookups in zh-CN", () => {
  it("keeps a slot that names an Object.prototype member", () => {
    expectTranslations([
      ["Hub icon constructor", "Hub 图标：constructor"],
      ["Hub icon color toString", "Hub 图标颜色：toString"],
      [
        "Fast mode is not active: constructor. Requests run at standard speed.",
        "快速模式未生效：constructor。请求会以标准速度运行。",
      ],
      [
        "WebSocket RPC thread.get timed out after 30000ms. The server did not finish this request in time. constructor",
        "WebSocket RPC thread.get 等待 30000 毫秒后超时。服务器没有及时完成这个请求。constructor",
      ],
    ]);
  });
});

describe("word-level rules leave English phrases alone", () => {
  it("does not half translate a phrase that only starts like a name", () => {
    for (const phrase of [
      "Back to chat",
      "Open account menu",
      "Open Editor menu",
      "Inspect reviews, triage issues, and prepare changes",
      "Loading chats…",
      "Removed allowance",
      "needs permission",
      "microphone permission",
    ]) {
      expect(translateZhCnPresentationText(phrase)).not.toMatch(/[一-鿿].*\b[a-z]{3,}\b/);
    }
  });

  it("keeps the older phrase when a new pattern could reach it", () => {
    expectTranslations([
      ["Waiting for permission", "正在等待权限"],
      ["Open Hubs.", "打开 Hubs。"],
    ]);
  });
});

describe("settings and app-wide labels in zh-CN", () => {
  it("names every per-theme control", () => {
    expectTranslations([
      ["Dark theme code theme", "深色代码主题"],
      ["Light theme accent color", "浅色主题强调色"],
      ["Dark theme background color", "深色主题背景色"],
      ["Light theme foreground color", "浅色主题前景色"],
      ["Dark theme UI font", "深色主题界面字体"],
      ["Light theme code font", "浅色主题代码字体"],
      ["Dark theme window material", "深色主题窗口材质"],
      ["Light theme translucent sidebar only", "浅色主题仅侧边栏半透明"],
      ["Dark theme translucency opacity", "深色主题半透明不透明度"],
      ["Light theme automatic background blur", "浅色主题自动背景模糊"],
      ["Dark theme background blur", "深色主题背景模糊"],
      ["Light theme contrast", "浅色主题对比度"],
      ["Dark theme preview: Linear", "深色主题预览：Linear"],
      ["Copied the dark theme share string.", "已复制深色主题分享字符串。"],
      ["Updated the light theme pack.", "已更新浅色主题包。"],
    ]);
  });

  it("translates computer control capabilities, alone and listed", () => {
    expectTranslations([
      ["screen capture", "屏幕截图"],
      ["window listing", "窗口列表"],
      ["window geometry", "窗口位置与大小"],
      ["stacking order", "窗口层级"],
      ["keyboard focus", "键盘焦点"],
      ["window raising", "窗口置顶"],
      ["ghost cursor", "虚拟光标"],
      ["screen capture, input, clipboard", "屏幕截图、输入、剪贴板"],
      ["Fill color", "填充颜色"],
      ["Computer control needs permissions", "电脑控制需要授权"],
      ["Computer control needs Accessibility", "电脑控制需要辅助功能权限"],
      [
        "Computer control needs Accessibility and Screen Recording",
        "电脑控制需要辅助功能和屏幕录制权限",
      ],
      [
        "macOS may ask to allow Accessibility and Screen Recording for Moss.",
        "macOS 可能会请求为 Moss 允许辅助功能和屏幕录制权限。",
      ],
    ]);
  });

  it("translates storage, profile and skills settings", () => {
    expectTranslations([
      ["Archived 5m", "归档于 5 分钟前"],
      ["Archived 2 小时", "归档于 2 小时前"],
      ["Archived now", "归档于 刚刚"],
      [
        "Moss was removed and 2 archived conversations were deleted.",
        "已移除 Moss，并删除了 2 个已归档的对话。",
      ],
      ["3 archived threads were permanently removed.", "已永久移除 3 个已归档的对话。"],
      ["Downloading Moss Beta…", "正在下载 Moss Beta…"],
      ["Downloading Moss Beta — 40%", "正在下载 Moss Beta——40%"],
      ["Share of tracked tokens.", "已统计 token 的占比。"],
      ["Share of turns.", "回合占比。"],
      ["1 of 1 skill enabled", "已启用 1 / 1 个技能"],
      ["3 of 5 skills enabled", "已启用 3 / 5 个技能"],
      ["tokens activity", "Token 活动"],
      ["prompts activity", "提示词活动"],
      ["Usage pace: on-track", "用量进度：符合预期"],
      ["Ctrl+K is available.", "Ctrl+K 可用。"],
      ["Ctrl+W is reserved for Copy. Try another.", "Ctrl+W 已保留给“复制”。请换一个。"],
      ["Emoji", "表情符号"],
      ["Icons", "图标"],
      ["Hour", "小时"],
      ["Minute", "分钟"],
    ]);
  });

  it("translates worktree cleanup and sign-in copy", () => {
    expectTranslations([
      [
        "login-fix could not be removed safely. Check its task, Git status, or connection.",
        "无法安全移除 login-fix。请检查它的任务、Git 状态或连接。",
      ],
      [
        "login-fix was deleted. Its branch remains available for recovery.",
        "已删除 login-fix。它的分支仍然保留，可用于恢复。",
      ],
      [
        "Moss sent a verification link to moss@example.com. Open it on this device, then return to sign in.",
        "Moss 已将验证链接发送到 moss@example.com。请在此设备上打开链接，然后返回登录。",
      ],
      [
        "Moss sent a verification link. Open it on this device, then return to sign in.",
        "Moss 已发送验证链接。请在此设备上打开链接，然后返回登录。",
      ],
      ["Email: moss@example.com", "邮箱：moss@example.com"],
      ["Change email from moss@example.com", "更改邮箱（当前为 moss@example.com）"],
      ["Use moss@example.com", "使用 moss@example.com"],
      ["Verified · Signed in", "已验证 · 已登录"],
      ["Copy diagnostic ID", "复制诊断 ID"],
      ["Projects · tldraw", "项目 · tldraw"],
    ]);
  });
});
