// FILE: mossToolPresentation.ts
// Purpose: What a tool row says for each Moss tool, in each state (running, done, failed,
//          stopped), in English and Simplified Chinese: one table the desktop and the phone
//          both read, so the phone never keeps a second, drifting copy.
// Layer: Shared pure logic (no DOM, no React, no other package imports), so the phone app
//          can import it through Metro.
// Exports: deriveMossMcpToolTitle, localizeMossToolHeading, mossToolLabel, the tool tables
//          and the name resolution the desktop's labels build on.
// Moved from apps/web/src/lib/toolCallLabel.ts (2026-11-24); the words are unchanged.

/** The browser tools Moss exposes to agents, and what each does. */
export const BROWSER_TOOL_TITLE_TABLE = {
  browser_status: "Check browser status",
  browser_tabs: "List browser tabs",
  browser_open: "Open browser tab",
  browser_navigate: "Navigate browser tab",
  browser_back: "Go back in browser history",
  browser_forward: "Go forward in browser history",
  browser_reload: "Reload browser page",
  browser_resize: "Resize browser viewport",
  browser_screenshot: "Capture browser screenshot",
  browser_logs: "Read browser diagnostics",
  browser_upload: "Upload workspace files",
  browser_run: "Run browser actions",
  browser_webmcp_tools: "Discover page WebMCP tools",
  browser_webmcp_call: "Call page WebMCP tool",
  browser_close: "Close browser tab",
} as const;

export interface MossMcpToolPresentation {
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
}

// Historical messages still contain retired tools (snapshot and element actions); presentation
// does not expose them to agents. The WebMCP tools are live again and come from BROWSER_TOOL_TITLE_TABLE.
export const BROWSER_HISTORY_TITLES = {
  ...BROWSER_TOOL_TITLE_TABLE,
  browser_snapshot: "Snapshot browser page",
  browser_click: "Click browser target",
  browser_hover: "Hover browser target",
  browser_drag: "Drag between browser targets",
  browser_type: "Type into browser target",
  browser_select: "Select browser options",
  browser_press: "Press browser keys",
  browser_scroll: "Scroll browser page",
  browser_wait: "Wait for browser condition",
  browser_evaluate: "Evaluate browser expression",
} as const;

export type BrowserHistoryToolName = keyof typeof BROWSER_HISTORY_TITLES;

export type MossBrowserToolName = `moss_${BrowserHistoryToolName}`;

export const BROWSER_HISTORY_TOOL_NAMES = Object.keys(
  BROWSER_HISTORY_TITLES,
) as BrowserHistoryToolName[];

export const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_HISTORY_TOOL_NAMES);

export const MOSS_BROWSER_TOOL_PRESENTATIONS = Object.fromEntries(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => {
    const title = BROWSER_HISTORY_TITLES[toolName];
    return [`moss_${toolName}`, { running: title, completed: title, failed: title }];
  }),
) as Record<MossBrowserToolName, MossMcpToolPresentation>;

/**
 * The desktop tools, spoken. Every browser tool had a curated presentation and
 * every computer tool had none, so the most consequential rows in the
 * transcript — an agent moving a pointer on the user's own machine — fell
 * through to the invented "Moss is handling computer click" fallback.
 *
 * The wording deliberately keeps the machine in the sentence ("this computer's
 * desktop") rather than saying "the desktop", because on the backends that
 * matter it is the user's own.
 */
