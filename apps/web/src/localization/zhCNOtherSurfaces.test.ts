// FILE: zhCNOtherSurfaces.test.ts
// Purpose: Locks the zh-CN copy of tasks, code review, the browser panel, previews, simulators,
//          project import, slash commands, kanban, automations and sidebar drag labels.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

function expectTranslations(rows: ReadonlyArray<readonly [string, string]>): void {
  for (const [english, chinese] of rows) {
    expect(translateZhCnPresentationText(english)).toBe(chinese);
  }
}

describe("tasks in zh-CN", () => {
  it("keeps the agent's name and translates what it is doing", () => {
    expectTranslations([
      ["Claude Code is working on it", "Claude Code 正在处理"],
      ["Codex wants to run a command", "Codex 想运行一条命令"],
      ["Codex wants computer access", "Codex 想使用电脑控制"],
      ["Grok asked you a question", "Grok 向你提了一个问题"],
      ["Pi is waiting for your OK", "Pi 正在等你确认"],
      ["Codex · gpt-5 · in D:\\work\\moss", "Codex · gpt-5 · 位于 D:\\work\\moss"],
      ["Delegated to Claude Code", "已委派给 Claude Code"],
    ]);
  });

  it("translates the status line with its relative time", () => {
    expectTranslations([
      ["Working · 4m", "工作中 · 4 分钟"],
      ["Finished 2m ago", "已结束 · 2 分钟前"],
      ["Finished just now", "已结束 · 刚刚"],
      ["Plan ready 3h ago", "计划已就绪 · 3 小时前"],
    ]);
  });

  it("translates the summary counts piece by piece", () => {
    expectTranslations([
      ["2 things need you · 1 working · 3 to do", "2 件事需要你处理 · 1 个进行中 · 3 个待办"],
      ["1 thing needs you", "1 件事需要你处理"],
      ["4 to do", "4 个待办"],
      ["1 working · 3 to do", "1 个进行中 · 3 个待办"],
    ]);
  });

  it("translates the composed accessible names and keeps the task title", () => {
    expectTranslations([
      ["Mark as done: Fix login (To do)", "标记为已完成：Fix login（待办）"],
      ["Mark as not done: Fix login (Done)", "标记为未完成：Fix login（已完成）"],
      ["Due Tomorrow", "截止：明天"],
      ["Due Today", "截止：今天"],
      ["Priority: Urgent", "优先级：紧急"],
      ["Priority: No priority", "优先级：无优先级"],
      ["Project: Moss", "项目：Moss"],
      ["Show all 12 done", "显示全部 12 项已完成"],
    ]);
  });
});

