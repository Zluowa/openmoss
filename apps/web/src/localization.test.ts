// FILE: localization.test.ts
// Purpose: Verifies local UI language resolution and translation lookup.
// Layer: Web UI state tests

import { describe, expect, it } from "vitest";

import {
  formatMossTranslation,
  resolveMossLocale,
  settingsSectionTranslationKeys,
  translateMoss,
} from "./localization";
import { SETTINGS_SECTION_IDS } from "./settingsNavigation";
import { SETTINGS_SEARCH_ENTRIES, settingsSearchEntryTitle } from "./settingsSearchIndex";

describe("resolveMossLocale", () => {
  it("uses explicit locale overrides before browser languages", () => {
    expect(resolveMossLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveMossLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("auto-detects supported browser languages", () => {
    expect(resolveMossLocale(null, ["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveMossLocale(null, ["en-US", "zh-CN"])).toBe("en");
  });

  it("falls back to Chinese when auto-detect cannot match a supported language", () => {
    expect(resolveMossLocale(null, ["fr-FR"])).toBe("zh-CN");
  });
});

describe("translateMoss", () => {
  it("returns localized UI strings for the active locale", () => {
    expect(translateMoss("zh-CN", "sidebar.settings")).toBe("设置");
    expect(translateMoss("en", "sidebar.settings")).toBe("Settings");
    expect(translateMoss("zh-CN", "chat.empty.logoAria")).toBe("Moss 标志");
    expect(translateMoss("en", "chat.empty.logoAria")).toBe("Moss logo");
    expect(translateMoss("zh-CN", "chat.empty.buildHeading")).toBe("一起构建");
    expect(translateMoss("en", "chat.empty.buildHeading")).toBe("Let's build");
    expect(translateMoss("zh-CN", "chat.environment.notepad")).toBe("记事本");
    expect(translateMoss("en", "chat.environment.notepad")).toBe("Notepad");
    expect(translateMoss("zh-CN", "chat.environment.notesPlaceholder")).toBe("在此输入");
    expect(translateMoss("en", "chat.environment.notesPlaceholder")).toBe("Type here");
    expect(translateMoss("zh-CN", "pullRequests.state.open")).toBe("开启中");
    expect(translateMoss("en", "pullRequests.state.open")).toBe("Open");
    expect(translateMoss("en", "chat.webMcp.listTools")).toBe("Listed website tools");
    expect(translateMoss("zh-CN", "chat.webMcp.listTools")).toBe("已列出网站工具");
    expect(translateMoss("en", "chat.webMcp.tool.inputTruncated")).toBe("Tool (input truncated)");
    expect(translateMoss("zh-CN", "chat.webMcp.result.truncated")).toBe("结果（已截断）");
  });

  it("keeps the composer Resume action localized in both supported locales", () => {
    expect(translateMoss("en", "chat.composer.send.resume")).toBe("Resume");
    expect(translateMoss("zh-CN", "chat.composer.send.resume")).toBe("继续运行");
  });

  it("localizes visual-reply controls and checkpoint confirmation copy in both locales", () => {
    expect(translateMoss("en", "chat.visualReply.openInPanel")).toBe("Open in panel");
    expect(translateMoss("zh-CN", "chat.visualReply.openInPanel")).toBe("在面板中打开");
    expect(translateMoss("en", "chat.visualReply.showSource")).toBe("Show source");
    expect(translateMoss("zh-CN", "chat.visualReply.showSource")).toBe("显示源代码");
    expect(translateMoss("en", "chat.visualReply.save")).toBe("Save visual reply");
    expect(translateMoss("zh-CN", "chat.visualReply.save")).toBe("保存可视化回复");
    expect(formatMossTranslation("en", "chat.checkpointRevert.title", { turnCount: 7 })).toBe(
      "Revert this thread to checkpoint 7?",
    );
    expect(formatMossTranslation("zh-CN", "chat.checkpointRevert.title", { turnCount: 7 })).toBe(
      "将此对话还原到检查点 7？",
    );
    expect(translateMoss("zh-CN", "chat.checkpointRevert.irreversible")).toBe("此操作无法撤销。");
    expect(translateMoss("en", "chat.fileUndo.title")).toBe(
      "Undo the file changes shown in this card?",
    );
    expect(translateMoss("zh-CN", "chat.fileUndo.title")).toBe("撤销此卡片中显示的文件更改？");
  });

  it("keeps automatic approval-review copy aligned with the frozen locales", () => {
    expect(translateMoss("en", "localConversation.automaticApprovalReview.inProgressTitle")).toBe(
      "Auto-reviewing",
    );
    expect(translateMoss("en", "localConversation.automaticApprovalReview.approvedTitle")).toBe(
      "Auto-review approved",
    );
    expect(translateMoss("en", "localConversation.automaticApprovalReview.deniedTitle")).toBe(
      "Auto-review denied",
    );
    expect(
      translateMoss("en", "localConversation.automaticApprovalReview.deniedHighRiskTitle"),
    ).toBe("Auto-review denied high risk");
    expect(translateMoss("en", "localConversation.automaticApprovalReview.timedOutTitle")).toBe(
      "Auto-review timed out",
    );
    expect(translateMoss("en", "localConversation.automaticApprovalReview.abortedTitle")).toBe(
      "Auto-review stopped",
    );
    expect(
      translateMoss("en", "localConversation.automaticApprovalReview.explicitAuthorization"),
    ).toBe("Requires explicit authorization");
    expect(
      translateMoss(
        "en",
        "localConversation.automaticApprovalReview.explicitAuthorizationHighRisk",
      ),
    ).toBe("Requires explicit authorization because this action is considered high risk");
    expect(
      translateMoss("en", "localConversation.automaticApprovalReview.inProgressFallback"),
    ).toBe("A carefully prompted reviewer agent is reviewing this request before ChatGPT runs it");
    expect(translateMoss("en", "localConversation.automaticApprovalReview.abortedFallback")).toBe(
      "A carefully prompted reviewer agent stopped reviewing this request before ChatGPT ran it",
    );
    expect(translateMoss("en", "localConversation.automaticApprovalReview.timedOutFallback")).toBe(
      "A carefully prompted reviewer agent timed out before ChatGPT ran this request",
    );
    expect(translateMoss("en", "localConversation.automaticApprovalReview.terminalFallback")).toBe(
      "A carefully prompted reviewer agent reviewed this request.",
    );
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.inProgressTitle"),
    ).toBe("自动审核中");
    expect(translateMoss("zh-CN", "localConversation.automaticApprovalReview.approvedTitle")).toBe(
      "自动审核已批准",
    );
    expect(translateMoss("zh-CN", "localConversation.automaticApprovalReview.deniedTitle")).toBe(
      "自动审核已拒绝",
    );
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.deniedHighRiskTitle"),
    ).toBe("自动审核已拒绝高风险操作");
    expect(translateMoss("zh-CN", "localConversation.automaticApprovalReview.timedOutTitle")).toBe(
      "自动审核超时",
    );
    expect(translateMoss("zh-CN", "localConversation.automaticApprovalReview.abortedTitle")).toBe(
      "自动审核已停止",
    );
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.explicitAuthorization"),
    ).toBe("需要明确授权");
    expect(
      translateMoss(
        "zh-CN",
        "localConversation.automaticApprovalReview.explicitAuthorizationHighRisk",
      ),
    ).toBe("此操作被视为高风险，需要明确授权");
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.inProgressFallback"),
    ).toBe("经过精心提示的审查智能体正在审查此请求，随后 ChatGPT 才会运行它");
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.abortedFallback"),
    ).toBe("经过精心提示的审查智能体在 ChatGPT 运行此请求前已停止审查此请求");
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.timedOutFallback"),
    ).toBe("经过精心提示的审查智能体在 ChatGPT 运行此请求前已超时。");
    expect(
      translateMoss("zh-CN", "localConversation.automaticApprovalReview.terminalFallback"),
    ).toBe("经优化提示的审查智能体已审查此请求。");
  });

  it("keeps Computer History product copy Moss-branded in both locales", () => {
    const brandedKeys = [
      "settings.history.enableDescription",
      "settings.history.historyDescription",
      "settings.history.off.title",
      "settings.history.off.description",
      "settings.history.off.privacy",
      "settings.history.permissionsRestart",
      "settings.history.error.turnOn",
      "settings.history.clearSuccess",
    ] as const;

    for (const locale of ["en", "zh-CN"] as const) {
      for (const key of brandedKeys) {
        const copy = translateMoss(locale, key);
        expect(copy).toContain("Moss");
        expect(copy).not.toMatch(/ChatGPT|OpenAI/iu);
      }
    }
  });

  it("localizes the quota-exhausted activity independently of its persisted summary", () => {
    expect(translateMoss("en", "mossQuota.exhausted.activity")).toBe("Moss usage limit reached");
    expect(translateMoss("zh-CN", "mossQuota.exhausted.activity")).toBe("本周期用量已用完");
    expect(translateMoss("en", "mossPay.quota.unknown")).toBe("Unavailable");
    expect(translateMoss("zh-CN", "mossPay.quota.unknown")).toBe("暂不可用");
  });

  it("describes the Sidebar new-thread fallback project in both locales", () => {
    expect(translateMoss("en", "sidebar.searchPalette.newThread.description")).toBe(
      "Start a fresh thread in the current or most recently used project.",
    );
    expect(translateMoss("zh-CN", "sidebar.searchPalette.newThread.description")).toBe(
      "在当前项目或最近使用的项目中开始新项目对话。",
    );
  });

  it("localizes markdown controls that live inside protected message content", () => {
    expect(translateMoss("en", "chat.markdown.code.enableSoftWrap")).toBe("Enable soft wrap");
    expect(translateMoss("zh-CN", "chat.markdown.code.enableSoftWrap")).toBe("启用自动换行");
    expect(translateMoss("en", "chat.markdown.code.disableSoftWrap")).toBe("Disable soft wrap");
    expect(translateMoss("zh-CN", "chat.markdown.code.disableSoftWrap")).toBe("关闭自动换行");
    expect(translateMoss("en", "chat.markdown.code.copy")).toBe("Copy code");
    expect(translateMoss("zh-CN", "chat.markdown.code.copy")).toBe("复制代码");
    expect(translateMoss("en", "chat.markdown.code.copied")).toBe("Copied");
    expect(translateMoss("zh-CN", "chat.markdown.code.copied")).toBe("已复制");
    expect(translateMoss("en", "chat.markdown.generatedImage.defaultAlt")).toBe("Generated image");
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.defaultAlt")).toBe("生成的图片");
    expect(translateMoss("en", "chat.markdown.generatedImage.downloadError")).toBe(
      "Could not download generated image",
    );
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.downloadError")).toBe(
      "无法下载生成的图片",
    );
    expect(translateMoss("en", "chat.markdown.generatedImage.expandAria")).toBe(
      "Expand generated image",
    );
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.expandAria")).toBe(
      "展开生成的图片",
    );
    expect(translateMoss("en", "chat.markdown.generatedImage.expand")).toBe("Expand");
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.expand")).toBe("展开");
    expect(translateMoss("en", "chat.markdown.generatedImage.downloadAria")).toBe(
      "Download generated image",
    );
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.downloadAria")).toBe(
      "下载生成的图片",
    );
    expect(translateMoss("en", "chat.markdown.generatedImage.download")).toBe("Download");
    expect(translateMoss("zh-CN", "chat.markdown.generatedImage.download")).toBe("下载");
  });

  it("keeps the frozen Codex plugin surfaces' exact zh-CN copy", () => {
    expect(translateMoss("zh-CN", "plugins.subtitle.plugins")).toBe(
      "连接插件，让 Moss 在你的各类工具中协同工作",
    );
    expect(translateMoss("zh-CN", "plugins.source.moss")).toBe("公开");
    expect(translateMoss("zh-CN", "plugins.manage.title")).toBe("插件");
    expect(translateMoss("zh-CN", "plugins.manage.subtitle")).toBe("管理插件、技能和 MCP");
    expect(translateMoss("zh-CN", "plugins.search.plugins")).toBe("搜索插件");
    expect(translateMoss("zh-CN", "plugins.warning.openAiRemoteAuth")).toContain(
      "Moss 内置插件仍可正常使用",
    );
    expect(translateMoss("en", "plugins.manage.tab.mcps")).toBe("MCPs");
    expect(translateMoss("zh-CN", "plugins.manage.tab.mcps")).toBe("MCP");
    expect(formatMossTranslation("en", "plugins.manage.openAppTools", { name: "Gmail" })).toBe(
      "Open Gmail tools",
    );
    expect(formatMossTranslation("zh-CN", "plugins.manage.openAppTools", { name: "Gmail" })).toBe(
      "打开 Gmail 工具",
    );
    expect(translateMoss("en", "plugins.import.canonicalNotice")).toContain(
      "server-issued import receipt",
    );
    expect(translateMoss("zh-CN", "plugins.import.canonicalNotice")).toContain("服务器签发");
    expect(translateMoss("en", "dialog.close")).toBe("Close");
    expect(translateMoss("zh-CN", "dialog.close")).toBe("关闭");
    expect(translateMoss("en", "plugins.action.importPluginsAndSkills")).toBe(
      "Import plugins and skills",
    );
    expect(translateMoss("zh-CN", "plugins.action.importPluginsAndSkills")).toBe("导入插件和技能");
    expect(translateMoss("en", "plugins.import.metadata.mcp")).toContain("server-sanitized");
    expect(translateMoss("zh-CN", "plugins.import.metadata.mcp")).toContain("服务器已清理");
    expect(translateMoss("en", "plugins.import.error.invalidMcpName")).toContain(
      "unsupported characters",
    );
    expect(translateMoss("zh-CN", "plugins.import.error.invalidMcpName")).toContain("不支持");
    expect(translateMoss("en", "plugins.import.mcpPreview")).toContain("revalidates");
    expect(translateMoss("zh-CN", "plugins.import.mcpPreview")).toContain("重新验证");
    expect(
      formatMossTranslation("en", "plugins.import.preview.mcp", {
        table: "mcpServers",
        name: "github",
      }),
    ).toContain("mcpServers.github");
    expect(
      formatMossTranslation("zh-CN", "plugins.import.preview.mcp", {
        table: "mcpServers",
        name: "github",
      }),
    ).toContain("操作：合并");
  });

  it("localizes subagent, workflow, and timeline presentation keys", () => {
    expect(formatMossTranslation("en", "rightDock.subagents.active", { count: 4 })).toBe(
      "Active · 4",
    );
    expect(formatMossTranslation("en", "rightDock.subagents.done", { count: 11 })).toBe(
      "Done · 11",
    );
    expect(translateMoss("en", "rightDock.subagents.emptyActive")).toBe("No active subagents");
    expect(translateMoss("en", "rightDock.subagents.working")).toBe("Working");
    expect(formatMossTranslation("en", "rightDock.subagents.showMore", { count: 1 })).toBe(
      "Show 1 more",
    );
    expect(translateMoss("en", "rightDock.subagents.showLess")).toBe("Show less");
    expect(translateMoss("en", "rightDock.subagents.back")).toBe("Back to subagents");
    expect(formatMossTranslation("zh-CN", "rightDock.subagents.active", { count: 4 })).toBe(
      "已开启 · 4",
    );
    expect(formatMossTranslation("zh-CN", "rightDock.subagents.done", { count: 11 })).toBe(
      "完成 · 11",
    );
    expect(translateMoss("zh-CN", "rightDock.subagents.emptyActive")).toBe("没有已开启的子代理");
    expect(translateMoss("zh-CN", "rightDock.subagents.working")).toBe("处理中");
    expect(formatMossTranslation("zh-CN", "rightDock.subagents.showMore", { count: 1 })).toBe(
      "再显示 1 个",
    );
    expect(translateMoss("zh-CN", "rightDock.subagents.showLess")).toBe("收起");
    expect(translateMoss("zh-CN", "rightDock.subagents.back")).toBe("返回子代理列表");

    expect(formatMossTranslation("en", "chat.workflow.toolCalls.many", { count: 4 })).toBe(
      "4 tool calls",
    );
    expect(formatMossTranslation("zh-CN", "chat.workflow.toolCalls.many", { count: 4 })).toBe(
      "4 次工具调用",
    );
    expect(formatMossTranslation("en", "chat.workflow.tokens", { tokens: "128k" })).toBe(
      "128k tokens",
    );
    expect(formatMossTranslation("zh-CN", "chat.workflow.tokens", { tokens: "128k" })).toBe(
      "128k 个令牌",
    );
    expect(translateMoss("en", "chat.workflow.phase.task")).toBe("Task");
    expect(translateMoss("zh-CN", "chat.workflow.phase.task")).toBe("任务");

    expect(formatMossTranslation("en", "chat.timeline.moreToolUses", { count: 2 })).toBe(
      "+2 more tool uses",
    );
    expect(formatMossTranslation("zh-CN", "chat.timeline.moreToolUses", { count: 2 })).toBe(
      "还有 2 次工具调用",
    );
    expect(translateMoss("en", "chat.timeline.openThread")).toBe("Open thread");
    expect(translateMoss("zh-CN", "chat.timeline.openThread")).toBe("打开对话");
    expect(translateMoss("en", "localConversation.working")).toBe("Working");
    expect(
      formatMossTranslation("en", "localConversation.modelRerouted", { toModel: "GPT-5.4" }),
    ).toBe("Your request was routed to GPT-5.4.");
    expect(translateMoss("en", "localConversation.modelRerouted.warning.line1")).toBe(
      "Heads up, your request was re-routed to reduce cyber-abuse risk.",
    );
    expect(translateMoss("en", "localConversation.modelRerouted.warning.line2.prefix")).toBe(
      "Think this is a mistake? Request a review at ",
    );
    expect(translateMoss("en", "localConversation.modelRerouted.warning.line2.suffix")).toBe(
      " or report via /feedback",
    );
    expect(formatMossTranslation("en", "localConversation.userStoppedAfter", { time: "3s" })).toBe(
      "You stopped after 3s",
    );
    expect(formatMossTranslation("en", "localConversation.workingFor", { time: "1s" })).toBe(
      "Working for 1s",
    );
    expect(
      formatMossTranslation("en", "chat.todoPlan.pillProgress", {
        stepNumber: 2,
        stepCount: 3,
      }),
    ).toBe("Step 2 / 3");
    expect(formatMossTranslation("en", "localConversation.workedFor", { time: "6s" })).toBe(
      "Worked for 6s",
    );
    expect(
      formatMossTranslation("en", "localConversation.previousMessagesSummary.one", { count: 1 }),
    ).toBe("1 previous message");
    expect(
      formatMossTranslation("en", "localConversation.previousMessagesSummary.many", { count: 4 }),
    ).toBe("4 previous messages");
    expect(translateMoss("zh-CN", "localConversation.working")).toBe("工作中");
    expect(
      formatMossTranslation("zh-CN", "localConversation.modelRerouted", { toModel: "GPT-5.4" }),
    ).toBe("你的请求已路由到 GPT-5.4。");
    expect(translateMoss("zh-CN", "localConversation.modelRerouted.warning.line1")).toBe(
      "请注意：为减少网络滥用风险，你的请求已被重新路由。",
    );
    expect(translateMoss("zh-CN", "localConversation.modelRerouted.warning.line2.prefix")).toBe(
      "认为这是误判？请在 ",
    );
    expect(translateMoss("zh-CN", "localConversation.modelRerouted.warning.line2.suffix")).toBe(
      " 申请复核，或通过 /feedback 举报",
    );
    expect(
      formatMossTranslation("zh-CN", "localConversation.userStoppedAfter", { time: "3秒" }),
    ).toBe("你在 3秒 后停止了");
    expect(formatMossTranslation("zh-CN", "localConversation.workingFor", { time: "1秒" })).toBe(
      "工作了 1秒",
    );
    expect(
      formatMossTranslation("zh-CN", "chat.todoPlan.pillProgress", {
        stepNumber: 2,
        stepCount: 3,
      }),
    ).toBe("第 2 / 3 步");
    expect(formatMossTranslation("zh-CN", "localConversation.workedFor", { time: "6秒" })).toBe(
      "已工作 6秒",
    );
    expect(
      formatMossTranslation("zh-CN", "localConversation.previousMessagesSummary.one", {
        count: 1,
      }),
    ).toBe("之前的 1 条消息");
    expect(
      formatMossTranslation("zh-CN", "localConversation.previousMessagesSummary.many", {
        count: 4,
      }),
    ).toBe("之前的 4 条消息");
    expect(formatMossTranslation("en", "chat.timeline.moreSubagents", { count: 3 })).toBe(
      "+3 more",
    );
    expect(formatMossTranslation("zh-CN", "chat.timeline.moreSubagents", { count: 3 })).toBe(
      "还有 3 个",
    );
    expect(formatMossTranslation("en", "chat.timeline.otherSubagent.one", { count: 1 })).toBe(
      "and 1 other subagent",
    );
    expect(formatMossTranslation("en", "chat.timeline.otherSubagent.many", { count: 2 })).toBe(
      "and 2 other subagents",
    );
    expect(formatMossTranslation("zh-CN", "chat.timeline.otherSubagent.one", { count: 1 })).toBe(
      "及其他 1 个子智能体",
    );
    expect(formatMossTranslation("zh-CN", "chat.timeline.otherSubagent.many", { count: 2 })).toBe(
      "及其他 2 个子智能体",
    );
    expect(formatMossTranslation("en", "chat.timeline.openSubagent", { name: "Scout" })).toBe(
      "Open Scout subagent",
    );
    expect(formatMossTranslation("zh-CN", "chat.timeline.openSubagent", { name: "Scout" })).toBe(
      "打开子智能体 Scout",
    );
    expect(translateMoss("en", "chat.timeline.subagentStatus.startedWorking")).toBe(
      "started working",
    );
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.startedWorking")).toBe(
      "已开始工作",
    );
    expect(translateMoss("en", "chat.timeline.subagentStatus.updated")).toBe("updated");
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.updated")).toBe("已更新");
    expect(translateMoss("en", "chat.timeline.subagentStatus.interrupted")).toBe("interrupted");
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.interrupted")).toBe("已中断");
    expect(translateMoss("en", "chat.timeline.subagentStatus.failed")).toBe("finished with errors");
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.failed")).toBe(
      "已完成，但出现错误",
    );
    expect(translateMoss("en", "chat.timeline.subagentStatus.progress")).toBe("made progress");
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.progress")).toBe("取得了进展");
    expect(translateMoss("en", "chat.timeline.subagentStatus.interrupted.one")).toBe(
      "was interrupted",
    );
    expect(translateMoss("en", "chat.timeline.subagentStatus.interrupted.many")).toBe(
      "were interrupted",
    );
    expect(translateMoss("en", "chat.timeline.subagentStatus.finished")).toBe("finished");
    expect(translateMoss("zh-CN", "chat.timeline.subagentStatus.finished")).toBe("已完成");
  });

  it("localizes the bounded MCP result states and diagnostics action", () => {
    expect(formatMossTranslation("en", "chat.mcpResult.resource.read", { target: "README" })).toBe(
      "Read README",
    );
    expect(
      formatMossTranslation("zh-CN", "chat.mcpResult.resource.read", { target: "README" }),
    ).toBe("读取 README");
    expect(formatMossTranslation("en", "chat.mcpResult.omittedBlocks", { count: 2 })).toBe(
      "2 blocks omitted",
    );
    expect(formatMossTranslation("zh-CN", "chat.mcpResult.omittedBlocks", { count: 2 })).toBe(
      "已省略 2 个内容块",
    );
    expect(translateMoss("en", "chat.mcpResult.raw.open")).toBe("Show raw tool call output");
    expect(translateMoss("zh-CN", "chat.mcpResult.raw.open")).toBe("显示原始工具调用输出");
    expect(
      formatMossTranslation("en", "chat.mcpResult.raw.title", {
        server: "filesystem",
        tool: "read_file",
      }),
    ).toBe("Raw filesystem.read_file tool call output");
    expect(
      formatMossTranslation("zh-CN", "chat.mcpResult.raw.title", {
        server: "filesystem",
        tool: "read_file",
      }),
    ).toBe("原始 filesystem.read_file 工具调用输出");
    for (const key of [
      "chat.mcpResult.invocation",
      "chat.mcpResult.plaintext",
      "chat.mcpResult.resource",
      "chat.mcpResult.embedded",
      "chat.mcpResult.unknown",
      "chat.mcpResult.structured",
      "chat.mcpResult.error",
      "chat.mcpResult.noContent",
      "chat.mcpResult.truncated",
      "chat.mcpResult.binaryDeferred",
      "chat.mcpResult.raw.open",
      "chat.mcpResult.raw.title",
      "chat.mcpResult.raw.description",
    ] as const) {
      expect(translateMoss("en", key)).not.toBe(key);
      expect(translateMoss("zh-CN", key)).not.toBe(key);
    }
  });

  it("localizes provider settings copy", () => {
    expect(translateMoss("zh-CN", "settings.nav.providers.label")).toBe("模型账号");
    expect(translateMoss("zh-CN", "settings.providers.providerUpdates.title")).toBe("服务商更新");
    expect(translateMoss("en", "settings.providers.status.inDevelopment")).toBe("In development");
    expect(translateMoss("zh-CN", "settings.providers.status.inDevelopment")).toBe("开发中");
    expect(
      formatMossTranslation("zh-CN", "settings.providers.status.updatesAvailable", {
        count: 2,
        updateWord: "updates",
      }),
    ).toBe("2 个更新可用");
    expect(
      formatMossTranslation("en", "settings.providers.status.updatesAvailable", {
        count: 2,
        updateWord: "updates",
      }),
    ).toBe("2 updates available");
    expect(translateMoss("en", "settings.providers.docs.reference")).toBe("Reference");
    expect(translateMoss("zh-CN", "settings.providers.docs.reference")).toBe("参考");
    expect(translateMoss("en", "settings.providers.docs.hooks")).toBe("Hooks");
    expect(translateMoss("zh-CN", "settings.providers.docs.hooks")).toBe("钩子");
  });

  it("localizes Antigravity effort labels without changing English", () => {
    expect(translateMoss("en", "chat.effort.none")).toBe("None");
    expect(translateMoss("zh-CN", "chat.effort.none")).toBe("无");
    expect(translateMoss("en", "chat.effort.label")).toBe("Effort");
    expect(translateMoss("zh-CN", "chat.effort.label")).toBe("推理强度");
    expect(translateMoss("en", "chat.effort.thinking")).toBe("Thinking");
    expect(translateMoss("zh-CN", "chat.effort.thinking")).toBe("思考");
    expect(translateMoss("en", "chat.effort.ultra")).toBe("Ultra");
    expect(translateMoss("zh-CN", "chat.effort.ultra")).toBe("超高");
    expect(translateMoss("en", "chat.effort.max")).toBe("Max");
    expect(translateMoss("zh-CN", "chat.effort.max")).toBe("最大");
    expect(translateMoss("en", "chat.traits.fastMode")).toBe("Fast mode");
    expect(translateMoss("zh-CN", "chat.traits.fastMode")).toBe("快速模式");
    expect(translateMoss("en", "chat.traits.fast")).toBe("Fast");
    expect(translateMoss("zh-CN", "chat.traits.fast")).toBe("快速");
    expect(translateMoss("en", "chat.traits.default")).toBe("Default");
    expect(translateMoss("zh-CN", "chat.traits.default")).toBe("默认");
    expect(translateMoss("en", "chat.traits.speed")).toBe("Speed");
    expect(translateMoss("zh-CN", "chat.traits.speed")).toBe("速度");
    expect(translateMoss("en", "chat.traits.fastModeOn")).toBe("Fast mode on");
    expect(translateMoss("zh-CN", "chat.traits.fastModeOn")).toBe("快速模式已开启");
    expect(translateMoss("en", "chat.traits.fastModeOff")).toBe("Fast mode off");
    expect(translateMoss("zh-CN", "chat.traits.fastModeOff")).toBe("快速模式已关闭");
    expect(translateMoss("en", "chat.traits.options")).toBe("Options");
    expect(translateMoss("zh-CN", "chat.traits.options")).toBe("选项");
    expect(translateMoss("en", "chat.traits.onDefault")).toBe("On (default)");
    expect(translateMoss("zh-CN", "chat.traits.onDefault")).toBe("开启（默认）");
    expect(translateMoss("en", "chat.traits.off")).toBe("Off");
    expect(translateMoss("zh-CN", "chat.traits.off")).toBe("关闭");
    expect(formatMossTranslation("en", "chat.traits.defaultOption", { label: "300K" })).toBe(
      "300K (default)",
    );
    expect(formatMossTranslation("zh-CN", "chat.traits.defaultOption", { label: "300K" })).toBe(
      "300K（默认）",
    );
    expect(translateMoss("en", "chat.traits.agent")).toBe("Agent");
    expect(translateMoss("zh-CN", "chat.traits.agent")).toBe("智能体");
    expect(translateMoss("en", "chat.traits.mode")).toBe("Mode");
    expect(translateMoss("zh-CN", "chat.traits.mode")).toBe("模式");
    expect(translateMoss("en", "chat.traits.variant")).toBe("Variant");
    expect(translateMoss("zh-CN", "chat.traits.variant")).toBe("变体");
    expect(translateMoss("en", "chat.traits.context")).toBe("Context");
    expect(translateMoss("zh-CN", "chat.traits.context")).toBe("上下文");
    expect(translateMoss("en", "chat.traits.contextWindow")).toBe("Context Window");
    expect(translateMoss("zh-CN", "chat.traits.contextWindow")).toBe("上下文窗口");
    expect(translateMoss("en", "chat.traits.changeControls")).toBe(
      "Change effort, context, and speed",
    );
    expect(translateMoss("zh-CN", "chat.traits.changeControls")).toBe("更改推理强度、上下文和速度");
    expect(translateMoss("en", "chat.effort.ultrathinkPromptHint")).toBe(
      "Remove Ultrathink from the prompt to change effort.",
    );
    expect(translateMoss("zh-CN", "chat.effort.ultrathinkPromptHint")).toBe(
      "请从提示词中移除 Ultrathink 后再更改推理强度。",
    );
  });

  it("fully localizes provider health copy", () => {
    expect(formatMossTranslation("zh-CN", "provider.health.title", { provider: "Codex" })).toBe(
      "Codex 服务商状态",
    );
    expect(
      formatMossTranslation("zh-CN", "provider.health.unavailable", { provider: "Codex" }),
    ).toBe("Codex 服务商当前不可用。");
    expect(formatMossTranslation("zh-CN", "provider.health.limited", { provider: "Codex" })).toBe(
      "Codex 服务商当前部分可用。",
    );
    expect(translateMoss("zh-CN", "provider.health.dismiss")).toBe("关闭服务商状态提示");
  });

  it("localizes later settings sections and search result titles", () => {
    expect(translateMoss("zh-CN", "settings.notifications.desktop.title")).toBe("桌面通知");
    expect(translateMoss("zh-CN", "settings.behavior.diffLineWrapping.title")).toBe(
      "Diff 自动换行",
    );
    expect(translateMoss("zh-CN", "settings.advanced.releaseHistory.view")).toBe("查看发布历史");

    const desktopNotificationsEntry = SETTINGS_SEARCH_ENTRIES.find(
      (entry) => entry.id === "notifications:desktop-notifications",
    );
    expect(desktopNotificationsEntry).toBeDefined();
    expect(
      settingsSearchEntryTitle(desktopNotificationsEntry!, (key) => translateMoss("zh-CN", key)),
    ).toBe("桌面通知");
  });

  it("defines English and Chinese navigation copy for every settings section", () => {
    for (const section of SETTINGS_SECTION_IDS) {
      const { label: labelKey, description: descriptionKey } =
        settingsSectionTranslationKeys(section);

      for (const locale of ["en", "zh-CN"] as const) {
        expect(translateMoss(locale, labelKey)).not.toBe(labelKey);
        expect(translateMoss(locale, descriptionKey)).not.toBe(descriptionKey);
      }
    }
  });

  it("defines English and Chinese copy for every settings navigation group", () => {
    const groups = ["personal", "integrations", "coding", "system", "archived"] as const;

    for (const group of groups) {
      const key = `settings.navGroup.${group}` as const;
      for (const locale of ["en", "zh-CN"] as const) {
        expect(translateMoss(locale, key)).not.toBe(key);
      }
    }
  });
});