export const MOSS_COMPUTER_TOOL_PRESENTATIONS = {
  moss_computer_screenshot: presentComputerTool("taking a screenshot", "took a screenshot"),
  moss_computer_get_state: presentComputerTool("reading the screen", "read the screen"),
  moss_computer_get_screen_size: presentComputerTool("measuring the screen", "measured the screen"),
  moss_computer_list_windows: presentComputerTool("listing windows", "listed the windows"),
  moss_computer_list_apps: presentComputerTool("listing apps", "listed the apps"),
  moss_computer_verify_state: presentComputerTool(
    "checking desktop state",
    "checked desktop state",
  ),
  moss_computer_zoom: presentComputerTool("zooming into a window", "zoomed into a window"),
  moss_computer_get_accessibility_tree: presentComputerTool(
    "listing apps and windows",
    "listed apps and windows",
  ),
  moss_computer_get_cursor_position: presentComputerTool(
    "reading the cursor position",
    "read the cursor position",
  ),
  moss_computer_help: presentComputerTool(
    "reading the Computer playbook",
    "read the Computer playbook",
  ),
  moss_computer_click: presentComputerTool("clicking the desktop", "clicked the desktop"),
  moss_computer_move_cursor: presentComputerTool("moving the cursor", "moved the cursor"),
  moss_computer_drag: presentComputerTool("dragging on the desktop", "dragged on the desktop"),
  moss_computer_scroll: presentComputerTool("scrolling the desktop", "scrolled the desktop"),
  moss_computer_type_text: presentComputerTool("typing on the desktop", "typed on the desktop"),
  moss_computer_press_key: presentComputerTool("pressing a key", "pressed a key"),
  moss_computer_set_value: presentComputerTool("setting a field", "set a field"),
  moss_computer_select_text: presentComputerTool("selecting text", "selected text"),
  moss_computer_perform_action: presentComputerTool("activating a control", "activated a control"),
  moss_computer_launch_app: presentComputerTool("opening an app", "opened an app"),
  moss_computer_activate_window: presentComputerTool("activating a window", "activated a window"),
  moss_computer_set_window_frame: presentComputerTool(
    "moving or resizing a window",
    "moved or resized a window",
  ),
  moss_computer_invoke_menu: presentComputerTool("invoking a menu item", "invoked a menu item"),
  moss_computer_kill_app: presentComputerTool("force-quitting an app", "force-quit an app"),
  moss_computer_set_window_minimized: presentComputerTool(
    "changing a window's visibility",
    "changed a window's visibility",
  ),
  moss_computer_set_app_visibility: presentComputerTool(
    "changing an app's visibility",
    "changed an app's visibility",
  ),
  moss_computer_wait: presentComputerTool("waiting for the desktop", "waited for the desktop"),
  moss_computer_read_clipboard: presentComputerTool("reading the clipboard", "read the clipboard"),
  moss_computer_write_clipboard: presentComputerTool(
    "writing to the clipboard",
    "wrote to the clipboard",
  ),
  moss_computer_paste: presentComputerTool("pasting text", "pasted text"),
  moss_computer_run: presentComputerTool("running a desktop sequence", "ran a desktop sequence"),
  moss_computer_inspect: presentComputerTool("inspecting the computer", "inspected the computer"),
  moss_computer_spaces: presentComputerTool(
    "inspecting desktop Spaces",
    "inspected desktop Spaces",
  ),
  moss_computer_browser_state: presentComputerTool(
    "reading the browser page",
    "read the browser page",
  ),
  moss_computer_browser_prepare: presentComputerTool("preparing a browser", "prepared a browser"),
  moss_computer_browser_navigate: presentComputerTool(
    "opening a browser page",
    "opened a browser page",
  ),
  moss_computer_browser_click: presentComputerTool(
    "clicking in the browser",
    "clicked in the browser",
  ),
  moss_computer_browser_type: presentComputerTool(
    "typing in a browser field",
    "typed in a browser field",
  ),
  moss_computer_browser_dialog: presentComputerTool(
    "handling a browser dialog",
    "handled a browser dialog",
  ),
  moss_computer_browser_upload: presentComputerTool(
    "attaching files in the browser",
    "attached files in the browser",
  ),
  moss_computer_browser_download: presentComputerTool("downloading a file", "downloaded a file"),
  moss_computer_browser_pointer: presentComputerTool(
    "using the pointer in the browser",
    "used the pointer in the browser",
  ),
  moss_computer_browser_press: presentComputerTool(
    "pressing Enter in the browser",
    "pressed Enter in the browser",
  ),
} as const satisfies Record<`moss_computer_${string}`, MossMcpToolPresentation>;

export function presentMossTool(present: string, past: string): MossMcpToolPresentation {
  return {
    running: `Moss is ${present}`,
    completed: `Moss ${past}`,
    failed: `Moss couldn't finish ${present}`,
  };
}

export function presentComputerTool(present: string, past: string): MossMcpToolPresentation {
  return {
    running: `Moss is ${present}`,
    completed: `Moss ${past}`,
    failed: `Moss couldn't finish ${present}`,
  };
}