describe("code review in zh-CN", () => {
  it("translates the list notes with their counts and times", () => {
    expectTranslations([
      [
        "Showing the 50 newest pull requests per repository. 3 repositories have more on GitHub.",
        "每个仓库显示最新的 50 个拉取请求。3 个仓库在 GitHub 上还有更多。",
      ],
      [
        "Showing the 50 most recently updated pull requests and issues per repository. 1 repository has more on GitHub.",
        "每个仓库显示最近更新的 50 个拉取请求和问题。1 个仓库在 GitHub 上还有更多。",
      ],
      [
        "Showing merged pull requests from the 50 newest closed pull requests per repository. 2 repositories have more on GitHub.",
        "显示每个仓库最新的 50 个已关闭拉取请求中已合并的部分。2 个仓库在 GitHub 上还有更多。",
      ],
      [
        "2 project repositories were unavailable. Healthy repositories are still shown.",
        "2 个项目的仓库不可用；正常仓库仍会显示。",
      ],
      [
        "GitHub rate limit reached. Showing the last loaded items. Refreshing resumes at 3:04 PM.",
        "已达到 GitHub 速率限制，正在显示上次加载的内容。将在 3:04 PM 恢复刷新。",
      ],
      [
        "GitHub rate limit reached. Some repositories could not be loaded. Refreshing resumes soon.",
        "已达到 GitHub 速率限制，部分仓库无法加载。很快会恢复刷新。",
      ],
      [
        "Moss pauses GitHub requests until the limit resets at 3:04 PM.",
        "Moss 会暂停 GitHub 请求，直到限制在 3:04 PM 重置。",
      ],
    ]);
  });

  it("translates filters and accessible names around their values", () => {
    expectTranslations([
      ["Pull requests, 12", "拉取请求，12"],
      ["Issues, 3", "问题，3"],
      ["Sort: Newest", "排序：最新"],
      ["Filter (2 active)", "筛选（已启用 2 项）"],
      ["Remove filter: Authored by me", "移除筛选条件：我创建的"],
      ["Ask about issue #7", "询问问题 #7"],
      ["Ask about PR #42", "询问 PR #42"],
      ["Ask about this pull request", "询问这个拉取请求"],
      ["Send to agent in Moss", "发送给 Moss 中的智能体"],
      ["State: Closed. Change state", "状态：已关闭。更改状态"],
      ["Pin issue #7", "固定问题 #7"],
      ["Unpin issue #7 in Moss", "取消固定问题 #7（Moss）"],
      ["Unpin issue #7 in 3 projects", "取消固定问题 #7（涉及 3 个项目）"],
      ["Pin pull request #42", "固定拉取请求 #42"],
    ]);
  });

  it("translates the timeline, checks and merge descriptions", () => {
    expectTranslations([
      ["octocat opened this issue", "octocat 打开了此问题"],
      ["Someone opened this pull request", "有人打开了此拉取请求"],
      ["Someone commented", "有人已评论"],
      ["Commit 3a1f2c9 by octocat", "提交 3a1f2c9（作者：octocat）"],
      ["Issue closed", "问题已关闭"],
      ["2 failing, 22 successful", "2 项失败，22 项成功"],
      ["1 pending", "1 项进行中"],
      ["4 skipped", "4 项已跳过"],
      ["5m ago", "5 分钟前"],
      ["just now", "刚刚"],
      ["Merge 3 pull requests?", "合并 3 个拉取请求？"],
      ["This will merge #42 into main using squash.", "将以压缩合并方式把 #42 合并到 main。"],
      ["This will merge #42 using squash.", "将以压缩合并方式合并 #42。"],
      [
        "This will atomically merge every open pull request through #42 into main using rebase.",
        "将以变基合并方式，把到 #42 为止所有开启的拉取请求一次性合并到 main。",
      ],
      [
        "This will atomically merge every open pull request through #42 into main using merge. Pull requests above it will remain open and GitHub will retarget them.",
        "将以普通合并方式，把到 #42 为止所有开启的拉取请求一次性合并到 main。它上面的拉取请求会保持开启，GitHub 会调整它们的目标分支。",
      ],
      ["Stack #9", "堆叠 #9"],
      ["Issue in Zluowa/moss", "Zluowa/moss 中的问题"],
      ["#42 PR open: Fix login", "#42 拉取请求开启中：Fix login"],
      ["View stack 9, pull request 2 of 3", "查看堆叠 9，第 2 个拉取请求（共 3 个）"],
      ["Stack #9 · PR 2 of 3 · targets main", "堆叠 #9 · 第 2 个 PR（共 3 个）· 目标分支 main"],
    ]);
  });
});

describe("the browser panel in zh-CN", () => {
  it("translates dynamic labels and keeps the query and site", () => {
    expectTranslations([
      ['Search the web for "moss docs"', "在网上搜索“moss docs”"],
      ["Open https://example.com/a", "打开 https://example.com/a"],
      ["Reveal password for me@example.com", "显示 me@example.com 的密码"],
      ["Delete login for example.com", "删除 example.com 的登录信息"],
      ["You can attach up to 8 references per message.", "每条消息最多可附加 8 个引用。"],
      ["12 cookies imported. 3 skipped.", "已导入 12 个 Cookie，跳过 3 个。"],
      [
        "1 cookie imported. 0 skipped. Some cookies could not be transferred; you may need to sign in again.",
        "已导入 1 个 Cookie，跳过 0 个。部分 Cookie 无法转移，你可能需要重新登录。",
      ],
    ]);
  });
});

