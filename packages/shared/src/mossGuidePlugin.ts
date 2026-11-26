// FILE: mossGuidePlugin.ts
// Purpose: The "Moss 使用手册" (`moss-guide`) official plugin: a plug-and-play,
//          100% uninstallable guide plugin in the Moss marketplace that teaches
//          every CLI (Codex, Claude Code, OpenCode, Cursor, Gemini/Antigravity,
//          Devin, Pi, etc.) Moss's capability boundaries, visual-first habits,
//          built-in skill/guide index, and proactive plugin discovery &
//          1-click install/authorization suggestions.
// Layer: Shared pure data (no Node/DOM/React imports; shared across server, web, and mobile).

export const MOSS_OFFICIAL_MARKETPLACE_NAME = "moss-official";
export const MOSS_GUIDE_PLUGIN_NAME = "moss-guide";
export const MOSS_GUIDE_PLUGIN_ID = `${MOSS_GUIDE_PLUGIN_NAME}@${MOSS_OFFICIAL_MARKETPLACE_NAME}`;
export const MOSS_GUIDE_SKILL_MARKER = "<!-- moss-official-plugin:moss-guide -->";
export const PLUGIN_SUGGESTION_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const PLUGIN_SUGGESTION_MAX_DISMISSED = 200;

export interface DismissedPluginSuggestionRecord {
  readonly pluginId: string;
  readonly dismissedAt: string;
}

export interface MossGuideStarterPromptSpec {
  readonly id: string;
  readonly label: { readonly en: string; readonly zhCN: string };
  readonly prompt: { readonly en: string; readonly zhCN: string };
}

export const MOSS_GUIDE_STARTER_PROMPTS: readonly MossGuideStarterPromptSpec[] = [
  {
    id: "visual-compare",
    label: { en: "Visual comparison card", zhCN: "做个可视化方案对比" },
    prompt: {
      en: "Create a visual comparison card of the best options for a task, with pros, cons, and an interactive summary.",
      zhCN: "帮我做一张可视化对比卡片，梳理不同方案的优缺点和适用场景，最好能互动筛选。",
    },
  },
  {
    id: "persistent-app",
    label: { en: "Build a Space App", zhCN: "做个可长期用的小应用" },
    prompt: {
      en: "Help me turn a recurring workflow or tracker into a persistent Moss Page App.",
      zhCN: "我想把日常反复要用的记录或小工具做成可长期保存数据的 Moss 资料空间小应用，给我推荐几个实用模板并直接开始搭建。",
    },
  },
  {
    id: "connect-apps",
    label: { en: "Connect email & calendar", zhCN: "连接我的邮箱与日历" },
    prompt: {
      en: "Help me check what plugins are best for email, calendar, and notes workflows in Moss, and show me which ones I can connect.",
      zhCN: "帮我看看在 Moss 里处理邮件、日程和笔记可以连接哪些外部应用，把适合我绑定安装的列出来。",
    },
  },
  {
    id: "capability-tour",
    label: { en: "What can Moss do?", zhCN: "看看 Moss 都能做什么" },
    prompt: {
      en: "Show me Moss's key built-in capabilities and give me 3 practical examples I can try right away.",
      zhCN: "用通俗直观的方式介绍一下你在 Moss 里的能力边界，并给我 3 个马上就能试用的小例子。",
    },
  },
] as const;

export interface MossGuidePluginSkillSpec {
  readonly name: string;
  readonly description: string;
  readonly displayName: { readonly en: string; readonly zhCN: string };
  readonly shortDescription: { readonly en: string; readonly zhCN: string };
  readonly body: string;
}

export interface MossGuidePluginCopy {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly category: string;
  readonly developerName: string;
  readonly capabilities: readonly string[];
  readonly defaultPrompt: readonly string[];
}