export const MOSS_MCP_TOOL_PRESENTATIONS = {
  moss_context: {
    running: "Moss is checking its context",
    completed: "Moss checked its context",
    failed: "Moss couldn't check its context",
  },
  moss_capabilities: {
    running: "Moss is checking available agents",
    completed: "Moss checked available agents",
    failed: "Moss couldn't check available agents",
  },
  moss_overview: {
    running: "Moss is gathering an overview",
    completed: "Moss gathered an overview",
    failed: "Moss couldn't gather an overview",
  },
  moss_list_allowed_projects: {
    running: "Moss is listing allowed projects",
    completed: "Moss listed allowed projects",
    failed: "Moss couldn't list allowed projects",
  },
  moss_create_task: {
    running: "Moss is creating a task",
    completed: "Moss created a task",
    failed: "Moss couldn't create a task",
  },
  moss_wait_for_task: {
    running: "Moss is waiting for a task",
    completed: "Moss finished waiting for a task",
    failed: "Moss couldn't wait for a task",
  },
  moss_read_task: {
    running: "Moss is reading a task",
    completed: "Moss read a task",
    failed: "Moss couldn't read a task",
  },
  moss_list_projects: {
    running: "Moss is listing projects",
    completed: "Moss listed projects",
    failed: "Moss couldn't list projects",
  },
  moss_list_threads: {
    running: "Moss is listing threads",
    completed: "Moss listed threads",
    failed: "Moss couldn't list threads",
  },
  moss_read_thread: {
    running: "Moss is reading a thread",
    completed: "Moss read a thread",
    failed: "Moss couldn't read a thread",
  },
  moss_read_thread_activity: {
    running: "Moss is reading thread activity",
    completed: "Moss read thread activity",
    failed: "Moss couldn't read thread activity",
  },
  moss_read_thread_events: {
    running: "Moss is reading thread events",
    completed: "Moss read thread events",
    failed: "Moss couldn't read thread events",
  },
  moss_read_thread_runtime_events: {
    running: "Moss is reading thread runtime events",
    completed: "Moss read thread runtime events",
    failed: "Moss couldn't read thread runtime events",
  },
  moss_diagnose_thread: {
    running: "Moss is diagnosing a thread",
    completed: "Moss diagnosed a thread",
    failed: "Moss couldn't diagnose a thread",
  },
  moss_create_thread: {
    running: "Moss is creating a thread",
    completed: "Moss created a thread",
    failed: "Moss couldn't create a thread",
  },
  moss_create_threads: {
    running: "Moss is creating threads",
    completed: "Moss created threads",
    failed: "Moss couldn't create threads",
  },
  moss_wait_for_threads: {
    running: "Moss is waiting for threads",
    completed: "Moss finished waiting for threads",
    failed: "Moss couldn't wait for threads",
  },
  moss_send_message: {
    running: "Moss is sending a message",
    completed: "Moss sent a message",
    failed: "Moss couldn't send a message",
  },
  moss_read_kanban_board: {
    running: "Moss is reading the board",
    completed: "Moss read the board",
    failed: "Moss couldn't read the board",
  },
  moss_read_kanban_card: {
    running: "Moss is reading a board card",
    completed: "Moss read a board card",
    failed: "Moss couldn't read a board card",
  },
  moss_create_kanban_task: {
    running: "Moss is creating a board task",
    completed: "Moss created a board task",
    failed: "Moss couldn't create a board task",
  },
  moss_move_kanban_card: {
    running: "Moss is moving a board card",
    completed: "Moss moved a board card",
    failed: "Moss couldn't move a board card",
  },
  moss_interrupt_thread: {
    running: "Moss is interrupting a thread",
    completed: "Moss interrupted a thread",
    failed: "Moss couldn't interrupt a thread",
  },
  moss_set_thread_title: {
    running: "Moss is renaming a thread",
    completed: "Moss renamed a thread",
    failed: "Moss couldn't rename a thread",
  },
  moss_set_thread_archived: {
    running: "Moss is updating a thread",
    completed: "Moss updated a thread",
    failed: "Moss couldn't update a thread",
  },
  moss_create_automation: {
    running: "Moss is creating an automation",
    completed: "Moss created an automation",
    failed: "Moss couldn't create an automation",
  },
  moss_create_todo: {
    running: "Moss is adding a to-do",
    completed: "Moss added a to-do",
    failed: "Moss couldn't add a to-do",
  },
  moss_list_todos: {
    running: "Moss is reading your to-dos",
    completed: "Moss read your to-dos",
    failed: "Moss couldn't read your to-dos",
  },
  moss_update_todo: {
    running: "Moss is updating a to-do",
    completed: "Moss updated a to-do",
    failed: "Moss couldn't update a to-do",
  },
  moss_request_secret: {
    running: "Moss is asking you for a secret",
    completed: "Moss asked you for a secret",
    failed: "Moss couldn't ask you for a secret",
  },
  moss_list_automations: {
    running: "Moss is listing automations",
    completed: "Moss listed automations",
    failed: "Moss couldn't list automations",
  },
  moss_view_automation: {
    running: "Moss is viewing an automation",
    completed: "Moss viewed an automation",
    failed: "Moss couldn't view an automation",
  },
  moss_update_automation: {
    running: "Moss is updating an automation",
    completed: "Moss updated an automation",
    failed: "Moss couldn't update an automation",
  },
  moss_update_automation_memory: {
    running: "Moss is updating automation memory",
    completed: "Moss updated automation memory",
    failed: "Moss couldn't update automation memory",
  },
  moss_report_automation_result: {
    running: "Moss is reporting an automation result",
    completed: "Moss reported an automation result",
    failed: "Moss couldn't report an automation result",
  },
  moss_cancel_automation: {
    running: "Moss is stopping an automation",
    completed: "Moss stopped an automation",
    failed: "Moss couldn't stop an automation",
  },
  moss_update_kanban_card: presentMossTool("updating a board card", "updated a board card"),
  moss_delete_kanban_card: presentMossTool("deleting a board card", "deleted a board card"),
  moss_create_kanban_draft: presentMossTool("drafting board tasks", "drafted board tasks"),
  moss_set_kanban_goal: presentMossTool("setting the board goal", "set the board goal"),
  moss_set_thread_goal: presentMossTool("setting a thread goal", "set a thread goal"),
  moss_theme_read: presentMossTool("reading the theme guide", "read the theme guide"),
  moss_theme_set: presentMossTool("restyling Moss", "restyled Moss"),
  moss_set_thread_pull_request: presentMossTool("linking a pull request", "linked a pull request"),
  moss_unlink_thread_pull_request: presentMossTool(
    "unlinking a pull request",
    "unlinked a pull request",
  ),
  moss_show_visual: presentMossTool("showing a visual", "showed a visual"),
  moss_e2e_review: presentMossTool(
    "reading the end-to-end test guide",
    "read the end-to-end test guide",
  ),
  moss_pages_spaces: presentMossTool("listing document spaces", "listed document spaces"),
  moss_pages_list: presentMossTool("listing pages", "listed pages"),
  moss_pages_read: presentMossTool("reading a page", "read a page"),
  moss_pages_versions: presentMossTool("reading page versions", "read page versions"),
  moss_pages_comments: presentMossTool("reading page comments", "read page comments"),
  moss_pages_mutate: presentMossTool("updating a page", "updated a page"),
  moss_canvas_open: presentMossTool("opening Canvas", "opened Canvas"),
  moss_canvas_read: presentMossTool("reading Canvas", "read Canvas"),
  moss_canvas_mutate: presentMossTool("updating Canvas", "updated Canvas"),
  moss_media_list: presentMossTool(
    "checking image and video models",
    "checked image and video models",
  ),
  moss_media_generate: presentMossTool("starting a generation", "started a generation"),
  moss_media_get: presentMossTool("checking a generation", "checked a generation"),
  moss_read_widget_context: presentMossTool("reading widget state", "read widget state"),
  moss_report_friction: presentMossTool("recording tool feedback", "recorded tool feedback"),
  moss_draft_devs_report: presentMossTool(
    "drafting a report for the Moss developers",
    "drafted a report for the Moss developers",
  ),
  html_render: {
    running: "Rendering an HTML page",
    completed: "Rendered an HTML page",
    failed: "Couldn't render an HTML page",
  },
  html_preview: {
    running: "Previewing an HTML page",
    completed: "Previewed an HTML page",
    failed: "Couldn't preview an HTML page",
  },
  visual_guide: {
    running: "Reading the visual guide",
    completed: "Read the visual guide",
    failed: "Couldn't read the visual guide",
  },
  place_photos: {
    running: "Finding place photos",
    completed: "Found place photos",
    failed: "Couldn't find place photos",
  },
  ...MOSS_BROWSER_TOOL_PRESENTATIONS,
  ...MOSS_COMPUTER_TOOL_PRESENTATIONS,
} as const satisfies Record<string, MossMcpToolPresentation>;

