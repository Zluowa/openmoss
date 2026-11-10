// FILE: zhCNCodeReviewCopy.ts
// Purpose: Simplified Chinese for Code review: the GitHub inbox list and filters, issue details,
//          and the parts of the pull request panel `zhCNPullRequests.ts` does not reach.
// Layer: Pure localization data
// Issue reads 问题, matching the Issues tab. Branches, repositories, numbers and people's names
// pass through the patterns untouched.

import { lookupPhrase, phraseTranslator } from "./zhCNPhraseTable";

const CODE_REVIEW_COPY: Readonly<Record<string, string>> = {
  "Connect GitHub to Moss": "连接 GitHub 到 Moss",
  "Connect the GitHub account on this computer to see pull requests and issues. You can skip this and start chatting.":
    "连接这台电脑上的 GitHub 账号后即可查看拉取请求和问题。你也可以跳过，直接开始聊天。",
  "Set up GitHub": "设置 GitHub",
  "Checking GitHub connection\u2026": "正在检查 GitHub 连接…",
  "Authorize Moss with GitHub": "在 GitHub 上授权",
  "GitHub sign-in could not be confirmed": "未能确认 GitHub 登录",
  "Could not check the GitHub connection": "无法检查 GitHub 连接",
  "Another GitHub sign-in is in progress": "另一个窗口正在连接 GitHub",
  "Connect GitHub": "连接 GitHub",
  "Sign in to GitHub": "登录 GitHub",
  "Sign in once, and Code review lists the pull requests and issues you opened, that await your review, or that are assigned to you.":
    "登录一次，代码审查就会列出你发起的、等你审查的和指派给你的拉取请求和问题。",
  // "My GitHub": the person's own items across GitHub, listed with or without projects.
  "My GitHub": "我的 GitHub",
  "Nothing on GitHub needs you right now": "GitHub 上暂时没有需要你处理的内容",
  "Pull requests and issues you opened, that await your review, or that are assigned to you show up here. Add a project to see everything in its repository.":
    "你发起的、等你审查的和指派给你的拉取请求和问题会显示在这里。添加项目后，还能看到该仓库里的全部内容。",
  "Your GitHub items could not be loaded": "未能读取你在 GitHub 上的内容",
  "Side chats need a project": "侧边对话需要一个项目",
  "Add this repository as a project in Moss to ask an agent about it.":
    "把这个仓库添加为 Moss 项目后，就可以让智能体处理它。",
  "Enter this one-time code on GitHub and return here after approving access.":
    "在 GitHub 页面输入这组一次性代码，确认授权后返回这里。",
  "Install GitHub CLI on the computer running Moss, then check again.":
    "请在运行 Moss 的电脑上安装 GitHub CLI，然后重新检查。",
  "Moss uses the GitHub account on this computer to load pull requests and issues.":
    "Moss 使用这台电脑上的 GitHub 账号读取拉取请求和问题。",
  "GitHub device code": "GitHub 一次性代码",
  "Open GitHub": "打开 GitHub",
  "Get GitHub CLI": "获取 GitHub CLI",
  // One-click GitHub CLI install.
  "Moss uses GitHub CLI to load pull requests and issues. Install it here in one step.":
    "Moss 通过 GitHub CLI 读取拉取请求和问题，点一下即可在这里安装。",
  "Install GitHub CLI": "安装 GitHub CLI",
  "Installing GitHub CLI…": "正在安装 GitHub CLI…",
  "Installing GitHub CLI": "正在安装 GitHub CLI",
  "Downloading GitHub CLI…": "正在下载 GitHub CLI…",
  "Setting up GitHub CLI for Moss…": "正在为 Moss 设置 GitHub CLI…",
  "GitHub CLI download": "GitHub CLI 下载进度",
  "Installing GitHub CLI. If an installer window opens, finish it there.":
    "正在安装 GitHub CLI。如果弹出安装窗口，请在窗口中完成安装。",
  "Checking the installation…": "正在检查安装结果…",
  "GitHub CLI could not be installed": "未能安装 GitHub CLI",
  "Moss can't install GitHub CLI on this computer by itself. Get it from the GitHub CLI website, then check again.":
    "Moss 无法在这台电脑上自动安装 GitHub CLI。请从 GitHub CLI 官网下载安装，然后重新检查。",
  "The download didn't finish. Check your network and try again, or get it from the GitHub CLI website.":
    "下载没有完成。请检查网络后重试，或从 GitHub CLI 官网下载。",
  "The installer didn't finish. Try again, or get it from the GitHub CLI website.":
    "安装没有完成。请重试，或从 GitHub CLI 官网下载。",
  "GitHub CLI was installed, but Moss couldn't start it. Try again, or get it from the GitHub CLI website.":
    "GitHub CLI 已装好，但 Moss 没能启动它。请重试，或从 GitHub CLI 官网下载。",
  "Open the GitHub CLI website": "打开 GitHub CLI 官网",
  "Check again": "重新检查",
  "Repositories could not be checked": "未能检查仓库",
  "Retry to check the repositories that did not respond.": "重新检查未响应的仓库。",
  "No GitHub remote configured": "尚未配置 GitHub 远端",
  "Add a project with a GitHub.com remote, or configure a remote in an existing project.":
    "添加一个关联 GitHub.com 远端的项目，或给现有项目配置远端。",
  "The browser could not open. Try again or visit the address below.":
    "未能打开浏览器。请重试，或在浏览器中打开下方地址。",
  // Inbox list
  "Resize code review list": "调整代码审查列表宽度",
  "Loading code review": "正在加载代码审查",
  "Code review list": "代码审查列表",
  "Select a pull request or issue": "选择一个拉取请求或问题",
  "Choose one from the sidebar to review it": "从侧边栏选择一项进行审查",
  "Could not update pin": "无法更新固定状态",
  "Refreshing…": "正在刷新…",
  "Could not refresh code review": "无法刷新代码审查",
  "Code review could not be refreshed.": "无法刷新代码审查。",
  "Pull requests and issues": "拉取请求和问题",
  "No issues found": "未找到问题",
  "No pull requests and issues found": "未找到拉取请求和问题",
  "Code review lists pull requests and issues from the GitHub repositories of your projects.":
    "代码审查会列出你的项目所关联 GitHub 仓库中的拉取请求和问题。",
  "Select Open to see pull requests awaiting your review.":
    "选择“打开”可查看等待你审查的拉取请求。",
  "Try another filter, or clear them.": "请尝试其他筛选条件，或清除筛选。",
  "Nothing here in the repositories of your projects.": "你的项目仓库中没有相关内容。",
  "Clear filters": "清除筛选",
  "The latest background refresh failed. Showing the last loaded items.":
    "最近一次后台刷新失败，正在显示上次加载的内容。",
  "Item details": "条目详情",
  "Needs my review": "待我审查",
  "Everything else": "其他全部",

  // Filters and sorting
  Newest: "最新",
  "Recently updated": "最近更新",
  Anyone: "任何人",
  "Involving me": "与我相关",
  "Authored by me": "我创建的",
  "Assigned to me": "分配给我的",
  PRs: "PR",
  "Sort by": "排序方式",
  Filter: "筛选",
  Involvement: "参与方式",
  "No projects": "没有项目",
  Labels: "标签",
  "No labels in this view": "此视图中没有标签",
  "More code review actions": "更多代码审查操作",
  "Search or paste a PR link": "搜索或粘贴 PR 链接",
  "Search pull requests and issues": "搜索拉取请求和问题",
  "Active filters": "已启用的筛选条件",

  // Issue detail and side chat
  Issue: "问题",
  "Issue detail tabs": "问题详情标签",
  "Issue not found": "未找到问题",
  "The selected issue could not be loaded.": "无法加载所选问题。",
  "Could not refresh the issue. Showing saved data.": "无法刷新问题，正在显示已保存的数据。",
  "Could not send the issue to an agent": "无法把问题发送给智能体",
  "Some comments are not shown here. Open the issue on GitHub for the full discussion.":
    "部分评论未显示在这里。请在 GitHub 上打开此问题查看完整讨论。",
  "Issue open": "问题开启中",
  "Issue closed": "问题已关闭",
  "Issue not planned": "问题不予处理",
  "Not planned": "不予处理",
  "New side chat": "新建侧边对话",
  "Could not start a side chat": "无法开始侧边对话",
  "Side chat is still syncing": "侧边对话仍在同步",
  "It will appear as soon as the thread list refreshes.": "对话列表刷新后就会显示。",
  "The item could not be loaded.": "无法加载此条目。",
  "Open side chat": "打开侧边对话",
  "Starting side chat": "正在开始侧边对话",
  "Ask in a side chat": "在侧边对话中询问",

  // Pull request panel
  "Preparing…": "正在准备…",
  "Send to agent": "发送给智能体",
  "Send to agent: choose project": "发送给智能体：选择项目",
  "Runs in this project's local checkout": "在此项目的本地检出中运行",
  "More ways to use this item": "使用此条目的更多方式",
  "just now": "刚刚",
  "Back to code review": "返回代码审查",
  Request: "请求审查",
  Reviews: "审查",
  "Merge status": "合并状态",
  Approved: "已批准",
  "Changes requested": "需要修改",
  "No reviews": "暂无审查",
  "View more": "查看更多",
  Assignees: "负责人",
  Opened: "创建时间",
  Image: "图片",
  "Link copied": "链接已复制",
  "Could not copy link": "无法复制链接",
  "Could not send the pull request to an agent": "无法把拉取请求发送给智能体",
  "Conflicts with": "冲突分支：",
  "Can merge without conflicts": "可无冲突合并",
  "Merge status unknown": "合并状态未知",
  "Mergeable with failing checks": "可合并，但有检查失败",
  "Merge status pending": "合并状态待定",
  "Ready to merge": "可以合并",

  // Stacks
  "Merge stack": "合并堆叠",
  "Merging stack…": "正在合并堆叠…",
  "Stack added to merge queue": "堆叠已加入合并队列",
  "Stack merged": "堆叠已合并",
  "Stack needs attention": "堆叠需要处理",
  "Stack details could not be loaded. Refresh before merging.":
    "无法加载堆叠详情。合并前请先刷新。",
  "Stack details are temporarily unavailable. Refresh before merging.":
    "堆叠详情暂时不可用。合并前请先刷新。",
  "This stack is not ready to merge.": "这个堆叠还不能合并。",
  "Stack #": "堆叠 #",
  "· targets": "· 目标分支",

  // GitHub availability
  "GitHub rate limit reached": "已达到 GitHub 速率限制",
  "Pull requests and issues are unavailable": "拉取请求和问题不可用",
  "Moss pauses GitHub requests until the limit resets.": "限制重置前，Moss 会暂停 GitHub 请求。",
  "The request to GitHub failed.": "向 GitHub 发送请求失败。",
  "The list refreshes on its own once the limit resets.": "限制重置后，列表会自动刷新。",

  // Starting a chat from an item
  "The thread could not be prepared.": "无法准备对话。",
  "Preparing pull request worktree…": "正在准备拉取请求的工作树…",
  "Checking out pull request branch…": "正在检出拉取请求的分支…",
  "Opening chat…": "正在打开对话…",
};

