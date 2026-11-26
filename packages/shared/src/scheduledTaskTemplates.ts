// FILE: scheduledTaskTemplates.ts
// Purpose: Single source of truth for Scheduled Tasks (定时任务) templates, copy, and
//          Moss Central linear icon mappings shared across Desktop (apps/web) and Mobile (apps/mobile).
// Layer: Shared domain data

export type ScheduledTaskTemplateIcon =
  | "sunrise"
  | "mailbox"
  | "heartBeat"
  | "branch"
  | "shieldCheck"
  | "note"
  | "tag"
  | "calendarSparkle";

export type ScheduledTaskTemplateSchedule =
  | {
      readonly kind: "daily";
      readonly timeOfDay: string;
    }
  | {
      readonly kind: "weekdays";
      readonly timeOfDay: string;
    }
  | {
      readonly kind: "weekly";
      readonly dayOfWeek: number;
      readonly timeOfDay: string;
    };

export interface ScheduledTaskTemplate {
  readonly id: string;
  readonly category: "work" | "life";
  readonly featuredInEmpty: boolean;
  readonly icon: ScheduledTaskTemplateIcon;
  readonly desktopIconName: string;
  readonly title: { readonly zh: string; readonly en: string };
  readonly summary: { readonly zh: string; readonly en: string };
  readonly scheduleMeta: { readonly zh: string; readonly en: string };
  readonly prompt: { readonly zh: string; readonly en: string };
  readonly schedule: ScheduledTaskTemplateSchedule;
}

export interface BilingualText {
  readonly zh: string;
  readonly en: string;
}

export const SCHEDULED_PAGE_COPY = {
  title: { zh: "定时任务", en: "Scheduled tasks" },
  tabYours: { zh: "我的任务", en: "Yours" },
  tabTemplates: { zh: "模板", en: "Templates" },
  newTask: { zh: "新建任务", en: "New task" },
  createWithMoss: { zh: "让 Moss 帮你建", en: "Create with Moss" },
  setUpManually: { zh: "手动设置", en: "Set up manually" },
  emptyTitle: { zh: "安排任务", en: "Schedule a task" },
  emptyDescription: {
    zh: "Moss 可以帮你处理持续性任务，让你不必亲自动手。",
    en: "Moss can handle recurring tasks for you so you can stay focused.",
  },
  browseTemplates: { zh: "浏览全部模板", en: "Browse templates" },
  localHint: {
    zh: "本地定时任务仅在电脑开机并联网时运行。",
    en: "Local scheduled tasks only run while your computer is awake and online.",
  },
  onlyOnThisComputer: { zh: "仅在当前电脑运行", en: "Only on this computer" },
  filterAll: { zh: "全部", en: "All" },
  filterActive: { zh: "运行中", en: "Active" },
  filterPaused: { zh: "已暂停", en: "Paused" },
  searchPlaceholder: { zh: "搜索任务", en: "Search tasks" },
  noSearchResults: { zh: "没有匹配的定时任务", en: "No matching scheduled tasks" },
  statusActive: { zh: "运行中", en: "Active" },
  statusPaused: { zh: "已暂停", en: "Paused" },
  statusScheduled: { zh: "已定时", en: "Scheduled" },
  statusDone: { zh: "已完成", en: "Done" },
  runNow: { zh: "立即运行", en: "Run now" },
  pause: { zh: "暂停", en: "Pause" },
  resume: { zh: "恢复", en: "Resume" },
  deleteTask: { zh: "删除任务", en: "Delete" },
  modalCreateTitle: { zh: "新建定时任务", en: "New scheduled task" },
  modalEditTitle: { zh: "编辑定时任务", en: "Edit scheduled task" },
  fieldName: { zh: "名称", en: "Name" },
  fieldNamePlaceholder: { zh: "例如：每日简报", en: "e.g. Daily briefing" },
  fieldInstructions: { zh: "任务说明", en: "Instructions" },
  fieldInstructionsPlaceholder: {
    zh: "描述每次定时执行时要完成的内容…",
    en: "Describe what this task should do on each run…",
  },
  fieldTrigger: { zh: "触发方式", en: "Trigger" },
  fieldRepeat: { zh: "重复", en: "Repeats" },
  fieldTime: { zh: "时间", en: "Time" },
  fieldWeekday: { zh: "星期", en: "Day" },
  fieldInterval: { zh: "间隔", en: "Every" },
  fieldRunAt: { zh: "运行时间", en: "Run at" },
  fieldCron: { zh: "Cron 表达式", en: "Cron" },
  fieldTimezone: { zh: "时区", en: "Timezone" },
  advancedSettings: { zh: "高级设置", en: "Advanced settings" },
  fieldProject: { zh: "项目", en: "Project" },
  fieldSelectProject: { zh: "选择项目", en: "Select project" },
  fieldAgentModel: { zh: "智能体与模型", en: "Agent & model" },
  fieldMode: { zh: "运行方式", en: "Run mode" },
  fieldTargetThread: { zh: "目标对话", en: "Target thread" },
  fieldWorkspace: { zh: "工作目录", en: "Workspace" },
  fieldPermissions: { zh: "权限模式", en: "Permissions" },
  fieldNotify: { zh: "通知", en: "Notify" },
  fieldOnFailure: { zh: "失败策略", en: "On failure" },
  fieldMaxRuns: { zh: "最大次数", en: "Max runs" },
  fieldStopWhen: { zh: "停止条件", en: "Stop when" },
  fieldStopWhenPlaceholder: { zh: "例如：PR 已准备合并", en: "e.g. PR is ready to merge" },
  cancel: { zh: "取消", en: "Cancel" },
  create: { zh: "创建", en: "Create" },
  save: { zh: "保存", en: "Save" },
  guidedStarter: {
    zh: "/automation 帮我创建一个定时任务：",
    en: "/automation Create a scheduled task to ",
  },
  guidedHintTitle: { zh: "告诉 Moss 你想定时做什么", en: "Tell Moss what to schedule" },
  guidedHintBody: {
    zh: "例如：「每个工作日早上 9 点帮我整理昨晚的提交和待处理的 PR」。",
    en: 'For example: "Every weekday at 9am, summarize recent commits and open PRs."',
  },
} as const satisfies Record<string, BilingualText>;