describe("previews in zh-CN", () => {
  it("translates dynamic labels and keeps file names and titles", () => {
    expectTranslations([
      ["Download report.docx", "下载 report.docx"],
      ["Zoom 120%", "缩放 120%"],
      ["Page 3", "第 3 页"],
      ["Go to page 3", "前往第 3 页"],
      ["Comment on page 3", "评论第 3 页"],
      ["Slide 2: Roadmap", "第 2 张幻灯片：Roadmap"],
      ["Slide 2 of 9: Roadmap", "第 2 张幻灯片（共 9 张）：Roadmap"],
      ["Cell 3 of 10", "第 3 个单元格（共 10 个）"],
      ["analysis.ipynb, cell 3 of 10", "analysis.ipynb，第 3 个单元格（共 10 个）"],
      ["Code cell 2, cell 2 of 4", "代码单元格 2，第 2 个单元格（共 4 个）"],
      ["Raw cell 4", "原始单元格 4"],
      ["· 10 cells", "· 10 个单元格"],
      ["Notebook output 2", "笔记本输出 2"],
      ["Play song.mp3", "播放 song.mp3"],
      ["Pause song.mp3", "暂停 song.mp3"],
      ["Seek in song.mp3", "在 song.mp3 中跳转"],
      ["MP3 audio", "MP3 音频"],
      ["This file type can be downloaded.", "此文件类型可以下载。"],
      ["This file type can be downloaded or attached to chat.", "此文件类型可以下载或附加到对话。"],
    ]);
  });
});

describe("simulators in zh-CN", () => {
  it("translates the panel around device names", () => {
    expectTranslations([
      ["iOS 18.2 · Booted", "iOS 18.2 · 已启动"],
      ["iOS 18.2 · Shut down", "iOS 18.2 · 关机"],
      ["iPhone 16 Pro screen", "iPhone 16 Pro 屏幕"],
      ["Shut down iPhone 16 Pro?", "关闭 iPhone 16 Pro？"],
      ["Shut down this simulator?", "关闭这个模拟器？"],
      ["Shut down iPad Air", "关闭 iPad Air"],
      ["Shut down simulator", "关闭模拟器"],
      ["Shut down a simulator to start iPad Air", "关闭一个模拟器以启动 iPad Air"],
      ["Shut down a simulator to start that simulator", "关闭一个模拟器以启动那个模拟器"],
      [
        "Moss keeps at most 3 simulators running at once, because each one holds a few gigabytes of memory. Pick one to shut down — anything running on it closes — and iPad Air starts in its place.",
        "Moss 最多同时运行 3 个模拟器，因为每个都会占用几 GB 内存。请选择一个关闭（上面运行的所有内容都会关闭），iPad Air 会在它的位置启动。",
      ],
    ]);
  });

  it("translates the degraded capability notice", () => {
    expectTranslations([
      ["Screen capture unavailable.", "屏幕截取不可用。"],
      [
        "Screen capture and video encoding unavailable with Xcode 16.2 — touch and keyboard input unaffected.",
        "屏幕截取、视频编码不可用（Xcode 16.2），触控和键盘输入不受影响。",
      ],
    ]);
  });
});

describe("project import in zh-CN", () => {
  it("translates progress and keeps project and conversation titles", () => {
    expectTranslations([
      ["5 conversations across 2 projects selected.", "已选择 2 个项目中的 5 个对话。"],
      ["Importing 2 of 5", "正在导入第 2 个（共 5 个）"],
      ["3 imported or already present.", "3 个已导入或已存在。"],
      [
        "3 imported. Import stopped; the rest are still selected.",
        "已导入 3 个。导入已停止，其余仍保持选中。",
      ],
      ["Import 412 conversations", "导入 412 个对话"],
      ["Import 1 conversation", "导入 1 个对话"],
      ["Importing 7 of 412…", "正在导入 7/412…"],
      ["Retry 2 failed", "重试 2 个失败项"],
      ["2 conversations couldn't be imported", "2 个对话未能导入"],
      ["1 conversation couldn't be imported", "1 个对话未能导入"],
      ["Moss couldn't read this conversation's files.", "Moss 读不了这个对话的文件。"],
      ["History only", "仅历史记录"],
      ["Choose projects", "选择项目"],
      ["Not found: Cursor, Gemini.", "没有找到：Cursor, Gemini。"],
      ["No conversations yet: Devin.", "还没有对话：Devin。"],
      [
        "Not found: Cursor · 2 can't be copied (Antigravity).",
        "没有找到：Cursor · 2 个无法复制（Antigravity）。",
      ],
      ["2 can't be copied (Antigravity).", "2 个无法复制（Antigravity）。"],
      ["1 conversation", "1 个对话"],
      ["Conversations in Moss", "Moss 中的对话"],
      ["Import Fix login", "导入 Fix login"],
      ["Import Untitled conversation", "导入未命名对话"],
    ]);
  });
});

