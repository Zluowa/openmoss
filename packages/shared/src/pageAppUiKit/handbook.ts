// FILE: handbook.ts
// Purpose: Interactive Moss UI Kit Handbook and two end-to-end showcase Page App fixtures
//          (WeChat Read + Smart Meeting Room with Voice & Mossbot) verified in headless Chromium.
// Layer: Shared Page App UI Kit

import { MOSS_UI_KIT_MODULE_URLS } from "./tokens";

export interface UiKitHtmlOptions {
  readonly moduleSpecifier?: string;
  readonly cspMeta?: string;
}

function cspTag(cspMeta?: string): string {
  if (!cspMeta) return "";
  const escaped = cspMeta.replace(/"/gu, "&quot;");
  return `<meta http-equiv="Content-Security-Policy" content="${escaped}">`;
}

/** Interactive handbook demonstrating 1-3 line drop-in integration for Core Primitives, Voice, and Feature Widgets. */
export function buildMossUiKitHandbookHtml(options: UiKitHtmlOptions = {}): string {
  const mod = options.moduleSpecifier ?? MOSS_UI_KIT_MODULE_URLS[0];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${cspTag(options.cspMeta)}
  <title>Moss 原生 UI 套件使用手册</title>
  <script id="moss-app-manifest" type="application/json">
{
  "title": "Moss 原生 UI 套件手册",
  "description": "非侵入式可插拔 Shadow DOM 原生组件库交互手册",
  "capabilities": {
    "ai": {},
    "chat": {},
    "mossbot": {},
    "voice": {},
    "media": {}
  }
}
  </script>
  <style>
    :root {
      color-scheme: light dark;
      --hb-bg: #fcfcfb;
      --hb-surface: #f4f3ef;
      --hb-ink: #141413;
      --hb-ink-2: rgba(20, 20, 19, 0.62);
      --hb-border: rgba(20, 20, 19, 0.10);
    }
    [data-theme="dark"] {
      --hb-bg: #1c1c1b;
      --hb-surface: #1a1a19;
      --hb-ink: #f0efec;
      --hb-ink-2: rgba(240, 239, 236, 0.62);
      --hb-border: rgba(240, 239, 236, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", sans-serif;
      background: var(--hb-bg);
      color: var(--hb-ink);
      line-height: 1.6;
    }
    .layout {
      max-width: 1120px;
      margin: 0 auto;
      padding: 24px 20px 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 20px;
      align-items: start;
    }
    .header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--hb-border);
    }
    .header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 500;
    }
    .header p {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--hb-ink-2);
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .code {
      margin: 8px 0 12px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--hb-border);
      background: var(--hb-bg);
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
    }
    .sample-prose {
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--hb-border);
      background: var(--hb-bg);
      user-select: text;
    }
  </style>
</head>
<body>
  <div class="layout">
    <header class="header">
      <div>
        <h1>Moss 原生 UI 套件手册</h1>
        <p>核心基础原语、原生语音控件与能力组件均封装于 Shadow DOM，隔离宿主样式，1–3 行即插即用。</p>
      </div>
      <div class="row">
        <moss-badge variant="success" label="v1.0.0 · 14 组件"></moss-badge>
        <moss-button id="btn-theme-toggle" size="sm" label="切换深色 / 浅色主题"></moss-button>
      </div>
    </header>

    <main class="stack">
      <moss-card title="1. Moss 核心基础原语" subtitle="Button · Card · Tabs · Badge · Toast · Dialog · Drawer · Markdown">
        <div class="code">import { registerMossUIKit, MossToast } from "moss-ui-kit";</div>
        <div class="row" style="margin-bottom: 10px;">
          <moss-button variant="primary" size="sm" id="btn-demo-toast" label="触发 MossToast"></moss-button>
          <moss-button size="sm" id="btn-demo-dialog" label="打开 MossDialog"></moss-button>
          <moss-badge variant="accent" label="Accent"></moss-badge>
          <moss-badge variant="warn" label="Notice"></moss-badge>
        </div>
        <moss-tabs id="handbook-tabs"></moss-tabs>
        <moss-markdown content="### Markdown 渲染器&#10;- 支持 **粗体**、\`行内代码\` 与代码块，零 innerHTML 注入风险。"></moss-markdown>
      </moss-card>

      <moss-card title="2. 划线提问与伴读抽屉" subtitle="MossSelectionAsk + MossCompanionDrawer">
        <div class="code">&lt;moss-selection-ask target="#handbook-prose" drawer="#handbook-drawer"&gt;&lt;/moss-selection-ask&gt;</div>
        <div id="handbook-prose" class="sample-prose">
          <p id="handbook-p1">良好的界面秩序来自克制：同一组圆角、同一张暖纸底色与清晰的信息层级，让工具退居内容之后。</p>
        </div>
      </moss-card>

      <moss-card title="3. 原生语音与会议协同" subtitle="MossVoiceButton + MossRealtimeVoiceBar + MossbotMeetingBar">
        <div class="code">&lt;moss-voice-button mode="dictate"&gt;&lt;/moss-voice-button&gt;
