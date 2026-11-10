// FILE: zhCNConversationCopy.ts
// Purpose: Simplified Chinese for the chat screen: timeline rows, subagents, pull request repairs,
//          the file editor and the transport errors a chat can show.
// Layer: Pure localization data
// Runs after the older tables, so nothing here replaces one of their translations. Titles, models,
// branches, method names and agent text pass through the patterns untouched.

import { phraseTranslator } from "./zhCNPhraseTable";

const CONVERSATION_COPY: Readonly<Record<string, string>> = {
  // Questions and approvals
  Answer: "回答",
  Answered: "已回答",
  "Submitting…": "正在提交…",
  "Cancelling...": "正在取消…",
  Enable: "启用",

  // Timeline details
  Started: "开始时间",
  Elapsed: "已用时间",
  Progress: "进度",
  To: "到",
  Task: "任务",
  Visualization: "可视化",
  Recommended: "推荐",
  Views: "视图",
  Suggestions: "建议",
  "→ was running": "→ 之前正在运行",
  running: "运行中",
  stopped: "已停止",
  failed: "失败",

  // Pull request repairs
  Repair: "修复",
  Everything: "全部",
  Reopen: "重新打开",
  Expired: "已过期",

  // Composer and model picker
  Check: "检查",
  "Expired terminal context won't be sent": "已过期的终端上下文不会发送",
  "Expired terminal contexts won't be sent": "已过期的终端上下文不会发送",
  "Expired terminal context omitted from message": "已过期的终端上下文未包含在消息中",
  "Expired terminal contexts omitted from message": "已过期的终端上下文未包含在消息中",

  // File editor
  Editing: "正在编辑",
  Redo: "重做",
  Overwrite: "覆盖",

  // Git actions
  "Pulling...": "正在拉取…",

  // Copy buttons, named by the file or value they copy
  "Copy diagnostic ID": "复制诊断 ID",
  "Copied diagnostic ID": "已复制诊断 ID",

  // App tools dialog
  Write: "写入",
};

// `lib/fastModeState.ts` names why a requested fast mode did not start.
const FAST_MODE_BLOCKED_CAUSE: Readonly<Record<string, string>> = {
  "usage credits are turned off for this Claude account": "这个 Claude 账号已关闭用量额度",
  "this Claude plan does not include it": "这个 Claude 套餐不包含快速模式",
  "it needs a first-party Anthropic account": "需要 Anthropic 官方账号",
  "it is disabled in this environment": "这个环境已停用快速模式",
  "this model does not support it": "这个模型不支持快速模式",
  "Claude could not check its availability": "Claude 无法确认是否可用",
  "Claude reported it as unavailable": "Claude 报告它不可用",
};

const BACKGROUND_OUTCOME: Readonly<Record<string, string>> = {
  finished: "已完成",
  failed: "失败",
  stopped: "已停止",
  updated: "已更新",
  ended: "已结束",
};

const TASK_APPROVAL_FAMILY: Readonly<Record<string, string>> = { Device: "设备", Computer: "电脑" };
const TASK_APPROVAL_STATE: Readonly<Record<string, string>> = {
  "approval requested": "正在等待批准",
  approved: "已批准",
  declined: "已拒绝",
  "approval cancelled": "批准已取消",
};

// `lib/indexedDb.ts` names the store that failed; these only reach a person through an error.
const BROWSER_STORE: Readonly<Record<string, string>> = {
  "AppSnap icon cache": "应用截图图标缓存",
  "composer image database": "输入框图片数据库",
  "conversation cache": "对话缓存",
};
const BROWSER_STORE_NAME = Object.keys(BROWSER_STORE).join("|");

const TIMEOUT_ADVICE: Readonly<Record<string, string>> = {
  "Check the result before retrying; the command may have been applied.":
    "请先检查结果再重试，这条命令可能已经生效。",
  "Try again when the server responds.": "请等服务器恢复响应后再试。",
};

// These two slots hold any text, and indexing a table with "constructor" would find a function.
function ownPhrase(phrases: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(phrases, key) ? (phrases[key] ?? key) : key;
}