// What each Moss gateway action did, in Simplified Chinese: [running, completed, failed].
// The Moss mark already sits beside the row, so the label starts with the action.
function zhAction(action: string): readonly [string, string, string] {
  return [`正在${action}`, `已${action}`, `无法${action}`];
}

// The Computer tools in Simplified Chinese. Until 2026-11-24 the desktop showed these rows in
// English inside a Chinese interface and the phone kept its own Chinese words; both now read
// these.
const ZH_CN_COMPUTER_TOOL_PRESENTATIONS = {
  moss_computer_screenshot: zhAction("截取屏幕"),
  moss_computer_get_state: zhAction("读取屏幕状态"),
  moss_computer_get_screen_size: zhAction("获取屏幕尺寸"),
  moss_computer_list_windows: zhAction("查看打开的窗口"),
  moss_computer_list_apps: zhAction("列出运行中的应用"),
  moss_computer_verify_state: zhAction("核对桌面状态"),
  moss_computer_zoom: zhAction("放大查看窗口"),
  moss_computer_get_accessibility_tree: zhAction("列出应用和窗口"),
  moss_computer_get_cursor_position: zhAction("读取指针位置"),
  moss_computer_help: zhAction("读取电脑操控指南"),
  moss_computer_click: zhAction("点击桌面"),
  moss_computer_move_cursor: zhAction("移动鼠标指针"),
  moss_computer_drag: zhAction("在桌面上拖拽"),
  moss_computer_scroll: zhAction("滚动桌面"),
  moss_computer_type_text: zhAction("在桌面上输入"),
  moss_computer_press_key: zhAction("按下按键"),
  moss_computer_set_value: zhAction("填写字段"),
  moss_computer_select_text: zhAction("选择文本"),
  moss_computer_perform_action: zhAction("操作控件"),
  moss_computer_launch_app: zhAction("打开应用"),
  moss_computer_activate_window: zhAction("切换窗口"),
  moss_computer_set_window_frame: zhAction("移动或调整窗口"),
  moss_computer_invoke_menu: zhAction("执行菜单命令"),
  moss_computer_kill_app: zhAction("强制退出应用"),
  moss_computer_set_window_minimized: zhAction("更改窗口显示状态"),
  moss_computer_set_app_visibility: zhAction("更改应用显示状态"),
  moss_computer_wait: zhAction("等待桌面就绪"),
  moss_computer_read_clipboard: zhAction("读取剪贴板"),
  moss_computer_write_clipboard: zhAction("写入剪贴板"),
  moss_computer_paste: zhAction("粘贴文本"),
  moss_computer_run: zhAction("执行一组桌面操作"),
  moss_computer_inspect: zhAction("检查电脑"),
  moss_computer_spaces: zhAction("查看桌面空间"),
  moss_computer_browser_state: zhAction("读取浏览器页面"),
  moss_computer_browser_prepare: zhAction("准备浏览器"),
  moss_computer_browser_navigate: zhAction("打开网页"),
  moss_computer_browser_click: zhAction("点击网页"),
  moss_computer_browser_type: zhAction("在网页中输入"),
  moss_computer_browser_dialog: zhAction("处理网页对话框"),
  moss_computer_browser_upload: zhAction("在网页中添加文件"),
  moss_computer_browser_download: zhAction("下载文件"),
  moss_computer_browser_pointer: zhAction("在网页中使用指针"),
  moss_computer_browser_press: zhAction("在网页中按回车"),
} as const satisfies Record<
  keyof typeof MOSS_COMPUTER_TOOL_PRESENTATIONS,
  readonly [string, string, string]
