// FILE: catalog.ts
// Purpose: Declarative component catalog and copy-paste recipes for Moss UI Kit
//          so `moss-developer` and AI Page App authors assemble native UI cleanly.
// Layer: Shared Page App UI Kit

import { MOSS_UI_KIT_CLASSIC_URLS, MOSS_UI_KIT_MODULE_URLS, MOSS_UI_KIT_VERSION } from "./tokens";

export interface MossUiKitCatalogEntry {
  readonly name: string;
  readonly tag: string;
  readonly mountHelper: string;
  readonly category: "primitive" | "voice" | "feature";
  readonly capability: "none" | "chat" | "ai" | "mossbot" | "voice" | "media";
  readonly description: string;
  readonly snippet: string;
}

export const MOSS_UI_KIT_CATALOG: readonly MossUiKitCatalogEntry[] = [
  {
    name: "MossButton",
    tag: "moss-button",
    mountHelper: "mountButton",
    category: "primitive",
    capability: "none",
    description: "标准高度与语义变体按钮（primary/secondary/ghost/destructive）",
    snippet: '<moss-button variant="primary" label="保存设置"></moss-button>',
  },
  {
    name: "MossCard",
    tag: "moss-card",
    mountHelper: "mountCard",
    category: "primitive",
    capability: "none",
    description: "暖白/暖黑 12px 圆角与 1px 细线卡片容器",
    snippet: '<moss-card title="项目概览" subtitle="最近更新"></moss-card>',
  },
  {
    name: "MossTabs",
    tag: "moss-tabs",
    mountHelper: "mountTabs",
    category: "primitive",
    capability: "none",
    description: "克制切换栏与面板容器（监听 moss-tab-change）",
    snippet:
      '<moss-tabs tabs=\'[{"id":"notes","label":"笔记"},{"id":"ai","label":"伴读"}]\'></moss-tabs>',
  },
  {
    name: "MossDrawer",
    tag: "moss-drawer",
    mountHelper: "mountDrawer",
    category: "primitive",
    capability: "none",
    description: "可折叠侧边抽屉面板",
    snippet: '<moss-drawer title="详情侧栏">内容区</moss-drawer>',
  },
  {
    name: "MossDialog",
    tag: "moss-dialog",
    mountHelper: "mountDialog",
    category: "primitive",
    capability: "none",
    description: "带 Esc 与遮罩关闭的无障碍弹窗",
    snippet: '<moss-dialog title="确认操作" description="操作后可随时在权限里更改"></moss-dialog>',
  },
  {
    name: "MossBadge",
    tag: "moss-badge",
    mountHelper: "mountBadge",
    category: "primitive",
    capability: "none",
    description: "8% 浅底同色语义徽标（neutral/accent/success/warn/danger）",
    snippet: '<moss-badge variant="success" label="已同步"></moss-badge>',
  },
  {
    name: "MossToast",
    tag: "moss-toast",
    mountHelper: "MossToast.show",
    category: "primitive",
    capability: "none",
    description: "右下角克制轻提示条（支持 MossToast.show）",
    snippet: 'MossToast.show("已保存批注", { variant: "success" });',
  },
  {
    name: "MossMarkdown",
    tag: "moss-markdown",
    mountHelper: "mountMarkdown",
    category: "primitive",
    capability: "none",
    description: "纯 DOM 安全的 Markdown 正文与代码块渲染器",
    snippet: '<moss-markdown content="## 本章小结\\n- 重点结论"></moss-markdown>',
  },
  {
    name: "MossVoiceButton",
    tag: "moss-voice-button",
    mountHelper: "mountVoiceButton",
    category: "voice",
    capability: "voice",
    description: "对齐聊天麦克风与朗读按钮的语音转文字 / TTS 控件",
    snippet: '<moss-voice-button mode="dictate"></moss-voice-button>',
  },
  {
    name: "MossRealtimeVoiceBar",
    tag: "moss-realtime-voice-bar",
    mountHelper: "mountRealtimeVoiceBar",
    category: "voice",
    capability: "voice",
    description: "带实时声波条与计时的 Moss 实时语音控制条",
    snippet: '<moss-realtime-voice-bar topic="产品评审"></moss-realtime-voice-bar>',
  },
  {
    name: "MossSelectionAsk",
    tag: "moss-selection-ask",
    mountHelper: "mountSelectionAsk",
    category: "feature",
    capability: "chat",
    description: "划词三色高亮与「划线提问 / 问 Moss」悬浮操作条",
    snippet: '<moss-selection-ask target="#article" drawer="#reader-drawer"></moss-selection-ask>',
  },
  {
    name: "MossCompanionDrawer",
    tag: "moss-companion-drawer",
    mountHelper: "mountCompanionDrawer",
    category: "feature",
    capability: "chat",
    description: "流式伴读与上下文追问侧栏抽屉",
    snippet: '<moss-companion-drawer id="reader-drawer" title="Moss 伴读"></moss-companion-drawer>',
  },
  {
    name: "MossbotMeetingBar",
    tag: "moss-bot-meeting-bar",
    mountHelper: "mountMossbotMeetingBar",
    category: "feature",
    capability: "mossbot",
    description: "一键拉 Moss 加入会议、会中提问与生成结构化纪要",
    snippet: '<moss-bot-meeting-bar meeting-title="周会同步"></moss-bot-meeting-bar>',
  },
  {
    name: "MossMediaTrigger",
    tag: "moss-media-trigger",
    mountHelper: "mountMediaTrigger",
    category: "feature",
    capability: "media",
    description: "内联配图与短视频生成触发及预览器",
    snippet: '<moss-media-trigger kind="image" prompt="极简架构示意图"></moss-media-trigger>',
  },
] as const;

export const MOSS_UI_KIT_RECIPES = {
  version: MOSS_UI_KIT_VERSION,
  esmImport: `import { registerMossUIKit, MossToast } from "${MOSS_UI_KIT_MODULE_URLS[0]}";\nregisterMossUIKit();`,
  esmCdnImport: `import { registerMossUIKit } from "${MOSS_UI_KIT_MODULE_URLS[1]}";\nregisterMossUIKit();`,
  classicScript: `<script src="${MOSS_UI_KIT_CLASSIC_URLS[0]}"></script>`,
  wechatReadCombo: `<moss-companion-drawer id="drawer" title="Moss 伴读"></moss-companion-drawer>\n<moss-selection-ask target="#book-body" drawer="#drawer"></moss-selection-ask>`,
  meetingRoomCombo: `<moss-realtime-voice-bar topic="产品规划会"></moss-realtime-voice-bar>\n<moss-bot-meeting-bar meeting-title="产品规划会"></moss-bot-meeting-bar>\n<moss-media-trigger kind="image" prompt="会议重点架构图"></moss-media-trigger>`,
} as const;
