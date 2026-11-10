// FILE: zhCNTasksCopy.ts
// Purpose: Simplified Chinese for the Tasks view: rows, the agent panel, hand-off and its toasts.
// Layer: Pure localization data
// Agent names, model names, folders and task titles pass through the patterns untouched.

import { phraseTranslator } from "./zhCNPhraseTable";

const TASKS_COPY: Readonly<Record<string, string>> = {
  // Rows and status
  "To do": "待办",
  List: "列表",
  "Task title": "任务标题",
  "Double-click or press F2 to rename": "双击或按 F2 重命名",
  "Add a task, or press Tab to hand it to an agent": "添加任务，或按 Tab 键交给智能体",
  "Couldn't load your tasks.": "无法加载你的任务。",
  "All done": "全部完成",
  "Add anything you need to do": "添加你要做的事",
  "Mark as done": "标记为已完成",
  "Mark as not done": "标记为未完成",
  "Waiting for your approval": "正在等你批准",
  "Asked you a question": "向你提了一个问题",
  "Needs your OK": "需要你确认",
  "Ready for you": "等你查看",
  "Chat deleted": "对话已删除",
  "Loading the chat…": "正在加载对话…",
  "The agent stopped with an error": "智能体因出错而停止",

  // Notes, due day, project and priority
  Notes: "备注",
  "Add a note": "添加备注",
  "Set a due day": "设置截止日",
  "Due day": "截止日",
  "No due date": "无截止日期",
  Tomorrow: "明天",
  "Next week": "下周",
  "Set a project": "设置项目",
  "Choose a project": "选择项目",
  "Folder…": "文件夹…",
  Urgent: "紧急",
  "No priority": "无优先级",

  // Agent panel and hand-off
  "Open chat": "打开对话",
  "More choices": "更多选项",
  "Answer in the chat": "在对话中回答",
  Unlink: "取消关联",
  "Unlink chat": "取消关联对话",
  "Delegate…": "委派…",
  "Hand it to an agent": "交给智能体",
  "Fewer options": "收起选项",
  "More options": "更多选项",
  Start: "开始",
  "The chat this task was handed to no longer exists.": "接手这个任务的对话已不存在。",

  // Toasts
  "Try again from the chat.": "请在对话中重试。",
  "Couldn't stop the agent": "无法停止智能体",
  "Couldn't confirm the agent started": "无法确认智能体已启动",
  "The connection dropped while sending. Check the chat.": "发送时连接断开了。请查看对话。",
  "Chat send in progress": "对话正在发送",
  "Wait for the current send to finish, then delegate this task again.":
    "请等当前发送结束，再重新委派这个任务。",
  "Finish delegating in the chat": "请在对话中完成委派",
  "Worktree setup runs from the chat composer.": "工作树设置要在对话输入框中运行。",
  "The chat has nothing to send yet.": "这个对话还没有可发送的内容。",
  "Couldn't start the agent": "无法启动智能体",
  "The server is not reachable.": "无法连接到服务器。",
  "Couldn't confirm the task's chat link": "无法确认任务与对话的关联",
  "No prompt was sent. Another window may have delegated this task. Check the chat before trying again.":
    "没有发送提示词。可能有其他窗口已委派这个任务。重试前请先查看对话。",
  "Couldn't unlink the task": "无法取消任务的关联",
  "The task's chat link changed": "任务关联的对话已变更",
  "The task is still linked. Check its chat before using Unlink in the task menu.":
    "任务仍处于关联状态。在任务菜单中使用“取消关联”前，请先查看它的对话。",
  "Delegation was not started. Check the task and try again.": "委派没有开始。请检查任务后重试。",
  "That chat has an unsent message": "那个对话有未发送的消息",
  "Send or clear it first, then delegate again.": "请先发送或清除它，再重新委派。",
  "Couldn't prepare a chat for that folder": "无法为那个文件夹准备对话",
  "The task could not be linked to the chat.": "无法把任务关联到对话。",
  "The agent was not started. Check the chat or unlink the task to try again.":
    "智能体没有启动。请查看对话，或取消任务关联后重试。",
  "Couldn't delegate the task": "无法委派任务",
  "Couldn't add the task": "无法添加任务",
  "Couldn't update the task": "无法更新任务",
  "Couldn't delete the task": "无法删除任务",
};

export const translateZhCnTasksCopyText = phraseTranslator(TASKS_COPY, [
  [/^(.+) is working on it$/, "$1 正在处理"],
  [/^(.+) wants to run a command$/, "$1 想运行一条命令"],
  [/^(.+) wants to read a file$/, "$1 想读取一个文件"],
  [/^(.+) wants to change a file$/, "$1 想修改一个文件"],
  [/^(.+) wants more permissions$/, "$1 需要更多权限"],
  [/^(.+) wants computer access$/, "$1 想使用电脑控制"],
  [/^(.+) wants to use a tool$/, "$1 想使用一个工具"],
  [/^(.+) asked you a question$/, "$1 向你提了一个问题"],
  [/^(.+) is waiting for your OK$/, "$1 正在等你确认"],
  [/^(.+ · .+) · in (.+)$/, "$1 · 位于 $2"],
  [/^Delegated to (.+)$/, "已委派给 $1"],
  [/^Show all (\d+) done$/, "显示全部 $1 项已完成"],
]);
