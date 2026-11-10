// FILE: zhCNSidebarInboxCopy.ts
// Purpose: Simplified Chinese for the sidebar's menus and toasts, the search palette, the inbox and
//          the smaller app-wide surfaces around them: plugins and worktree cleanup.
// Layer: Pure localization data
// Project, thread, branch, plugin and model names pass through the patterns untouched.

import { phraseTranslator } from "./zhCNPhraseTable";

const SLOT: Readonly<Record<string, string>> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
};

const SIDEBAR_INBOX_COPY: Readonly<Record<string, string>> = {
  // Inbox
  Morning: "上午",
  Afternoon: "下午",
  Evening: "晚上",
  ", now": "，现在",
  "same as yesterday": "与昨天相同",
  ", approve a command": "，需要批准命令",
  ", has a question": "，有一个问题",
  ", plan ready": "，计划已就绪",
  ", turn failed": "，这一轮失败了",

  // Sidebar navigation and search palette
  "Quick actions": "快捷操作",
  Explore: "探索",
  "Explore destinations": "探索目的地",
  "Unpin from sidebar": "从侧边栏取消固定",
  "Pin to sidebar": "固定到侧边栏",
  Features: "功能",

  // Relative times written without a locale
  now: "刚刚",

  // Snoozed chats
  "Returning…": "即将恢复…",
  "Less than a minute left": "还剩不到 1 分钟",

  // Project appearance, time picker and canvas
  Emoji: "表情符号",
  Icons: "图标",
  Hour: "小时",
  Minute: "分钟",
  "Projects · tldraw": "项目 · tldraw",

  // Email verification
  "Moss sent a verification link. Open it on this device, then return to sign in.":
    "Moss 已发送验证链接。请在此设备上打开链接，然后返回登录。",
};

function snoozeRemaining(value: string): string {
  return value
    .replace(/\bdays?\b/, "天")
    .replace("hr", "小时")
    .replace("min", "分钟");
}

export const translateZhCnSidebarInboxCopyText = phraseTranslator(SIDEBAR_INBOX_COPY, [
  // Inbox stories
  [
    /^(.+) (more|less|fewer) than this time yesterday$/,
    ({ 1: amount = "", 2: direction = "" }) =>
      `比昨天此时${direction === "more" ? "多" : "少"} ${amount}`,
  ],
  [
    /^Mostly (morning|afternoon|evening)(?:, (\d+) failed)?$/,
    ({ 1: slot = "", 2: failed }) =>
      `主要集中在${SLOT[slot] ?? slot}${failed ? `，${failed} 轮失败` : ""}`,
  ],
  [/^(\d+) prompts?, mostly (.+)$/, "$1 条提示词，主要使用 $2"],
  [/^(\d+) turns?, mostly (.+)$/, "$1 轮，主要使用 $2"],
  [/^Mostly (.+)$/, "主要使用 $1"],
  [/^(\S+) pull requests? to review$/, "$1 个拉取请求待审查"],
  [/^(\S+) automation runs? to check$/, "$1 次自动化运行待查看"],

  // Thread menus
  [/^(.+) in this thread$/, "在当前对话中交接给 $1"],
  [/^(.+) in a new thread$/, "在新对话中交接给 $1"],
  [/^More actions for (.+)$/, "$1 的更多操作"],
  [/^Move (.+) up$/, "上移 $1"],
  [/^Move (.+) down$/, "下移 $1"],

  // Hubs and folders
  [/^(.+) was created, but the project was not moved$/, "已创建 $1，但项目没有移动"],
  [/^Make (.+) primary$/, "将 $1 设为主文件夹"],

  // Worktree cleanup
  [
    /^(.+) could not be removed safely\. Check its task, Git status, or connection\.$/,
    "无法安全移除 $1。请检查它的任务、Git 状态或连接。",
  ],
  [
    /^(.+) was deleted\. Its branch remains available for recovery\.$/,
    "已删除 $1。它的分支仍然保留，可用于恢复。",
  ],

  // Snoozed chats
  [
    /^(\d+ (?:days?|hr|min)(?: \d+ (?:hr|min))?) left$/,
    ({ 1: span = "" }) => `还剩 ${snoozeRemaining(span)}`,
  ],

  // Plugins
  [/^(.+) app enabled$/, "已启用 $1 应用"],
  [/^(.+) app disabled$/, "已停用 $1 应用"],
  [/^Could not remove (.+)$/, "无法移除 $1"],
  [/^Could not upgrade (.+)$/, "无法升级 $1"],
  [/^Upgraded (.+)$/, "已升级 $1"],

  // Email verification
  [
    /^Moss sent a verification link to (\S+)\. Open it on this device, then return to sign in\.$/,
    "Moss 已将验证链接发送到 $1。请在此设备上打开链接，然后返回登录。",
  ],
]);
