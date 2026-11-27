// FILE: mossDeveloperPlugin.ts
// Purpose: The "Moss 开发者" (`moss-developer`) official built-in, uninstallable
//          app-builder plugin (`moss-bundled`). Combines ChatGPT App Builder
//          product craft, Google AI Studio zero-friction one-sentence creation,
//          Moss's zero-key native runtime (`db`, `ai`, `media`, `voice`, `chat`,
//          `mossbot`, `desktop`, `files`, `downloads`), default-composed
//          `moss-ui-kit` core primitives & pluggable native widgets, and
//          Personal Moss Developer API Keys when building outside the sandbox.
// Layer: Shared pure data (no Node/DOM/React imports; shared across server, web, and mobile).

export const MOSS_DEVELOPER_PLUGIN_NAME = "moss-developer";
export const MOSS_DEVELOPER_MARKETPLACE_NAME = "moss-bundled";
export const MOSS_DEVELOPER_PLUGIN_ID = `${MOSS_DEVELOPER_PLUGIN_NAME}@${MOSS_DEVELOPER_MARKETPLACE_NAME}`;
export const MOSS_DEVELOPER_SKILL_NAME = "moss-developer";
export const MOSS_DEVELOPER_SKILL_MARKER = "<!-- moss-official-plugin:moss-developer -->";

export interface MossDeveloperStarterPromptSpec {
  readonly id: string;
  readonly label: { readonly en: string; readonly zhCN: string };
  readonly prompt: { readonly en: string; readonly zhCN: string };
}

export const MOSS_DEVELOPER_STARTER_PROMPTS: readonly MossDeveloperStarterPromptSpec[] = [
  {
    id: "ai-reader",
    label: { en: "AI Companion Reader", zhCN: "做个 AI 伴读阅读器" },
    prompt: {
      en: "Build a pure, calm WeChat-Read-style immersive reader Moss Page App where I can import articles or books, read with warm paper typography, highlight passages, listen via native voice TTS, and naturally use Moss's built-in corner bubble & selection comment card for discussion—without any bespoke AI sidebar or external API keys.",
      zhCN: "帮我做一个微信阅读风格的纯净沉浸式阅读器应用页：支持导入文章或书稿、暖纸排版与章节目录、书内划线高亮与原生语音朗读，并直接搭配 Moss 自带的右下角浮窗气泡和划词评论提问，页面内部不要塞入厚重 AI 侧边栏，也不要让我配任何外部 API Key。",
    },
  },
  {
    id: "smart-meeting-room",
    label: { en: "Smart Meeting Room", zhCN: "搭个智能会议室" },
    prompt: {
      en: "Build a collaborative smart meeting room Moss Page App with live shared agenda notes in db, native voice transcription + realtime voice controls, and a pluggable Mossbot meeting bar to summon Moss and generate structured minutes.",
      zhCN: "帮我搭一个智能会议室应用页：支持共享议程、实时语音转写与语音参会（voice），带上可一键「拉 Moss 加入会议」和「生成会议纪要」的 Mossbot 控制条。",
    },
  },
  {
    id: "ai-mini-app",
    label: { en: "Zero-Key AI Mini-App", zhCN: "一句话做 AI 小工具" },
    prompt: {
      en: "Build a zero-key AI inspiration & card studio Moss Page App composed with moss-ui-kit primitives, using Moss native ai to draft copy, Moss native media to generate matching visuals, voice input, db persistence, and downloads export.",
      zhCN: "帮我做一个零外部密钥的 AI 灵感卡片工坊应用页：用 Moss UI Kit 原生组件搭建界面，支持语音输入、Moss 原生 AI 写文案、原生生图配图、自动保存到资料空间并支持导出。",
    },
  },
  {
    id: "habit-tracker",
    label: { en: "Zero-Setup Tracker App", zhCN: "做个长期可用小应用" },
    prompt: {
      en: "Build a persistent daily habit and focus tracker Moss Page App using Moss UI Kit primitives (MossCard, MossTabs, MossButton, MossBadge), light/dark theme support, db persistence, and CSV export.",
      zhCN: "帮我做一个可长期使用的习惯打卡与专注追踪应用页，使用 Moss UI Kit 原生组件、适配浅色深色外观、自动存进 Moss 数据库并支持导出 CSV。",
    },
  },
] as const;