&lt;moss-realtime-voice-bar topic="架构同步"&gt;&lt;/moss-realtime-voice-bar&gt;
&lt;moss-bot-meeting-bar meeting-title="周度架构评审"&gt;&lt;/moss-bot-meeting-bar&gt;</div>
        <div class="stack">
          <div class="row">
            <moss-voice-button id="handbook-voice-dictate" mode="dictate"></moss-voice-button>
            <moss-voice-button id="handbook-voice-speak" mode="speak" text="Moss 原生语音组件已准备就绪。"></moss-voice-button>
          </div>
          <moss-realtime-voice-bar id="handbook-realtime-voice" topic="架构同步"></moss-realtime-voice-bar>
          <moss-bot-meeting-bar id="handbook-meeting" meeting-title="周度架构评审"></moss-bot-meeting-bar>
        </div>
      </moss-card>

      <moss-card title="4. 内联媒体生成触发器" subtitle="MossMediaTrigger">
        <moss-media-trigger id="handbook-media" kind="image" prompt="极简暖白书房插画"></moss-media-trigger>
      </moss-card>
    </main>

    <aside style="height: 560px;">
      <moss-companion-drawer id="handbook-drawer" title="Moss 伴读助手" app-title="UI 套件手册"></moss-companion-drawer>
    </aside>
  </div>

  <moss-dialog id="handbook-dialog" title="Moss 原生弹窗" description="基于 Shadow DOM 隔离渲染，支持 Esc 与遮罩关闭。">
    <moss-button slot="footer" variant="primary" size="sm" id="btn-close-dialog" label="知道了"></moss-button>
  </moss-dialog>

  <moss-selection-ask id="handbook-ask" target="#handbook-prose" drawer="#handbook-drawer" app-title="UI 套件手册"></moss-selection-ask>

  <script type="module">
    import { registerMossUIKit, MossToast } from ${JSON.stringify(mod)};
    registerMossUIKit();
    var root = document.documentElement;
    document.getElementById("btn-theme-toggle").addEventListener("click", function () {
      var dark = root.getAttribute("data-theme") === "dark";
      if (dark) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", "dark");
    });
    document.getElementById("handbook-tabs").setTabs([
      { id: "overview", label: "概览", content: "14 个开箱即用原生组件，完全隔离宿主 CSS。" },
      { id: "tokens", label: "设计令牌", content: "自动适配 --moss-paper / --moss-ink 明暗双主题。" }
    ], "overview");
    document.getElementById("btn-demo-toast").addEventListener("click", function () {
      MossToast.show("Moss 轻提示已触发", { variant: "success" });
    });
    var dialog = document.getElementById("handbook-dialog");
    document.getElementById("btn-demo-dialog").addEventListener("click", function () {
      dialog.show();
    });
    document.getElementById("btn-close-dialog").addEventListener("click", function () {
      dialog.close();
    });
  </script>
</body>
</html>`;
}

/** Fixture 1: 微信阅读 + 非侵入式划线提问 / 伴读抽屉 (strict CSS isolation proof). */
export function buildWechatReadUiKitFixtureHtml(options: UiKitHtmlOptions = {}): string {
  const mod = options.moduleSpecifier ?? MOSS_UI_KIT_MODULE_URLS[0];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${cspTag(options.cspMeta)}
  <title>微信阅读 · 非侵入式伴读示例</title>
  <script id="moss-app-manifest" type="application/json">
{
  "title": "微信阅读",
  "description": "宿主羊皮纸阅读版式 + 非侵入式 Moss 原生划线提问与伴读抽屉",
  "capabilities": {
    "chat": {},
    "ai": {},
    "db": {}
  }
}
  </script>
  <style>
    /* Deliberately opinionated host styles to prove Shadow DOM bidirectional style isolation */
    body {
      margin: 0;
      background-color: rgb(244, 236, 216);
      color: rgb(56, 43, 28);
      font-family: Georgia, "Songti SC", serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    button {
      border: 3px dashed rgb(180, 83, 9);
      background: rgb(254, 243, 199);
      color: rgb(120, 53, 15);
      border-radius: 2px;
      padding: 6px 14px;
      font-size: 15px;
    }
    .reader-main {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      padding: 36px 42px;
    }
    .book-title {
      margin: 0 0 18px;
      font-size: 26px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    #book-body p {
      font-size: 18px;
      line-height: 1.9;
      margin: 0 0 18px;
    }
    .host-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(56, 43, 28, 0.16);
    }
    .drawer-host {
      height: 100%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <main class="reader-main">
    <div class="host-toolbar">
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="host-book-meta">《设计的克制》· 第一章</span>
        <moss-badge id="wechat-sync-badge" variant="success" label="伴读就绪"></moss-badge>
      </div>
      <button type="button" id="host-bookmark-btn">宿主页签按钮</button>
    </div>
    <article id="book-body">
      <h1 class="book-title">第一章 · 纸面与留白</h1>
      <p id="para-1">真正的工具应当像空气一样存在：当读者专注于文字脉络时，界面只提供恰如其分的边界与质感，从不喧宾夺主。</p>
      <p id="para-2">通过 Shadow DOM 与局部设计令牌隔离，任何第三方阅读应用都能以零样式污染接入划线批注与 AI 伴读能力。</p>
    </article>
  </main>

  <aside class="drawer-host">
    <moss-companion-drawer id="wechat-drawer" title="Moss 伴读" app-title="微信阅读"></moss-companion-drawer>
  </aside>

  <moss-selection-ask id="wechat-selection-ask" target="#book-body" drawer="#wechat-drawer" app-title="微信阅读"></moss-selection-ask>

  <script type="module">
    import { registerMossUIKit, MossToast } from ${JSON.stringify(mod)};
    registerMossUIKit();
    window.__wechatKitStats = { highlights: [], asks: [] };
    var askEl = document.getElementById("wechat-selection-ask");
    askEl.addEventListener("moss-highlight", function (ev) {
      window.__wechatKitStats.highlights.push(ev.detail);
      MossToast.show("已添加划线", { variant: "success" });
    });
    document.getElementById("wechat-drawer").addEventListener("moss-drawer-reply", function (ev) {
      window.__wechatKitStats.asks.push(ev.detail);
    });
  </script>
</body>
</html>`;
}

