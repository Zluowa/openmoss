// FILE: zhCNComposerCommandsCopy.ts
// Purpose: Simplified Chinese for what composer slash commands report, and the computer, compaction
//          and unblock flows they share a toast with.
// Layer: Pure localization data
// Commands such as `/side` stay literal inside the sentences.

import { phraseTranslator } from "./zhCNPhraseTable";

const COMPOSER_COMMANDS_COPY: Readonly<Record<string, string>> = {
  // /fast, /goal and /rename
  "Fast mode is on": "快速模式已开启",
  "Fast mode is off": "快速模式已关闭",
  "Open a thread before setting a goal.": "设置目标前请先打开一个对话。",
  "An error occurred while updating the goal.": "更新目标时出错。",
  "Could not pause the thread goal": "无法暂停对话目标",
  "Could not resume the thread goal": "无法恢复对话目标",
  "No thread goal is set": "还没有设置对话目标",
  "Thread goal paused": "对话目标已暂停",
  "Thread goal resumed": "对话目标已恢复",
  "Rename is unavailable": "无法重命名",
  "Open a thread before renaming it.": "重命名前请先打开一个对话。",
  "Nothing to rename yet": "还没有可重命名的内容",
  "Send a message before generating a thread title.": "生成对话标题前请先发送一条消息。",
  "Newer thread title kept": "已保留较新的对话标题",
  "The generated title was discarded because the title changed.":
    "标题已更改，所以生成的标题被丢弃了。",
  "Could not rename thread": "无法重命名对话",
  "An error occurred while renaming the thread.": "重命名对话时出错。",

  // /side and forks
  "Side chat started without the prompt": "侧边对话已开始，但没有带上提示词",
  "The side chat is open. Send the prompt again when it finishes loading.":
    "侧边对话已打开。加载完成后请再次发送提示词。",
  "The fork succeeded and will appear as soon as the thread list refreshes.":
    "分支已创建，对话列表刷新后就会显示。",
  "Side chat prompt was not sent": "侧边对话的提示词没有发送",
  "Remove composer attachments or context before using /side.":
    "使用 /side 前，请先移除输入框中的附件或上下文。",
  "Enable and sign in to that provider, then run /side again.":
    "请启用并登录那个服务商，然后再次运行 /side。",

  // /computer-use and computer control
  "Add a task after /computer-use": "请在 /computer-use 后面写上任务",
  "For example: /computer-use open Calculator and calculate 123 × 45.":
    "例如：/computer-use 打开计算器并计算 123 × 45。",
  "Computer control was reset": "电脑控制已重置",
  "Control was reset — invoke /computer-use again for a new task.":
    "控制已重置。如有新任务，请再次调用 /computer-use。",
  "Computer control could not be changed": "无法更改电脑控制",
  "Setting up computer control": "正在设置电脑控制",
  "Setting up the desktop may require installing a helper or allowing the permissions Moss needs.":
    "设置桌面可能需要安装辅助程序，或授予 Moss 所需的权限。",
  "Computer control is ready": "电脑控制已就绪",
  "Computer control still needs setup": "电脑控制仍需设置",
  "Couldn't set up computer control": "无法设置电脑控制",
  "The computer frame could not be decoded.": "无法解码电脑画面。",
  "The computer stream sent a frame Moss could not read.": "电脑画面发来了 Moss 无法读取的帧。",
  "The computer stream disconnected.": "电脑画面已断开。",
  "Check a desktop Space operation": "检查桌面空间操作",
  "Asked to show Computer on screen": "已请求在屏幕上显示电脑控制",
  "Computer allowed on screen": "已允许在屏幕上显示电脑控制",
  "Computer kept in the background": "电脑控制保持在后台",
  "On-screen request cancelled": "屏幕显示请求已取消",

  // Compaction and unblock
  "Could not request compaction": "无法请求压缩",
  "Could not confirm compaction": "无法确认压缩",
  "Retry to confirm the same request. A second compaction will not be created.":
    "请重试以确认同一个请求，不会再创建一次压缩。",
  "Could not unblock thread": "无法解除对话阻塞",
  "An unexpected error occurred while clearing the provider failure.":
    "清除服务商故障时发生意外错误。",
  "Messages skipped while it was blocked were retried. Resend your last message if the thread stays idle.":
    "阻塞期间跳过的消息已重试。如果对话仍然没有动静，请重新发送你的上一条消息。",
  "Blocker already cleared": "阻塞已解除",
  "Another session settled the failure. Resend your last message to continue.":
    "另一个会话已处理这个故障。请重新发送你的上一条消息以继续。",
  "No provider failure is holding it back. Resend your last message to continue.":
    "没有服务商故障阻塞它。请重新发送你的上一条消息以继续。",

  // Fast mode state and attachments
  "Fast paused": "快速模式已暂停",
  "Fast mode is paused after a rate limit. Requests run at standard speed for now.":
    "因达到速率限制，快速模式已暂停。请求暂时以标准速度运行。",
  "Fast unavailable": "快速模式不可用",
  "Could not restore saved images. Open the chat to retry or remove them before sending.":
    "无法恢复已保存的图片。请打开对话重试，或在发送前移除它们。",
  "Image optimization failed.": "图片优化失败。",
};

export const translateZhCnComposerCommandsCopyText = phraseTranslator(COMPOSER_COMMANDS_COPY, [
  [/^Keep the goal within ([\d,]+) characters\.$/, "目标不能超过 $1 个字符。"],
  [/^(.+) is unavailable for Side$/, "$1 无法用于侧边对话"],
]);