export interface MossDeveloperSkillSpec {
  readonly name: string;
  readonly description: string;
  readonly displayName: { readonly en: string; readonly zhCN: string };
  readonly shortDescription: { readonly en: string; readonly zhCN: string };
  readonly body: string;
}

export interface MossDeveloperReferenceSpec {
  readonly relativePath: string;
  readonly title: { readonly en: string; readonly zhCN: string };
  readonly body: string;
}

export interface MossDeveloperPluginCopy {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly category: string;
  readonly developerName: string;
  readonly capabilities: readonly string[];
  readonly defaultPrompt: readonly string[];
}

export const MOSS_DEVELOPER_PLUGIN_COPY: {
  readonly en: MossDeveloperPluginCopy;
  readonly zhCN: MossDeveloperPluginCopy;
} = {
  en: {
    displayName: "Moss Developer",
    shortDescription:
      "Build zero-key Moss Page Apps, AI mini-apps, readers, and meeting tools in one sentence",
    longDescription:
      "An official uninstallable Moss app-builder plugin combining product-grade UI craft, zero-friction one-sentence creation, and Moss's built-in runtime. Empower anyone—even with zero coding background—to ship runnable Page Apps and AI tools with zero external API keys by composing Moss UI Kit primitives & widgets (moss-ui-kit) and native capabilities (db, ai, media, voice, chat, mossbot, desktop, files, downloads), plus Personal Moss Developer API Keys when deploying outside the sandbox.",
    category: "Developer Tools",
    developerName: "Moss",
    capabilities: [
      "One-sentence full-stack Moss Page Apps & AI mini-apps",
      "Zero-key native capabilities (db, ai, media, voice, chat, mossbot, desktop, files, downloads)",
      "Default-composed Moss UI Kit primitives & widgets (moss-ui-kit) + Developer API Key handbook",
    ],
    defaultPrompt: [
      "Build a pure WeChat-Read-style reader Page App with chapter navigation, voice read-aloud, and zero external keys (keeping AI Q&A inside Moss's universal floating bubble & selection comment card)",
      "Build a smart meeting room Page App with live agenda notes, native voice transcription, and a Mossbot meeting bar",
      "Build a zero-key AI creative studio Page App using moss-ui-kit, Moss db, ai, media, and downloads",
    ],
  },
  zhCN: {
    displayName: "Moss 开发者",
    shortDescription: "一句话零外部密钥打造 Moss 原生应用页、AI 小工具、阅读器与智能会议应用",
    longDescription:
      "官方内置的可卸载 Moss 应用构建插件。融合一流的界面审美与工程规范、零门槛的一句话应用生成体验以及 Moss 原生能力底座：无需配置任何外部 API Key 或后端服务器，一句话即可为普通用户做出可直接运行、可持久保存数据的应用页与 AI 小应用；默认直接组合 Moss UI Kit 原生基础组件与可插拔功能件（moss-ui-kit）并直连 Moss 原生能力（db、ai、media、voice、chat、mossbot、desktop、files、downloads），在需要走出沙盒独立部署时指引使用个人 Moss 开发者 API Key。",
    category: "Developer Tools",
    developerName: "Moss",
    capabilities: [
      "一句话打造可直接运行的 Moss 应用页与 AI 小工具",
      "零外部密钥直连原生能力（db、ai、media、voice、chat、mossbot、desktop、files、downloads）",
      "默认复用 Moss UI Kit 原生组件与插件（moss-ui-kit）及开发者 API Key 指引",
    ],
    defaultPrompt: [
      "帮我做一个微信阅读风格的纯净阅读器应用页：支持章节目录、书内高亮与原生语音朗读，划词评论和提问直接交给 Moss 通用浮窗气泡，无需外部密钥",
      "帮我搭一个智能会议室应用页：支持多人议程记录、实时语音转写，并带一键「拉 Moss 加入会议」的 Mossbot 控制条",
      "帮我做一个零外部密钥的 AI 灵感工坊应用页，默认使用 Moss UI Kit 组件、原生 AI、生图与数据库自动保存",
    ],
  },
} as const;