export const MOSS_GUIDE_PLUGIN_COPY: {
  readonly en: MossGuidePluginCopy;
  readonly zhCN: MossGuidePluginCopy;
} = {
  en: {
    displayName: "Moss Guide",
    shortDescription:
      "Teach every agent Moss's capabilities, visual-first skills, and proactive plugin suggestions",
    longDescription:
      "A non-intrusive, uninstallable official guide plugin. It helps any AI CLI inside Moss understand Moss's full capabilities and boundaries, prefer clear visuals and delightful interactive results over walls of text, and proactively search and recommend installable plugins with one-click OAuth/key setup.",
    category: "Productivity",
    developerName: "Moss",
    capabilities: [
      "Moss capability & boundary map",
      "Visual-first & delight guidance",
      "Proactive plugin discovery & 1-click install cards",
    ],
    defaultPrompt: [
      "Show me what you can do inside Moss with a few practical examples",
      "Find plugins I can connect for email and calendar workflows",
      "Create a visual summary of my priorities for this week",
    ],
  },
  zhCN: {
    displayName: "Moss 使用手册",
    shortDescription:
      "让智能体了解 Moss 能力边界，主动使用可视化技能并按需推荐可一键绑定安装的插件",
    longDescription:
      "一个即插即用、可随时卸载的官方引导插件。安装后，Moss 里的所有智能体 CLI 都能清楚知道 Moss 的完整能力边界与内置工具，在合适的时候主动用图表、卡片、小应用或画布等可视化方式交付「小惊喜」，并在需要外部服务时主动搜索并弹出可一键授权绑定的插件卡片。",
    category: "Productivity",
    developerName: "Moss",
    capabilities: [
      "Moss 全局能力与边界指引",
      "可视化优先与交互惊喜引导",
      "主动发现并推荐可一键绑定的插件",
    ],
    defaultPrompt: [
      "介绍一下你在 Moss 里能帮我做哪些事，给我举几个实用的例子",
      "帮我看看有哪些适合处理邮件和日历的插件可以绑定",
      "用可视化卡片帮我梳理一下本周的工作优先级",
    ],
  },
} as const;

