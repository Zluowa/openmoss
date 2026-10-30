// FILE: localizationPrimaryJourneyContracts.test.ts
// Purpose: Locks HEL-20 primary zh-CN copy and HEL-21 product terminology/AX contracts.
// Layer: Pure localization and source-wiring tests

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  formatMossTranslation,
  translateMoss,
  ZH_CN_PRODUCT_GLOSSARY,
  type TranslationKey,
} from "./localization";

const primaryCopy = [
  ["sidebar.surface.switch", "Switch sidebar surface", "切换侧边栏界面"],
  ["sidebar.surface.mossDescription", "Build, debug, and ship", "构建、调试与发布"],
  ["sidebar.surface.studioDescription", "Open-ended agent work", "开放式智能体工作"],
  ["sidebar.openNewChatHome", "Open new chat home", "打开新建全局对话主页"],
  ["sidebar.noProjectsYet", "No projects yet", "暂无项目"],
  ["sidebar.space.active", "Active", "当前"],
  ["sidebar.space.empty.projectTitle", "{name} is empty", "{name} 为空"],
  ["sidebar.space.empty.voidTitle", "Void is empty", "未归类项目为空"],
  [
    "sidebar.space.empty.moveHint",
    "Move projects here, or right-click a project to file it.",
    "将项目移到这里，或右键点击项目将其归类。",
  ],
  [
    "sidebar.space.empty.unfiledHint",
    "New and unassigned projects appear here.",
    "新建且尚未归类的项目会显示在这里。",
  ],
  ["sidebar.space.empty.moveHere", "Move projects here", "将项目移到这里"],
  ["sidebar.spacePicker.noProjectsYet", "No projects yet.", "暂无项目。"],
  ["sidebar.spacePicker.noMatchingProjects", "No matching projects.", "没有匹配的项目。"],
  [
    "sidebar.spacePicker.everyProjectInTarget",
    "Every project is already in {space}.",
    "所有项目都已在 {space} 中。",
  ],
  ["sidebar.spacePicker.thisSpace", "this space", "此空间"],
  ["sidebar.spacePicker.title", "Move projects to {space}", "将项目移到 {space}"],
  [
    "sidebar.spacePicker.description",
    "Choose existing projects. Their chats and pinned state move with them.",
    "选择已有项目。项目中的对话和置顶状态会一并移动。",
  ],
  ["sidebar.spacePicker.moving", "Moving…", "正在移动…"],
  ["sidebar.spacePicker.moveProjects", "Move projects", "移动项目"],
  ["sidebar.spacePicker.moveError", "Unable to move the selected projects.", "无法移动所选项目。"],
  ["settings.behavior.followUp.title", "Follow-up behavior", "后续消息处理"],
  [
    "settings.behavior.followUp.description",
    "Choose whether messages sent during an active turn wait in the queue or steer the current run. Ctrl/Cmd+Enter uses the opposite behavior for one message.",
    "选择活跃运行期间发送的消息是排队等待，还是引导当前运行。按下 Ctrl/Cmd+Enter 可对单条消息使用相反行为。",
  ],
  ["settings.behavior.followUp.resetLabel", "follow-up behavior", "后续消息处理"],
  ["settings.behavior.followUp.aria", "Follow-up behavior", "后续消息处理"],
  ["settings.behavior.followUp.option.queue", "Queue", "排队"],
  ["settings.behavior.followUp.option.steer", "Steer", "引导"],
  ["settings.behavior.pullRequestDiffColors.title", "Pull request diff colors", "拉取请求差异着色"],
  [
    "settings.behavior.pullRequestDiffColors.description",
    "Show additions in green and deletions in red in pull request summaries.",
    "在拉取请求摘要中用绿色显示新增内容，用红色显示删除内容。",
  ],
  [
    "settings.behavior.pullRequestDiffColors.resetLabel",
    "pull request diff colors",
    "拉取请求差异着色",
  ],
  [
    "settings.behavior.pullRequestDiffColors.aria",
    "Show pull request diff colors",
    "显示拉取请求差异着色",
  ],
  ["sidebar.newSpace", "New space", "新建空间"],
  ["sidebar.help", "Help", "帮助"],
  ["chat.composer.addImagesAria", "Add images to the message", "向消息添加图片"],
  ["chat.composer.fast", "Fast", "快速"],
  ["chat.composer.default", "Default", "默认"],
  ["chat.composer.send.connecting", "Connecting", "正在连接"],
  ["chat.composer.send.transcribingVoice", "Transcribing voice note", "正在转写语音消息"],
  ["chat.composer.send.loadingModels", "Loading models", "正在加载模型"],
  ["chat.composer.send.optimizingImage", "Optimizing image", "正在优化图片"],
  ["chat.composer.send.preparingWorktree", "Preparing worktree", "正在准备工作树"],
  ["chat.composer.send.sending", "Sending", "正在发送"],
  ["chat.composer.send.message", "Send message", "发送消息"],
  ["chat.contextWindow.title", "Context window", "上下文窗口"],
  ["chat.environment.panel", "Environment", "环境"],
  ["chat.environment.togglePanel", "Toggle environment panel", "切换环境面板"],
  ["chat.projectPicker.workInProject", "Work in a project", "在项目中工作"],
  ["chat.projectPicker.reset", "Don't work in a project", "不在项目中工作"],
  ["chat.projectPicker.searchPlaceholder", "Search projects", "搜索项目"],
  [
    "chat.projectPicker.connecting",
    "App is still connecting. Try again in a moment.",
    "应用仍在连接。请稍后重试。",
  ],
  ["chat.projectPicker.loadingFolders", "Loading folders…", "正在加载文件夹…"],
  ["chat.projectPicker.noFoldersFound", "No folders found", "未找到文件夹"],
  ["chat.projectPicker.noMatches", "No matches", "无匹配项"],
  ["sidebar.voice.starting", "Voice chat starting", "语音对话正在启动"],
  ["sidebar.voice.active", "Voice chat active", "语音对话进行中"],
  ["sidebar.voice.ending", "Voice chat ending", "语音对话正在结束"],
  ["chat.voice.newChatTitle", "New voice chat", "新建语音对话"],
  ["sidebar.noChatsYet", "No chats yet", "暂无对话"],
  ["sidebar.activity.switchToActivityView", "Switch to activity view", "切换到活动视图"],
  ["sidebar.activity.switchToClassicView", "Switch to classic view", "切换到经典视图"],
  ["sidebar.activity.filterByProject", "Filter activity by project", "按项目筛选活动"],
  ["sidebar.activity.options", "Activity options", "活动选项"],
  [
    "sidebar.activity.startNewChatInLastProject",
    "Start new chat in last used project",
    "在上次使用的项目中新建对话",
  ],
  [
    "kanban.newTask.promptPlaceholder",
    "Describe the task, @tag files/folders, paste images, or use / for skills",
    "描述任务，使用 @ 标记文件/文件夹、粘贴图片，或输入 / 使用技能",
  ],
  [
    "sidebar.collapseAllProjectsExceptActive",
    "Collapse all projects except the active project",
    "仅保留当前项目展开",
  ],
  ["pullRequests.summary.description", "Description", "描述"],
  ["pullRequests.summary.noDescription", "No description provided.", "暂无描述。"],
  ["rightDock.toggleBottomPanel", "Toggle bottom panel", "切换底部面板显示"],
  ["rightDock.toggleRightSidebar", "Toggle right sidebar", "显示/隐藏侧边栏"],
  ["chat.permissions.approvalRequired", "Ask for approval", "需要批准"],
  ["chat.permissions.auto", "Approve for me", "自动批准"],
  ["chat.permissions.fullAccess", "Full access", "完全访问"],
] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("HEL-20 primary zh-CN localization contract", () => {
  it("localizes every observed product-owned string while preserving English", () => {
    for (const [key, english, chinese] of primaryCopy) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }
  });

  it("localizes right-panel launcher labels and accessible names", () => {
    const launcherCases = [
      ["rightDock.pane.terminal", "Terminal", "终端"],
      ["rightDock.pane.browser", "Browser", "浏览器"],
      ["rightDock.pane.files", "Files", "文件"],
      ["rightDock.launcher.sideChats", "Side chats", "侧边聊天"],
      ["rightDock.launcher.sourceControl", "Source control", "源代码管理"],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [labelKey, englishLabel, chineseLabel] of launcherCases) {
      expect(translateMoss("en", labelKey)).toBe(englishLabel);
      expect(translateMoss("zh-CN", labelKey)).toBe(chineseLabel);
      expect(
        formatMossTranslation("en", "rightDock.launcher.openPane", {
          label: translateMoss("en", labelKey),
        }),
      ).toBe(`Open ${englishLabel}`);
      expect(
        formatMossTranslation("zh-CN", "rightDock.launcher.openPane", {
          label: translateMoss("zh-CN", labelKey),
        }),
      ).toBe(`打开${chineseLabel}`);
    }
  });

  it("localizes dynamic context-window accessibility names", () => {
    expect(
      formatMossTranslation("en", "chat.contextWindow.aria.percentage", {
        percentage: "4.7%",
      }),
    ).toBe("Context window 4.7% used");
    expect(
      formatMossTranslation("zh-CN", "chat.contextWindow.aria.percentage", {
        percentage: "4.7%",
      }),
    ).toBe("上下文窗口已使用 4.7%");
    expect(
      formatMossTranslation("en", "chat.contextWindow.aria.tokens", {
        tokens: "9.4k",
      }),
    ).toBe("Context window 9.4k tokens used");
    expect(
      formatMossTranslation("zh-CN", "chat.contextWindow.aria.tokens", {
        tokens: "9.4k",
      }),
    ).toBe("上下文窗口已使用 9.4k 个令牌");
  });

  it("localizes Kanban task lifecycle toasts while preserving English", () => {
    const toastCases = [
      ["kanban.newTask.toast.addedToDrafts", "Task added to Drafts", "任务已添加到草稿"],
      ["kanban.newTask.toast.started", "Task started", "任务已启动"],
      ["kanban.newTask.toast.finishInChat", "Finish this task in the chat", "请在对话中完成此任务"],
      [
        "kanban.newTask.toast.worktreePending",
        "Worktree setup stays on the normal composer send path.",
        "请继续通过常规消息输入框发送，以完成工作树设置。",
      ],
      ["kanban.newTask.toast.savedAsDraft", "The task was saved as a draft.", "任务已存为草稿。"],
      [
        "kanban.newTask.toast.savedToDraftsFallback",
        "The task was saved to Drafts instead. Open it to send manually.",
        "任务已改存到草稿。请打开后手动发送。",
      ],
      ["kanban.newTask.toast.retry", "Please try again.", "请重试。"],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of toastCases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }

    const submitHook = source("./components/kanban/useKanbanTaskSubmit.ts");
    for (const [key] of toastCases) {
      expect(submitHook, `useKanbanTaskSubmit must use ${key}`).toContain(key);
    }
  });

  it("localizes the bounded archive usage notice while preserving English", () => {
    expect(translateMoss("en", "settings.usage.archiveIncomplete")).toBe(
      "The bounded local archive scan could not inspect every eligible entry, so totals are lower bounds.",
    );
    expect(translateMoss("zh-CN", "settings.usage.archiveIncomplete")).toBe(
      "本地归档的有界扫描未能检查所有符合条件的条目，因此显示的是用量下限。",
    );
    expect(translateMoss("en", "settings.usage.scanningLocal")).toBe("Scanning local usage data…");
    expect(translateMoss("zh-CN", "settings.usage.scanningLocal")).toBe("正在扫描本地用量数据…");
    expect(translateMoss("en", "settings.usage.noLocalData")).toBe(
      "No local usage data is available for this provider.",
    );
    expect(translateMoss("zh-CN", "settings.usage.noLocalData")).toBe("此服务商暂无本地用量数据。");
    expect(translateMoss("en", "settings.usage.learnMore")).toBe("Learn more");
    expect(translateMoss("zh-CN", "settings.usage.learnMore")).toBe("了解更多");
  });

  it("localizes Kanban draft dispatch outcomes while preserving English", () => {
    const draftToastCases = [
      ["kanban.draft.toast.sent", "Draft sent", "草稿已发送"],
      ["kanban.draft.toast.finishInChat", "Finish this draft in the chat", "在对话中完成此草稿"],
      [
        "kanban.draft.toast.empty",
        "Nothing to send yet — write the prompt in the composer.",
        "还没有可发送的内容；请在消息输入框中编写提示词。",
      ],
      [
        "kanban.draft.toast.worktreePending",
        "Open the chat to create the worktree with the normal send flow.",
        "打开对话，通过常规发送流程创建工作树。",
      ],
      [
        "kanban.draft.toast.continueInChat",
        "Open the chat to continue this task.",
        "打开对话以继续此任务。",
      ],
      ["kanban.draft.toast.notConnected", "Not connected", "未连接"],
      [
        "kanban.draft.toast.reconnect",
        "Reconnect to the server before sending drafts.",
        "请重新连接服务器后再发送草稿。",
      ],
      ["kanban.draft.toast.sendFailed", "Could not send draft", "无法发送草稿"],
      [
        "kanban.draft.toast.sendFailedDescription",
        "Open the chat to review the draft and try again.",
        "请打开对话检查草稿，然后重试。",
      ],
      [
        "kanban.doneDrop.toast.derivedTitle",
        "Done is derived automatically",
        "已完成状态会自动确定",
      ],
      [
        "kanban.doneDrop.toast.derivedDescription",
        "Cards move here when their runs complete.",
        "任务运行完成后，卡片会自动移到这里。",
      ],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of draftToastCases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }

    const boardView = source("./components/kanban/KanbanProjectBoardView.logic.ts");
    for (const [key] of draftToastCases) {
      expect(boardView, `KanbanProjectBoardView must use ${key}`).toContain(key);
    }

    const boardComponent = source("./components/kanban/KanbanProjectBoardView.tsx");
    expect(boardComponent).not.toContain('title: "Done is derived automatically"');
    expect(boardComponent).not.toContain(
      'description: "Cards move here when their runs complete."',
    );
  });

  it("localizes blocked provider send copy while preserving provider proper names", () => {
    expect(translateMoss("en", "provider.send.blocked.disabled")).toBe(
      "This provider is disabled in Moss settings.",
    );
    expect(translateMoss("zh-CN", "provider.send.blocked.disabled")).toBe(
      "此服务商已在 Moss 设置中禁用。",
    );
    expect(
      formatMossTranslation("en", "provider.send.blocked.unauthenticated", {
        provider: "Claude Work",
      }),
    ).toBe("Claude Work is not authenticated. Open provider settings to sign in.");
    expect(
      formatMossTranslation("zh-CN", "provider.send.blocked.unauthenticated", {
        provider: "Claude Work",
      }),
    ).toBe("Claude Work 尚未登录。请打开服务商设置并登录。");
    expect(
      formatMossTranslation("zh-CN", "provider.send.blocked.unavailable", {
        provider: "Gemini",
      }),
    ).toBe("Gemini 当前不可用。");
    expect(translateMoss("zh-CN", "provider.send.blocked.statusLoading")).toBe(
      "服务商状态仍在加载中。",
    );
    expect(translateMoss("zh-CN", "provider.send.blocked.statusTimeout")).toBe(
      "服务商状态检查超时。请选择其他可用服务商或重试。",
    );
  });

  it("distinguishes global and project-scoped new-conversation entry points", () => {
    expect(translateMoss("en", "sidebar.newChat")).toBe("New chat");
    expect(translateMoss("zh-CN", "sidebar.newChat")).toBe("新建全局对话");
    expect(translateMoss("en", "sidebar.searchPalette.newChat.description")).toBe(
      "Open the new chat landing screen.",
    );
    expect(translateMoss("zh-CN", "sidebar.searchPalette.newChat.description")).toBe(
      "打开新建全局对话主页。",
    );
    expect(translateMoss("en", "sidebar.newThread")).toBe("New thread");
    expect(translateMoss("zh-CN", "sidebar.newThread")).toBe("新建项目对话");
    expect(translateMoss("zh-CN", "sidebar.searchPalette.newThread.description")).toBe(
      "在当前项目或最近使用的项目中开始新项目对话。",
    );
    expect(
      formatMossTranslation("en", "sidebar.project.newConversationAria", {
        project: "Moss Core",
      }),
    ).toBe("Create new thread in Moss Core");
    expect(
      formatMossTranslation("zh-CN", "sidebar.project.newConversationAria", {
        project: "Moss Core",
      }),
    ).toBe("在 Moss Core 中新建项目对话");
  });

  it("wires localized visible and accessibility copy into the owning components", () => {
    const contracts = [
      {
        path: "./components/Sidebar.tsx",
        keys: [
          "sidebar.surface.switch",
          "sidebar.surface.mossDescription",
          "sidebar.surface.studioDescription",
          "sidebar.openNewChatHome",
          "sidebar.newChat",
          "sidebar.newThread",
          "sidebar.project.newConversationAria",
          "sidebar.project.newConversationTooltip",
          "sidebar.newSpace",
          "sidebar.newSpace.description",
          "sidebar.noChatsYet",
          "sidebar.activity.switchToActivityView",
          "sidebar.activity.switchToClassicView",
          "sidebar.expandAllProjects",
          "sidebar.collapseAllProjects",
          "sidebar.collapseAllProjectsExceptActive",
          "sidebar.collapseAllProjectsExceptActiveChat",
        ],
        forbidden: [
          'aria-label="Switch sidebar surface"',
          'description: "Build, debug, and ship"',
          'description: "Open-ended agent work"',
          'label="Open new chat home"',
          'label="Help"',
          'label: "New space"',
          "<span>New space…</span>",
          "`New chat (${newChatShortcutLabel})`",
          "`Create new thread in ${project.name}`",
          "`New thread (${newThreadShortcutLabel})`",
          'label="New thread"',
          "No chats yet",
          'active ? "Switch to classic view" : "Switch to activity view"',
          '"Collapse all projects except the active project"',
        ],
      },
      {
        path: "./components/ChatView.tsx",
        keys: ["chat.voice.newChatTitle"],
        forbidden: ['title: "New voice chat"'],
      },
      {
        path: "./components/SidebarActivityView.tsx",
        keys: [
          "sidebar.activity.filterByProject",
          "sidebar.activity.options",
          "sidebar.activity.startNewChatInLastProject",
        ],
        forbidden: [
          'aria-label="Filter activity by project"',
          'label="Activity options"',
          'label="Start new chat in last used project"',
        ],
      },
      {
        path: "./components/kanban/KanbanNewTaskDialog.tsx",
        keys: ["kanban.newTask.promptPlaceholder"],
        forbidden: [
          'placeholder="Describe the task, @tag files/folders, paste images, or use / for skills"',
        ],
      },
      {
        path: "./components/pullRequest/PullRequestSummaryTab.tsx",
        keys: ["pullRequests.summary.description", "pullRequests.summary.noDescription"],
        forbidden: [
          '<DisclosureSection label="Description">',
          'fallback="_No description provided._"',
        ],
      },
      {
        // The bottom-panel and right-sidebar toggles live in ChatHeader in the
        // merged architecture (asserted below); the dock keeps only its launcher.
        path: "./components/chat/RightDock.tsx",
        keys: ["rightDock.launcher.open", "rightDock.launcher.openPane"],
        forbidden: [
          'aria-label="Open a panel"',
          "aria-label={`Open ${label}`}",
          'label="切换底部面板显示"',
          'title="切换底部面板显示"',
          'label="显示/隐藏侧边栏"',
          'title="显示/隐藏侧边栏"',
          '"切换底部面板显示",',
          '"显示/隐藏侧边栏",',
        ],
      },
      {
        // The bottom panel was removed upstream (the right dock owns its panes),
        // so only the right-sidebar toggle keys remain here.
        path: "./components/chat/ChatHeader.tsx",
        keys: [
          "rightDock.toggleRightSidebar",
          "rightDock.toggleRightSidebarShortcut",
          "chat.header.chatHistory",
          "chat.header.noProjectChats",
          "chat.header.newRailItem",
          "chat.header.new",
          "chat.header.newChat",
          "chat.header.newTerminal",
          "chat.header.chatIndex",
          "chat.header.closeNamed",
          "chat.header.terminal",
          "chat.header.closeTerminal",
          "chat.header.toggleDiffPanel",
          "chat.header.toggleDiffPanelShortcut",
          "chat.header.diffUnavailableNotGit",
          "chat.header.openRightSidebar",
          "chat.header.closeRightSidebar",
          "chat.header.closeSelectedSide",
        ],
        forbidden: [
          'aria-label="切换底部面板显示"',
          'aria-label="显示/隐藏侧边栏"',
          "`切换底部面板显示 (${bottomPanelAction.shortcutLabel})`",
          "`显示/隐藏侧边栏 (${rightDockAction.shortcutLabel})`",
          "`${rightPanelToggleLabel} (${rightDockAction.shortcutLabel})`",
          "`${bottomPanelToggleLabel} (${bottomPanelAction.shortcutLabel})`",
          'label="Chat history"',
          'title="Chat history"',
          'label="New editor rail item"',
          'title="New"',
          "<span>New chat</span>",
          "<span>New terminal</span>",
          "`Chat ${index + 1}`",
          "`Close ${thread.title}`",
          'title="Terminal"',
          'label="Terminal"',
          'closeLabel="Close Terminal"',
          'aria-label={togglesRightDock ? "Toggle right sidebar" : "Toggle diff panel"}',
          '"Diff panel is unavailable because this project is not a git repository."',
          "`Toggle diff panel (${diffToggleShortcutLabel})`",
          'label="Close selected Side"',
          'tooltip="Close selected Side"',
        ],
      },
      {
        path: "./components/chat/environment/EnvironmentToggle.tsx",
        keys: ["chat.environment.panel", "chat.environment.togglePanel"],
        forbidden: ['aria-label="Toggle environment panel"', ">Environment<"],
      },
      {
        path: "./components/chat/ComposerExtrasMenu.tsx",
        keys: [
          "chat.composer.addImagesAria",
          "chat.composer.extras",
          "chat.composer.addFiles",
          "chat.composer.planMode",
          "chat.composer.fast",
          "chat.composer.default",
        ],
        forbidden: [
          'aria-label="Add images to the message"',
          'aria-label="Composer extras"',
          "<MenuSubTrigger>Fast</MenuSubTrigger>",
          '<MenuRadioItem value="normal">Default</MenuRadioItem>',
          '<MenuRadioItem value="fast">Fast</MenuRadioItem>',
        ],
      },
      {
        path: "./components/chat/ContextWindowMeter.tsx",
        keys: [
          "chat.contextWindow.title",
          "chat.contextWindow.aria.percentage",
          "chat.contextWindow.aria.tokens",
        ],
        forbidden: [">Context window<"],
      },
      {
        path: "./components/chat/ProjectPicker.tsx",
        keys: [
          "chat.projectPicker.workInProject",
          "chat.projectPicker.reset",
          "chat.projectPicker.searchPlaceholder",
          "chat.projectPicker.connecting",
          "chat.projectPicker.loadFoldersFailed",
          "chat.projectPicker.selectProjectFailed",
          "chat.projectPicker.openFolderPickerFailed",
          "chat.projectPicker.updateProjectFailed",
          "chat.projectPicker.newProject",
          "chat.projectPicker.addNewProject",
          "chat.projectPicker.addingProject",
          "chat.projectPicker.openingFolderPicker",
          "chat.projectPicker.loadingFolders",
          "chat.projectPicker.noFoldersFound",
          "chat.projectPicker.noMatches",
        ],
        forbidden: [
          'emptyTriggerLabelProp ?? "Work in a project"',
          'resetActionLabelProp ?? "Don\'t work in a project"',
          'searchPlaceholderProp ?? "Search projects"',
          '"App is still connecting. Try again in a moment."',
          '"Unable to load folders."',
          '"Unable to select project."',
          '"Unable to open the folder picker."',
          '"Unable to update project."',
          "error.message",
          "runtimeDetail: true",
          '"New project"',
          '"Add new project"',
          '"Adding project..."',
          '"Opening folder picker..."',
          '"Loading folders…"',
          '"No folders found"',
          '"No matches"',
          "onSelectWorkspaceRoot?.(absolutePath);",
        ],
      },
      {
        path: "./components/BranchToolbar.tsx",
        keys: [
          "chat.permissions.approvalRequired",
          "chat.permissions.auto",
          "chat.permissions.fullAccess",
        ],
        forbidden: [],
      },
      {
        path: "./components/CreateProjectDialog.tsx",
        keys: [
          "projectSetup.createProject.title",
          "projectSetup.createProject.projectName",
          "projectSetup.createProject.sourceFolder",
          "projectSetup.createProject.addFolderOnComputer",
          "projectSetup.createProject.thisComputer",
          "projectSetup.createProject.remoteDevices",
          "projectSetup.createProject.noConnectedRemotes",
          "projectSetup.createProject.addRemoteHost",
          "projectSetup.createProject.add",
          "projectSetup.createProject.removeFolder",
          "projectSetup.createProject.folderRequired",
          "projectSetup.createProject.cancel",
          "projectSetup.createProject.create",
        ],
        forbidden: [
          'aria-label="New space"',
          '"Add a folder on this computer"',
          '"No remote hosts are connected right now."',
          ">Create project<",
        ],
      },
      {
        path: "./components/SpaceSwitcher.tsx",
        keys: ["sidebar.newSpace"],
        forbidden: ['aria-label="New space"', ">New space<"],
      },
      {
        path: "./components/SpaceEditorDialog.tsx",
        keys: [
          "sidebar.newSpace",
          "sidebar.newSpace.dialogDescription",
          "sidebar.spaceEditor.edit.title",
          "sidebar.spaceEditor.edit.description",
          "sidebar.spaceEditor.void.title",
          "sidebar.spaceEditor.void.description",
          "sidebar.spaceEditor.name",
          "sidebar.spaceEditor.nameRequired",
          "sidebar.spaceEditor.nameTaken",
          "sidebar.spaceEditor.saveFailed",
          "sidebar.spaceEditor.placeholder.unfiled",
          "sidebar.spaceEditor.placeholder.work",
          "sidebar.spaceEditor.icon",
          "sidebar.spaceEditor.cancel",
          "sidebar.spaceEditor.saving",
          "sidebar.spaceEditor.create",
          "sidebar.spaceEditor.save",
        ],
        forbidden: [
          'props.mode === "create" ? "New space"',
          '"Edit unfiled group"',
          '"Edit space"',
          '"Name the group that holds projects you haven\'t filed into a space. This is a local preference — the projects in it stay where they are."',
          '"Rename this space or give it a different icon. Its projects stay where they are."',
          '"Enter a name."',
          '"That name is already taken."',
          '"Unable to save the space."',
          'isVoid ? "Unfiled" : "Work"',
          ">Name<",
          ">Icon<",
          ">Cancel<",
          'submitting ? "Saving…"',
          '? "Create space" : "Save"',
          "error.message",
        ],
      },
      {
        path: "./components/Sidebar.tsx",
        keys: ["sidebar.voice.starting", "sidebar.voice.active", "sidebar.voice.ending"],
        forbidden: [
          'return "Voice chat starting"',
          'return "Voice chat active"',
          'return "Voice chat ending"',
        ],
      },
      {
        path: "./components/chat/rightDockPaneMeta.tsx",
        keys: ["rightDock.launcher.sideChats"],
        forbidden: [
          'sidechat: { label: "Side chats"',
          'sidechat: "Side chats"',
          "RIGHT_DOCK_LAUNCHER_LABELS",
        ],
      },
    ] as const;

    for (const contract of contracts) {
      const contents = source(contract.path);
      for (const key of contract.keys) {
        expect(contents, `${contract.path} must use ${key}`).toContain(key);
      }
      for (const forbidden of contract.forbidden) {
        expect(contents, `${contract.path} must not retain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps shared permission-mode structure while localizing its presentation", () => {
    const contents = source("./components/BranchToolbar.tsx");
    expect(contents).toContain("RUNTIME_MODE_PRESENTATION[mode]");
    expect(contents).toContain("presentation.label");
    expect(contents).toContain("presentation.description");
    expect(contents).toContain("chat.permissions.approvalRequired");
    expect(contents).toContain("chat.permissions.auto");
    expect(contents).toContain("chat.permissions.fullAccess");
  });

  it("wires reviewed panel, project-picker, and space-dialog copy through runtime translation calls", () => {
    const rightDock = source("./components/chat/RightDock.tsx");
    expect(rightDock).toContain("items.map(({ kind, Icon, label })");

    const rightDockMeta = source("./components/chat/rightDockPaneMeta.tsx");
    expect(rightDockMeta).toContain('sidechat: { labelKey: "rightDock.launcher.sideChats"');
    expect(rightDockMeta).not.toContain('sidechat: { label: "Side chats"');
    const translatedLauncherCall =
      /resolveRightDockLauncherItems\(\s*\{[\s\S]*?hasReview:\s*dockDiffTotals\.fileCount\s*>\s*0,[\s\S]*?\},\s*t,\s*\)/;
    // The launcher moved from the route into SingleChatSurface in the merged
    // architecture; the route no longer builds launcher items itself.
    expect(source("./components/chat/SingleChatSurface.tsx")).toMatch(translatedLauncherCall);

    const chatHeader = source("./components/chat/ChatHeader.tsx");
    expect(chatHeader).toContain('t("rightDock.toggleRightSidebar")');
    expect(chatHeader).toContain('format("rightDock.toggleRightSidebarShortcut"');
    expect(chatHeader).toContain('format("chat.header.chatIndex"');
    expect(chatHeader).toContain('format("chat.header.closeNamed"');
    expect(chatHeader).toContain('format("chat.header.toggleDiffPanelShortcut"');

    const projectPicker = source("./components/chat/ProjectPicker.tsx");
    expect(projectPicker).toContain('t("chat.projectPicker.reset")');
    expect(projectPicker).toContain('t("chat.projectPicker.searchPlaceholder")');
    expect(projectPicker).toContain("runProjectPickerWorkspaceSelection({");
    expect(projectPicker).toContain("onSuccess: () => setOpen(false)");
    expect(projectPicker).toContain("onError: (message) => {");
    expect(projectPicker).toContain("setErrorMessage(message);");
    expect(projectPicker).toContain("setOpen(true);");

    const spaceEditor = source("./components/SpaceEditorDialog.tsx");
    expect(spaceEditor).toContain('t("sidebar.spaceEditor.edit.title")');
    expect(spaceEditor).toContain('t("sidebar.spaceEditor.edit.description")');
    expect(spaceEditor).toContain('t("sidebar.spaceEditor.void.title")');
    expect(spaceEditor).toContain('t("sidebar.spaceEditor.void.description")');
  });

  it("keeps the reachable space and behavior panels free of hardcoded English copy", () => {
    const spaceEmptyState = source("./components/SpaceEmptyState.tsx");
    expect(spaceEmptyState).toContain('t("sidebar.noProjectsYet")');
    expect(spaceEmptyState).toContain('format("sidebar.space.empty.projectTitle"');
    expect(spaceEmptyState).toContain('t("sidebar.space.empty.voidTitle")');
    expect(spaceEmptyState).not.toContain("No projects yet");

    const projectMenuPicker = source("./components/ProjectMenuPicker.tsx");
    expect(projectMenuPicker).toContain('t("chat.projectPicker.searchPlaceholder")');
    expect(projectMenuPicker).toContain('t("sidebar.noProjectsYet")');
    expect(projectMenuPicker).toContain('t("chat.projectPicker.noMatches")');
    expect(projectMenuPicker).not.toContain('"No matching projects"');

    const spacePicker = source("./components/SpaceProjectPickerDialog.tsx");
    for (const key of [
      "sidebar.space.active",
      "sidebar.spacePicker.noProjectsYet",
      "sidebar.spacePicker.noMatchingProjects",
      "sidebar.spacePicker.everyProjectInTarget",
      "sidebar.spacePicker.title",
      "sidebar.spacePicker.description",
      "sidebar.spacePicker.moving",
      "sidebar.spacePicker.moveProjects",
      "sidebar.spacePicker.moveError",
      "chat.projectPicker.searchPlaceholder",
      "sidebar.spaceEditor.cancel",
    ] as const) {
      expect(spacePicker, `SpaceProjectPickerDialog must use ${key}`).toContain(key);
    }
    expect(spacePicker).not.toContain('"No projects yet."');
    expect(spacePicker).not.toContain('"No matching projects."');
    expect(spacePicker).not.toContain('"Follow-up behavior"');

    const settings = source("./routes/_chat.settings.tsx");
    for (const key of [
      "settings.behavior.followUp.title",
      "settings.behavior.followUp.description",
      "settings.behavior.followUp.option.queue",
      "settings.behavior.followUp.option.steer",
      "settings.behavior.pullRequestDiffColors.title",
      "settings.behavior.pullRequestDiffColors.description",
    ] as const) {
      expect(settings, `_chat.settings.tsx must use ${key}`).toContain(key);
    }
    expect(settings).not.toContain('title="Follow-up behavior"');
    expect(settings).not.toContain('label="follow-up behavior"');
    expect(settings).not.toContain('ariaLabel="Follow-up behavior"');
    expect(settings).not.toContain('{ value: "queue", label: "Queue" }');
    expect(settings).not.toContain('{ value: "steer", label: "Steer" }');
    expect(settings).not.toContain('title: "Pull request diff colors"');
  });

  it("localizes every Space editor mode title and description", () => {
    const cases = [
      ["sidebar.newSpace", "New space", "新建空间"],
      [
        "sidebar.newSpace.dialogDescription",
        "Group projects into a focused work context. Projects you add while a space is open land in it.",
        "将项目归入一个专注的工作情境。空间打开期间添加的项目会归入该空间。",
      ],
      ["sidebar.spaceEditor.edit.title", "Edit space", "编辑空间"],
      [
        "sidebar.spaceEditor.edit.description",
        "Rename this space or give it a different icon. Its projects stay where they are.",
        "重命名此空间或更换图标。其中的项目位置不会改变。",
      ],
      ["sidebar.spaceEditor.void.title", "Edit unfiled group", "编辑未归类分组"],
      [
        "sidebar.spaceEditor.void.description",
        "Name the group that holds projects you haven't filed into a space. This is a local preference — the projects in it stay where they are.",
        "为尚未归入空间的项目分组命名。这只是本地偏好，不会改变其中项目的位置。",
      ],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of cases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }
  });

  it("localizes the complete Space editor form without translating user-entered names", () => {
    const formCases = [
      ["sidebar.spaceEditor.name", "Name", "名称"],
      ["sidebar.spaceEditor.nameRequired", "Enter a name.", "请输入名称。"],
      ["sidebar.spaceEditor.nameTaken", "That name is already taken.", "该名称已被占用。"],
      ["sidebar.spaceEditor.saveFailed", "Unable to save the space.", "无法保存空间。"],
      ["sidebar.spaceEditor.placeholder.unfiled", "Unfiled", "未归类"],
      ["sidebar.spaceEditor.placeholder.work", "Work", "工作"],
      ["sidebar.spaceEditor.icon", "Icon", "图标"],
      ["sidebar.spaceEditor.cancel", "Cancel", "取消"],
      ["sidebar.spaceEditor.saving", "Saving…", "正在保存…"],
      ["sidebar.spaceEditor.create", "Create space", "创建空间"],
      ["sidebar.spaceEditor.save", "Save", "保存"],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of formCases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }

    const spaceEditor = source("./components/SpaceEditorDialog.tsx");
    expect(spaceEditor).toContain("value={name}");
    expect(spaceEditor).toContain("onSubmit({ name: trimmedName, icon })");
  });

  it("formats ChatHeader dynamic labels while preserving thread names and shortcuts", () => {
    expect(formatMossTranslation("en", "chat.header.chatIndex", { index: 2 })).toBe("Chat 2");
    expect(formatMossTranslation("zh-CN", "chat.header.chatIndex", { index: 2 })).toBe("对话 2");
    expect(
      formatMossTranslation("en", "chat.header.closeNamed", { name: "Moss Core / Fix AX" }),
    ).toBe("Close Moss Core / Fix AX");
    expect(
      formatMossTranslation("zh-CN", "chat.header.closeNamed", { name: "Moss Core / Fix AX" }),
    ).toBe("关闭Moss Core / Fix AX");
    expect(
      formatMossTranslation("zh-CN", "chat.header.toggleDiffPanelShortcut", {
        shortcut: "⌘⇧J",
      }),
    ).toBe("切换差异面板（⌘⇧J）");
    expect(
      formatMossTranslation("en", "rightDock.toggleBottomPanelShortcut", {
        shortcut: "Ctrl+Shift+Y",
      }),
    ).toBe("Toggle bottom panel (Ctrl+Shift+Y)");
    expect(
      formatMossTranslation("zh-CN", "rightDock.toggleBottomPanelShortcut", {
        shortcut: "Ctrl+Shift+Y",
      }),
    ).toBe("切换底部面板显示（Ctrl+Shift+Y）");
    expect(
      formatMossTranslation("zh-CN", "rightDock.toggleRightSidebarShortcut", {
        shortcut: "Ctrl+Alt+U",
      }),
    ).toBe("显示/隐藏侧边栏（Ctrl+Alt+U）");
  });

  it("uses safe typed ProjectPicker outcome copy instead of runtime diagnostics", () => {
    const cases = [
      [
        "chat.projectPicker.loadFoldersFailed",
        "Unable to load folders. Try again.",
        "无法加载文件夹。请重试。",
      ],
      [
        "chat.projectPicker.selectProjectFailed",
        "Unable to select the project. Try again.",
        "无法选择项目。请重试。",
      ],
      [
        "chat.projectPicker.openFolderPickerFailed",
        "Unable to open the folder picker. Try again.",
        "无法打开文件夹选择器。请重试。",
      ],
      [
        "chat.projectPicker.updateProjectFailed",
        "Unable to update the project. Try again.",
        "无法更新项目。请重试。",
      ],
      ["chat.projectPicker.newProject", "New project", "新建项目"],
      ["chat.projectPicker.addNewProject", "Add new project", "添加新项目"],
      ["chat.projectPicker.addingProject", "Adding project...", "正在添加项目..."],
      [
        "chat.projectPicker.openingFolderPicker",
        "Opening folder picker...",
        "正在打开文件夹选择器...",
      ],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of cases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }
  });

  it("localizes bounded ChatHeader chrome while preserving English", () => {
    const cases = [
      ["chat.header.chatHistory", "Chat history", "对话历史"],
      ["chat.header.noProjectChats", "No chats in this project yet", "此项目尚无对话"],
      ["chat.header.newRailItem", "New editor rail item", "新建编辑器栏项目"],
      ["chat.header.new", "New", "新建"],
      ["chat.header.newChat", "New chat", "新建项目对话"],
      ["chat.header.newTerminal", "New terminal", "新建终端"],
      ["chat.header.terminal", "Terminal", "终端"],
      ["chat.header.closeTerminal", "Close Terminal", "关闭终端"],
      ["chat.header.toggleDiffPanel", "Toggle diff panel", "切换差异面板"],
      [
        "chat.header.diffUnavailableNotGit",
        "Diff panel is unavailable because this project is not a git repository.",
        "此项目不是 Git 仓库，因此差异面板不可用。",
      ],
      ["chat.header.openRightSidebar", "Open right sidebar", "打开右侧边栏"],
      ["chat.header.closeRightSidebar", "Close right sidebar", "关闭右侧边栏"],
      ["chat.header.closeSelectedSide", "Close selected Side", "关闭所选侧边对话"],
    ] as const satisfies ReadonlyArray<readonly [TranslationKey, string, string]>;

    for (const [key, english, chinese] of cases) {
      expect(translateMoss("en", key), key).toBe(english);
      expect(translateMoss("zh-CN", key), key).toBe(chinese);
    }
  });
});

describe("HEL-21 zh-CN product glossary", () => {
  it("keeps concept families deterministic without collapsing distinct runtime concepts", () => {
    expect(ZH_CN_PRODUCT_GLOSSARY).toEqual({
      chat: "对话",
      conversation: "对话",
      thread: "对话",
      project: "项目",
      workspace: "工作区",
      worktree: "工作树",
      provider: "服务商",
      account: "账号",
      model: "模型",
      agent: "智能体",
      permissionModes: {
        "approval-required": "需要批准",
        auto: "自动批准",
        "full-access": "完全访问",
      },
    });
  });

  it("documents the same glossary and the boundaries for intentional technical terms", () => {
    const glossary = source("../../../docs/zh-CN-product-glossary.md");
    expect(glossary).toContain("chat / conversation / thread");
    expect(glossary).toContain("project");
    expect(glossary).toContain("workspace");
    expect(glossary).toContain("worktree");
    expect(glossary).toContain("provider");
    expect(glossary).toContain("account");
    expect(glossary).toContain("model");
    expect(glossary).toContain("Agent");
    expect(glossary).toContain("approval-required");
    expect(glossary).toContain("auto");
    expect(glossary).toContain("full-access");
    expect(glossary).toContain("Git");
    expect(glossary).toContain("MCP");
    expect(glossary).toContain("专有名称");
    expect(glossary).toContain("用户名称");
    expect(glossary).toContain("项目名称");
    expect(glossary).toContain("仓库内容");
  });

  it("applies glossary terms to model-source, environment, and conversation keys", () => {
    expect(translateMoss("zh-CN", "sidebar.newThread")).toBe("新建项目对话");
    expect(translateMoss("zh-CN", "sidebar.searchPalette.importThread.label")).toBe("导入对话...");
    expect(translateMoss("zh-CN", "chat.environment.worktree")).toBe("工作树");
    expect(translateMoss("zh-CN", "chat.agent.trigger")).toBe("切换智能体，当前：{agent}");
    expect(translateMoss("zh-CN", "chat.provider.missingAccount")).toBe("缺少账号");
    expect(translateMoss("zh-CN", "settings.nav.providers.label")).toBe("模型账号");
    expect(translateMoss("zh-CN", "settings.changed.defaultProvider")).toBe("默认服务商");
    expect(translateMoss("zh-CN", "settings.nav.models.label")).toBe("模型");
  });
});