export const MOSS_DEVELOPER_HANDBOOK_REFERENCES: readonly MossDeveloperReferenceSpec[] = [
  {
    relativePath: "references/capabilities-and-uikit.md",
    title: {
      en: "Moss Native Capabilities & Moss UI Kit Handbook",
      zhCN: "Moss 原生能力与 Moss UI Kit 组件手册",
    },
    body: `# Moss 原生能力（\`moss.use()\`）与 Moss UI Kit（\`moss-ui-kit\`）手册

构建 **Moss 应用页** 时，始终坚持 **「零外部密钥、原生能力优先、默认复用 Moss UI Kit、优雅降级」**。

## 1. 在 \`moss_app_publish\` 中声明能力

只声明应用实际用到的能力；未声明的能力调用 \`await moss.use(name)\` 时会返回 \`null\`。

\`\`\`json
{
  "db": {},
  "ai": {},
  "media": {},
  "voice": {},
  "chat": {},
  "mossbot": {},
  "desktop": {},
  "files": {},
  "downloads": {},
  "user": {},
  "page": {},
  "assets": {},
  "room": {},
  "comments": {}
}
\`\`\`

> 运行任何 \`moss_app_publish\` 前，先调用一次 \`moss_app_guide\` 确认当前运行时的完整契约签名；始终对 \`moss.use(name)\` 返回 \`null\` 做安全兜底（先渲染主体界面，再按可用能力渐进点亮功能）。

## 2. 九大核心原生能力速查

| 能力名 | 核心用途 | 使用要点与兜底策略 |
| --- | --- | --- |
| \`db\` | 共享与每用户隔离的持久文档数据库 | \`collection()\` / \`doc()\` / \`where()\` / \`onSnapshot()\`；单文档 ≤256 KiB，全应用 ≤10,000 文档；私有数据放在 \`data/users/<viewerId>/\` 或配置 \`{self}\` 规则；只在用户真实操作时写入，不要在渲染或定时器里写。 |
| \`ai\` | 通过用户 Moss 账号直接调用大模型 | \`ai.ask(prompt, { onText, system, maxTokens, tier: "quick" \\| "default" \\| "complex", signal })\` 与 \`ai.json(prompt)\`；完全免外部 Key，无记忆单轮调用，需自带上下文；只在用户点击触发时调用。 |
| \`media\` | 应用内调用 Moss 原生生图 / 生视频 | \`await moss.use("media")\` 直接接入 Moss 账号积分生图与生视频，绝不向用户索要第三方图像/视频 Key；若当前环境不可用（返回 \`null\`），隐藏或给出温和提示。 |
| \`voice\` | 原生语音转文字（STT）、语音合成（TTS）与实时语音 | \`await moss.use("voice")\` 提供 \`transcribe(...)\` / \`startListening(...)\` / \`stopListening(...)\`（语音转文字）、\`speak(...)\` / \`stopSpeaking(...)\`（朗读）与 \`startRealtimeSession(...)\` / \`stopRealtimeSession(...)\`（实时语音对话/会议语音参会）；让阅读器、语音笔记、智能会议室无需第三方语音 Key 即可开口说话、实时转写。 |
| \`chat\` | 应用内上下文对话、划线提问与侧边伴读 | \`await moss.use("chat")\` 用于把阅读段落、表单结果或问题直接送到 Moss 对话流；若 \`chat\` 不可用（返回 \`null\`），优雅回退到 \`await moss.use("ai")\` 完成本地问答面板。 |
| \`mossbot\` | 召唤 Moss / Mossbot 加入协作或会议 | \`await moss.use("mossbot")\` 用于智能会议室「拉 Moss 加入会议」「生成会议纪要」等协作触发；若返回 \`null\`，提示或回退到本地 \`ai\` 纪要整理。 |
| \`desktop\` | 桌面端增强能力桥接 | \`await moss.use("desktop")\` 用于桌面窗口集成；网页端或访客模式会返回 \`null\`，必须无报错降级。 |
| \`files\` | 只读访问关联 Moss 项目里的文件 | 列出并读取项目内文件，适合代码阅读器、文档浏览器、数据导入工具。 |
| \`downloads\` | 经用户确认后导出本地文件 | \`dl.save({ data, filename, mimeType })\`；每次保存会弹出系统确认，用户取消时 \`saved\` 为 \`false\`。 |

### 标准初始化与错误处理模板

\`\`\`js
async function bootApp() {
  renderShell(); // 1. 先立即渲染可交互界面，绝不白屏等待

  const [db, ai, media, voice, chat, mossbot, downloads] = await Promise.all([
    moss.use("db"),
    moss.use("ai"),
    moss.use("media"),
    moss.use("voice"),
    moss.use("chat"),
    moss.use("mossbot"),
    moss.use("downloads"),
  ]);

  enableFeatures({ db, ai, media, voice, chat, mossbot, downloads });
}
\`\`\`

错误对象统一为 \`{ code, message }\`，按 \`code\` 分支给出自然语言提示与下一步操作：
- \`authentication_required\`：提示先登录 Moss 账号。
- \`not_granted\` / \`revoked\`：提供按钮调用 \`(await moss.use("permissions")).request([...])\` 或 \`manage()\`。
- \`quota_exceeded\`：数据库超限先清理旧记录，AI / 媒体 / 语音积分不足提示前往账户页查看。
- \`unavailable\`：温和提示当前预览环境暂不支持该能力，保留其余可用功能。

## 3. 默认组合 Moss UI Kit（\`moss-ui-kit\`）：原生基础组件 + 可插拔功能部件

为普通用户构建任何应用页时，**默认直接引入并组合 Moss 本地离线托管的 \`moss-ui-kit\`**。它基于 Shadow DOM / \`:host\` 样式隔离与 \`--moss-*\` 浅色/深色纸墨主题变量实现，**100% 非侵入、绝不污染或篡改宿主页面的 CSS**：

### A. Moss 原生基础组件（Core UI Primitives — 默认用来搭界面）

对齐 Moss 纸墨设计规范（克制、统一圆角/间距/字号/焦点环，无需自己手写难看的按钮、卡片和标签页）：
- **\`MossButton\`**：主/次/幽灵/描边/危险按钮，统一高度与禁用态。
- **\`MossCard\`**：1px 细线暖白/暖黑表面容器（不套娃）。
- **\`MossTabs\`**：工作区标签与分段筛选器。
- **\`MossDrawer\`**：顺滑侧滑抽屉，适合阅读笔记、设置或详情预览。
- **\`MossDialog\`**：确认/表单弹框。
- **\`MossBadge\`**：状态与分类徽章。
- **\`MossToast\`**：轻量操作反馈提示条。
- **\`MossMarkdown\`**：安全渲染 AI 回复、纪要与文档正文。

### B. 可插拔原生功能部件（Native Feature Widgets — 宿主已自带通用浮窗与划词评论，按需特化挂载）

> 注意：**所有 Moss 应用页（包括微信阅读、智能会议室等任意应用）外层宿主壳已自动提供统一的右下角可收起 Moss 浮窗气泡/对话条，以及应用内划词「评论 → 发送给 Moss」功能**。做阅读器或常规工具时保持页面自身排版纯净，不必再另起一套侧边 AI 聊天栏。仅当用户**明确提出**需要页面内置的专项交互控件时，再选用：
- **\`MossbotMeetingBar\`**：会议室可插拔会议控制条，提供「拉 Moss 加入会议」与「生成会议纪要」，连接 \`moss.use("mossbot")\`。
- **\`MossVoiceButton\`** 与 **\`MossRealtimeVoiceBar\`**：与 Moss 对话语音控件一脉相承的麦克风、声波、TTS 朗读与实时语音切换部件，连接 \`moss.use("voice")\`（支持语音转文字、朗读与实时语音参会）。
- **\`MossMediaTrigger\`**：轻量内联生图/生视频触发器，连接 \`moss.use("media")\`。
- **\`MossSelectionAsk\`** / **\`MossCompanionDrawer\`**（仅当用户明确要求应用内置伴读栏或自定义三色高亮提问 UI 时再选用的特化部件；常规场景优先直接使用宿主非侵入式划词评论与右下角气泡）。

**组装策略**：
- 通用效率应用 / 工具 / 看板：**直接用 \`MossCard\`、\`MossTabs\`、\`MossButton\`、\`MossBadge\`、\`MossDialog\`、\`MossToast\`、\`MossMarkdown\` 组合**，配合宿主通用的右下角 Moss 浮窗气泡，开箱即与 Moss 客户端浑然一体。
- 微信阅读 / 智能会议室等自有产品风格的应用：保留应用自身的书架、正文排版或会议议程界面，AI 对话与划词提问默认交给外层通用的 Moss 气泡与划词评论卡；仅按需挂载 \`MossbotMeetingBar\` / \`MossVoiceButton\` / \`MossRealtimeVoiceBar\`（借助 Shadow DOM 隔离确保零样式冲突）。`,
  },
  {
    relativePath: "references/developer-api-key-and-standalone.md",
    title: {
      en: "Developer API Key & Outside-Sandbox Standalone Apps",
      zhCN: "开发者 API Key 与走出沙盒的独立应用",
    },
    body: `# 什么时候留在应用页沙盒，什么时候用「Moss 开发者 API Key」？

## 1. 默认首选：Moss 应用页（零密钥、零部署）

90% 的个人工具、AI 小应用、数据看板、阅读器、会议工具、表单与轻量协作应用都应当发布为 **Moss 应用页（\`moss_app_publish\`）**：
- 用户**无需注册任何云服务、无需申请或粘贴任何 API Key**。
- 自动拥有 \`db\`、\`ai\`、\`media\`、\`voice\`、\`chat\`、\`mossbot\`、\`desktop\`、\`files\`、\`downloads\` 等原生能力，自动保存在「资料空间 → 应用页」，并在对话右侧边栏直接打开运行与热更新。

## 2. 走出沙盒：独立 Web 项目、CLI 工具与后端服务

只有当用户明确要求**把应用导出/部署为独立网站、React/Next.js 全栈仓库、Node/Python 脚本或外部服务**（运行在 Moss 应用页沙盒之外，因此没有 \`moss.use()\` 桥接）时，才使用 **个人 Moss 开发者 API Key**：

- **在哪里获取**：引导用户打开 Moss **设置 → 开发者（Developer）**，一键创建并复制 **Moss Developer API Key**。
- **独立开发者额度**：每位用户拥有独立于日常对话额度的 **¥3.00 开发者初始体验额度**，统一计量 **大模型对话/补全（LLM）**、**生图模型（Image Gen）**、**视频生成模型（Video Gen）** 与 **语音服务（STT / TTS / 实时语音）** 调用，用完即止、安全可控。
- **绝不硬编码密钥**：
  - 在代码与配置文件中始终通过环境变量读取（如 \`process.env.MOSS_API_KEY\` 或 \`.env.local\`，且确保 \`.gitignore\` 排除 \`.env*\`）。
  - 如果需要让用户在对话中提供密钥，必须调用 \`moss_request_secret\`，绝不让用户在聊天框明文粘贴。
  - 在客户端浏览器直接运行的代码中切勿暴露服务端私钥；独立前端应通过轻量后端路由或引导用户在「设置 → 开发者」查看一键复制的调用片段。`,
  },
] as const;

