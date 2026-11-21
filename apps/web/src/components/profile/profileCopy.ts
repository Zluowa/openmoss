// FILE: profileCopy.ts
// Purpose: Simplified Chinese (first) and English UI copy for the Profile page,
//          inline display-name / @handle editors, avatar picker, and Settings → 账号.
// Layer: Web profile feature (pure copy dictionary, no I/O)

import type { MossProfileHandleStatus } from "@moss/contracts";
import type { MossLocaleCode } from "~/appSettings";
import type { ProfileAvatarPresetCategory } from "./profileAvatarPresets";
import type { ProfileDisplayNameError, ProfileErrorKind } from "./profileValidation";

export interface ProfileCopy {
  readonly title: string;
  readonly backToMoss: string;
  readonly openAccountSettings: string;
  readonly openSettings: string;
  readonly share: string;
  readonly editProfile: string;
  readonly changeAvatar: string;
  readonly editNameAria: string;
  readonly editHandleAria: string;
  readonly namePlaceholder: string;
  readonly handlePlaceholder: string;
  readonly setHandlePrompt: string;
  readonly save: string;
  readonly saving: string;
  readonly cancel: string;
  readonly signIn: string;
  readonly signInToMoss: string;
  readonly signedOutTitle: string;
  readonly signedOutLocalHint: string;
  readonly offlineNotice: string;
  readonly retrySync: string;
  readonly loadStatsError: string;
  readonly tryAgain: string;
  readonly planManageHint: string;
  readonly stats: {
    readonly lifetimeTokens: string;
    readonly peakDay: string;
    readonly longestTask: string;
    readonly longestStreak: string;
    readonly currentStreak: string;
  };
  readonly heatmap: {
    readonly title: string;
    readonly daily: string;
    readonly weekly: string;
    readonly cumulative: string;
    readonly claudeNote: string;
  };
  readonly sections: {
    readonly recentWork: string;
    readonly topProject: string;
    readonly topProjectMeta: (prompts: number, threads: number, days: number) => string;
    readonly noRecentWork: string;
    readonly popularPlugins: string;
    readonly noPlugins: string;
    readonly runs: (count: string) => string;
    readonly activityInsights: string;
    readonly mostUsedProvider: string;
    readonly mostUsedReasoning: string;
    readonly mostActiveHour: string;
    readonly skillsExplored: string;
    readonly totalPrompts: string;
    readonly totalThreads: string;
    readonly modelUsage: string;
    readonly shareOfTokens: string;
    readonly shareOfTurns: string;
    readonly noModelActivity: string;
    readonly providerShareOfTokens: (percent: number) => string;
    readonly providerShareOfTurns: (percent: number) => string;
  };
  readonly avatarPicker: {
    readonly title: string;
    readonly description: string;
    readonly tabPresets: string;
    readonly tabUpload: string;
    readonly tabInitials: string;
    readonly categoryAll: string;
    readonly categories: Readonly<Record<ProfileAvatarPresetCategory, string>>;
    readonly uploadPrompt: string;
    readonly uploadHint: string;
    readonly chooseImage: string;
    readonly replaceImage: string;
    readonly zoomLabel: string;
    readonly initialsHint: string;
    readonly accentColorLabel: string;
    readonly saveAvatar: string;
    readonly uploading: string;
    readonly processing: string;
  };
  readonly handleStatus: Readonly<Record<MossProfileHandleStatus, string>>;
  readonly handleChecking: string;
  readonly nameErrors: Readonly<Record<ProfileDisplayNameError, string>>;
  readonly errors: Readonly<Record<ProfileErrorKind, string>>;
  readonly accountSettings: {
    readonly profileShortcutTitle: string;
    readonly profileShortcutDescription: string;
    readonly openProfile: string;
    readonly signedOutTitle: string;
    readonly signedOutDescription: string;
    readonly goToSignIn: string;
    readonly backToPhoneAccount: string;
    readonly googleAccountsTitle: string;
    readonly googleAccountsDescription: string;
    readonly switchWithoutSignOut: string;
    readonly addAccount: string;
    readonly noSavedAccounts: string;
    readonly current: string;
    readonly ready: string;
    readonly signInAgain: string;
    readonly use: string;
    readonly switching: string;
    readonly remove: string;
    readonly removing: string;
    readonly usageAndCreditsTitle: string;
    readonly usageAndCreditsDescription: string;
    readonly openUsage: string;
    readonly signOut: string;
    readonly signingOut: string;
    readonly sessionExpires: (formatted: string) => string;
    readonly actionFailed: string;
    readonly loadFailedTitle: string;
    readonly loadFailedDescription: string;
    readonly retry: string;
    readonly signInUnavailable: string;
    readonly loading: string;
    readonly verified: string;
    readonly verificationNeeded: string;
    readonly signedIn: string;
  };
}