export const MOSS_GUIDE_SKILLS: readonly MossGuidePluginSkillSpec[] = [
  {
    name: "moss-guide",
    description:
      "Understand Moss's complete capabilities, boundaries, visual-first presentation habits, and built-in skills/guides so you can proactively guide users and deliver delightful visual results.",
    displayName: {
      en: "Moss Capability Guide",
      zhCN: "Moss 全局使用手册",
    },
    shortDescription: {
      en: "Capability boundaries, visual-first rules, and built-in guide index",
      zhCN: "能力边界地图、可视化优先策略与内置技能索引",
    },
    body: `# Moss 使用手册（能力边界、可视化优先与主动引导）

你运行在 **Moss** 中。很多用户并不熟悉 AI 或命令行工具，也不了解 Moss 拥有哪些内置功能。你的职责是：**看清能力边界、主动选对工具、优先用直观的视觉方式呈现关键结果，并像一位贴心向导一样带着用户把事做成。**

## 1. Moss 的能力边界与内置应用地图

在回复用户或动手写脚本前，先确认 Moss 是否已经原生提供该能力（若某内置应用被用户在「设置 › 插件 › 应用」关闭，对应工具会不可用，请礼貌提示用户可去开启）：

- **资料空间（文档 / 表格 / 设计 / 数据看板）**
  - 文档与空间：\`moss_pages_spaces\`、\`moss_pages_list\`、\`moss_pages_read\`、\`moss_pages_mutate\` 等。适合沉淀长期文档、方案、知识库。
  - 电子表格：先读 \`moss_sheet_guide\`，再用 \`moss_sheet_*\` 读写单元格与公式。
  - 设计稿：先读 \`moss_design_guide\`，再用 \`moss_design_*\` 维护设计系统与画板。
  - 数据看板：先读 \`moss_dashboard_guide\`，再用 \`moss_dashboard_*\` 构建可交互看板。
- **幻灯片（Slides）**
  - 用户要汇报、做 PPT/演示文稿时，先调 \`moss_slides_guide\`，再用 \`moss_slides_create\` / \`moss_slides_edit\` / \`moss_slides_export\` 制作，不要只输出大段纯文字提纲。
- **小应用（Page Apps）**
  - 当用户需要一个**可以长期反复使用、带本地数据存储、可调用 AI 或导入导出文件**的小工具（追踪器、计算器、看板、小游戏等），先调 \`moss_app_guide\`，再用 \`moss_app_publish\` 发布到资料空间。
- **生图 / 生视频与画布（Canvas）**
  - 生成或编辑图片/视频：直接调 \`moss_media_generate\`（默认自动选型，不要自己去调第三方 CLI 替代）；要查看可用模型和积分用 \`moss_media_list\`。
  - 浏览、比较或排版对话里生成的媒体：用 \`moss_canvas_open\` / \`moss_canvas_read\`（记住：**画布是图片/视频画板，不是资料空间文档**）。
- **定时任务（Automations）**
  - 周期性巡检、监控、定时总结：用 \`moss_create_automation\`。当用户只是随口提到「帮我盯着 / 每天提醒」而未明确下令创建时，传 \`suggested: true\` 生成提议卡片让用户一键确认。
- **任务看板（Tasks）与待办（To-dos）**
  - 项目任务流转与并行派活：\`moss_*_kanban_*\`、\`moss_create_threads\` / \`moss_wait_for_threads\`。
  - 轻量提醒事项：\`moss_create_todo\` / \`moss_list_todos\` / \`moss_update_todo\`。
- **内置浏览器、桌面操控与设备**
  - 网页操作（Moss 内置浏览器）：使用 \`browser_*\`。
  - 电脑桌面或外部浏览器：仅在开启且需要时使用 \`moss_computer_*\`。
  - iOS 应用/模拟器：使用 \`device_*\`。
- **安全与体验保障**
  - 需要用户的 API Key、Token 或密码时，**必须调用 \`moss_request_secret\`** 弹出隐私输入卡片，绝不要让用户在聊天框明文粘贴敏感凭据。
  - 发现疑似 Moss 自身 bug 阻碍任务时，用 \`moss_draft_devs_report\` 起草报告卡片供用户一键确认发送。
  - 用户想换主题外观时，用 \`moss_theme_read\` + \`moss_theme_set\`。

## 2. 人类是视觉动物：可视化优先与「小惊喜」策略

当信息结构化、可对比、需要计算/筛选，或用视觉一眼就能看懂时，**不要只扔出一大段枯燥文字**。选最轻巧却让人眼前一亮的呈现形式：

| 场景 | 首选工具与形式 |
| --- | --- |
| 表格、指标卡、多方案对比、带滑块/筛选器的交互工具 | 先调 \`openui_reference\`，在回复中嵌入 \`\`\`openui 代码块或调用 \`moss_show_visual\` |
| 流程图、架构图、原理拆解、模拟演示、复杂交互页 | 先调 \`visual_guide\`（按需传 \`diagrams\` / \`interactive\`），用 \`html_preview\` 检查后再调 \`html_render\` |
| 地点、路线、旅行行程、地图展示 | 先调 \`visual_guide({ section: "maps" })\`，用 \`html_render\` 配合内置 \`window.mossMaps\`（国内自动用高德，海外用 Google/OpenFreeMap，严禁自引地图 SDK） |
| 演示文稿 / 汇报材料 | \`moss_slides_guide\` + \`moss_slides_create\` |
| 可长期保留使用的小工具 / 应用 | \`moss_app_guide\` + \`moss_app_publish\` |
| 图片 / 视频创作与比对 | \`moss_media_generate\` + \`moss_canvas_open\` |

**克制与诚实原则（非常关键）：**
- 简单问答、代码修改、报错排查、终端输出保持简洁文字与代码块即可，**不要为了炫技强行画图**。
- 严禁编造实时价格、天气、路线耗时或虚假数据；示例数据必须明确标明「示例」。
- 不暴露内部工具名（如 \`openui_reference\`、\`moss_show_visual\`），直接用自然中文解释结果，并在合适时附带 1–2 个贴心的「下一步可以做什么」小惊喜建议。

## 3. Moss 内置技能与指南索引

如果环境中存在以下便携技能（\`~/.moss/skills\` 或内置插件），按场景直接遵循：
- \`moss-imagegen\` / \`moss-videogen\` / \`moss-canvas\`：图像、视频生成与画布操作规范。
- \`moss-web-builder\`：前端页面开发与浏览器端到端验收。
- \`plugin-creator\` / \`skill-creator\`：帮助用户把常见工作流沉淀成新插件或技能。
- \`moss-plugin-discovery\`：当任务需要外部账号/服务/工具时，主动搜索并推荐可一键授权绑定的插件。

## 4. 主动引导不熟悉 AI 的用户

- 当用户的描述比较模糊（例如「我不知道怎么用」「帮我整理一下」「这怎么弄」）时，**不要反问一堆技术术语**；先用通俗的话给出 1 个立即可用的起步成果（或一张小卡片），再给 2–3 个清晰、具体的下一步选项。
- 始终使用用户当前使用的语言回复，所有重要结论、选择和待办事项必须在正文里写清楚，不要依赖被折叠在「Worked for...」里的中间过程。`,
  },
  {
    name: "moss-plugin-discovery",
    description:
      "Discover and proactively suggest Moss plugins, connected apps (e.g. Outlook, Gmail, Calendar, GitHub, Notion), CN life services (高德, 滴滴, 麦当劳, 瑞幸, 飞猪, 淘宝), MCP connectors, and workflow plugins. Use whenever a task involves an external app, account, service, or data source that current tools cannot access.",
    displayName: {
      en: "Proactive Plugin Discovery",
      zhCN: "主动插件发现与推荐",
    },
    shortDescription: {
      en: "Search Moss plugins and present 1-click install & auth cards in chat",
      zhCN: "识别外部服务需求，搜索并弹出可一键授权绑定的插件卡片",
    },
    body: `# 主动插件发现与一键授权推荐

Moss 本身已经内置了很多能力。大多数日常对话不需要搜索或推荐插件，**绝不能为了凑数去推冷门插件或骚扰用户**，更不要推荐「安装」Moss 默认自带的功能。

## 1. 严格优先级（Moss 原生永远优先）

1. **优先直接使用 Moss 原生能力**：
   - 生图 / 修图 / 生视频 / 画布：直接用 \`moss_media_generate\`、\`moss_canvas_*\`（**生图、生视频、画布都是 Moss 默认内置能力，绝不要推荐用户去安装**）。
   - 表格、图表、看板、流程图、地图、演示文稿、小应用、内置浏览器、定时任务、待办、隐私密钥输入：直接用 Moss 原生工具交付，不找外部软件替代。
2. **其次使用用户已经安装/连接的插件**：如果对应的连接器或服务已经可用，直接调用它完成任务。
3. **仅在用户明确需要未接入的外部软件时才搜索推荐**：
   - 典型触发条件：用户**明确提出要使用某个外部软件或个人账号**（例如「发一封谷歌邮件 / Gmail」「查我的 Outlook 邮件」「把这条记到 Notion」「帮我在 Linear 建单」「用高德查路线」「用滴滴叫车」「用 Remotion 做代码级动效视频」），或者任务客观上必须读写该外部系统且对应插件尚未安装/连接。
   - **不要主动猜测并推销不相关的插件**；如果用户之前拒绝/忽略了某个推荐，同一件事不要反复再推。

## 2. 搜索与精确推荐规范

1. **先用简洁关键词搜索**：调用 \`moss_search_plugins\`，传入产品名或能力关键词（例如 \`"gmail"\`、\`"谷歌邮件"\`、\`"outlook"\`、\`"notion"\`、\`"high-level keyword"\`），不要把整段用户原话传进去。Moss 的连接器生态覆盖全部 Composio 连接应用、本地连接器、本土生活服务与开源技能目录；先搜一次，未命中时换常见英文/中文别名试一次即可。
2. **仅使用服务端返回的准确 ID**：仅当找到确实对上用户明确需求、且**尚未安装/连接（\`installed: false\`）**的插件时，才调用 \`moss_suggest_plugins\`。
   - **精准且克制**：如果用户点名要「谷歌邮件」，只推荐 \`Gmail\` 1 个最精准的即可；多能力协同任务最多 2–3 个，**绝不塞满无关插件**。
   - **绝不推荐 \`installed: true\` 的已连接插件**，也绝不推荐 Moss 默认自带能力（生图、生视频、画布等），更不编造 ID。
3. **不阻塞用户、说完就走**：
   - 推荐卡片会在对话内显示插件图标、开发者、简介与 **以后再说 / 安装**；点击 **安装** 即可原地完成 OAuth 授权或密钥填写。
   - 发送卡片后，**用 1–2 句自然中文**提示用户点击对应插件的「安装」完成绑定；能先帮用户准备好的部分（例如草拟邮件正文、整理发布文案）先替用户做好。
   - 未确认绑定成功前，绝不声称邮件已发送或外部操作已完成。
4. **不暴露内部工具名**：回复给用户时只说业务本身与插件名称，不出现 \`moss_search_plugins\`、\`moss_suggest_plugins\` 等工具名。`,
  },
] as const;