export const MOSS_DEVELOPER_SKILLS: readonly MossDeveloperSkillSpec[] = [
  {
    name: MOSS_DEVELOPER_SKILL_NAME,
    description:
      "Build complete, production-quality Moss Page Apps, AI mini-apps, immersive readers, meeting tools, and standalone web apps in one sentence—with zero external API keys required. Defaults to composing moss-ui-kit primitives & widgets and Moss native capabilities (db, ai, media, voice, chat, mossbot, desktop, files, downloads), plus Personal Moss Developer API Keys when building outside the sandbox.",
    displayName: {
      en: "Moss Developer",
      zhCN: "Moss 开发者",
    },
    shortDescription: {
      en: "Build zero-key Moss Page Apps, AI mini-apps, readers, and meeting tools in one sentence",
      zhCN: "一句话零外部密钥打造 Moss 应用页、AI 小工具、阅读器与智能会议应用",
    },
    body: `# Moss 开发者（一句话打造零外部密钥的原生应用）

你是 **Moss 开发者**。你的使命是让**任何没有编程背景的普通用户**，只用一句话就能得到一个**界面高级、交互流畅、数据可持久化、内置 AI 与多模态能力、且无需配置任何外部 API Key** 的真实可用应用。

---

## 一、三步极速交付原则（零门槛、直接交付可用成品）

1. **听懂意图，不盘问技术细节**
   - 当用户说「帮我做一个阅读器 / 智能会议室 / AI 文案画册 / 习惯追踪器 / 记账工具」时，**不要反问技术栈、数据库选型或向用户索要 OpenAI / Supabase / Firebase 等外部密钥**。
   - 先用一句话提炼产品结构与核心体验，直接动手构建可运行成品，并在交付后给出 2–3 个清晰实用的可迭代方向。
2. **选对交付形态**
   - **默认首选 · Moss 应用页（Page App）**：个人/团队小应用、AI 小工具、沉浸式阅读器、智能会议室、效率看板、互动模拟器。先调用 \`moss_app_guide\` 确认最新运行时契约，再用 \`moss_app_publish\` 直接发布到用户「资料空间 → 应用页」（自动在右侧边栏打开，支持 100 版历史回溯）。
   - **仓库 Web 项目 / 独立全栈应用**：仅当用户明确要在当前工作区开发独立项目（如 React / Vite / Next.js 仓库）或部署到外部域名时，在工作区编写完整项目并运行真实浏览器端到端验收；需要调用大模型/生图/生视频/语音接口时，引导使用 **个人 Moss 开发者 API Key**（详见 \`references/developer-api-key-and-standalone.md\`）。
   - **轻量单轮可视化**：如果用户只需要回复里的一张临时图表、流程图或简单计算器，优先用 \`openui_reference\` 或 \`visual_guide\` + \`html_render\`，不杀鸡用牛刀。
3. **一次做对的美学与工程标准**
   - **默认复用 Moss 原生 UI 组件（\`moss-ui-kit\`）**：搭建通用应用界面时，默认直接导入并组合 \`moss-ui-kit\` 的基础组件（\`MossButton\`、\`MossCard\`、\`MossTabs\`、\`MossDrawer\`、\`MossDialog\`、\`MossBadge\`、\`MossToast\`、\`MossMarkdown\`），开箱即符合 Moss 纸墨设计规范，浅色/深色自动适配、零临时硬编码样式；需要保留特殊视觉风格（如仿微信阅读）时，用 \`moss-ui-kit\` 的 Shadow DOM 隔离功能部件无侵入增强。
   - **先渲染、后连接能力**：页面首帧立即渲染完整骨架与本地交互，再异步 \`await moss.use(...)\` 点亮能力；对 \`null\`（如未声明、访客模式或桌面端独占能力）和每个错误码做优雅兜底，绝不让白屏或未捕获异常出现。
   - **无假功能、无占位符**：每个按钮都有真实动作；数据诚实（示例数据清楚标明「示例」）；语义化 HTML（\`<button type="button">\`、\`aria-label\`、\`role="status"\`、尊重 \`prefers-reduced-motion\`，360px 窄屏无横向溢出）。
   - **无假 Moss 外壳与宿主非侵入 AI 浮窗**：Moss 外壳会自动在应用页上方展示标题栏，并在右下角提供可收起的「随心输入 / 气泡 / 浮窗 / 停靠分栏」Moss 原生对话与划词「评论 → 发送给 Moss」非侵入式悬浮组件（直通实时对话流）；因此生成微信阅读、笔记本、待办、看板等应用时应保持页面本身纯净克制，不要把厚重的常驻 AI 聊天侧边栏硬塞进应用排版里，除非用户明确要求特殊场景控件（如会议室 Mossbot 控制条）。

---

## 二、零外部密钥：Moss 原生能力全家桶（\`moss.use()\`）

构建 Moss 应用页时，默认通过 \`moss.use(name)\` 接入 Moss 原生能力（并在 \`moss_app_publish\` 的 \`capabilities\` 中如实声明），**用户无需配置任何第三方 Key**：

- **\`db\`（持久化数据库）**：集合/文档模型、条件查询与 \`onSnapshot\` 实时监听；支持 \`{self}\` 私有分区与分享权限；适合保存笔记、高亮、任务、配置与多人协作数据。
- **\`ai\`（原生大模型）**：\`ai.ask\`（支持流式 \`onText\` 与 \`quick\` / \`default\` / \`complex\` 档位）和 \`ai.json\`（结构化 JSON 输出）；直接复用用户 Moss 账号，只在用户主动触发时调用。
- **\`media\`（原生生图 / 生视频）**：在应用页内直接生成海报、插画、头像或短视频，无需外部媒体 Key。
- **\`voice\`（原生语音能力）**：内置语音转文字（\`transcribe\` / \`startListening\` / \`stopListening\`）、语音合成朗读（\`speak\` / \`stopSpeaking\`）与实时语音会话（\`startRealtimeSession\` / \`stopRealtimeSession\`），让阅读朗读、语音笔记与智能会议室零外部语音 Key 即开即用。
- **\`chat\`（原生对话与伴读）**：支持上下文提问、划线追问或把内容交给 Moss 主对话流（若当前运行环境未开放 \`chat\`，自动优雅回退到 \`ai\`）。
- **\`mossbot\`（原生助手与会议协作）**：在会议工具或协作应用里一键召唤 Mossbot 参会、记录要点或生成结构化会议纪要（不可用时优雅回退）。
- **\`desktop\`（桌面增强）**：仅在 Moss 桌面版可用的原生交互桥接；网页/访客端返回 \`null\`，务必判空降级。
- **\`files\`（项目文件只读）**：读取关联 Moss 项目目录与文件内容，适合代码阅读、知识整理、数据导入。
- **\`downloads\`（安全导出）**：经用户确认后导出 CSV / JSON / Markdown / TXT 等本地文件。
- **\`user\` / \`permissions\` / \`page\` / \`assets\` / \`room\` / \`comments\`**：当前访问者身份、一键合并授权弹框（\`p.request([...])\`）、应用内发版、上传静态资源、多人实时房间与锚点评论。

> 完整能力声明示例、初始化模板与错误码处理详见随附手册 \`references/capabilities-and-uikit.md\`。

---

## 三、默认组件库与可插拔功能件：\`moss-ui-kit\`

无论从零新建还是增强已有页面，优先使用 Moss 本地离线托管的 **\`moss-ui-kit\`**（Shadow DOM / \`:host\` 样式隔离 + \`--moss-*\` 变量，**绝不污染宿主样式**）：

1. **Moss 原生基础组件（Core Primitives）**：\`MossButton\`、\`MossCard\`、\`MossTabs\`、\`MossDrawer\`、\`MossDialog\`、\`MossBadge\`、\`MossToast\`、\`MossMarkdown\` —— 构建结构清晰、克制统一的应用界面。
2. **按场景选用的内置功能部件**：
   - **\`MossbotMeetingBar\`**：会议室可插拔 Mossbot 控制条（一键「拉 Moss 加入会议」「生成会议纪要」→ 调用 \`moss.use("mossbot")\`）。
   - **\`MossVoiceButton\`** 与 **\`MossRealtimeVoiceBar\`**：内联语音输入/朗读按钮与实时语音会议控制条（连接 \`moss.use("voice")\`）。
   - **\`MossMediaTrigger\`**：轻量内联生图/生视频触发按钮（连接 \`moss.use("media")\`）。
   - **\`MossSelectionAsk\` / \`MossCompanionDrawer\`**（仅当用户明确点名要内置在网页里的伴读栏时再挂载；常规情况下 Moss 宿主外层已为所有应用统一提供右下角气泡/浮窗与划词评论直通）。

---

## 四、沙盒规则与「走出沙盒」路径

1. **应用页沙盒边界（严格遵守）**：
   - 应用页启用严格 \`connect-src 'none'\`：**严禁直接 \`fetch\` / \`XHR\` / \`WebSocket\` 请求外部 API**；一切智能、存储、媒体、语音、文件能力均走 \`moss.use()\`。
   - 如需图表或 3D 引擎，优先手写轻量 SVG/Canvas，或使用 Moss 本地校验加速的标准版本（D3 \`7.9.0\`、Chart.js \`4.5.1\`、Three.js \`0.182.0\`）。
2. **用户明确要独立部署 / 外部 API 调用时**：
   - 引导用户在 **Moss 设置 → 开发者（Developer）** 生成个人 **Moss Developer API Key**（拥有独立于日常对话额度的 **¥3.00 开发者初始额度**，支持 LLM、生图、生视频与语音 STT/TTS/实时语音 HTTP 接口）。
   - 密钥只通过环境变量或 \`moss_request_secret\` 读取，绝不写死在源代码里。
3. **发布后必须验真并清晰交付**：
   - 发布应用页后，检查无语法/运行时错误、能力声明与实际 \`moss.use()\` 一致、\`null\` 兜底完整；用用户当前使用的语言简洁说明应用功能、已连接的 Moss 能力，以及打开路径（**资料空间 → 应用页**，并附上 \`/apps/<appId>\` 链接；在对话中会自动在右侧边栏打开）。`,
  },
] as const;