>;

export const ZH_CN_MOSS_TOOL_PRESENTATIONS: Readonly<
  Partial<Record<keyof typeof MOSS_MCP_TOOL_PRESENTATIONS, readonly [string, string, string]>>
> = {
  moss_context: ["正在检查上下文", "已检查上下文", "无法检查上下文"],
  moss_capabilities: ["正在查看可用智能体", "已查看可用智能体", "无法查看可用智能体"],
  moss_overview: ["正在汇总概况", "已汇总概况", "无法汇总概况"],
  moss_list_allowed_projects: ["正在列出可用项目", "已列出可用项目", "无法列出可用项目"],
  moss_create_task: ["正在创建任务", "已创建任务", "无法创建任务"],
  moss_wait_for_task: ["正在等待任务完成", "任务已完成", "无法等待任务"],
  moss_read_task: ["正在读取任务", "已读取任务", "无法读取任务"],
  moss_list_projects: ["正在列出项目", "已列出项目", "无法列出项目"],
  moss_list_threads: ["正在列出对话", "已列出对话", "无法列出对话"],
  moss_read_thread: ["正在读取对话", "已读取对话", "无法读取对话"],
  moss_read_thread_activity: ["正在读取对话动态", "已读取对话动态", "无法读取对话动态"],
  moss_read_thread_events: ["正在读取对话事件", "已读取对话事件", "无法读取对话事件"],
  moss_read_thread_runtime_events: ["正在读取运行事件", "已读取运行事件", "无法读取运行事件"],
  moss_diagnose_thread: ["正在诊断对话", "已诊断对话", "无法诊断对话"],
  moss_create_thread: ["正在创建对话", "已创建对话", "无法创建对话"],
  moss_create_threads: ["正在创建多个对话", "已创建多个对话", "无法创建对话"],
  moss_wait_for_threads: ["正在等待对话完成", "对话已完成", "无法等待对话"],
  moss_send_message: ["正在发送消息", "已发送消息", "无法发送消息"],
  moss_read_kanban_board: ["正在读取看板", "已读取看板", "无法读取看板"],
  moss_read_kanban_card: ["正在读取看板卡片", "已读取看板卡片", "无法读取看板卡片"],
  moss_create_kanban_task: ["正在创建看板任务", "已创建看板任务", "无法创建看板任务"],
  moss_move_kanban_card: ["正在移动看板卡片", "已移动看板卡片", "无法移动看板卡片"],
  moss_update_kanban_card: ["正在更新看板卡片", "已更新看板卡片", "无法更新看板卡片"],
  moss_delete_kanban_card: ["正在删除看板卡片", "已删除看板卡片", "无法删除看板卡片"],
  moss_create_kanban_draft: ["正在起草看板任务", "已起草看板任务", "无法起草看板任务"],
  moss_set_kanban_goal: ["正在设置看板目标", "已设置看板目标", "无法设置看板目标"],
  moss_interrupt_thread: ["正在中断对话", "已中断对话", "无法中断对话"],
  moss_set_thread_title: ["正在重命名对话", "已重命名对话", "无法重命名对话"],
  moss_set_thread_archived: ["正在更新对话", "已更新对话", "无法更新对话"],
  moss_set_thread_goal: ["正在设置对话目标", "已设置对话目标", "无法设置对话目标"],
  moss_theme_read: ["正在读取主题指南", "已读取主题指南", "无法读取主题指南"],
  moss_theme_set: ["正在更换 Moss 外观", "已更换 Moss 外观", "无法更换 Moss 外观"],
  moss_set_thread_pull_request: ["正在关联拉取请求", "已关联拉取请求", "无法关联拉取请求"],
  moss_unlink_thread_pull_request: [
    "正在取消关联拉取请求",
    "已取消关联拉取请求",
    "无法取消关联拉取请求",
  ],
  moss_create_automation: ["正在创建自动化", "已创建自动化", "无法创建自动化"],
  moss_list_automations: ["正在列出自动化", "已列出自动化", "无法列出自动化"],
  moss_view_automation: ["正在查看自动化", "已查看自动化", "无法查看自动化"],
  moss_update_automation: ["正在更新自动化", "已更新自动化", "无法更新自动化"],
  moss_update_automation_memory: ["正在更新自动化记忆", "已更新自动化记忆", "无法更新自动化记忆"],
  moss_report_automation_result: ["正在报告自动化结果", "已报告自动化结果", "无法报告自动化结果"],
  moss_cancel_automation: ["正在停止自动化", "已停止自动化", "无法停止自动化"],
  moss_create_todo: ["正在添加待办", "已添加待办", "无法添加待办"],
  moss_list_todos: ["正在读取待办", "已读取待办", "无法读取待办"],
  moss_update_todo: ["正在更新待办", "已更新待办", "无法更新待办"],
  moss_request_secret: ["正在向你请求密钥", "已向你请求密钥", "无法请求密钥"],
  moss_show_visual: ["正在生成图表", "已生成图表", "无法生成图表"],
  moss_e2e_review: ["正在读取端到端测试指南", "已读取端到端测试指南", "无法读取端到端测试指南"],
  moss_pages_spaces: ["正在列出资料空间", "已列出资料空间", "无法列出资料空间"],
  moss_pages_list: ["正在列出文档", "已列出文档", "无法列出文档"],
  moss_pages_read: ["正在读取文档", "已读取文档", "无法读取文档"],
  moss_pages_versions: ["正在读取文档历史", "已读取文档历史", "无法读取文档历史"],
  moss_pages_comments: ["正在读取文档评论", "已读取文档评论", "无法读取文档评论"],
  moss_pages_mutate: ["正在更新文档", "已更新文档", "无法更新文档"],
  moss_canvas_open: ["正在打开画布", "已打开画布", "无法打开画布"],
  moss_canvas_read: ["正在查看画布", "已查看画布", "无法查看画布"],
  moss_canvas_mutate: ["正在更新画布", "已更新画布", "无法更新画布"],
  moss_media_list: ["正在查看图像和视频模型", "已查看图像和视频模型", "无法查看图像和视频模型"],
  moss_media_generate: ["正在提交生成", "已提交生成", "无法提交生成"],
  moss_media_get: ["正在查询生成进度", "已查询生成进度", "无法查询生成进度"],
  moss_read_widget_context: ["正在读取小组件状态", "已读取小组件状态", "无法读取小组件状态"],
  moss_report_friction: ["正在记录工具反馈", "已记录工具反馈", "无法记录工具反馈"],
  moss_draft_devs_report: [
    "正在起草给 Moss 开发者的问题报告",
    "已起草给 Moss 开发者的问题报告",
    "无法起草给 Moss 开发者的问题报告",
  ],
  ...ZH_CN_COMPUTER_TOOL_PRESENTATIONS,
};

