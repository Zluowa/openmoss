// FILE: zhCNBrowserCopy.ts
// Purpose: Simplified Chinese for the browser panel, saved logins and cookie import.
// Layer: Pure localization data
// Cookie, Keychain and Full Disk Access keep the names the operating system shows.

import { phraseTranslator } from "./zhCNPhraseTable";

const BROWSER_COPY: Readonly<Record<string, string>> = {
  // Panel: its servers list and "…" menu (the keyed copy lives in localization.tsx; these
  // cover the same words wherever they show as plain text).
  "Show dev server logs": "显示开发服务器日志",
  "Dev server logs": "开发服务器日志",
  Servers: "服务器",
  "See all": "查看全部",
  "Run a server to preview your app, or enter a URL.": "启动一个服务器来预览你的应用，或输入网址。",
  "Some entries in the launch file couldn't be read.": "启动文件里有些条目无法读取。",
  "Check its command in the launch file.": "请检查启动文件里的命令。",
  "Cancel element selection (Esc)": "取消选择元素（Esc）",
  "Select an element to annotate": "选择要标注的元素",
  "Cancel annotation": "取消标注",
  "Annotate page": "标注页面",
  "This page could not be loaded": "无法加载此页面",
  "Reload page": "重新加载页面",
  "Scanning local servers": "正在扫描本地服务器",
  "Checking localhost ports": "正在检查 localhost 端口",
  "The browser screenshot could not be prepared.": "无法准备浏览器截图。",
  Navigation: "导航",
  "Page tools": "页面工具",
  "Page actions": "页面操作",
  "Browser menu": "浏览器菜单",
  "Browser is unavailable.": "浏览器不可用。",
  "Browser is sleeping": "浏览器处于休眠状态",
  "Restoring cached browser": "正在恢复缓存的浏览器",
  "Browser preview": "浏览器预览",
  Untitled: "未命名",
  "Bring the browser tab into view before annotating.": "标注前请先让浏览器标签显示出来。",
  "This page is still loading. Try annotating again in a moment.":
    "此页面仍在加载。请稍后再试着标注。",
  "This browser tab isn't available for annotation.": "此浏览器标签无法标注。",
  "Annotation mode is already active.": "标注模式已开启。",
  "Couldn't close annotation mode. Try again.": "无法关闭标注模式。请重试。",
  "Couldn't refresh annotation markers.": "无法刷新标注标记。",
  "Couldn't start annotation mode. Try again.": "无法开启标注模式。请重试。",
  "Close annotation": "关闭标注",
  "Close annotation (Esc)": "关闭标注（Esc）",
  "Select an element or draw on the page": "选择元素，或在页面上画标记",
  "Annotation tools": "标注工具",
  "Select element": "选择元素",
  Draw: "画笔",
  Shapes: "形状",
  Rectangle: "矩形",
  Ellipse: "椭圆",
  Arrow: "箭头",
  Line: "直线",
  "Add text": "文字",
  "Add to chat": "添加到对话",
  "Adding…": "正在添加…",
  "Discard your marks?": "放弃这些标记？",
  "Keep editing": "继续编辑",
  Discard: "放弃",
  "Annotation text": "标注文字",
  "Type, then Enter": "输入后按回车",
  "The marked page could not be prepared.": "无法生成带标记的页面截图。",
  "The marked page could not be added.": "无法添加带标记的页面截图。",

  // Page comments
  "Comment on the page": "在页面上评论",
  "Leave comment mode": "退出评论模式",
  "Leave comment mode (Esc)": "退出评论模式（Esc）",
  "Comment options": "评论选项",
  "All comments": "所有评论",
  "Hide all comments": "收起所有评论",
  "Hide comment markers": "隐藏评论标记",
  "Show comment markers": "显示评论标记",
  "New comment": "新评论",
  "Ask Moss about this…": "问问 Moss…",
  "Add a comment…": "添加评论…",
  "Send to Moss": "发给 Moss",
  "Post comment": "发表评论",
  "Post (Enter)": "发表（回车）",
  Dictate: "语音输入",
  "Stop dictation": "停止语音输入",
  "Comment thread": "评论串",
  "Close comment": "关闭评论",
  "Reply…": "回复…",
  "thinking…": "思考中…",
  "Moss finished without replying here.": "Moss 已完成，但没有在这里回复。",
  "Newest first": "最新在前",
  "Oldest first": "最早在前",
  "Close comments": "关闭评论",
  "No comments yet. Turn on comment mode, then click anywhere on the page.":
    "还没有评论。打开评论模式，然后点击页面上的任意位置。",
  "1 reply": "1 条回复",
  "Sent to Moss": "已发给 Moss",
  You: "你",

  // Saved logins
  "Saved logins": "已保存的登录信息",
  "Saved logins could not be loaded.": "无法加载已保存的登录信息。",
  "The change could not be saved. Please try again.": "无法保存更改。请重试。",
  "Loading saved logins...": "正在加载已保存的登录信息…",
  "Saved logins are locked.": "已保存的登录信息已锁定。",
  Unlock: "解锁",
  "Set master password": "设置主密码",
  "Update password?": "更新密码？",
  "Save password?": "保存密码？",
  Logins: "登录信息",
  "No saved logins.": "没有已保存的登录信息。",
  "Back to browser": "返回浏览器",
  "No username": "没有用户名",
  "Saved by an agent": "由智能体保存",
  "Saved by you": "由你保存",
  "Saved login": "已保存的登录信息",
  "Unfinished signup": "未完成的注册",
  "(expired)": "（已过期）",
  "Reveal password": "显示密码",
  "Delete login": "删除登录信息",
  "Delete this saved login?": "删除这条已保存的登录信息？",
  "Saving and access": "保存与访问",
  "Saving & access": "保存与访问",
  "Master password": "主密码",
  "Lock saved logins": "锁定已保存的登录信息",
  "Allow agents to find saved accounts": "允许智能体查找已保存的账号",
  "Agent password filling and generation are unavailable.": "智能体无法填写和生成密码。",
  "Offer to save passwords": "提示保存密码",
  "Autosave accepted logins": "自动保存已接受的登录信息",
  "Use at least 12 characters and enter the same password twice.":
    "请至少使用 12 个字符，并输入两次相同的密码。",
  "Could not verify the master password. Try again shortly.": "无法验证主密码。请稍后重试。",
  "Revealed password": "已显示的密码",
  "New master password": "新主密码",
  "Confirm master password": "确认主密码",
  "Keep this password somewhere safe. A forgotten master password cannot be reset here.":
    "请把这个密码保存在安全的地方。忘记主密码后无法在这里重置。",
  "Verifying...": "正在验证…",

  // Cookie import
  "macOS denied access to Safari's cookie files. Allow Moss in System Settings > Privacy & Security > Full Disk Access, then quit and reopen Moss before retrying. Revisit Safari import setup in Moss Settings > General for the correct app. You can sign in directly instead.":
    "macOS 拒绝访问 Safari 的 Cookie 文件。请在“系统设置 > 隐私与安全性 > 完全磁盘访问权限”中允许 Moss，然后退出并重新打开 Moss 再重试。你可以在 Moss 的“设置 > 通用”中重新查看 Safari 导入设置，确认选择了正确的应用。也可以直接登录。",
  "macOS denied access to this browser's cookie data. Review Moss's file access in Privacy & Security and any Keychain prompt, then retry.":
    "macOS 拒绝访问此浏览器的 Cookie 数据。请检查“隐私与安全性”中 Moss 的文件访问权限和钥匙串提示，然后重试。",
  "The operating system denied access to this browser's cookie data. Review its access permissions or sign in directly.":
    "操作系统拒绝访问此浏览器的 Cookie 数据。请检查它的访问权限，或直接登录。",
  "The browser reader timed out. Close the source browser and retry.":
    "读取浏览器数据超时。请关闭来源浏览器后重试。",
  "The selected profile is no longer available. Choose another profile or open the source browser first.":
    "所选配置文件已不可用。请选择其他配置文件，或先打开来源浏览器。",
  "The native cookie reader is unavailable. Reinstall Moss with its optional native dependencies, or sign in directly.":
    "原生 Cookie 读取器不可用。请重新安装包含可选原生依赖的 Moss，或直接登录。",
  "Cookies were imported, but secure storage could not save their session state for future launches. Existing sessions may have changed.":
    "Cookie 已导入，但安全存储无法保存会话状态供以后启动时使用。现有会话可能已发生变化。",
  "The native reader could not open or acquire the source cookie store. A permission denial was not confirmed. Check that the source profile is available and Moss has access to it.":
    "原生读取器无法打开或获取来源 Cookie 存储，但未确认是权限被拒绝。请检查来源配置文件是否可用，以及 Moss 是否有权访问它。",
  "The native reader could not decode this profile's cookie data. This is a cookie-format failure, not a confirmed permission denial.":
    "原生读取器无法解码此配置文件的 Cookie 数据。这是 Cookie 格式问题，并未确认是权限被拒绝。",
  "The native reader could not decrypt this profile's cookies. Review any OS key-store prompt, or sign in directly.":
    "原生读取器无法解密此配置文件的 Cookie。请检查系统密钥库的提示，或直接登录。",
  "The native reader could not read this profile. A permission denial was not identified. Close the source browser and retry, or sign in directly.":
    "原生读取器无法读取此配置文件，但未发现权限被拒绝。请关闭来源浏览器后重试，或直接登录。",
  "The cookie transfer could not be verified. Existing sessions may have changed; retry or sign in directly.":
    "无法验证 Cookie 转移结果。现有会话可能已发生变化；请重试或直接登录。",
  "No available profiles found.": "未找到可用的配置文件。",
  "Profiles could not be read. Check browser installation and system permissions.":
    "无法读取配置文件。请检查浏览器安装情况和系统权限。",
  "Cookie import is unavailable on this platform.": "此平台不支持导入 Cookie。",
  "Cookie import is unavailable. Sign in directly in the browser instead.":
    "无法导入 Cookie。请直接在浏览器中登录。",
  "Import stopped because the browser destination changed or the operation became unavailable. Select the destination and retry.":
    "导入已停止，因为目标浏览器已变更或此操作已不可用。请选择目标后重试。",
  "Import browser cookies": "导入浏览器 Cookie",
  "Import scope": "导入范围",
  "Cookie import scope": "Cookie 导入范围",
  "This site:": "此网站：",
  "All sites in this profile": "此配置文件中的所有网站",
  "Imports all compatible cookies from the selected profile. Every imported signed-in session becomes available across Moss browser tabs and agent workflows.":
    "导入所选配置文件中所有兼容的 Cookie。每个导入的登录会话都可在 Moss 浏览器标签和智能体工作流中使用。",
  "Imports this site, its subdomains, and matching parent domains. Imported sessions are shared across Moss browser tabs and agent workflows.":
    "导入此网站、它的子域名和匹配的上级域名。导入的会话会在 Moss 浏览器标签和智能体工作流之间共享。",
  "Cookie source browser": "Cookie 来源浏览器",
  "Cookie source profile": "Cookie 来源配置文件",
  "I allow Moss and its agents to use all imported signed-in sessions from this profile.":
    "我允许 Moss 及其智能体使用此配置文件中所有导入的登录会话。",
  "Working...": "正在处理…",
  "Import all sites": "导入所有网站",
  "Import for this site": "导入此网站",
};

export const translateZhCnBrowserCopyText = phraseTranslator(BROWSER_COPY, [
  [/^Search the web for "(.+)"$/, "在网上搜索“$1”"],
  [/^Open (https?:\/\/\S+)$/, "打开 $1"],
  [/^You can attach up to (\d+) references per message\.$/, "每条消息最多可附加 $1 个引用。"],
  [/^Reveal password for (.+)$/, "显示 $1 的密码"],
  [/^(\d+) replies$/, "$1 条回复"],
  [/^Moss · via (.+)$/, "Moss · 经由 $1"],
  [/^Unread comment from (.+)$/, "$1 的未读评论"],
  [/^Comment from (.+)$/, "$1 的评论"],
  [/^Delete login for (.+)$/, "删除 $1 的登录信息"],
  [/^(\d+) cookies? imported\. (\d+) skipped\.$/, "已导入 $1 个 Cookie，跳过 $2 个。"],
  [
    /^(\d+) cookies? imported\. (\d+) skipped\. Some cookies could not be transferred; you may need to sign in again\.$/,
    "已导入 $1 个 Cookie，跳过 $2 个。部分 Cookie 无法转移，你可能需要重新登录。",
  ],
]);