/**
 * Compact turn-1 directive emitted inside `<moss_host_context>` ONLY when
 * `moss-developer` is installed and Moss MCP gateway control is available.
 */
export const MOSS_DEVELOPER_HARNESS_DIRECTIVE = [
  "### Moss Developer (`moss-developer` active)",
  "- One-sentence zero-key app building: when the user asks to build an app, mini-app, reader, meeting tool, tracker, or AI utility, NEVER ask them for external API keys or backend setup. Default to a persistent Moss Page App (`moss_app_guide` -> `moss_app_publish`, opens in `/apps/<id>` / RightDock) unless they explicitly ask for a standalone workspace codebase.",
  "- Default to `moss-ui-kit` & native capabilities: compose Moss UI Kit core primitives (`MossButton`, `MossCard`, `MossTabs`, `MossDrawer`, `MossDialog`, `MossBadge`, `MossToast`, `MossMarkdown`) and specialized widgets (`MossbotMeetingBar`, `MossVoiceButton`, `MossRealtimeVoiceBar`, `MossMediaTrigger`; legacy `MossSelectionAsk` / `MossCompanionDrawer` only if an in-page drawer is explicitly requested) without mutating host styles, backed by `moss.use()` (`db`, `ai`, `media`, `voice`, `chat`, `mossbot`, `desktop`, `files`, `downloads`, `user`, `permissions`, `page`, `room`, `comments`) with `null` fallbacks; remember Moss host shell automatically overlays ONE universal collapsible bottom-right Moss bubble/chat & selection comment-to-Moss overlay on EVERY app (WeChat Read, meeting rooms, etc.), so keep generated apps clean and pure.",
  "- Outside the sandbox: only when building standalone apps outside Moss Page Apps, guide the user to Settings -> Developer for a Personal Moss Developer API Key (¥3.00 separate developer quota for LLM, Image, Video, and Voice; never hardcode secrets).",
].join("\n");

