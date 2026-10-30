// FILE: zhCNRealtimeVoice.test.ts
// Purpose: Locks build 6119 Realtime Voice presentation copy without translating runtime data.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("Simplified Chinese Realtime Voice presentation", () => {
  it.each([
    ["Meet Moss Voice", "认识 Moss 语音"],
    ["Work across projects", "跨项目工作"],
    [
      "Start new tasks, coordinate work in progress, and pick up where you left off—without micromanaging",
      "开启新任务、协调进行中的工作，并从上次停下的地方继续——无需事事盯着",
    ],
    ["Work across your desktop", "在整个桌面上工作"],
    [
      "Use your files, apps, and connected tools—from Slack and GitHub to Notion and beyond",
      "使用你的文件、应用和已连接的工具——从 Slack、GitHub 到 Notion 等",
    ],
    ["Explore, plan, and learn", "探索、规划和学习"],
    [
      "Talk through a PR, ask questions about a codebase, or learn a new topic through natural back-and-forth",
      "讨论 PR、询问代码库相关问题，或通过自然的来回交流学习新主题",
    ],
    ["Bring your screen into the conversation", "让你的屏幕加入对话"],
    [
      "Appshots let Moss use the active window’s image and text when you ask about what’s on screen.",
      "当你询问屏幕上的内容时，Appshots 可让 Moss 使用当前窗口的图像和文本。",
    ],
    ["Use Appshots", "使用 Appshots"],
    ["You can turn this off anytime in Settings", "你随时可在“设置”中将其关闭"],
    ["Saving Appshots preference", "正在保存 Appshots 偏好设置"],
    ["Appshots couldn’t be updated", "无法更新 Appshots"],
    ["Appshots aren’t available on this device", "此设备不支持 Appshots"],
    ["Set up voice chat", "设置语音聊天"],
    ["Close voice chat setup", "关闭语音聊天设置"],
    ["Choose your voice", "选择你的语音"],
    ["You can change this anytime in Settings", "你随时可在“设置”中对此进行更改"],
    ["Start voice chat", "开启语音聊天"],
    ["Starting voice chat", "正在开启语音聊天"],
    ["Voice chat couldn’t start", "无法开启语音聊天"],
    ["Try again, or go back", "重试，或返回"],
    ["Try again", "重试"],
    ["Try Moss Voice", "试试 Moss 语音"],
    ["Orchestrate tasks, connect tools, and explore code", "编排任务，连接工具，探索代码"],
    ["Start Voice", "开始语音"],
    ["Dismiss voice chat banner", "关闭语音聊天横幅"],
    ["No compatible voices are available", "没有可用的兼容语音"],
    ["Previous voice", "上一个语音"],
    ["Next voice", "下一个语音"],
    ["Choose a voice", "选择语音"],
    ["Unable to load voice settings", "无法加载语音设置"],
    ["Unable to save voice", "无法保存语音"],
    ["Realtime Voice controls", "语音聊天控制项"],
    ["Move voice chat to floating overlay", "将语音聊天移到浮动窗口"],
    ["Mute microphone", "将麦克风静音"],
    ["Unmute microphone", "取消麦克风静音"],
    ["Mute voice output", "将语音输出静音"],
    ["Unmute voice output", "取消语音输出静音"],
    ["End voice chat", "结束语音聊天"],
    ["Preparing voice chat", "正在准备语音聊天"],
    ["Connecting voice chat", "正在连接语音聊天"],
    ["Ending voice chat", "正在结束语音聊天"],
    ["Speaking", "正在说话"],
    ["Thinking", "思考中"],
    ["Listening", "正在聆听"],
  ] as const)("translates build 6119 voice chrome: %s", (source, expected) => {
    expect(translateZhCnPresentationText(source)).toBe(expected);
  });

  it.each([
    ["Maple: Cheerful and candid", "Maple：开朗而直率"],
    ["Selected voice: Sol. Savvy and relaxed", "已选择语音：Sol。聪慧而从容"],
    ["Replay Maple preview", "重播 Maple 预览"],
    ["Retry Arbor preview", "重试 Arbor 预览"],
    ["Play Vale preview", "播放 Vale 预览"],
    ["Pause Spruce preview", "暂停 Spruce 试听"],
    ["Cove preview loading", "正在加载 Cove 预览"],
    ["Ember preview unavailable", "Ember 预览不可用"],
  ] as const)(
    "localizes voice-picker chrome while preserving the voice name: %s",
    (source, expected) => {
      expect(translateZhCnPresentationText(source)).toBe(expected);
    },
  );

  it.each([
    "Maple",
    "gpt-realtime-2.1",
    "Voice chat took too long to start",
    "The provider returned an unknown session error",
    "请让 Maple 帮我继续这个任务",
  ])("does not rewrite voice names, models, runtime errors, or user content: %s", (value) => {
    expect(translateZhCnPresentationText(value)).toBe(value);
  });
});