const ZH_COPY: ProfileCopy = {
  title: "个人资料",
  backToMoss: "返回 Moss",
  openAccountSettings: "账号",
  openSettings: "设置",
  share: "分享",
  editProfile: "编辑资料",
  changeAvatar: "更换头像",
  editNameAria: "编辑显示名称",
  editHandleAria: "编辑个人 ID",
  namePlaceholder: "输入显示名称",
  handlePlaceholder: "输入 3–20 位小写字母、数字或下划线",
  setHandlePrompt: "设置 @ID",
  save: "保存",
  saving: "正在保存…",
  cancel: "取消",
  signIn: "登录",
  signInToMoss: "登录 Moss",
  signedOutTitle: "未登录",
  signedOutLocalHint: "当前为本机资料，登录 Moss 后可同步到账号",
  offlineNotice: "暂时连不上 Moss 账号服务，当前展示离线缓存，联网后可编辑。",
  retrySync: "重试同步",
  loadStatsError: "暂时无法加载本机统计数据。",
  tryAgain: "重试",
  planManageHint: "管理账号与套餐",
  stats: {
    lifetimeTokens: "累计 Token 数",
    peakDay: "Token 使用峰值",
    longestTask: "最长任务用时",
    longestStreak: "最长连续天数",
    currentStreak: "当前连续天数",
  },
  heatmap: {
    title: "Token 活动",
    daily: "每天",
    weekly: "每周",
    cumulative: "累计总量",
    claudeNote: "Claude Token 统计仅包含可核验记录，早期历史与未完成轮次可能不完整。",
  },
  sections: {
    recentWork: "常做项目与工作概览",
    topProject: "最常投入项目",
    topProjectMeta: (prompts, threads, days) =>
      `${prompts} 次提问 · ${threads} 个对话 · 活跃 ${days} 天`,
    noRecentWork: "还没有项目记录，在 Moss 里开启对话后会显示在这里。",
    popularPlugins: "热门插件与智能体",
    noPlugins: "还没有使用过技能或智能体。",
    runs: (count) => `${count} 次`,
    activityInsights: "使用洞察",
    mostUsedProvider: "最常用模型来源",
    mostUsedReasoning: "常用推理强度",
    mostActiveHour: "最活跃时段",
    skillsExplored: "已探索技能",
    totalPrompts: "累计提问",
    totalThreads: "累计对话",
    modelUsage: "模型用量",
    shareOfTokens: "按已统计 Token 占比。",
    shareOfTurns: "按对话轮次占比。",
    noModelActivity: "还没有模型使用记录。",
    providerShareOfTokens: (percent) => ` · 占已统计 Token 的 ${percent}%`,
    providerShareOfTurns: (percent) => ` · 占对话轮次的 ${percent}%`,
  },
  avatarPicker: {
    title: "选择头像",
    description: "选一个 Moss 预设头像，或上传自己的图片。",
    tabPresets: "预设头像",
    tabUpload: "上传图片",
    tabInitials: "字母头像",
    categoryAll: "全部",
    categories: {
      moss: "Moss 原创",
      people: "简笔人物",
      friends: "可爱伙伴",
    },
    uploadPrompt: "选择图片并裁成圆形头像",
    uploadHint: "支持 PNG、JPEG、WebP，裁剪后不超过 1 MB。",
    chooseImage: "上传图片",
    replaceImage: "重新选图",
    zoomLabel: "缩放",
    initialsHint: "使用名称首字作为简洁字母头像。",
    accentColorLabel: "底色",
    saveAvatar: "保存头像",
    uploading: "正在上传…",
    processing: "正在处理…",
  },
  handleStatus: {
    available: "这个 ID 可以使用",
    current: "当前正在使用这个 ID",
    taken: "这个 ID 已被占用，换一个试试",
    reserved: "这个 ID 为系统保留，请换一个",
    too_short: "ID 至少需要 3 个字符",
    too_long: "ID 最多 20 个字符",
    invalid_characters: "只能使用小写字母、数字和下划线",
    unverified: "暂时无法校验唯一性，保存时会再次检查",
  },
  handleChecking: "正在检查可用性…",
  nameErrors: {
    empty: "请输入显示名称",
    too_long: "显示名称最多 32 个字符",
    invalid_characters: "显示名称不能包含换行或控制字符",
  },
  errors: {
    offline: "暂时连不上 Moss 账号服务，请稍后再试。",
    handleTaken: "这个 ID 已被占用，换一个试试。",
    invalid: "资料内容不符合要求，请检查后重试。",
    avatarInvalid: "头像需为 1 MB 以内的 PNG、JPEG 或 WebP 图片。",
    unknown: "保存失败，请稍后重试。",
  },
  accountSettings: {
    profileShortcutTitle: "个人资料",
    profileShortcutDescription: "自定义头像、显示名称、@ID，查看 Token 活动与统计。",
    openProfile: "打开个人资料",
    signedOutTitle: "当前未登录 Moss 账号",
    signedOutDescription: "登录后可使用 Moss 模型额度、会员套餐，并在多设备间同步个人资料。",
    goToSignIn: "前往登录",
    backToPhoneAccount: "返回手机号账号",
    googleAccountsTitle: "已保存的 Google 账号",
    googleAccountsDescription: "无需退出即可在已保存的账号之间切换。",
    switchWithoutSignOut: "无需退出即可切换。",
    addAccount: "添加账号",
    noSavedAccounts: "还没有已保存的 Moss 账号。",
    current: "当前",
    ready: "可用",
    signInAgain: "需重新登录",
    use: "切换",
    switching: "正在切换…",
    remove: "移除",
    removing: "正在移除…",
    usageAndCreditsTitle: "用量与充值",
    usageAndCreditsDescription: "在设置 → 用量与限额查看剩余额度并充值。",
    openUsage: "打开用量",
    signOut: "退出登录",
    signingOut: "正在退出…",
    sessionExpires: (formatted) => `登录有效期至 ${formatted}`,
    actionFailed: "账号操作失败",
    loadFailedTitle: "暂时无法连接 Moss",
    loadFailedDescription: "请重试或重启 Moss 后再试。",
    retry: "重试",
    signInUnavailable: "当前无法使用 Moss 账号登录。",
    loading: "正在加载账号…",
    verified: "已验证",
    verificationNeeded: "待验证",
    signedIn: "已登录",
  },
};