/** Fixture 2: 智能会议室 + 原生语音控件 + 可插拔 Mossbot 控制条 + 媒体配图触发器. */
export function buildMeetingRoomUiKitFixtureHtml(options: UiKitHtmlOptions = {}): string {
  const mod = options.moduleSpecifier ?? MOSS_UI_KIT_MODULE_URLS[0];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${cspTag(options.cspMeta)}
  <title>智能会议室 · Moss 语音与 Mossbot 协同示例</title>
  <script id="moss-app-manifest" type="application/json">
{
  "title": "智能会议室",
  "description": "接入 Moss 原生语音、Mossbot 控制条与会议视觉纪要配图触发器",
  "capabilities": {
    "mossbot": {},
    "voice": {},
    "media": {},
    "chat": {},
    "ai": {}
  }
}
  </script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f5f7fa;
      color: #16181d;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", sans-serif;
    }
    .room-shell {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .room-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .room-head h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 500;
    }
    .voice-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .transcript-box {
      padding: 16px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid rgba(22, 24, 29, 0.08);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .line {
      font-size: 14px;
      line-height: 22px;
    }
    .participant-name {
      font-weight: 500;
      margin-right: 8px;
    }
  </style>
</head>
<body>
  <div class="room-shell">
    <header class="room-head">
      <h1>Q4 产品路线图评审会议</h1>
      <div class="voice-row">
        <moss-badge id="room-live-badge" variant="accent" label="3 位参会者 · 实时记录"></moss-badge>
        <moss-voice-button id="meeting-voice-btn" mode="dictate" label="语音速记"></moss-voice-button>
      </div>
    </header>

    <moss-realtime-voice-bar id="meeting-realtime-voice" topic="Q4 产品路线图评审"></moss-realtime-voice-bar>

    <moss-bot-meeting-bar id="meeting-bar" meeting-id="room-q4-plan" meeting-title="Q4 产品路线图评审"></moss-bot-meeting-bar>

    <section class="transcript-box" id="meeting-transcript">
      <div class="line"><span class="participant-name">林溪：</span>本周优先落地非侵入式 UI 套件，保证所有第三方应用页零污染接入 Moss 能力。</div>
      <div class="line"><span class="participant-name">陈默：</span>会议室场景需要一键拉 Mossbot 入场、开启实时语音并生成结构化结论和待办。</div>
      <div class="line"><span class="participant-name">苏安：</span>会后纪要如果能直接朗读播报并配图，会更方便同步给团队。</div>
    </section>

    <moss-media-trigger id="meeting-media" kind="image" prompt="Q4 产品路线图清爽架构示意图"></moss-media-trigger>
  </div>

  <script type="module">
    import { registerMossUIKit } from ${JSON.stringify(mod)};
    registerMossUIKit();
    var transcriptBox = document.getElementById("meeting-transcript");
    var bar = document.getElementById("meeting-bar");
    var rtBar = document.getElementById("meeting-realtime-voice");
    var voiceBtn = document.getElementById("meeting-voice-btn");
    var lastSummary = "";

    bar.configure({
      getTranscript: function () {
        return transcriptBox.innerText;
      },
      onSummary: function (outcome) {
        lastSummary = outcome.summary || "";
      }
    });

    rtBar.configure({
      getContext: function () { return transcriptBox.innerText; },
      getSummaryText: function () { return lastSummary || transcriptBox.innerText; }
    });

    voiceBtn.addEventListener("moss-voice-transcript", function (ev) {
      var text = ev.detail && ev.detail.text;
      if (!text) return;
      var line = document.createElement("div");
      line.className = "line";
      var who = document.createElement("span");
      who.className = "participant-name";
      who.textContent = "语音速记：";
      line.appendChild(who);
      line.appendChild(document.createTextNode(text));
      transcriptBox.appendChild(line);
    });
  </script>
</body>
</html>`;
}