export const ZH_CN_MOSS_TOOL_HEADINGS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ZH_CN_MOSS_TOOL_PRESENTATIONS).flatMap(([toolName, zh]) => {
    const presentation = (MOSS_MCP_TOOL_PRESENTATIONS as Record<string, MossMcpToolPresentation>)[
      toolName
    ];
    if (!presentation || !zh) return [];
    const [running, completed, failed] = zh;
    return [
      [presentation.running, running],
      [presentation.completed, completed],
      [presentation.failed, failed],
      // deriveMossMcpToolTitle's cancelled form: "Moss stopped <running action>".
      [
        `Moss stopped ${presentation.running.slice("Moss is ".length)}`,
        `已停止${running.replace(/^正在/u, "")}`,
      ],
    ];
  }),
);

// Tools whose row title is the same in every state (the browser tools) or does not start
// with "Moss" (HTML pages, the visual tools), in Simplified Chinese, keyed by the English.
export const ZH_CN_PLAIN_TOOL_HEADINGS: Readonly<Record<string, string>> = {
  "Check browser status": "检查浏览器状态",
  "List browser tabs": "列出浏览器标签页",
  "Open browser tab": "打开浏览器标签页",
  "Navigate browser tab": "导航浏览器标签页",
  "Go back in browser history": "返回浏览器上一页",
  "Go forward in browser history": "前往浏览器下一页",
  "Reload browser page": "重新加载浏览器页面",
  "Resize browser viewport": "调整浏览器视口",
  "Snapshot browser page": "获取浏览器页面快照",
  "Capture browser screenshot": "截取浏览器屏幕",
  "Read browser diagnostics": "读取浏览器诊断",
  "Click browser target": "点击浏览器目标",
  "Hover browser target": "悬停浏览器目标",
  "Drag between browser targets": "拖动浏览器目标",
  "Type into browser target": "在浏览器目标中输入",
  "Select browser options": "选择浏览器选项",
  "Upload workspace files": "上传工作区文件",
  "Press browser keys": "按下浏览器按键",
  "Scroll browser page": "滚动浏览器页面",
  "Wait for browser condition": "等待浏览器条件",
  "Evaluate browser expression": "执行浏览器表达式",
  "Close browser tab": "关闭浏览器标签页",
  "Discover page WebMCP tools": "查看网页提供的工具",
  "Call page WebMCP tool": "调用网页提供的工具",
  "Rendering an HTML page": "正在渲染 HTML 页面",
  "Rendered an HTML page": "已渲染 HTML 页面",
  "Couldn't render an HTML page": "无法渲染 HTML 页面",
  "Previewing an HTML page": "正在预览 HTML 页面",
  "Previewed an HTML page": "已预览 HTML 页面",
  "Couldn't preview an HTML page": "无法预览 HTML 页面",
  "Reading the visual guide": "正在阅读可视化指南",
  "Read the visual guide": "已阅读可视化指南",
  "Couldn't read the visual guide": "无法阅读可视化指南",
  "Finding place photos": "正在查找地点照片",
  "Found place photos": "已找到地点照片",
  "Couldn't find place photos": "无法查找地点照片",
  "Run browser actions": "执行浏览器操作",
};