const LIST_ORDER: Readonly<Record<string, string>> = {
  newest: "最新",
  "most recently updated": "最近更新",
};
const LIST_NOUN: Readonly<Record<string, string>> = {
  "pull requests and issues": "拉取请求和问题",
  "pull requests": "拉取请求",
  issues: "问题",
};
const MERGE_METHOD: Readonly<Record<string, string>> = {
  merge: "普通合并",
  squash: "压缩合并",
  rebase: "变基合并",
};

function zhCnStackMergeDescription(match: RegExpExecArray): string {
  const [, through, baseBranch, method = "", remainder] = match;
  const remains = remainder ? "它上面的拉取请求会保持开启，GitHub 会调整它们的目标分支。" : "";
  return `将以${lookupPhrase(MERGE_METHOD, method) ?? method}方式，把到 #${through} 为止所有开启的拉取请求一次性合并到 ${baseBranch}。${remains}`;
}

export const translateZhCnCodeReviewCopyText = phraseTranslator(CODE_REVIEW_COPY, [
  [/^List takes (\d+)% of the width$/, "列表占宽度的 $1%"],
  [
    /^Showing the 50 (newest|most recently updated) (pull requests and issues|pull requests|issues) per repository\. (\d+) repositor(?:y has|ies have) more on GitHub\.$/,
    ({ 1: order = "", 2: noun = "", 3: count }) =>
      `每个仓库显示${lookupPhrase(LIST_ORDER, order)}的 50 个${lookupPhrase(LIST_NOUN, noun)}。${count} 个仓库在 GitHub 上还有更多。`,
  ],
  [
    /^Showing merged pull requests from the 50 (newest|most recently updated) closed pull requests per repository\. (\d+) repositor(?:y has|ies have) more on GitHub\.$/,
    ({ 1: order = "", 2: count }) =>
      `显示每个仓库${lookupPhrase(LIST_ORDER, order)}的 50 个已关闭拉取请求中已合并的部分。${count} 个仓库在 GitHub 上还有更多。`,
  ],
  [
    /^GitHub rate limit reached\. Showing the last loaded items\. Refreshing resumes at (.+)\.$/,
    "已达到 GitHub 速率限制，正在显示上次加载的内容。将在 $1 恢复刷新。",
  ],
  [
    /^GitHub rate limit reached\. Showing the last loaded items\. Refreshing resumes soon\.$/,
    "已达到 GitHub 速率限制，正在显示上次加载的内容。很快会恢复刷新。",
  ],
  [
    /^GitHub rate limit reached\. Some repositories could not be loaded\. Refreshing resumes at (.+)\.$/,
    "已达到 GitHub 速率限制，部分仓库无法加载。将在 $1 恢复刷新。",
  ],
  [
    /^GitHub rate limit reached\. Some repositories could not be loaded\. Refreshing resumes soon\.$/,
    "已达到 GitHub 速率限制，部分仓库无法加载。很快会恢复刷新。",
  ],
  [
    /^Moss pauses GitHub requests until the limit resets at (.+)\.$/,
    "Moss 会暂停 GitHub 请求，直到限制在 $1 重置。",
  ],
  [/^Filter \((\d+) active\)$/, "筛选（已启用 $1 项）"],
  [/^Pull request in (.+)$/, "$1 中的拉取请求"],
  [/^Issue in (.+)$/, "$1 中的问题"],
  [/^Ask about issue #(\d+)$/, "询问问题 #$1"],
  [/^Ask about PR #(\d+)$/, "询问 PR #$1"],
  [/^Ask about this pull request$/, "询问这个拉取请求"],
  [/^Ask about this issue$/, "询问这个问题"],
  [/^Send to agent in (.+)$/, "发送给 $1 中的智能体"],
  [/^Pin issue #(\d+) in (\d+) projects$/, "固定问题 #$1（涉及 $2 个项目）"],
  [/^Unpin issue #(\d+) in (\d+) projects$/, "取消固定问题 #$1（涉及 $2 个项目）"],
  [/^Pin issue #(\d+) in (.+)$/, "固定问题 #$1（$2）"],
  [/^Unpin issue #(\d+) in (.+)$/, "取消固定问题 #$1（$2）"],
  [/^Pin issue #(\d+)$/, "固定问题 #$1"],
  [/^Unpin issue #(\d+)$/, "取消固定问题 #$1"],
  [/^Someone opened this pull request$/, "有人打开了此拉取请求"],
  [/^Someone opened this issue$/, "有人打开了此问题"],
  [/^Someone reviewed$/, "有人已审查"],
  [/^Someone commented$/, "有人已评论"],
  [/^(.+?) opened this issue$/, "$1 打开了此问题"],
  [/^Commit ([0-9a-fA-F]{7,40}) by (.+)$/, "提交 $1（作者：$2）"],
  [/^Merge (\d+) pull requests?\?$/, "合并 $1 个拉取请求？"],
  [
    /^This will merge #(\d+) into (.+) using (merge|squash|rebase)\.$/,
    ({ 1: number, 2: baseBranch, 3: method = "" }) =>
      `将以${lookupPhrase(MERGE_METHOD, method)}方式把 #${number} 合并到 ${baseBranch}。`,
  ],
  [
    /^This will atomically merge every open pull request through #(\d+) into (.+) using (merge|squash|rebase)\.( Pull requests above it will remain open and GitHub will retarget them\.)?$/,
    zhCnStackMergeDescription,
  ],
  [/^Stack #(\d+)$/, "堆叠 #$1"],
  [/^View stack (\d+), pull request (\d+) of (\d+)$/, "查看堆叠 $1，第 $2 个拉取请求（共 $3 个）"],
  [/^Stack #(\d+), pull request (\d+) of (\d+)$/, "堆叠 #$1，第 $2 个拉取请求（共 $3 个）"],
  [
    /^Stack #(\d+) · PR (\d+) of (\d+) · targets (.+)$/,
    "堆叠 #$1 · 第 $2 个 PR（共 $3 个）· 目标分支 $4",
  ],
  [/^(\d+) skipped$/, "$1 项已跳过"],
]);
