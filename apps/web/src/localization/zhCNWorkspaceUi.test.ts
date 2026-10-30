// FILE: zhCNWorkspaceUi.test.ts
// Purpose: Locks workspace/chrome Chinese copy and the runtime-content preservation boundary.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnWorkspaceUiText } from "./zhCNWorkspaceUi";

describe("translateZhCnWorkspaceUiText", () => {
  it("translates visible Git, workspace, composer, automation, Kanban, and preview chrome", () => {
    expect(translateZhCnWorkspaceUiText("Git action in progress.")).toBe("Git 操作正在进行。");
    expect(translateZhCnWorkspaceUiText("Workspace settings")).toBe("工作区设置");
    expect(translateZhCnWorkspaceUiText("Session Status")).toBe("会话状态");
    expect(translateZhCnWorkspaceUiText("Approval needed")).toBe("需要批准");
    expect(translateZhCnWorkspaceUiText("Draft sent")).toBe("草稿已发送");
    expect(translateZhCnWorkspaceUiText("Attention")).toBe("关注");
    expect(translateZhCnWorkspaceUiText("Classic")).toBe("经典");
    expect(translateZhCnWorkspaceUiText("Awaiting you")).toBe("待你处理");
    expect(translateZhCnWorkspaceUiText("Stuck")).toBe("卡住");
    expect(translateZhCnWorkspaceUiText("Awaiting approval")).toBe("等待批准");
    expect(translateZhCnWorkspaceUiText("Awaiting your input")).toBe("等待你的输入");
    expect(translateZhCnWorkspaceUiText("Awaiting you is derived automatically")).toBe(
      "“待你处理”列会自动得出",
    );
    expect(
      translateZhCnWorkspaceUiText(
        "Cards move here when they need your approval, input, or a retry.",
      ),
    ).toBe("当卡片需要你的批准、输入或重试时，会自动移到此处。");
    expect(
      translateZhCnWorkspaceUiText(
        "Pick an automation in the panel to see its runs, or schedule a new one.",
      ),
    ).toBe("在面板中选择一个自动化工作流即可查看其运行记录，也可以新建定时任务。");
    expect(translateZhCnWorkspaceUiText("Installed")).toBe("已安装");
    expect(translateZhCnWorkspaceUiText("No installed plugins yet.")).toBe("还没有已安装的插件。");
    expect(translateZhCnWorkspaceUiText("No installed skills yet.")).toBe("还没有已安装的技能。");
    expect(translateZhCnWorkspaceUiText("Moss Control")).toBe("Moss 控制中心");
    expect(translateZhCnWorkspaceUiText("View changelog")).toBe("查看更新日志");
    expect(translateZhCnWorkspaceUiText("Download generated image")).toBe("下载生成的图片");
    expect(translateZhCnWorkspaceUiText("Project pin limit reached")).toBe(
      "已达到项目固定数量上限",
    );
    expect(translateZhCnWorkspaceUiText("Chat match")).toBe("对话匹配");
    expect(translateZhCnWorkspaceUiText("Thinking")).toBe("思考中");
    expect(translateZhCnWorkspaceUiText("Starting Codex…")).toBe("正在启动 Codex…");
    expect(translateZhCnWorkspaceUiText("Starting…")).toBe("正在启动…");
    expect(translateZhCnWorkspaceUiText("Retrying: connection timed out")).toBe(
      "正在重试：连接超时",
    );
    expect(translateZhCnWorkspaceUiText("Retrying: connection timed out (3/15)")).toBe(
      "正在重试：连接超时（第 3/15 次）",
    );
    expect(translateZhCnWorkspaceUiText("Please run grok login")).toBe("请运行 grok login");
    expect(translateZhCnWorkspaceUiText("Download the update manually")).toBe("手动下载更新");
    expect(translateZhCnWorkspaceUiText("Two Columns")).toBe("双列");
    expect(translateZhCnWorkspaceUiText("views")).toBe("视图");
    expect(
      translateZhCnWorkspaceUiText(
        "Moss is still restoring your account session. Try again in a moment.",
      ),
    ).toBe("Moss 正在恢复账号会话，请稍后重试。");
    expect(
      translateZhCnWorkspaceUiText("Voice notes require an active Moss account session."),
    ).toBe("语音笔记需要有效的 Moss 账号会话，请登录后重试。");
  });

  it("translates anchored dynamic chrome while preserving branch, path, id, and error slots", () => {
    expect(translateZhCnWorkspaceUiText("Updated feature/zh-cn from origin/main")).toBe(
      "已从 origin/main 更新 feature/zh-cn",
    );
    expect(translateZhCnWorkspaceUiText("Pushed a1b2c3d to release/0.5.5")).toBe(
      "已推送 a1b2c3d 到 release/0.5.5",
    );
    expect(translateZhCnWorkspaceUiText('Create and checkout "moss/feature-name"')).toBe(
      "创建并检出“moss/feature-name”",
    );
    expect(translateZhCnWorkspaceUiText("Preview of src/components/WorkspaceView.tsx")).toBe(
      "src/components/WorkspaceView.tsx 的预览",
    );
    expect(translateZhCnWorkspaceUiText("Every 30 min")).toBe("每 30 分钟");
    expect(translateZhCnWorkspaceUiText("Daily at 9:00")).toBe("每天 9:00");
    expect(translateZhCnWorkspaceUiText("Mon at 9:00")).toBe("周一 9:00");
    expect(translateZhCnWorkspaceUiText("Show tasks sidebar")).toBe("显示任务侧边栏");
    expect(
      translateZhCnWorkspaceUiText(
        "main.tsx, Sidebar.tsx and 3 other files have uncommitted changes. Commit or stash before switching.",
      ),
    ).toBe("main.tsx, Sidebar.tsx 及其他 3 个文件有未提交的更改；请先提交或暂存再切换。");
    expect(translateZhCnWorkspaceUiText('Archive 12 threads in "Moss Desktop"?')).toBe(
      "归档“Moss Desktop”中的 12 个对话？",
    );
    expect(translateZhCnWorkspaceUiText("Approaching rate limit (82% used). Resets in 7m.")).toBe(
      "即将达到速率限制（已使用 82%）。将在 7m 后重置。",
    );
    expect(
      translateZhCnWorkspaceUiText(
        "Automatic installation has failed 3 times. Download 0.5.5 manually to finish updating.",
      ),
    ).toBe("自动安装已失败 3 次。请手动下载 0.5.5 以完成更新。");
    expect(translateZhCnWorkspaceUiText('Delete action "Run Moss"')).toBe("删除操作“Run Moss”");
    expect(
      translateZhCnWorkspaceUiText(
        "Could not remove /Users/moss/project/.worktrees/task-1. EPERM: operation not permitted",
      ),
    ).toBe("无法移除 /Users/moss/project/.worktrees/task-1。EPERM: operation not permitted");
  });

  it("translates unified workspace audit residuals", () => {
    const translations = {
      Stash: "暂存",
      "Home directory unavailable.": "主目录不可用。",
      "No normalized events for this thread": "此对话没有标准化事件",
      "No matches": "没有匹配项",
      "No MCP servers": "没有 MCP 服务器",
      "No skills": "没有技能",
      "No memory entries": "没有记忆条目",
      "No hooks": "没有钩子",
      "No provider start options": "没有服务商启动选项",
      "No projection warnings": "没有投影警告",
      "No active tasks": "没有活动任务",
      "No recent reviews": "没有最近审阅",
      "No evidence": "没有证据",
      "No role manifests": "没有角色清单",
      "No gate checks": "没有门禁检查",
      Provided: "已提供",
      Fallback: "回退",
      Pass: "通过",
      Blocked: "已阻塞",
      "Loading provider sessions": "正在加载服务商会话",
      "Runtime session bridge missing": "缺少运行时会话桥接",
      "Provider sessions unavailable": "服务商会话不可用",
      "No provider sessions": "没有服务商会话",
      retryable: "可重试",
      "not retryable": "不可重试",
      Call: "调用",
      "Select project": "选择项目",
      "PR is ready to merge": "PR 已可合并",
      "from your PATH. Cursor editor CLI paths are accepted too.":
        "（来自 PATH）。也支持 Cursor 编辑器 CLI 路径。",
      "default UI font": "默认界面字体",
    } as const;

    for (const [source, expected] of Object.entries(translations)) {
      expect(translateZhCnWorkspaceUiText(source)).toBe(expected);
    }
  });

  it("translates launch-plan atoms and provider sign-in labels without changing identifiers", () => {
    expect(translateZhCnWorkspaceUiText("redacted")).toBe("已脱敏");
    expect(translateZhCnWorkspaceUiText("captured without value")).toBe("已记录但未包含值");
    expect(translateZhCnWorkspaceUiText("no path")).toBe("无路径");
    expect(translateZhCnWorkspaceUiText("required")).toBe("必需");
    expect(translateZhCnWorkspaceUiText("disabled")).toBe("已禁用");
    expect(translateZhCnWorkspaceUiText("enabled")).toBe("已启用");
    expect(translateZhCnWorkspaceUiText("hash sha256:abc123")).toBe("哈希 sha256:abc123");
    expect(translateZhCnWorkspaceUiText("source environment")).toBe("来源 environment");
    expect(translateZhCnWorkspaceUiText("Sign in for Work Account")).toBe("登录 Work Account");
    expect(translateZhCnWorkspaceUiText("Cancel sign-in for Work Account")).toBe(
      "取消 Work Account 的登录",
    );
    expect(translateZhCnWorkspaceUiText("Sign in for Work / Fallback")).toBe(
      "登录 Work / Fallback",
    );
    expect(translateZhCnWorkspaceUiText("Cancel sign-in for Work / Claude")).toBe(
      "取消 Work / Claude 的登录",
    );
  });

  it("keeps project names, providers, models, paths, user text, and diagnostics unchanged", () => {
    const values = [
      "Moss Desktop",
      "feature/zh-cn",
      "/Users/moss/Codex/tools/apps/web/src/main.tsx",
      "Claude Code",
      "OpenAI gpt-5.4",
      "active",
      "ScreenCaptureKit error -3801",
      "redacted / hash sha256:abc123 / source user",
      "My note / Pass",
      "Pass / user",
      "ScreenCaptureKit error / Blocked",
      "Please keep my English project title exactly as written.",
      "A server-provided tool output line",
    ];

    for (const value of values) {
      expect(translateZhCnWorkspaceUiText(value)).toBe(value);
    }
  });

  it("does not partially match dynamic sentences", () => {
    expect(translateZhCnWorkspaceUiText("prefix Updated feature/zh-cn from origin/main")).toBe(
      "prefix Updated feature/zh-cn from origin/main",
    );
    expect(translateZhCnWorkspaceUiText("Every 30 min after deployment")).toBe(
      "Every 30 min after deployment",
    );
  });
});