export const translateZhCnConversationCopyText = phraseTranslator(CONVERSATION_COPY, [
  // Questions and approvals
  [/^Answer: (.+)$/, "回答：$1"],
  [
    /^(Device|Computer) task (approval requested|approved|declined|approval cancelled)$/,
    ({ 1: family = "", 2: state = "" }) =>
      `${TASK_APPROVAL_FAMILY[family] ?? family}任务${TASK_APPROVAL_STATE[state] ?? state}`,
  ],

  // Timeline rows
  [/^failed · exit (-?\d+)$/, "失败 · 退出码 $1"],
  [/^Browser annotation (\d+): (.+), (.+)$/, "浏览器标注 $1：$2，$3"],
  [/^Review changes to (.+)$/, "查看 $1 的更改"],
  [/^Goal achieved in (.+)$/, "目标已达成，用时 $1"],
  [/^Message (\d+): ([\s\S]+)$/, "消息 $1：$2"],
  [/^Open source chat (.+)$/, "打开来源对话 $1"],
  [
    /^Resumed: “(.+)” (finished|failed|stopped|updated)(?: ·)?$/,
    ({ 0: whole = "", 1: task = "", 2: outcome = "" }) =>
      `已恢复：“${task}”${BACKGROUND_OUTCOME[outcome] ?? outcome}${whole.endsWith("·") ? " ·" : ""}`,
  ],
  [
    /^Resumed: (\d+) background tasks (finished|failed|stopped|updated|ended)(?: ·)?$/,
    ({ 0: whole = "", 1: count = "", 2: outcome = "" }) =>
      `已恢复：${count} 个后台任务${BACKGROUND_OUTCOME[outcome] ?? outcome}${whole.endsWith("·") ? " ·" : ""}`,
  ],
  [
    /^(Subagent|Background task) (finished|failed|stopped)(?:: ([\s\S]+))?$/,
    ({ 1: noun = "", 2: outcome = "", 3: detail }) => {
      const subject = noun === "Subagent" ? "子智能体" : "后台任务";
      const state = BACKGROUND_OUTCOME[outcome] ?? outcome;
      return detail ? `${subject}${state}：${detail}` : `${subject}${state}`;
    },
  ],
  [/^- hash (\S+)$/, "- 哈希 $1"],

  // Subagents
  [/^(\d+) running$/, "$1 个运行中"],
  [/^(\d+) queued$/, "$1 个排队中"],
  [/^(\d+) done$/, "$1 个已完成"],
  [/^(\d+) failed$/, "$1 个失败"],
  [/^(\d+) stopped$/, "$1 个已停止"],
  [/^(\d+) interrupted$/, "$1 个已中断"],
  [/^launched (\d+) subagents?$/, "启动了 $1 个子智能体"],
  [/^(\d+) subagents? running, show (?:it|them)$/, "$1 个子智能体正在运行，点击查看"],
  [/^Back to main thread$/, "返回主对话"],
  [/^This answer went back to (.+)$/, "这个回答已返回给 $1"],
  [/^Open parent thread (.+)$/, "打开上级对话 $1"],

  // Side chats and tabs
  [/^Open side chat (.+) \(expired\)$/, "打开侧边对话 $1（已过期）"],
  [/^Open side chat (.+)$/, "打开侧边对话 $1"],
  [/^Delete side chat "(.+)"\?$/, "删除侧边对话“$1”？"],
  [/^Delete side chat (.+)$/, "删除侧边对话 $1"],
  [/^(\d+) more tabs?$/, "还有 $1 个标签页"],
  [/^Open automation (.+)$/, "打开自动化工作流 $1"],

  // Pull request repairs
  [
    /^Paused: checks still failed after (\d+) fix attempts\. Turn it on again to retry\.$/,
    "已暂停：尝试修复 $1 次后检查仍未通过。重新开启即可重试。",
  ],
  [/^(\d+\+?) review comments?$/, "$1 条审查评论"],
  [/^Repair PR #(\d+)$/, "修复 PR #$1"],
  [/^Auto-fix CI for #(\d+)$/, "为 #$1 自动修复 CI"],
  [/^Open #(\d+) on GitHub$/, "在 GitHub 上打开 #$1"],

  // Composer and model picker
  [/^Remove (.+) from favourites$/, "从收藏中移除 $1"],
  [/^Add (.+) to favourites$/, "将 $1 加入收藏"],
  [/^Cannot switch to (.+) yet$/, "暂时无法切换到 $1"],
  [
    /^Send a message to switch to (.+) first, then choose this access mode\.$/,
    "请先发送一条消息切换到 $1，再选择这个访问模式。",
  ],
  [/^Context window (.+) tokens used$/, "已使用上下文窗口 $1 tokens"],
  [/^Context window (.+) used$/, "已使用上下文窗口 $1"],
  [
    /^Fast mode is not active: (.+)\. Requests run at standard speed\.$/,
    ({ 1: cause = "" }) =>
      `快速模式未生效：${ownPhrase(FAST_MODE_BLOCKED_CAUSE, cause)}。请求会以标准速度运行。`,
  ],
  [
    /^(.+) uses a custom local binary path in this app\. Availability will be confirmed when you start a session\.$/,
    "$1 在此应用中使用自定义本地二进制路径。开始会话时会确认是否可用。",
  ],

  // Prompt cache
  [/^Likely warm$/, "可能仍有效"],
  [/^Likely expired$/, "可能已过期"],
  [/^Observed lifetime: (.+) to (.+)$/, "观察到的有效期：$1 到 $2"],
  [/^Observed lifetime: (.+)$/, "观察到的有效期：$1"],
  [/^Last response: (.+) ago$/, "上次回复：$1前"],

  // Diffs
  [/^vs (\S+)$/, "对比 $1"],

  // Transport and browser storage errors
  [/^Unknown RPC method: (.+)$/, "未知的 RPC 方法：$1"],
  [
    /^WebSocket RPC (.+) timed out after (\d+)ms\. The server did not finish this request in time\. (.+)$/,
    ({ 1: method = "", 2: elapsed = "", 3: advice = "" }) =>
      `WebSocket RPC ${method} 等待 ${elapsed} 毫秒后超时。服务器没有及时完成这个请求。${ownPhrase(TIMEOUT_ADVICE, advice)}`,
  ],
  [/^WebSocket RPC (.+) was cancelled\.$/, "WebSocket RPC $1 已取消。"],
  [
    /^WebSocket RPC (.+) was interrupted by a transport reconnect\.$/,
    "WebSocket RPC $1 因连接重连而中断。",
  ],
  [
    new RegExp(`^Could not open the (${BROWSER_STORE_NAME})\\.$`),
    ({ 1: store = "" }) => `无法打开${BROWSER_STORE[store] ?? store}。`,
  ],
  [
    new RegExp(`^The (${BROWSER_STORE_NAME}) upgrade was blocked\\.$`),
    ({ 1: store = "" }) => `${BROWSER_STORE[store] ?? store}的升级被阻止。`,
  ],
]);