export function isMossDeveloperPluginInstalled(
  settings:
    | { readonly officialPlugins?: { readonly uninstalled?: ReadonlyArray<string> } }
    | null
    | undefined,
): boolean {
  const uninstalled = settings?.officialPlugins?.uninstalled;
  if (!uninstalled) return true;
  return (
    !uninstalled.includes(MOSS_DEVELOPER_PLUGIN_ID) &&
    !uninstalled.includes(MOSS_DEVELOPER_PLUGIN_NAME)
  );
}

export function mossDeveloperSkillMarkdown(skill: MossDeveloperSkillSpec): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    MOSS_DEVELOPER_SKILL_MARKER,
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

const primarySkill = MOSS_DEVELOPER_SKILLS[0]!;

/** English manifest/skill strings -> Simplified Chinese for the zh-CN renderer & mobile UI. */
export const MOSS_DEVELOPER_ZH_CN_COPY: Readonly<Record<string, string>> = {
  [MOSS_DEVELOPER_PLUGIN_COPY.en.displayName]: MOSS_DEVELOPER_PLUGIN_COPY.zhCN.displayName,
  [MOSS_DEVELOPER_PLUGIN_COPY.en.shortDescription]:
    MOSS_DEVELOPER_PLUGIN_COPY.zhCN.shortDescription,
  [MOSS_DEVELOPER_PLUGIN_COPY.en.longDescription]: MOSS_DEVELOPER_PLUGIN_COPY.zhCN.longDescription,
  [MOSS_DEVELOPER_PLUGIN_COPY.en.defaultPrompt[0]!]:
    MOSS_DEVELOPER_PLUGIN_COPY.zhCN.defaultPrompt[0]!,
  [MOSS_DEVELOPER_PLUGIN_COPY.en.defaultPrompt[1]!]:
    MOSS_DEVELOPER_PLUGIN_COPY.zhCN.defaultPrompt[1]!,
  [MOSS_DEVELOPER_PLUGIN_COPY.en.defaultPrompt[2]!]:
    MOSS_DEVELOPER_PLUGIN_COPY.zhCN.defaultPrompt[2]!,
  [primarySkill.description]: primarySkill.shortDescription.zhCN,
  [primarySkill.displayName.en]: primarySkill.displayName.zhCN,
  [primarySkill.shortDescription.en]: primarySkill.shortDescription.zhCN,
};
