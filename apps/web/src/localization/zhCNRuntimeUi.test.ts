// FILE: zhCNRuntimeUi.test.ts
// Purpose: Locks pure-TypeScript runtime UI copy and its runtime-content safety boundary.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";
import { translateZhCnRuntimeUiText } from "./zhCNRuntimeUi";

describe("translateZhCnRuntimeUiText", () => {
  it.each([
    [
      "Start a fresh thread and clear the current conversation context",
      "开始新对话并清除当前对话上下文",
    ],
    ["Compact is unavailable", "无法压缩上下文"],
    ["Fast mode enabled", "已开启快速模式"],
    [
      "Use /fork and then choose Local or New Worktree.",
      "请使用 /fork，然后选择“本地”或“新建工作树”。",
    ],
    ["Quick Chat", "快速聊天"],
    ["Previous recent view", "上一个最近视图"],
    ["Toggle terminal", "切换终端"],
    ["Open full-width terminal workspace", "打开全宽终端工作区"],
    ["Available now", "当前可用"],
    ["Project scripts", "项目脚本"],
    ["Space", "空格"],
    ["Esc", "Esc 键"],
    ["Commit, push & PR", "提交、推送并创建 PR"],
    ["Generating commit message...", "正在生成提交信息…"],
    ["Session ID", "会话 ID"],
    ["Paste an OpenCode session id", "粘贴 OpenCode 会话 ID"],
    ["Composer context is not persisted", "输入框上下文不会持久保存"],
    ["Not scheduled", "未安排"],
    ["Chat automation", "聊天自动化工作流"],
    ["Fast recurring loop", "高频循环"],
    ["Local checkout", "本地检出"],
    ["Favourites", "收藏"],
    ["Path copied", "已复制路径"],
    ["Task added to Drafts", "任务已添加到草稿"],
    ["Plan preview unavailable.", "计划预览不可用。"],
    ["Failed to update pinned message", "更新固定消息失败"],
    ["Untitled thread", "未命名对话"],
    ["Command approval requested.", "需要批准命令。"],
    ["Restoring tab...", "正在恢复标签页…"],
    ["Creating branch and worktree", "正在创建分支和工作树"],
    ["The microphone could not be opened.", "无法打开麦克风。"],
    ["Browse folders on this computer", "浏览此电脑上的文件夹"],
    ["Folders on this Mac", "这台 Mac 上的文件夹"],
    ["Worktree pending", "工作树待就绪"],
    ["Unable to prepare a new Studio chat.", "无法准备新的 Studio 对话。"],
    ["File comments", "文件评论"],
    ["Referenced assistant selections", "已引用助手所选内容"],
    ["Reasoning trace", "推理轨迹"],
    ["Agent task", "智能体任务"],
    ["Agent activity", "智能体活动"],
    ["Searched the web", "已搜索网页"],
    ["Reading", "正在读取"],
    ["Committed", "已提交"],
    ["Extra High", "极高"],
    ["Unsupported diff format. Showing raw patch.", "不支持此差异格式，正在显示原始补丁。"],
    ["Failed to load checkpoint diff.", "无法加载检查点差异。"],
    ["Git handoff is unavailable.", "Git 交接不可用。"],
    ["Voice transcription failed", "语音转写失败"],
    ["Couldn't transcribe voice note", "无法转写语音备注"],
    [
      "Voice transcription is temporarily unavailable. Try again shortly.",
      "语音转写服务暂时不可用，请稍后重试。",
    ],
    ["Check for updates", "检查更新"],
    ["Moss product shell default", "默认使用 Moss 产品外壳"],
    ["Verify email · Moss", "验证邮箱 · Moss"],
    ["Sign in · Moss", "登录 · Moss"],
    ["Yesterday", "昨天"],
    ["Thinking On", "思考已开启"],
    ["Thinking Off", "思考已关闭"],
    [
      "Save additional Antigravity CLI base model names for the picker.",
      "保存额外的 Antigravity CLI 基础模型名称，以便在选择器中使用。",
    ],
    ["In Progress", "进行中"],
    ["Thread archived", "对话已归档"],
    ["Thread deleted", "对话已删除"],
    ["New worktree (pending)", "新工作树（等待中）"],
    ["New project", "新建项目"],
    ["Add new project", "添加新项目"],
    ["Opening folder picker...", "正在打开文件夹选择器…"],
    ["Search projects", "搜索项目"],
    [
      "Press both Option keys (⌥ ⌥) to snap any app’s window into the task you’re working in.",
      "同时按下两个 Option 键（⌥ ⌥），即可把任意应用窗口捕捉到当前任务中。",
    ],
    ["The scan failed. Try refreshing.", "扫描失败，请尝试刷新。"],
    ["Local dev servers will appear here.", "本地开发服务器会显示在这里。"],
    [
      "Desktop app notifications use your operating system notification center.",
      "桌面应用通知使用操作系统通知中心。",
    ],
    ["Browser notifications are enabled for this app.", "此应用已启用浏览器通知。"],
    [
      "Browser notifications are blocked. Re-enable them in your browser site settings.",
      "浏览器通知已被阻止，请在浏览器的网站设置中重新启用。",
    ],
    [
      "Browser notifications need a secure context. Localhost works; plain HTTP does not.",
      "浏览器通知需要安全上下文；localhost 可以使用，普通 HTTP 不可以。",
    ],
    ["This browser does not support desktop notifications.", "此浏览器不支持桌面通知。"],
    [
      "Allow browser notifications to get alerts when chats or terminal agents finish or need input in the background.",
      "允许浏览器通知，以便在聊天或终端智能体于后台完成或需要输入时收到提醒。",
    ],
    ["From", "来自"],
    ["Review updates", "查看更新"],
    ["Update all", "全部更新"],
    ["Create and switch to a new branch from", "创建并切换到新分支，起点为"],
    ["e.g. npm run dev", "例如 npm run dev"],
    [
      "https://github.com/owner/repo/pull/42 or #42",
      "https://github.com/owner/repo/pull/42 或 #42",
    ],
  ] as const)("translates fixed runtime presentation copy: %s", (source, expected) => {
    expect(translateZhCnRuntimeUiText(source)).toBe(expected);
  });

  it("translates safe dynamic chrome and preserves every runtime slot", () => {
    expect(translateZhCnRuntimeUiText("You can keep up to 12 pinned messages in a thread.")).toBe(
      "每个对话最多可固定 12 条消息。",
    );
    expect(translateZhCnRuntimeUiText("You can attach up to 8 references per message.")).toBe(
      "每条消息最多可附加 8 个引用。",
    );
    expect(translateZhCnRuntimeUiText("5d")).toBe("5 天");
    expect(translateZhCnRuntimeUiText("1 day")).toBe("1 天");
    expect(translateZhCnRuntimeUiText("4,934 days")).toBe("4,934 天");
    expect(translateZhCnRuntimeUiText("17bn")).toBe("17 十亿");
    expect(translateZhCnRuntimeUiText("1 line")).toBe("1 行");
    expect(translateZhCnRuntimeUiText("4,000 chars")).toBe("4,000 个字符");
    expect(translateZhCnRuntimeUiText("Jump to visible thread 7")).toBe("跳转到可见对话 7");
    expect(translateZhCnRuntimeUiText("Spawning 3 agents")).toBe("正在启动 3 个智能体");
    expect(translateZhCnRuntimeUiText("OpenCode update available")).toBe("OpenCode 有可用更新");
    expect(translateZhCnRuntimeUiText("4 provider updates available")).toBe("4 个服务商有可用更新");
    expect(translateZhCnRuntimeUiText("OpenCode has a newer version available.")).toBe(
      "OpenCode 有新版本可用。",
    );
    expect(
      translateZhCnRuntimeUiText("OpenCode and 3 more providers have newer versions available."),
    ).toBe("OpenCode 和另外 3 个服务商有新版本可用。");
    expect(
      translateZhCnRuntimeUiText("OpenCode and 1 more provider have newer versions available."),
    ).toBe("OpenCode 和另外 1 个服务商有新版本可用。");
    expect(translateZhCnRuntimeUiText("Agent activity (4)")).toBe("智能体活动（4）");
    expect(
      translateZhCnRuntimeUiText(
        "Update timed out after 2 minutes. The provider process was stopped.",
      ),
    ).toBe("更新等待 2 分钟后超时，服务商进程已停止。");
    expect(
      translateZhCnRuntimeUiText(
        "Update timed out after 20 milliseconds. The provider process was stopped.",
      ),
    ).toBe("更新等待 20 毫秒后超时，服务商进程已停止。");
    expect(translateZhCnRuntimeUiText("Update command exited with code 1.")).toBe(
      "更新命令已退出，退出码 1。",
    );
    expect(
      translateZhCnRuntimeUiText(
        "Update timed out after 5 minutes. The provider process was stopped. This install updates through the vendor's own servers, which have no domestic mirror. Reinstalling it with npm lets Moss update it through the mirror.",
      ),
    ).toBe(
      "更新等待 5 分钟后超时，服务商进程已停止。这个智能体用的是官方安装程序，更新要连接海外服务器，没有国内镜像。改用 npm 重新安装后，Moss 就能通过镜像更新它。",
    );
    expect(
      translateZhCnRuntimeUiText(
        `Could not read 'My Project (draft).md'. Paths with spaces or special characters may need a path mention (@"…") instead of a file attachment.`,
      ),
    ).toBe(
      `无法读取“My Project (draft).md”。包含空格或特殊字符的路径可能需要改用路径提及（@"…"），而不是文件附件。`,
    );
    expect(translateZhCnRuntimeUiText("1 server running")).toBe("1 个服务器正在运行");
    expect(translateZhCnRuntimeUiText("3 servers running")).toBe("3 个服务器正在运行");
    expect(translateZhCnRuntimeUiText("Stop Vite · localhost:5173")).toBe(
      "停止 Vite · localhost:5173",
    );
    expect(translateZhCnRuntimeUiText("Worked for 7.8s")).toBe("已运行 7.8s");
    expect(translateZhCnRuntimeUiText("Worked for 1h 4m")).toBe("已运行 1h 4m");
    expect(translateZhCnRuntimeUiText("3 updates - Running tests (2/4)")).toBe(
      "3 次更新 - Running tests (2/4)",
    );
    expect(
      translateZhCnRuntimeUiText(
        'Archive 3 threads in "Moss / 中文"?\nArchived threads are hidden from the sidebar but can be restored later.',
      ),
    ).toBe("归档“Moss / 中文”中的 3 个对话？\n已归档对话会从侧边栏隐藏，但之后仍可恢复。");
    expect(
      translateZhCnRuntimeUiText(
        'Archive 2 threads in "Moss / 中文"?\nArchived threads are hidden from the sidebar but can be restored later.\n\n1 running thread is currently active and will be skipped.',
      ),
    ).toBe(
      "归档“Moss / 中文”中的 2 个对话？\n已归档对话会从侧边栏隐藏，但之后仍可恢复。\n\n1 个对话正在运行，将被跳过。",
    );
    expect(
      translateZhCnRuntimeUiText("Failed to archive 2 threads. Skipped 3 running threads."),
    ).toBe("归档 2 个对话失败。已跳过 3 个正在运行的对话。");
    expect(
      translateZhCnRuntimeUiText(
        'Delete 3 threads in "Moss / 中文"?\nThis permanently clears conversation history for these threads.',
      ),
    ).toBe("删除“Moss / 中文”中的 3 个对话？\n这会永久清除这些对话的聊天记录。");
    expect(translateZhCnRuntimeUiText("You're up to date on 0.5.5. Click to check again.")).toBe(
      "当前已是 0.5.5 最新版本。点击可再次检查。",
    );
    expect(
      translateZhCnRuntimeUiText(
        "Moss restarted, but update 0.5.6-arm64 was not installed. Click to try again.",
      ),
    ).toBe("Moss 已重启，但未安装 0.5.6-arm64 更新。点击可重试。");
    expect(
      translateZhCnRuntimeUiText("Could not prepare update 0.5.6-arm64. Click to retry."),
    ).toBe("无法准备 0.5.6-arm64 更新。点击可重试。");
    expect(
      translateZhCnRuntimeUiText("Could not install update 0.5.6-arm64. Click to retry."),
    ).toBe("无法安装 0.5.6-arm64 更新。点击可重试。");
    expect(translateZhCnRuntimeUiText("Preparing update (37%)")).toBe("正在准备更新（37%）");
    expect(translateZhCnRuntimeUiText("Preparing update 0.5.6-arm64")).toBe(
      "正在准备更新 0.5.6-arm64",
    );
    expect(
      translateZhCnRuntimeUiText("Update 0.5.6-arm64 is ready. Click to restart and install."),
    ).toBe("0.5.6-arm64 更新已就绪。点击可重启并安装。");
    expect(translateZhCnRuntimeUiText("No prompts on Jul 17, 2026")).toBe(
      "Jul 17, 2026 没有 prompts",
    );
    expect(translateZhCnRuntimeUiText("No account. Workspace data stays on this machine.")).toBe(
      "No account. Workspace data stays on this machine.",
    );
    expect(translateZhCnRuntimeUiText("Implement Exact English Plan Title")).toBe(
      "实施计划：Exact English Plan Title",
    );
    expect(translateZhCnRuntimeUiText("Pushing to feature/zh-cn...")).toBe(
      "正在推送到 feature/zh-cn…",
    );
    expect(translateZhCnRuntimeUiText("Running setup action: Install dependencies")).toBe(
      "正在运行设置操作：Install dependencies",
    );
    expect(translateZhCnRuntimeUiText("Run claudeAgent native command")).toBe(
      "运行 claudeAgent 原生命令",
    );
    expect(translateZhCnRuntimeUiText("Run antigravity native command")).toBe(
      "运行 antigravity 原生命令",
    );
    expect(translateZhCnRuntimeUiText("Reference lines 21:5-23:8 in chat")).toBe(
      "在聊天中引用第 21:5-23:8 行",
    );
    expect(translateZhCnRuntimeUiText("apps/web/src/main.tsx lines 21-23")).toBe(
      "apps/web/src/main.tsx 第 21–23 行",
    );
    expect(
      translateZhCnRuntimeUiText(
        'Close terminal "Build log"?\nThis permanently clears the terminal history for this tab.',
      ),
    ).toBe("关闭终端“Build log”？\n这会永久清除此标签页的终端历史记录。");
    expect(
      translateZhCnRuntimeUiText(
        'This action will commit and push changes on "feature/Settings". You can continue on this branch or create a feature branch and run the same action there.',
      ),
    ).toBe(
      "此操作会在“feature/Settings”上提交并推送更改。你可以继续使用此分支，也可以创建功能分支并在那里执行相同操作。",
    );
    expect(
      translateZhCnRuntimeUiText(
        'Pull requests can\'t be opened from "release/0.5.5" into itself. This action will create a feature branch from your current commits, push it, and create the PR.',
      ),
    ).toBe("无法从“release/0.5.5”向自身创建 PR。此操作会基于当前提交创建功能分支、推送并创建 PR。");
  });

  it("keeps prompts, user text, paths, model names, and diagnostics byte-for-byte", () => {
    const values = [
      "Review current changes",
      "Please keep my English task title exactly as written.",
      "My task was moved back to Draft.",
      "Workspace Terminal finished working.",
      "/Users/moss/Codex/tools/apps/web/src/main.tsx",
      "fatal: unable to access upstream remote",
      "OpenAI gpt-5.4",
      "feature/zh-cn",
      "Settings",
      "PLEASE IMPLEMENT THIS PLAN:\nKeep this provider prompt unchanged.",
    ];

    for (const value of values) {
      expect(translateZhCnRuntimeUiText(value)).toBe(value);
    }
  });

  it("does not partially match dynamic sentences", () => {
    expect(
      translateZhCnRuntimeUiText("prefix You can keep up to 12 pinned messages in a thread."),
    ).toBe("prefix You can keep up to 12 pinned messages in a thread.");
    expect(translateZhCnRuntimeUiText("5d remaining")).toBe("5d remaining");
    expect(translateZhCnRuntimeUiText("Pushing to feature/zh-cn... after approval")).toBe(
      "Pushing to feature/zh-cn... after approval",
    );
  });

  it("is delegated by the shared Simplified-Chinese presentation translator", () => {
    expect(translateZhCnPresentationText("Untitled thread")).toBe("未命名对话");
    expect(translateZhCnPresentationText("Path copied")).toBe("已复制路径");
    expect(translateZhCnPresentationText("Yesterday")).toBe("昨天");
    expect(translateZhCnPresentationText("Sign in · Moss")).toBe("登录 · Moss");
    expect(translateZhCnPresentationText("12 unmodified lines")).toBe("12 行未修改");
    expect(
      translateZhCnPresentationText(
        "Start a fresh thread and clear the current conversation context",
      ),
    ).toBe("开始新对话并清除当前对话上下文");
  });
});