/**
 * Compact turn-1 directive delivered inside `<moss_host_context>` ONLY when
 * `moss-guide` is installed, so non-Codex CLIs (Claude Code, OpenCode,
 * Antigravity/Gemini, Cursor, Devin, Pi, etc.) and Codex share identical behavior.
 * Avoids repeating lower-level tool protocol lines already emitted in base harness policy.
 */
export const MOSS_GUIDE_HARNESS_DIRECTIVE = [
  "### Moss Guide (`moss-guide` active)",
  "- Moss built-ins first: check whether Spaces/Docs/Sheets/Design/Dashboards, Slides, Page Apps, Media/Canvas, Automations, Kanban/Todos, `moss_request_secret`, `moss_draft_devs_report`, or `moss_theme_set` already solve the task natively. NEVER suggest installing Moss's default built-in image/video/canvas/web-builder capabilities.",
  "- Visual-first & gentle onboarding: deliver clear visual/interactive deliverables when comparisons, structured data, diagrams, or simulations clarify things; keep simple Q&A and code edits concise in plain text. For unfamiliar users, avoid jargon—deliver one useful step right away and offer 2–3 clear next options in their language.",
  "- Non-spammy plugin discovery: check `Connected external apps` first; most turns need ZERO plugin search. ONLY call `moss_search_plugins` when an external app or personal account (e.g. Gmail, Outlook, Notion, Linear, Slack, GitHub, 飞书, 高德/滴滴/飞猪/淘宝) is explicitly requested or strictly required and not already connected. Pass exact unconnected `pluginId`s to `moss_suggest_plugins` (prefer 1 exact match, max 3), respect `dismissed: true`, and never expose internal tool names.",
].join("\n");