/** zh-CN for a Moss action: a known one, or the generic "Moss handled …" fallback. */
export function localizeMossToolHeading(value: string): string | undefined {
  const known = ZH_CN_MOSS_TOOL_HEADINGS[value] ?? ZH_CN_PLAIN_TOOL_HEADINGS[value];
  if (known) return known;
  if (/^Moss is handling .+$/u.test(value)) return "正在使用 Moss 工具";
  if (/^Moss handled .+$/u.test(value)) return "已使用 Moss 工具";
  if (/^Moss couldn't handle .+$/u.test(value)) return "Moss 工具未完成";
  return undefined;
}

export function normalizeMossMcpIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export const MOSS_BROWSER_TOOL_NAME_BY_PRESENTATION = new Map<string, MossBrowserToolName>(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => [
    normalizeMossMcpIdentifier(BROWSER_HISTORY_TITLES[toolName]),
    `moss_${toolName}`,
  ]),
);

export const MOSS_MCP_TOOL_PRESENTATION_ENTRIES = Object.entries(MOSS_MCP_TOOL_PRESENTATIONS).map(
  ([toolName, presentation]) => ({
    toolName,
    presentation,
    normalizedRunning: normalizeMossMcpIdentifier(presentation.running),
    normalizedCompleted: normalizeMossMcpIdentifier(presentation.completed),
    normalizedFailed: normalizeMossMcpIdentifier(presentation.failed),
  }),
);

// Moss Apps' server name also starts with "moss_", but its tools are the app
// backend's, named by mossAppsToolLabel rather than as Moss gateway actions.
export const MOSS_APPS_IDENTIFIER_PREFIX = /^(?:mcp_)?moss_apps(?:_|$)/u;

export function extractMossMcpToolName(normalizedCandidate: string): string | null {
  if (MOSS_APPS_IDENTIFIER_PREFIX.test(normalizedCandidate)) {
    return null;
  }
  // HTML tools keep their bare names. Match them before the moss_ prefix so
  // `moss_html_preview` is a page preview, not a generic Moss action.
  const htmlTool = /^(?:(?:mcp_)?moss_)?html_(render|preview)(?:_|$)/u.exec(
    normalizedCandidate,
  )?.[1];
  if (htmlTool === "render") {
    return "html_render";
  }
  if (htmlTool === "preview") {
    return "html_preview";
  }
  // The visual tools keep their bare names too.
  const visualTool = /^(?:(?:mcp_)?moss_)?(visual_guide|place_photos)(?:_|$)/u.exec(
    normalizedCandidate,
  )?.[1];
  if (visualTool !== undefined) {
    return visualTool;
  }
  if (BROWSER_TOOL_NAME_SET.has(normalizedCandidate)) {
    return `moss_${normalizedCandidate}`;
  }
  if (normalizedCandidate.startsWith("mcp_moss_moss_")) {
    return normalizedCandidate.slice("mcp_moss_".length);
  }
  if (normalizedCandidate.startsWith("mcp_moss_")) {
    return `moss_${normalizedCandidate.slice("mcp_moss_".length)}`;
  }
  if (normalizedCandidate.startsWith("moss_moss_")) {
    return normalizedCandidate.slice("moss_".length);
  }
  if (normalizedCandidate.startsWith("moss_")) {
    return normalizedCandidate;
  }
  return null;
}

/** Moss tools that block until the user answers a card in the chat. */
export const MOSS_USER_ANSWER_TOOL_NAMES: ReadonlySet<string> = new Set(["moss_request_secret"]);

export function isMossUserAnswerToolCall(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const name = extractMossMcpToolName(aliasMossPrefix(normalizeMossMcpIdentifier(toolName)));
  return name !== null && MOSS_USER_ANSWER_TOOL_NAMES.has(name);
}

/** The agent's own calls that start or follow a Moss media job. */
export const MOSS_MEDIA_JOB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "moss_media_generate",
  "moss_media_get",
]);

export function isMossMediaJobToolCall(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const name = extractMossMcpToolName(aliasMossPrefix(normalizeMossMcpIdentifier(toolName)));
  return name !== null && MOSS_MEDIA_JOB_TOOL_NAMES.has(name);
}

export function resolveMossBrowserToolName(
  candidates: ReadonlyArray<string | null | undefined>,
): MossBrowserToolName | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalizedCandidate = normalizeMossMcpIdentifier(candidate);
    const extractedToolName = extractMossMcpToolName(normalizedCandidate);
    const candidateToolName =
      extractedToolName ??
      MOSS_BROWSER_TOOL_NAME_BY_PRESENTATION.get(normalizedCandidate) ??
      normalizedCandidate;
    if (candidateToolName in MOSS_BROWSER_TOOL_PRESENTATIONS) {
      return candidateToolName as MossBrowserToolName;
    }
  }
  return null;
}

export function fallbackMossMcpToolPresentation(toolName: string): MossMcpToolPresentation {
  const action =
    toolName
      .replace(/^moss_/, "")
      .replace(/_+/g, " ")
      .trim() || "an action";
  return {
    running: `Moss is handling ${action}`,
    completed: `Moss handled ${action}`,
    failed: `Moss couldn't handle ${action}`,
  };
}

