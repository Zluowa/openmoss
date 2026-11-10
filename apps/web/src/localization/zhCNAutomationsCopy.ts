// FILE: zhCNAutomationsCopy.ts
// Purpose: Simplified Chinese for automations and the kanban board's goal and dispatch messages.
// Layer: Pure localization data
// Thread and task titles pass through the patterns untouched. Kanban's `kanban.*` keys go through
// typed i18n and never reach this table.

import { phraseTranslator } from "./zhCNPhraseTable";

const AUTOMATIONS_COPY: Readonly<Record<string, string>> = {
  // Creating an automation
  "Creating automation": "正在创建自动化",
  "Confirm automation creation": "确认创建自动化",
  "The result of this creation is awaiting confirmation. Retrying uses the same request and original settings.":
    "这次创建的结果正在等待确认。重试会使用相同的请求和原始设置。",
  "Creating…": "正在创建…",
  "Retry creation": "重试创建",
  "Could not finish automation setup.": "无法完成自动化设置。",
  "Could not confirm automation creation.": "无法确认自动化已创建。",
  "The account or creation context changed. Reopen the original creation to confirm its result.":
    "账号或创建上下文已变更。请重新打开原来的创建流程以确认结果。",
  "The account changed. Reopen this creation in its original account.":
    "账号已变更。请在原来的账号中重新打开这次创建。",
  "The saved creation cannot be read. Preserve this window and retry.":
    "无法读取已保存的创建内容。请保留这个窗口并重试。",
  "Saved creation is missing its request identity.": "已保存的创建内容缺少请求标识。",
  "A previous creation is still awaiting confirmation. Confirm it before creating another automation.":
    "上一次创建仍在等待确认。请先确认，再创建其他自动化。",
  "An automation creation requires a request identity.": "创建自动化需要请求标识。",
  "· Accepted": "· 已接受",
  "· Dismissed": "· 已忽略",

  // Form validation and schedules
  "Add a name": "请添加名称",
  "Use a 5-field cron expression (minute hour day month weekday)":
    "请使用 5 段式 cron 表达式（分 时 日 月 周）",
  "Add a timezone": "请添加时区",
  "Unknown timezone": "未知时区",
  "Add a prompt": "请添加提示词",
  "Pick a project": "请选择项目",
  "Pick a target thread": "请选择目标对话",
  "Set a valid interval": "请设置有效的间隔",
  "Add a cron expression": "请添加 cron 表达式",
  "Pick a run time": "请选择运行时间",
  "Set a valid time": "请设置有效的时间",
  "Acknowledge the flagged risks first": "请先确认标记的风险",
  "Every minute": "每分钟",
  "Every second": "每秒",
  "Next run now": "即将运行",
  "in 1 minute": "1 分钟后",
  "in 1 hour": "1 小时后",
  "in 1 day": "1 天后",
  "Keep running": "继续运行",
  "Stop after 1 failure": "失败 1 次后停止",

  "Automation name": "自动化名称",
  "What should this automation do on each run?": "这个自动化每次运行时要做什么？",
  "Manual runs only": "仅手动运行",
  "This automation only runs when you press Run now.": "这个自动化只有在你按“立即运行”时才会运行。",
  "Triage crashes": "分诊崩溃",
  "Look for new crashes in $sentry and open a fix PR for the most impactful one.":
    "在 $sentry 中查找新崩溃，并为影响最大的一个打开修复 PR。",
  "Update dependencies": "更新依赖",
  "Check for outdated dependencies, bump the safe minor and patch versions, then run the tests.":
    "检查过时的依赖，升级安全的次版本和补丁版本，然后运行测试。",
  "Daily standup summary": "每日站会摘要",
  "Daily summary": "每日摘要",
  "Summarize what changed on the main branch in the last 24 hours as a short standup update.":
    "把主分支过去 24 小时的变化总结成一条简短的站会更新。",

  // List and detail
  "Loading automations...": "正在加载自动化…",
  "Could not load automations.": "无法加载自动化。",
  "Finish automation setup": "完成自动化设置",
  "Finishing setup": "正在完成设置",
  "Finishing…": "正在完成…",
  "The automation has been saved.": "自动化已保存。",
  "The automation has been saved and remains paused until setup succeeds.":
    "自动化已保存，在设置成功前会保持暂停。",
  "Saving its connection to this page…": "正在把它的连接保存到此页面…",
  "Manage automation": "管理自动化",
  "Retry setup": "重试设置",
  "On failure": "失败时",
  Notify: "通知",
  "All runs": "所有运行",
  "Loading automation…": "正在加载自动化…",
  "Could not load this automation.": "无法加载这个自动化。",
  "Suggested automation": "建议的自动化",
  "Accept it before it can run, or dismiss it to archive the suggestion.":
    "接受后才能运行，也可以忽略以归档这条建议。",
  "Accept the automation proposal first": "请先接受自动化提议",
  "Re-enable the automation first": "请先重新启用自动化",
  "Re-enable": "重新启用",
  "No persistent memory yet.": "还没有持久记忆。",
  Switch: "切换",
  "Continue an existing thread": "继续现有对话",
  "Release the current thread?": "释放当前对话？",
  "Each run appends a turn to the thread you pick and waits for it to go idle.":
    "每次运行都会在你选择的对话中追加一轮，并等待它进入空闲。",
  "Pick a thread…": "选择对话…",
  Accept: "接受",

  // Kanban
  "Send as goal": "作为目标发送",
  "Set as goal": "设为目标",
  "Goal set": "目标已设置",
  "Could not send as goal": "无法作为目标发送",
  "Could not set goal": "无法设置目标",
  "The thread has no prompt or title to save as its goal.":
    "这个对话没有可保存为目标的提示词或标题。",
  "Move to…": "移到…",
  "Unknown error.": "未知错误。",
  "Board view": "看板视图",
  "Drafted prompts, running turns, and completed chats will show up here automatically.":
    "起草的提示词、运行中的回合和已完成的对话都会自动显示在这里。",
  "The board stood down; the running chat send owns this turn.":
    "看板已退出；这一轮由正在运行的对话发送负责。",
  "Nothing to send yet. Write the prompt in the composer.":
    "还没有可发送的内容。请在输入框中写下提示词。",
};

export const translateZhCnAutomationsCopyText = phraseTranslator(AUTOMATIONS_COPY, [
  [/^in (\d+) minutes$/, "$1 分钟后"],
  [/^in (\d+) hours$/, "$1 小时后"],
  [/^in (\d+) days$/, "$1 天后"],
  [/^Every (\d+) hours$/, "每 $1 小时"],
  [/^Every (\d+) minutes$/, "每 $1 分钟"],
  [/^Every (\d+) seconds$/, "每 $1 秒"],
  [/^Stop after (\d+) failures$/, "失败 $1 次后停止"],
  [
    /^The automation stops writing to “(.+)”; the thread itself is kept\.$/,
    "自动化将不再写入“$1”；对话本身会保留。",
  ],
  [
    /^The automation stops writing to its thread; the thread itself is kept\.$/,
    "自动化将不再写入它的对话；对话本身会保留。",
  ],
  [/^(.+) was moved back to Draft\.$/, "“$1”已移回草稿。"],
  [/^New task in (?!Chats$)(.+)$/, "在 $1 中新建任务"],
  [/^Optimizing images?…$/, "正在优化图片…"],
  [
    /^The goal is ([\d,]+) characters; keep it within ([\d,]+)\.$/,
    "目标有 $1 个字符；请控制在 $2 个以内。",
  ],
]);
