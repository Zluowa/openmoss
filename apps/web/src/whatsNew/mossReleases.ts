// FILE: whatsNew/mossReleases.ts
// Purpose: Moss's own published versions for Settings › 更新记录, newest first, condensed from
//          the published release notes (github.com/Zluowa/moss-releases). One short line per
//          change, no build or channel details.
// Layer: Static data. `WHATS_NEW_ENTRIES` (entries.ts) is the upstream history this app grew
//        from and no longer feeds the release history.

export interface MossRelease {
  readonly version: string;
  /** Publication day, Beijing time. */
  readonly date: { readonly zh: string; readonly en: string };
  readonly notes: { readonly zh: readonly string[]; readonly en: readonly string[] };
}

export const MOSS_RELEASES: readonly MossRelease[] = [
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

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Releases up to and including `runningVersion`, newest first: never a version not yet installed. */
export function mossReleasesUpTo(
  runningVersion: string,
  releases: readonly MossRelease[] = MOSS_RELEASES,
): readonly MossRelease[] {
  return releases
    .filter((release) => compareVersions(release.version, runningVersion) <= 0)
    .toSorted((left, right) => compareVersions(right.version, left.version));
}