export function resolveMossMcpToolPresentation(
  candidates: ReadonlyArray<string | null | undefined>,
  options?: { readonly requireHtmlToolIdentity?: boolean },
): MossMcpToolPresentation | null {
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate) {
      continue;
    }
    const normalizedCandidate = aliasMossPrefix(normalizeMossMcpIdentifier(candidate));
    for (const entry of MOSS_MCP_TOOL_PRESENTATION_ENTRIES) {
      if (
        normalizedCandidate === entry.normalizedRunning ||
        normalizedCandidate === entry.normalizedCompleted ||
        normalizedCandidate === entry.normalizedFailed
      ) {
        if (
          options?.requireHtmlToolIdentity &&
          index > 0 &&
          (entry.presentation === MOSS_MCP_TOOL_PRESENTATIONS.html_render ||
            entry.presentation === MOSS_MCP_TOOL_PRESENTATIONS.html_preview)
        ) {
          continue;
        }
        return entry.presentation;
      }
    }
    const toolName = extractMossMcpToolName(normalizedCandidate);
    const aliasedToolName = toolName ? aliasMossPrefix(toolName) : null;
    const knownPresentation = aliasedToolName
      ? (MOSS_MCP_TOOL_PRESENTATIONS[aliasedToolName as keyof typeof MOSS_MCP_TOOL_PRESENTATIONS] as
          | MossMcpToolPresentation
          | undefined)
      : undefined;
    if (knownPresentation) {
      if (options?.requireHtmlToolIdentity && index > 0 && toolName) {
        continue;
      }
      return knownPresentation;
    }
    // Free-text summaries (e.g. reconciler activity lines) can begin with the
    // word "Moss" and normalize into a fake tool identifier; only
    // identifier-shaped candidates may take an invented fallback presentation.
    if (/\s/.test(candidate.trim())) {
      continue;
    }
    if (normalizedCandidate.startsWith("moss_is_handling_")) {
      return fallbackMossMcpToolPresentation(
        `moss_${normalizedCandidate.slice("moss_is_handling_".length)}`,
      );
    }
    if (normalizedCandidate.startsWith("moss_handled_")) {
      return fallbackMossMcpToolPresentation(
        `moss_${normalizedCandidate.slice("moss_handled_".length)}`,
      );
    }
    if (normalizedCandidate.startsWith("moss_couldn_t_handle_")) {
      return fallbackMossMcpToolPresentation(
        `moss_${normalizedCandidate.slice("moss_couldn_t_handle_".length)}`,
      );
    }
    if (!aliasedToolName) {
      continue;
    }
    return fallbackMossMcpToolPresentation(aliasedToolName);
  }
  return null;
}

export type MossMcpToolStatus = "running" | "completed" | "failed" | "cancelled";

export interface MossMcpToolTitleInput {
  readonly toolName?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly fallbackLabel?: string | null | undefined;
  readonly status?: MossMcpToolStatus | undefined;
}

// Every provider exposes Moss's MCP tools differently: MCP, dynamic, and even
// file-change rows can all represent the same gateway action. Normalize by tool
// identity instead of provider item type so transport details never reach the UI.
export function deriveMossMcpToolTitle(input: MossMcpToolTitleInput): string | null {
  const presentation = resolveMossMcpToolPresentation(
    [input.toolName, input.title, input.fallbackLabel],
    {
      requireHtmlToolIdentity: input.toolName !== undefined && input.toolName !== null,
    },
  );
  if (!presentation) {
    return null;
  }
  switch (input.status ?? "completed") {
    case "running":
      return presentation.running;
    case "completed":
      return presentation.completed;
    case "failed":
      return presentation.failed;
    case "cancelled":
      return presentation.running.startsWith("Moss is ")
        ? `Moss stopped ${presentation.running.slice("Moss is ".length)}`
        : `Cancelled ${presentation.running}`;
  }
}

// The upstream rebrand renamed the public server/tool prefix from moss_ to
// moss_; records and fixtures from that lineage resolve to the same Moss
// presentations. Only a leading prefix is rewritten, so titles like
// "Moss: Moss Create Threads" and ids like "mcp__moss__moss_run" both
// collapse onto the Moss keys.
export function aliasMossPrefix(normalizedCandidate: string): string {
  return normalizedCandidate
    .replace(/^mcp_moss_/, "mcp_moss_")
    .replace(/^moss_moss_/, "moss_")
    .replace(/^moss_/, "moss_")
    .replace(/^moss_moss_/, "moss_");
}

export type MossToolLocale = "en" | "zh-CN";

/**
 * What a row says for a Moss tool call (gateway, Computer, browser, HTML and visual tools),
 * in the given state and language, exactly as the desktop's transcript says it; null when the
 * name is not a Moss tool. Names arrive however a provider wraps them
 * (`mcp__moss__moss_context`, `moss_context`, `browser_open`).
 */
export function mossToolLabel(input: {
  readonly toolName: string;
  readonly status?: MossMcpToolStatus | undefined;
  readonly locale: MossToolLocale;
}): string | null {
  const title = deriveMossMcpToolTitle({ toolName: input.toolName, status: input.status });
  if (!title) return null;
  return input.locale === "zh-CN" ? (localizeMossToolHeading(title) ?? title) : title;
}