export const SCHEDULED_TASK_TEMPLATES: readonly ScheduledTaskTemplate[] = [
  {
    id: "daily-briefing",
    category: "work",
    featuredInEmpty: true,
    icon: "sunrise",
    desktopIconName: "sunrise",
    title: { zh: "每日简报", en: "Briefing" },
    summary: {
      zh: "汇总今日日程、重要邮件与待办事项的晨间简报。",
      en: "Summary of your calendar, emails, and messages.",
    },
    scheduleMeta: { zh: "工作日 07:18", en: "Weekdays at 7:18 AM" },
    prompt: {
      zh: "为我生成今日晨间简报，按优先级整理：1. 今日日程与会议重点；2. 需要处理的未读邮件；3. 待回复的重要消息与待办事项。",
      en: "Generate a morning briefing covering today's schedule, important unread emails, messages requiring a response, and priority action items.",
    },
    schedule: { kind: "weekdays", timeOfDay: "07:18" },
  },
  {
    id: "email-triage",
    category: "work",
    featuredInEmpty: true,
    icon: "mailbox",
    desktopIconName: "mailbox",
    title: { zh: "邮件分拣", en: "Email triage" },
    summary: {
      zh: "梳理收件箱优先级，为紧急邮件准备好回复草稿。",
      en: "Categorize and prioritize your inbox, with draft responses for urgent items.",
    },
    scheduleMeta: { zh: "工作日 07:52", en: "Weekdays at 7:52 AM" },
    prompt: {
      zh: "检查我的收件箱，按紧急程度分类未读邮件，标出需要尽快回复的事项，并为最紧急的邮件起草简明回复。",
      en: "Review my inbox, categorize unread emails by urgency, highlight items that need attention today, and prepare concise draft replies.",
    },
    schedule: { kind: "weekdays", timeOfDay: "07:52" },
  },
  {
    id: "system-health-check",
    category: "work",
    featuredInEmpty: true,
    icon: "heartBeat",
    desktopIconName: "heart-beat",
    title: { zh: "系统健康检查", en: "System health check" },
    summary: {
      zh: "巡检项目服务日志、报错信息与性能异常指标。",
      en: "Monitor infrastructure and services for errors, outages, and performance issues.",
    },
    scheduleMeta: { zh: "每天 07:47", en: "Daily at 7:47 AM" },
    prompt: {
      zh: "巡检当前项目与服务状态，排查最近 24 小时内的异常日志、失败任务或性能退化，并输出简明的健康报告。",
      en: "Inspect services and project logs for errors, outages, or performance regressions in the last 24 hours and report key findings.",
    },
    schedule: { kind: "daily", timeOfDay: "07:47" },
  },
  {
    id: "pr-review-digest",
    category: "work",
    featuredInEmpty: true,
    icon: "branch",
    desktopIconName: "branch",
    title: { zh: "PR 评审摘要", en: "PR review digest" },
    summary: {
      zh: "汇总待评审的拉取请求、CI 状态与阻塞项。",
      en: "Overview of open PRs, review status, and what needs attention.",
    },
    scheduleMeta: { zh: "工作日 07:49", en: "Weekdays at 7:49 AM" },
    prompt: {
      zh: "查看当前仓库所有打开的拉取请求，汇总评审进度、CI 检查结果以及需要我今天确认或合并的 PR。",
      en: "Summarize open pull requests, review statuses, CI checks, and highlight PRs waiting on my review or ready to merge.",
    },
    schedule: { kind: "weekdays", timeOfDay: "07:49" },
  },
  {
    id: "dependency-security-check",
    category: "work",
    featuredInEmpty: false,
    icon: "shieldCheck",
    desktopIconName: "shield-check",
    title: { zh: "依赖安全检查", en: "Dependency security check" },
    summary: {
      zh: "扫描过时依赖包、已知安全漏洞与可安全升级项。",
      en: "Scan for outdated packages, security patches, and breaking changes.",
    },
    scheduleMeta: { zh: "每周一 09:16", en: "Every Monday at 9:16 AM" },
    prompt: {
      zh: "检查项目依赖的安全公告和版本更新，列出存在风险或可安全升级的依赖，并给出升级建议。",
      en: "Scan project dependencies for security advisories and outdated packages, separating safe patch/minor updates from breaking upgrades.",
    },
    schedule: { kind: "weekly", dayOfWeek: 1, timeOfDay: "09:16" },
  },
  {
    id: "release-notes-drafter",
    category: "work",
    featuredInEmpty: false,
    icon: "note",
    desktopIconName: "page-text",
    title: { zh: "发布说明草稿", en: "Release notes drafter" },
    summary: {
      zh: "整理本周主分支合并内容，自动生成面向用户的更新说明。",
      en: "Draft user-facing release notes from recent main branch merges.",
    },
    scheduleMeta: { zh: "每周五 17:00", en: "Every Friday at 5:00 PM" },
    prompt: {
      zh: "总结本周合并到主分支的重要功能与修复，按新功能、体验优化、问题修复整理一份清晰的中文发布说明草稿。",
      en: "Summarize recent changes merged to main into clear user-facing release notes grouped by features, improvements, and fixes.",
    },
    schedule: { kind: "weekly", dayOfWeek: 5, timeOfDay: "17:00" },
  },
  {
    id: "price-alert",
    category: "life",
    featuredInEmpty: true,
    icon: "tag",
    desktopIconName: "tag",
    title: { zh: "价格提醒", en: "Price alert" },
    summary: {
      zh: "每天跟踪关注商品的价格变动，降价时及时提醒我。",
      en: "Check tracked product prices daily and notify me when they drop.",
    },
    scheduleMeta: { zh: "每天 09:00", en: "Daily at 9:00 AM" },
    prompt: {
      zh: "检查我关注清单中的商品当前价格与优惠信息；如果出现降价或达到目标价位，立即整理对比并提醒我。",
      en: "Check current prices for my tracked items and notify me with a clear comparison whenever a price drops.",
    },
    schedule: { kind: "daily", timeOfDay: "09:00" },
  },
  {
    id: "weekend-local-plans",
    category: "life",
    featuredInEmpty: true,
    icon: "calendarSparkle",
    desktopIconName: "calendar-days",
    title: { zh: "周末本地活动安排", en: "Weekend local plans" },
    summary: {
      zh: "每周四整理值得参加的本地展览、演出与周末出行灵感。",
      en: "Recommend local weekend events and activities every Thursday.",
    },
    scheduleMeta: { zh: "每周四 18:00", en: "Every Thursday at 6:00 PM" },
    prompt: {
      zh: "结合本周末的天气与本地生活资讯，为我精选 3 到 5 个值得参加的本地活动、展览或休闲去处，并附上时间与地点。",
      en: "Find 3 to 5 interesting local weekend events, exhibitions, or outdoor ideas with times, locations, and weather notes.",
    },
    schedule: { kind: "weekly", dayOfWeek: 4, timeOfDay: "18:00" },
  },
] as const;

export function localizedTemplateText(text: BilingualText, isZh: boolean): string {
  return isZh ? text.zh : text.en;
}