describe("slash commands, kanban and automations in zh-CN", () => {
  it("keeps commands literal and translates what they report", () => {
    expectTranslations([
      ["Fast mode is on", "快速模式已开启"],
      ["Fast mode disabled", "已关闭快速模式"],
      ["Thread goal paused", "对话目标已暂停"],
      ["Keep the goal within 4,000 characters.", "目标不能超过 4,000 个字符。"],
      ["Claude is unavailable for Side", "Claude 无法用于侧边对话"],
      [
        "Remove composer attachments or context before using /side.",
        "使用 /side 前，请先移除输入框中的附件或上下文。",
      ],
      ["Add a task after /computer-use", "请在 /computer-use 后面写上任务"],
    ]);
  });

  it("translates dynamic kanban and automation messages", () => {
    expectTranslations([
      ["Fix login was moved back to Draft.", "“Fix login”已移回草稿。"],
      ["New task in Moss", "在 Moss 中新建任务"],
      ["Optimizing images…", "正在优化图片…"],
      [
        "The goal is 5,000 characters; keep it within 4,000.",
        "目标有 5,000 个字符；请控制在 4,000 个以内。",
      ],
      ["Next run Tomorrow at 9:00 AM", "下次运行 明天 9:00 AM"],
      ["Next run in 5 minutes", "下次运行 5 分钟后"],
      ["Next run now", "即将运行"],
      ["Every 5 minutes", "每 5 分钟"],
      ["Stop after 3 failures", "失败 3 次后停止"],
      [
        "The automation stops writing to “Daily summary”; the thread itself is kept.",
        "自动化将不再写入“Daily summary”；对话本身会保留。",
      ],
      [
        "The automation stops writing to its thread; the thread itself is kept.",
        "自动化将不再写入它的对话；对话本身会保留。",
      ],
    ]);
  });
});

describe("sidebar drag labels and provider options in zh-CN", () => {
  it("translates drag targets and their announcements around the names", () => {
    expectTranslations([
      ["Drop project in Pinned", "把项目放到 Pinned"],
      ["Drop thread in Recent", "把对话放到 Recent"],
      ["Drop project before Moss", "把项目放到 Moss 之前"],
      ["Drop thread before Fix login", "把对话放到 Fix login 之前"],
      ["Move project:moss", "移动 project:moss"],
      ["Move 8f14e45f-ceea", "移动 8f14e45f-ceea"],
      ["Picked up sidebar item.", "已拿起侧边栏项目。"],
      [
        "Picked up sidebar project moss. Use ArrowUp or ArrowDown to choose a position.",
        "已拿起侧边栏项目 moss。请用上下方向键选择位置。",
      ],
      [
        "Picked up thread abc. Use ArrowUp or ArrowDown to choose a position.",
        "已拿起对话 abc。请用上下方向键选择位置。",
      ],
      ["Sidebar item will be placed before moss.", "侧边栏项目会放到 moss 之前。"],
      [
        "Sidebar item will be placed at the end of the pinned container.",
        "侧边栏项目会放到 pinned 容器的末尾。",
      ],
      ["Thread will be placed before abc.", "对话会放到 abc 之前。"],
      [
        "Thread will be placed at the end of the recent container.",
        "对话会放到 recent 容器的末尾。",
      ],
      ["Sidebar placement committed.", "侧边栏位置已确定。"],
      ["Sidebar placement cancelled.", "已取消侧边栏位置调整。"],
      ["Thread placement committed.", "对话位置已确定。"],
      ["Thread placement cancelled.", "已取消对话位置调整。"],
    ]);
  });

  it("names a provider option for its account", () => {
    expectTranslations([
      ["Artifacts, /design and /slides for Work", "Work 的 Artifacts、/design 和 /slides"],
      ["OpenAI response WebSockets for Work", "Work 的 OpenAI 响应 WebSocket"],
    ]);
  });

  it("leaves a sentence opening with Move or Import whole instead of half translating it", () => {
    for (const sentence of [
      "Move the unknown thing somewhere",
      "Move this over there",
      "Import the unknown thing",
      "Import all of the things",
      "Import stopped",
      "Move projects",
      "Download failed with HTTP 500.",
    ]) {
      expect(translateZhCnPresentationText(sentence)).toBe(sentence);
    }
  });
});