const EN_COPY: ProfileCopy = {
  title: "Profile",
  backToMoss: "Back to Moss",
  openAccountSettings: "Account",
  openSettings: "Settings",
  share: "Share",
  editProfile: "Edit",
  changeAvatar: "Change avatar",
  editNameAria: "Edit display name",
  editHandleAria: "Edit @handle",
  namePlaceholder: "Your display name",
  handlePlaceholder: "3–20 lowercase letters, digits, or _",
  setHandlePrompt: "Set @handle",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  signIn: "Sign in",
  signInToMoss: "Sign in to Moss",
  signedOutTitle: "Not signed in",
  signedOutLocalHint: "Saved on this computer. Sign in to sync with your Moss account.",
  offlineNotice: "Can’t reach Moss account service. Showing cached copy; editing resumes online.",
  retrySync: "Retry",
  loadStatsError: "Couldn’t load your local stats.",
  tryAgain: "Try again",
  planManageHint: "Manage account & plan",
  stats: {
    lifetimeTokens: "Lifetime tokens",
    peakDay: "Peak day",
    longestTask: "Longest task",
    longestStreak: "Longest streak",
    currentStreak: "Current streak",
  },
  heatmap: {
    title: "Token activity",
    daily: "Daily",
    weekly: "Weekly",
    cumulative: "Cumulative",
    claudeNote:
      "Claude token totals use verifiable records. Older history and unfinished turns may be incomplete.",
  },
  sections: {
    recentWork: "Recent project & overview",
    topProject: "Most worked project",
    topProjectMeta: (prompts, threads, days) =>
      `${prompts} prompts · ${threads} threads · ${days} active days`,
    noRecentWork: "No project activity yet. Start a chat in Moss to see highlights here.",
    popularPlugins: "Most used plugins",
    noPlugins: "No skills or agents used yet.",
    runs: (count) => `${count} runs`,
    activityInsights: "Activity insights",
    mostUsedProvider: "Most used provider",
    mostUsedReasoning: "Most used reasoning",
    mostActiveHour: "Most active hour",
    skillsExplored: "Skills explored",
    totalPrompts: "Total prompts",
    totalThreads: "Total threads",
    modelUsage: "Model usage",
    shareOfTokens: "Share of tracked tokens.",
    shareOfTurns: "Share of turns.",
    noModelActivity: "No model activity yet.",
    providerShareOfTokens: (percent) => ` · ${percent}% of tracked tokens`,
    providerShareOfTurns: (percent) => ` · ${percent}% of turns`,
  },
  avatarPicker: {
    title: "Choose avatar",
    description: "Pick a minimal Moss preset or upload your own photo.",
    tabPresets: "Presets",
    tabUpload: "Upload image",
    tabInitials: "Initials",
    categoryAll: "All",
    categories: {
      moss: "Moss",
      people: "Minimal faces",
      friends: "Cute companions",
    },
    uploadPrompt: "Choose a photo to crop into a circle",
    uploadHint: "PNG, JPEG, or WebP up to 1 MB.",
    chooseImage: "Upload image",
    replaceImage: "Choose another",
    zoomLabel: "Zoom",
    initialsHint: "Show a clean initials badge from your display name.",
    accentColorLabel: "Accent",
    saveAvatar: "Save avatar",
    uploading: "Uploading…",
    processing: "Processing…",
  },
  handleStatus: {
    available: "Available",
    current: "Current handle",
    taken: "This handle is already taken",
    reserved: "This handle is reserved",
    too_short: "Must be at least 3 characters",
    too_long: "Must be 20 characters or fewer",
    invalid_characters: "Use lowercase letters, digits, and underscores only",
    unverified: "Can’t check uniqueness right now; will verify on save",
  },
  handleChecking: "Checking availability…",
  nameErrors: {
    empty: "Display name can’t be empty",
    too_long: "Display name must be 32 characters or fewer",
    invalid_characters: "Display name can’t include line breaks or control characters",
  },
  errors: {
    offline: "Can’t reach Moss account service right now. Try again later.",
    handleTaken: "This handle is already taken.",
    invalid: "Profile details are invalid. Please check and try again.",
    avatarInvalid: "Avatar must be a PNG, JPEG, or WebP image under 1 MB.",
    unknown: "Couldn’t save changes. Please try again.",
  },
  accountSettings: {
    profileShortcutTitle: "Profile",
    profileShortcutDescription: "Customize your avatar, name, @handle, and view activity stats.",
    openProfile: "Open profile",
    signedOutTitle: "Not signed in",
    signedOutDescription: "Sign in to use Moss quota, plans, and sync your profile across devices.",
    goToSignIn: "Sign in",
    backToPhoneAccount: "Back to phone account",
    googleAccountsTitle: "Saved accounts",
    googleAccountsDescription: "Switch without signing out.",
    switchWithoutSignOut: "Switch without signing out.",
    addAccount: "Add account",
    noSavedAccounts: "No saved Moss accounts.",
    current: "Current",
    ready: "Ready",
    signInAgain: "Sign in again",
    use: "Use",
    switching: "Switching…",
    remove: "Remove",
    removing: "Removing…",
    usageAndCreditsTitle: "Usage and credits",
    usageAndCreditsDescription: "Open Settings → Usage to see quota and buy credits.",
    openUsage: "Open Usage",
    signOut: "Sign out",
    signingOut: "Signing out…",
    sessionExpires: (formatted) => `Session expires ${formatted}`,
    actionFailed: "Account action failed",
    loadFailedTitle: "Couldn’t connect to Moss",
    loadFailedDescription: "Restart Moss and try again.",
    retry: "Try again",
    signInUnavailable: "Moss account sign-in isn’t available right now.",
    loading: "Loading your Moss account…",
    verified: "Verified",
    verificationNeeded: "Verification needed",
    signedIn: "Signed in",
  },
};

export function getProfileCopy(locale: MossLocaleCode): ProfileCopy {
  return locale === "zh-CN" ? ZH_COPY : EN_COPY;
}
