// FILE: zhCNPullRequests.ts
// Purpose: Simplified-Chinese presentation translations for the pull-request workspace and
//          its shared sidebar/environment surfaces. Dynamic identifiers are captured and
//          reinserted verbatim; unknown text is deliberately left untouched.
// Layer: Web localization
// Exports: translateZhCnPullRequestText

const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  // Sidebar entry, list header, filters, and list states.
  "Pull requests": "拉取请求",
  "Pull request": "拉取请求",
  "Pull Request": "拉取请求",
  "Refresh pull requests": "刷新拉取请求",
  "Wait for the pull request action to finish": "请等待拉取请求操作完成",
  Refresh: "刷新",
  "Search pull requests": "搜索拉取请求",
  All: "全部",
  Reviewing: "待我审查",
  Authored: "我创建的",
  Closed: "已关闭",
  Merged: "已合并",
  Project: "项目",
  "All projects": "所有项目",
  "Filter by project": "按项目筛选",
  Pinned: "已固定",
  "Review requested": "待审查",
  Others: "其他",
  "Review requests only apply to open pull requests": "审查请求仅适用于处于开启状态的拉取请求",
  "No pull requests found": "未找到拉取请求",
  "Select Open to see pull requests currently awaiting your review.":
    "选择“开启中”以查看当前等待你审查的拉取请求。",
  "Try another involvement, state, project, or search filter.":
    "请尝试其他参与范围、状态、项目或搜索条件。",
  "Could not update pull request pin": "无法更新拉取请求固定状态",
  "The pin could not be saved.": "无法保存固定状态。",
  "Could not refresh pull requests": "无法刷新拉取请求",
  "The pull request list could not be refreshed.": "无法刷新拉取请求列表。",
  "The latest background refresh failed. Showing the last available pull requests.":
    "最近一次后台刷新失败，正在显示上次可用的拉取请求。",
  "Loading pull request...": "正在加载拉取请求…",
  "Loading pull request…": "正在加载拉取请求…",
  "The pull request review count is temporarily incomplete": "拉取请求审查数量暂时不完整",

  // Detail header, actions, confirmation, and status feedback.
  Summary: "概览",
  Timeline: "时间线",
  Code: "代码",
  "Pull request detail tabs": "拉取请求详情标签",
  "Open in external browser": "在外部浏览器中打开",
  "More actions": "更多操作",
  Draft: "草稿",
  "Ready for review": "可供审查",
  Merge: "合并",
  merge: "合并",
  squash: "压缩合并",
  rebase: "变基合并",
  "Merging…": "正在合并…",
  "Copy link": "复制链接",
  "Preparing findings…": "正在准备问题…",
  "Fix findings": "修复问题",
  "Preparing conflicts…": "正在准备冲突处理…",
  "Resolve conflicts": "解决冲突",
  "Close pull request": "关闭拉取请求",
  "Reopen pull request": "重新打开拉取请求",
  "Resolve merge conflicts before merging": "合并前请先解决冲突",
  "Close pull request panel": "关闭拉取请求面板",
  Close: "关闭",
  "Pull request not found": "未找到拉取请求",
  "The selected pull request could not be loaded.": "无法加载所选拉取请求。",
  "Could not refresh pull request details. Showing saved data.":
    "无法刷新拉取请求详情，正在显示已保存的数据。",
  "Merge pull request?": "确认合并拉取请求？",
  "Close pull request?": "确认关闭拉取请求？",
  Cancel: "取消",
  "Pull request merged": "拉取请求已合并",
  "Marked ready for review": "已标记为可供审查",
  "Converted to draft": "已转为草稿",
  "Pull request closed": "拉取请求已关闭",
  "Pull request reopened": "拉取请求已重新打开",
  "Pull request action failed": "拉取请求操作失败",
  "GitHub CLI action failed.": "GitHub CLI 操作失败。",
  "Could not create a draft thread for this pull request.": "无法为此拉取请求创建草稿对话。",
  "The PR thread could not be prepared.": "无法准备拉取请求对话。",
  "Could not prepare findings": "无法准备问题修复",
  "Could not prepare conflict resolution": "无法准备冲突解决",
  "Pull request link copied": "已复制拉取请求链接",
  "Could not copy pull request link": "无法复制拉取请求链接",
  "Clipboard access failed.": "无法访问剪贴板。",

  // Summary, comments, checks, state labels, and code tab.
  Branch: "分支",
  "Has conflicts": "存在冲突",
  Reviewers: "审查者",
  None: "无",
  Comments: "评论",
  Checks: "检查",
  Description: "描述",
  "No description provided.": "未提供描述。",
  "_No description provided._": "_未提供描述。_",
  "No checks reported.": "未报告检查。",
  "Some unresolved review comments could not be loaded. Check GitHub for the complete review.":
    "部分未解决的审查评论无法加载，请前往 GitHub 查看完整审查。",
  "More unresolved review comments may be available on GitHub.":
    "GitHub 上可能还有更多未解决的审查评论。",
  "No comments": "暂无评论",
  "Leave a comment": "发表评论",
  "Post comment": "发布评论",
  "Commenting as your GitHub account": "将使用你的 GitHub 账号发表评论",
  "Could not post comment": "无法发布评论",
  "GitHub CLI comment failed.": "GitHub CLI 评论操作失败。",
  Running: "运行中",
  Succeeded: "已成功",
  Failed: "失败",
  Skipped: "已跳过",
  Neutral: "中性",
  Cancelled: "已取消",
  "No checks": "暂无检查",
  "No required checks": "没有必需检查",
  "All checks passed": "所有检查均已通过",
  "Comments may exist": "可能有评论",
  "High Severity": "高严重度",
  "Medium Severity": "中严重度",
  "Low Severity": "低严重度",
  High: "高",
  Medium: "中",
  Low: "低",
  Severity: "严重度",
  Reply: "回复",
  "No review body.": "没有审查内容。",
  "_No review body._": "_没有审查内容。_",
  "Diff exceeded 8 MiB and was truncated.": "差异超过 8 MiB，已截断。",
  "Loading pull request diff…": "正在加载拉取请求差异…",
  "Could not load diff.": "无法加载差异。",
  "This pull request has no file changes.": "此拉取请求没有文件更改。",
  "The pull request diff is unavailable.": "拉取请求差异不可用。",
  "Select a pull request to open it here.": "选择一个拉取请求以在此处打开。",
  "No commit message.": "没有提交信息。",
  "PR open": "拉取请求开启中",
  "PR closed": "拉取请求已关闭",
  "PR merged": "拉取请求已合并",
  "PR draft": "拉取请求为草稿",
  "PR has conflicts": "拉取请求存在冲突",

  // Missing/unauthenticated GitHub CLI states.
  "Could not copy command": "无法复制命令",
  "Copy to clipboard": "复制到剪贴板",
  Copied: "已复制",
  Copy: "复制",
  "GitHub CLI is required": "需要 GitHub CLI",
  "Sign in to GitHub CLI": "登录 GitHub CLI",
  "Pull requests are unavailable": "拉取请求不可用",
  "Moss reads GitHub data only through the gh CLI. Install it, then reopen this view.":
    "Moss 仅通过 gh CLI 读取 GitHub 数据。安装后请重新打开此视图。",
  "Authenticate the GitHub CLI in a terminal, then retry.": "请在终端中登录 GitHub CLI，然后重试。",
  "The pull request request failed.": "拉取请求失败。",
  "Install instructions": "安装说明",
  Retry: "重试",
  "Check your connection and try again.": "请检查网络连接后重试。",

  // Chat Environment panel's pull-request section.
  "Open pull request file changes": "打开拉取请求文件更改",
  "Drafts a prompt in the composer asking the agent to resolve the merge conflicts — review it, then send":
    "在输入框中生成解决合并冲突的提示词；请审阅后发送",
  Fix: "修复",
  "Merged on GitHub": "已在 GitHub 合并",
  "Closed on GitHub": "已在 GitHub 关闭",
  "Couldn't load PR data": "无法加载拉取请求数据",
  "Retry loading checks and review comments": "重新加载检查和审查评论",
  "Loading checks…": "正在加载检查…",
  "No checks reported for this PR.": "此拉取请求未报告检查。",
  "Loading comments…": "正在加载评论…",
  "Comments unavailable": "评论不可用",
  "Review comments may be hidden by the bounded preview. Open the PR on GitHub.":
    "受限预览可能隐藏了审查评论，请在 GitHub 上打开此拉取请求。",
  "No unresolved review comments.": "没有未解决的审查评论。",
  "More review comments may be available on GitHub.": "GitHub 上可能还有更多审查评论。",
  "Draft one prompt containing all visible review comments": "生成包含所有可见审查评论的提示词",
  "(empty comment)": "（空评论）",

  // Checkout-pull-request dialog.
  "Checkout Pull Request": "检出拉取请求",
  "Resolve a GitHub pull request, then create the draft thread in the main repo or in a dedicated worktree.":
    "解析 GitHub 拉取请求，然后在主仓库或独立工作树中创建草稿对话。",
  "Paste a GitHub pull request URL or enter 123 / #123.":
    "请粘贴 GitHub 拉取请求 URL，或输入 123 / #123。",
  "Use a GitHub pull request URL, 123, or #123.": "请使用 GitHub 拉取请求 URL、123 或 #123。",
  "Failed to resolve pull request.": "无法解析拉取请求。",
  "Failed to prepare pull request thread.": "无法准备拉取请求对话。",
  "Resolving pull request...": "正在解析拉取请求…",
  "Preparing local...": "正在准备本地检出…",
  Local: "本地",
  "Preparing worktree...": "正在准备工作树…",
  Worktree: "工作树",
};