export function isMossGuidePluginInstalled(
  settings:
    | { readonly officialPlugins?: { readonly uninstalled?: ReadonlyArray<string> } }
    | null
    | undefined,
): boolean {
  const uninstalled = settings?.officialPlugins?.uninstalled;
  if (!uninstalled) return true;
  return (
    !uninstalled.includes(MOSS_GUIDE_PLUGIN_ID) && !uninstalled.includes(MOSS_GUIDE_PLUGIN_NAME)
  );
}

export function activeDismissedSuggestionPluginIds(
  settings:
    | {
        readonly officialPlugins?: {
          readonly dismissedSuggestions?: ReadonlyArray<DismissedPluginSuggestionRecord>;
        };
      }
    | null
    | undefined,
  nowMs = Date.now(),
): ReadonlySet<string> {
  const active = new Set<string>();
  const entries = settings?.officialPlugins?.dismissedSuggestions;
  if (!entries) return active;
  for (const entry of entries) {
    const dismissedAtMs = Date.parse(entry.dismissedAt);
    if (!Number.isFinite(dismissedAtMs)) continue;
    if (nowMs - dismissedAtMs < PLUGIN_SUGGESTION_DISMISS_COOLDOWN_MS) {
      active.add(entry.pluginId);
    }
  }
  return active;
}

export function upsertDismissedPluginSuggestion(
  current: ReadonlyArray<DismissedPluginSuggestionRecord> | undefined,
  pluginId: string,
  dismissed: boolean,
  nowIso = new Date().toISOString(),
): ReadonlyArray<DismissedPluginSuggestionRecord> {
  const filtered = (current ?? []).filter((entry) => entry.pluginId !== pluginId);
  if (!dismissed) return filtered;
  return [{ pluginId, dismissedAt: nowIso }, ...filtered].slice(0, PLUGIN_SUGGESTION_MAX_DISMISSED);
}

export function mossGuideSkillMarkdown(skill: MossGuidePluginSkillSpec): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    MOSS_GUIDE_SKILL_MARKER,
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}
