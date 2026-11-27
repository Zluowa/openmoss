// FILE: whatsNew/mossReleases.ts
// Purpose: Moss's own published versions for Settings › 更新记录, newest first, condensed from
//          the published release notes (github.com/Zluowa/moss-releases). One short line per
//          change, no build or channel details.
// Layer: Static data. `WHATS_NEW_ENTRIES` (entries.ts) is the upstream history this app grew
//        from and no longer feeds the release history.

export type MossReleaseGroupKind = "feat" | "improvement" | "fix";

export interface MossReleaseGroup {
  readonly kind: MossReleaseGroupKind;
  readonly zh: readonly string[];
  readonly en: readonly string[];
}

export interface MossRelease {
  readonly version: string;
  /** Publication day, Beijing time. */
  readonly date: { readonly zh: string; readonly en: string };
  readonly notes: { readonly zh: readonly string[]; readonly en: readonly string[] };
  /** Optional grouped sections (New / Improved / Fixed) for the post-update What's New dialog. */
  readonly groups?: readonly MossReleaseGroup[];
}

export const MOSS_RELEASES: readonly MossRelease[] = [
  {
    version: "1.0.18",
    date: { zh: "11月27日", en: "Nov 27" },
    notes: {
      zh: [
        "画布新增多人实时协作与 AI 批注升级，支持悬停预览与分步导览",
        "新增官方「Moss 使用手册」插件、首页快捷引导，并支持企业 API Key 独立连接应用",
        "桌面端与网页端全面性能优化：冷启动更快、交互更流畅、安装包更精简",
        "支持运行中实时引导对话、新版资料空间「苔」、Mossbot 像素小人及手动触发更新下载",
      ],
      en: [
        "Added real-time multiplayer Canvas collaboration, hover previews, and guided tours",
        "Added official Moss Guide plugin, Home quick starters, and isolated Enterprise API Key app connections",
        "Major desktop and web performance pass: faster cold start, smoother UI, smaller installers",
        "Added live mid-run turn steering, redesigned Moss story Space, pixel Mossbots, and manual update downloads",
      ],
    },
    groups: [
      {
        kind: "feat",
        zh: [
          "画布支持多人实时协作同步、远端光标、AI 批注悬停预览与分步导览",
          "内置可卸载官方插件「Moss 使用手册」与首页快捷引导，开放企业 API Key 按 Key 独立连接应用",
          "升级运行中实时引导对话（含 Antigravity 1.5+ 原生引导），并重做桌面与手机端定时任务页",
        ],
        en: [
          "Added live multiplayer Canvas sync, remote cursors, AI offer hover previews, and guided tours",
          "Added official uninstallable Moss Guide plugin, Home quick starters, and per-key Enterprise API Key apps",
          "Upgraded live mid-run turn steering (including native Antigravity 1.5+) and redesigned scheduled tasks across desktop and mobile",
        ],
      },
      {
        kind: "improvement",
        zh: [
          "全面吸收冷启动分包、服务端查询缓存与资源精简优化，桌面端启动更快、安装包更小、断网秒速重连",
          "全新资料空间「苔」图文故事与 Mossbot 像素小人形象（新增小狗头像），更新改为手动点击下载并在顶栏安静提示新功能",
        ],
        en: [
          "Major cold-start, server cache, and packaging optimizations for faster boot, smaller installers, and instant reconnect",
          "New Moss story Space, pixel-art Mossbot avatars (with puppy), manual update downloads, and quiet top-right What's new dialog",
        ],
      },
      {
        kind: "fix",
        zh: [
          "修复切换对话或刷新后输入框草稿与多附件丢失，支持新建对话继续保留未发送草稿",
          "修复更新后头像与 Windows 应用图标丢失、Codex 用量页中文显示与账号隔离，以及 Antigravity 后台任务误超时",
        ],
        en: [
          "Fixed lost composer drafts and attachments across chat switches or reloads, preserving unsent drafts on New chat",
          "Fixed avatar and Windows app icon persistence across updates, Codex usage localization/isolation, and Antigravity background timeouts",
        ],
      },
    ],
  },
  {
    version: "1.0.17",
    date: { zh: "11月26日", en: "Nov 26" },
    notes: {
      zh: [
        "彻底拆分「Moss 本体更新」与「智能体 CLI 更新」入口",
        "左侧栏直出「插件」市场入口，支持离线重试与统一图标",
        "桌面端与手机端重做工作过程折叠、工具步骤与资料空间体验",
        "修复企业 API Key 切换 Codex 模型路由与等待批准期间工具计时",
      ],
      en: [
        "Separated Moss desktop updates from Agent CLI updates in the left rail",
        "Added Plugins directly to the primary rail with offline retry and fallback icons",
        "Refined work-log folds, tool steps, and Space Slides/Sheets across desktop and mobile",
        "Fixed Enterprise API Key Codex routing and paused tool timers while awaiting approval",
      ],
    },
    groups: [
      {
        kind: "feat",
        zh: [
          "左侧栏直出「插件」入口，解除插件市场对 Codex 开关的绑定，并补全离线详情与重试",
          "拆分「Moss 本体更新」与「智能体 CLI 更新」，智能体更新失败不再阻塞 Moss 升级",
        ],
        en: [
          "Added Plugins directly to the left rail, decoupled from Codex CLI availability, with offline detail and retry",
          "Separated Moss desktop updates from Agent CLI updates so agent update errors never block Moss upgrades",
        ],
      },
      {
        kind: "improvement",
        zh: [
          "重做手机端工作过程折叠、两段式工具步骤查看与 7 档思考强度换行胶囊",
          "桌面端「用量与限额」正确识别企业 API Key，任务与看板草稿标题全面中文化",
        ],
        en: [
          "Refined mobile work-log folds, two-stage tool step inspection, and wrapping 7-level effort pills",
          "Usage settings recognize Enterprise API Keys cleanly, and untitled Tasks/Kanban drafts are localized",
        ],
      },
      {
        kind: "fix",
        zh: [
          "修复国内镜像下 Windows 版 Devin CLI 更新链路，并默认折叠原始报错细节",
          "修复企业 API Key 下切换到 Codex 的模型路由、资料空间幻灯片空白与表格公式求值",
          "等待批准期间暂停内层工具空闲计时",
        ],
        en: [
          "Fixed Windows Devin CLI updates under the China mirror and collapsed raw error details behind View details",
          "Fixed Codex routing under Enterprise API Keys, Space Slides rendering, and Sheet =SUM evaluation",
          "Paused inner running tool timers while waiting for approval",
        ],
      },
    ],
  },
  {
    version: "1.0.16",
    date: { zh: "11月25日", en: "Nov 25" },
    notes: {
      zh: [
        "资料空间全面对齐文档、幻灯片、表格、设计、数据看板、应用页与画布",
        "新增关闭收入托盘、开机自启、侧栏父子对话折叠与新版服务商工作台",
        "Claude 与 Codex 首轮对话提速，「已工作」计时剔除等待批准时间",
        "修复批准命令时消息滚走、Windows 命令格式与未发送草稿标签页保留",
      ],
      en: [
        "Unified Workspace across Docs, Slides, Sheets, Design, Dashboards, App Pages, and Canvas",
        "Added close-to-tray, launch-at-login, collapsible thread hierarchies, and redesigned Providers workbench",
        "Faster first-turn startup for Claude and Codex, excluding approval wait from Worked for duration",
        "Fixed prompt scroll on approvals, Windows command formatting, and unsent draft tab retention",
      ],
    },
    groups: [
      {
        kind: "feat",
        zh: [
          "资料空间全面对齐文档、幻灯片、电子表格、设计、数据看板、应用页与画布，支持深色画布同步",
          "桌面端新增关闭收入托盘、开机自启、侧栏父子对话折叠与新版服务商工作台",
        ],
        en: [
          "Unified Workspace across Docs, Slides, Sheets, Design, Dashboards, App Pages, and Canvas with dark mode sync",
          "Added close-to-tray, launch-at-login, sidebar thread hierarchy collapsing, and redesigned Providers workbench",
        ],
      },
      {
        kind: "improvement",
        zh: [
          "Claude 与 Codex 对话首轮启动提速，「已工作」计时剔除等待批准的时间",
          "窄窗输入框与画布悬浮条自适应换行不裁切，设置页精简冗余文案",
        ],
        en: [
          "Faster first-turn startup for Claude and Codex chats, with Worked for duration excluding approval wait time",
          "Narrow-window composer and canvas floating bar wrap cleanly without clipping, with leaner Settings copy",
        ],
      },
      {
        kind: "fix",
        zh: [
          "修复批准命令时用户消息被滚走、Windows 命令格式异常与前进后退历史错位",
          "修复等待批准时退出提示文案、未发送草稿标签页保留与设计稿播放模式脚本问题",
        ],
        en: [
          "Fixed user prompts scrolling away on command approval, Windows command formatting, and Back/Forward history",
          "Fixed quit wording during pending approvals, unsent draft tab retention, and Design play mode scripts",
        ],
      },
    ],
  },
  {
    version: "1.0.14",
    date: { zh: "11月23日", en: "Nov 23" },
    notes: {
      zh: [
        "一键安装 Antigravity，代理环境下也能下载",
        "Windows 更新时显示进度，装完自动重新打开",
        "关闭窗口后可在托盘继续运行，可开机启动",
        "新的「模型与智能体」设置页",
      ],
      en: [
        "One-click Antigravity install, also behind a proxy",
        "Windows updates show progress and reopen Moss when done",
        "Keep running in the tray after closing the window; launch at login",
        "New Models & agents settings page",
      ],
    },
  },
  {
    version: "1.0.13",
    date: { zh: "11月23日", en: "Nov 23" },
    notes: {
      zh: ["下载更新时左下角显示进度", "左下角头像与额度圆环大小一致"],
      en: [
        "Update download progress at the bottom left",
        "The bottom-left avatar matches the usage ring",
      ],
    },
  },
  {
    version: "1.0.12",
    date: { zh: "11月22日", en: "Nov 22" },
    notes: {
      zh: ["修复从个人资料页打开插件设置时崩溃"],
      en: ["Fixed a crash when opening plugin settings from the profile page"],
    },
  },
  {
    version: "1.0.11",
    date: { zh: "11月22日", en: "Nov 22" },
    notes: {
      zh: ["点左下角余额查看用量，点头像打开账号和设置", "应用快照显示真实的应用图标和名称"],
      en: [
        "Click the balance for usage, the avatar for account and settings",
        "AppSnap shows real app icons and names",
      ],
    },
  },
  {
    version: "1.0.10",
    date: { zh: "11月22日", en: "Nov 22" },
    notes: {
      zh: [
        "新的个人资料页和 20 款 Moss 头像",
        "用量与限额页改版",
        "Windows 应用快照更快",
        "模型列表秒开",
      ],
      en: [
        "New profile page and 20 Moss avatars",
        "Redesigned usage and limits",
        "Faster AppSnap on Windows",
        "Model lists open at once",
      ],
    },
  },
  {
    version: "1.0.9",
    date: { zh: "11月21日", en: "Nov 21" },
    notes: {
      zh: [
        "智能体工作时也能更新 Codex 和 Claude",
        "Codex 工作时可以先发下一条消息",
        "额度用完时保留已生成的回复",
        "Windows 支持电脑历史，默认关闭",
      ],
      en: [
        "Update Codex and Claude while agents are working",
        "Send your next message while Codex works",
        "Replies are kept when credits run out",
        "Computer History on Windows, off by default",
      ],
    },
  },
  {
    version: "1.0.8",
    date: { zh: "11月20日", en: "Nov 20" },
    notes: {
      zh: ["更新前先安全停止 Codex", "安装包从 Moss 自己的下载地址提供"],
      en: ["Codex stops safely before an update", "Downloads come from Moss's own mirrors"],
    },
  },
  {
    version: "1.0.7",
    date: { zh: "11月19日", en: "Nov 19" },
    notes: {
      zh: ["预测下一条消息", "可以自己改外观，也可以让智能体帮你改", "新的欢迎引导", "安装包更小"],
      en: [
        "Predicted next message",
        "Restyle Moss yourself or ask an agent",
        "New welcome guide",
        "Smaller installer",
      ],
    },
  },
  {
    version: "1.0.6",
    date: { zh: "11月17日", en: "Nov 17" },
    notes: {
      zh: ["每块画布各自保存自己的内容"],
      en: ["Each canvas keeps its own drawing"],
    },
  },
  {
    version: "1.0.5",
    date: { zh: "11月14日", en: "Nov 14" },
    notes: {
      zh: [
        "可交互的应用页",
        "更干净的画布",
        "电脑控制可以逐个应用开关",
        "用量分析",
        "修复长时间使用后智能体没反应",
      ],
      en: [
        "Interactive pages",
        "A cleaner canvas",
        "Computer use per app",
        "Usage analytics",
        "Agents no longer go quiet after long sessions",
      ],
    },
  },
  {
    version: "1.0.3",
    date: { zh: "11月1日", en: "Nov 1" },
    notes: {
      zh: ["修复跑不起来的智能体", "登录刷新不再打断对话"],
      en: ["Fixed agents that could not run", "Sign-in refresh no longer interrupts chats"],
    },
  },
  {
    version: "1.0.2",
    date: { zh: "10月31日", en: "Oct 31" },
    notes: {
      zh: ["第一个能自动更新的版本"],
      en: ["The first version that updates itself"],
    },
  },
];

function versionParts(version: string): readonly number[] {
  return (version.split("-")[0] ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareMossVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Finds the release entry matching `version` by numeric semver comparison. */
export function mossReleaseForVersion(
  version: string,
  releases: readonly MossRelease[] = MOSS_RELEASES,
): MossRelease | null {
  return releases.find((release) => compareMossVersions(release.version, version) === 0) ?? null;
}

/** Releases up to and including `runningVersion`, newest first: never a version not yet installed. */
export function mossReleasesUpTo(
  runningVersion: string,
  releases: readonly MossRelease[] = MOSS_RELEASES,
): readonly MossRelease[] {
  return releases
    .filter((release) => compareMossVersions(release.version, runningVersion) <= 0)
    .toSorted((left, right) => compareMossVersions(right.version, left.version));
}