const REPLACEMENT_TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Project/repository names and PR numbers are retained verbatim.
  [/^(\d+) projects$/, "$1 个项目"],
  [/^Filter pull requests by project: All projects$/, "按项目筛选拉取请求：所有项目"],
  [/^Filter pull requests by project: (.+)$/, "按项目筛选拉取请求：$1"],
  [/^View pull requests for (.+)$/, "查看 $1 的拉取请求"],
  [/^Pin pull request #(\d+) in (\d+) projects$/, "固定拉取请求 #$1（涉及 $2 个项目）"],
  [/^Unpin pull request #(\d+) in (\d+) projects$/, "取消固定拉取请求 #$1（涉及 $2 个项目）"],
  [/^Pin pull request #(\d+) in (.+)$/, "固定拉取请求 #$1（$2）"],
  [/^Unpin pull request #(\d+) in (.+)$/, "取消固定拉取请求 #$1（$2）"],
  [/^Pin pull request #(\d+)$/, "固定拉取请求 #$1"],
  [/^Unpin pull request #(\d+)$/, "取消固定拉取请求 #$1"],

  // Accessible review-count labels preserve their numeric count.
  [
    /^At least (\d+) pull requests? (?:is|are) waiting for your review$/,
    "至少有 $1 个拉取请求等待你审查",
  ],
  [/^(\d+) pull requests? (?:is|are) waiting for your review$/, "$1 个拉取请求等待你审查"],

  // Detail/timeline variables are identifiers, not translation input.
  [/^Conflicts with (.+)$/, "与 $1 冲突"],
  [/^(.+?) opened this pull request$/, "$1 打开了此拉取请求"],
  [/^(.+?) reviewed$/, "$1 已审查"],
  [/^(.+?) commented$/, "$1 已评论"],
  [/^Commit ([0-9a-fA-F]{7,40})$/, "提交 $1"],
  [/^This will merge #(\d+) using merge\.$/, "将以普通合并方式合并 #$1。"],
  [/^This will merge #(\d+) using squash\.$/, "将以压缩合并方式合并 #$1。"],
  [/^This will merge #(\d+) using rebase\.$/, "将以变基合并方式合并 #$1。"],
  [/^This will close #(\d+) without merging it\.$/, "将关闭 #$1，但不会合并。"],

  // Count summaries generated by the list, checks, comments, and diff helpers.
  [/^(\d+) files?$/, "$1 个文件"],
  [/^(\d+) failing checks?$/, "$1 项检查失败"],
  [/^(\d+) cancelled checks?$/, "$1 项检查已取消"],
  [/^(\d+) pending checks?$/, "$1 项检查进行中"],
  [/^(\d+)(\+?) comments?$/, "$1$2 条评论"],
  [
    /^Showing the first 50 matching pull requests for (\d+) repositor(?:y|ies)\.$/,
    "仅显示 $1 个仓库中前 50 个匹配的拉取请求。",
  ],
  [
    /^(\d+) project repositor(?:y was|ies were) unavailable\. Healthy repositories are still shown\.$/,
    "$1 个项目的仓库不可用；正常仓库仍会显示。",
  ],
  [/^Couldn't load review comments: (.+)$/, "无法加载审查评论：$1"],
];

/**
 * Translates a known pull-request presentation string to Simplified Chinese.
 *
 * Regexes are intentionally anchored and only interpolate known dynamic slots. Repository,
 * branch, actor, path, and check identifiers are never independently interpreted or rewritten.
 */
export function translateZhCnPullRequestText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  for (const [pattern, replacement] of REPLACEMENT_TRANSLATIONS) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }

  return value;
}
