// FILE: toolCallLabel.ts
// Purpose: Normalizes generic tool-call titles and humanizes command executions for timeline rows.
// Layer: UI utility
// Exports: deriveReadableToolTitle, deriveReadableCommandDisplay, deriveFriendlyCommandTarget, command icon classifiers, deriveInlineCommandCall, deriveLiteralCommand, deriveCommandReadTargets, normalizeCompactToolLabel, isGenericToolTitle, extractWebFetchUrl
// Depends on: @synara/contracts tool lifecycle item types

import type { ToolLifecycleItemType } from "@synara/contracts";
import { BROWSER_TOOL_TITLES } from "@synara/shared/browserAutomationPresentation";
import {
  isMossAppsServer,
  MOSS_APPS_DISPLAY_NAME,
  mossAppsToolAction,
} from "@synara/shared/mossAppsPresentation";
import {
  COMPUTER_TOOL_TITLES,
  computerToolName,
  type ComputerToolName,
} from "./computerToolPresentation";
import { basenameOfPath } from "../file-icons";
import { extractToolArgumentField } from "./toolArgumentSummary";
import type { MossLocaleCode } from "~/uiLocale";

// Keyed by the shared English action labels.
const ZH_CN_MOSS_APPS_ACTIONS: Readonly<Record<string, string>> = {
  "Find app actions": "查找可用操作",
  "Read app action details": "读取操作说明",
  "Run app actions": "执行操作",
  "Check app connections": "检查连接",
  "Use the app workbench": "使用工作台",
  "Run an app workbench command": "在工作台运行命令",
};

const ZH_CN_TOOL_HEADINGS: Readonly<Record<string, string>> = {
  Read: "已读取",
  Reading: "正在读取",
  Edited: "已编辑",
  Search: "搜索",
  "Searched the web": "已搜索网页",
  "Generated image": "已生成图片",
  "Viewed image": "已查看图片",
  "Agent task": "智能体任务",
  Searching: "正在搜索",
  Searched: "已搜索",
  Listing: "正在列出",
  Listed: "已列出",
  Finding: "正在查找",
  Found: "已找到",
  Creating: "正在创建",
  Created: "已创建",
  Removing: "正在移除",
  Removed: "已移除",
  Copying: "正在复制",
  Copied: "已复制",
  Moving: "正在移动",
  Moved: "已移动",
  Checking: "正在检查",
  Checked: "已检查",
  Comparing: "正在比较",
  Compared: "已比较",
  Inspecting: "正在检查",
  Inspected: "已检查",
  Reviewing: "正在查看",
  Reviewed: "已查看",
  Staging: "正在暂存",
  Staged: "已暂存",
  Committing: "正在提交",
  Committed: "已提交",
  Pushing: "正在推送",
  Pushed: "已推送",
  Pulling: "正在拉取",
  Pulled: "已拉取",
  "Switching to": "正在切换到",
  "Switched to": "已切换到",
  Running: "正在运行",
  Ran: "已运行",
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
  "Rendering an HTML page": "正在渲染 HTML 页面",
  "Rendered an HTML page": "已渲染 HTML 页面",
  "Couldn't render an HTML page": "无法渲染 HTML 页面",
  "Previewing an HTML page": "正在预览 HTML 页面",
  "Previewed an HTML page": "已预览 HTML 页面",
  "Couldn't preview an HTML page": "无法预览 HTML 页面",
  "Search tools:": "搜索工具：",
  ...Object.fromEntries(
    Object.entries(ZH_CN_MOSS_APPS_ACTIONS).map(([action, translated]) => [
      `${MOSS_APPS_DISPLAY_NAME}: ${action}`,
      `Moss 应用：${translated}`,
    ]),
  ),
};

export function localizeToolHeading(value: string, locale: MossLocaleCode): string {
  return locale === "zh-CN" ? (ZH_CN_TOOL_HEADINGS[value] ?? value) : value;
}

/** What a Moss Apps tool does ("Run app actions"), in the UI language. */
export function localizeMossAppsToolAction(tool: string, locale: MossLocaleCode): string {
  const action = mossAppsToolAction(tool);
  return locale === "zh-CN" ? (ZH_CN_MOSS_APPS_ACTIONS[action] ?? action) : action;
}

export function normalizeCompactToolLabel(value: string): string {
  return value
    .trimEnd()
    .replace(/\s(?:complete|completed|done|finished|success|succeeded|started|running)$/i, "")
    .trim();
}

// Canonical form for comparing tool display strings (heading vs preview vs
// label): ignores case, whitespace runs, and trailing status words so dedup
// decisions behave identically in the work-log builder and the timeline rows.
export function normalizeToolTextForComparison(value: string | undefined): string {
  return normalizeCompactToolLabel(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Web-fetch tool calls (e.g. Claude's `WebFetch`) arrive as generic dynamic tool
// calls whose detail is the raw `ToolName: {json}` argument summary. Recognizing
// them lets the timeline surface the target site (favicon + URL) instead of the
// raw JSON arguments.
const WEB_FETCH_TOOL_NAMES = new Set(["webfetch", "fetch", "urlfetch", "fetchurl", "httpfetch"]);

function isWebFetchToolName(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.toLowerCase().replace(/[^a-z]/g, "");
  if (WEB_FETCH_TOOL_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("fetch") &&
    (normalized.includes("web") || normalized.includes("url") || normalized.includes("http"))
  );
}

// Pulls the first http(s) URL out of a web-fetch tool call's argument summary.
// Prefers the JSON `url`/`uri` field (the actual shape) and falls back to a bare
// URL token so a slightly different summary still resolves. Returns null for
// non-fetch tools or when no usable URL is present, so callers fall back to the
// generic tool-call rendering.
export function extractWebFetchUrl(input: {
  readonly toolName?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): string | null {
  if (!isWebFetchToolName(input.toolName)) {
    return null;
  }
  const detail = input.detail;
  if (!detail) {
    return null;
  }
  const candidate =
    extractToolArgumentField(detail, ["url", "uri"]) ??
    /https?:\/\/[^\s"'<>)\]}]+/i.exec(detail)?.[0]?.replace(/[.,;:!?]+$/, "");
  if (candidate && /^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  return null;
}

// Moss Apps rows say what each backend meta-tool does instead of its branded name.
function mossAppsToolLabel(server: string | undefined, tool: string): string | null {
  return isMossAppsServer(server) ? mossAppsToolAction(tool) : null;
}

/**
 * The server and tool behind an MCP approval. Claude names the tool
 * `mcp__<server>__<tool>`; Codex reports the server beside a bare tool name.
 */
export function resolveMcpApprovalTool(input: {
  readonly serverName?: string | undefined;
  readonly toolName?: string | undefined;
}): { readonly server: string | null; readonly tool: string | null } {
  const toolName = input.toolName?.trim() ?? "";
  if (toolName.startsWith("mcp__")) {
    const [, server, ...rest] = toolName.split("__");
    const tool = rest.join("__").trim();
    if (server?.trim() && tool) return { server: server.trim(), tool };
  }
  return {
    server: input.serverName?.trim() || null,
    tool: toolName || null,
  };
}

// Turns internal MCP identifiers into readable inline labels for timeline rows.
function humanizeMcpToolIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const [, server, tool, ...rest] = trimmed.split("__");
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool =
    mossAppsToolLabel(server, [tool, ...rest].join("__")) ??
    [tool, ...rest]
      .map((part) => humanizeMcpToken(part))
      .filter((part) => part.length > 0)
      .join(" ");

  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

function humanizeMcpServerTool(server: string, tool: string): string | null {
  const normalizedServer = humanizeMcpToken(server);
  const normalizedTool = mossAppsToolLabel(server, tool) ?? humanizeMcpToken(tool);
  if (!normalizedServer || !normalizedTool) {
    return null;
  }
  return `${normalizedServer}: ${normalizedTool}`;
}

export interface ReadableToolTitleInput {
  readonly title?: string | null;
  readonly fallbackLabel: string;
  readonly itemType?: ToolLifecycleItemType | undefined;
  readonly requestKind?:
    | "command"
    | "file-read"
    | "file-change"
    | "permissions"
    | "tool"
    | "computer-foreground"
    | undefined;
  readonly command?: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly isRunning?: boolean;
}

interface MossMcpToolPresentation {
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
}

// Historical messages still contain retired tools; presentation does not expose them to agents.
const BROWSER_HISTORY_TITLES = {
  ...BROWSER_TOOL_TITLES,
  browser_snapshot: "Snapshot browser page",
  browser_webmcp_tools: "Discover page WebMCP tools",
  browser_webmcp_call: "Call page WebMCP tool",
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
type BrowserHistoryToolName = keyof typeof BROWSER_HISTORY_TITLES;
type MossBrowserToolName = `moss_${BrowserHistoryToolName}`;
const BROWSER_HISTORY_TOOL_NAMES = Object.keys(BROWSER_HISTORY_TITLES) as BrowserHistoryToolName[];
const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_HISTORY_TOOL_NAMES);

const MOSS_BROWSER_TOOL_PRESENTATIONS = Object.fromEntries(
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
const MOSS_COMPUTER_TOOL_PRESENTATIONS = {
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
} as const satisfies Record<`moss_${ComputerToolName}`, MossMcpToolPresentation>;

function presentComputerTool(present: string, past: string): MossMcpToolPresentation {
  return {
    running: `Moss is ${present}`,
    completed: `Moss ${past}`,
    failed: `Moss couldn't finish ${present}`,
  };
}

const MOSS_MCP_TOOL_PRESENTATIONS = {
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
  ...MOSS_BROWSER_TOOL_PRESENTATIONS,
  ...MOSS_COMPUTER_TOOL_PRESENTATIONS,
} as const satisfies Record<string, MossMcpToolPresentation>;

function normalizeMossMcpIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const MOSS_BROWSER_TOOL_NAME_BY_PRESENTATION = new Map<string, MossBrowserToolName>(
  BROWSER_HISTORY_TOOL_NAMES.map((toolName) => [
    normalizeMossMcpIdentifier(BROWSER_HISTORY_TITLES[toolName]),
    `moss_${toolName}`,
  ]),
);

const MOSS_MCP_TOOL_PRESENTATION_ENTRIES = Object.entries(MOSS_MCP_TOOL_PRESENTATIONS).map(
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
const MOSS_APPS_IDENTIFIER_PREFIX = /^(?:mcp_)?moss_apps(?:_|$)/u;

function extractMossMcpToolName(normalizedCandidate: string): string | null {
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
const MOSS_USER_ANSWER_TOOL_NAMES: ReadonlySet<string> = new Set(["moss_request_secret"]);

export function isMossUserAnswerToolCall(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const name = extractMossMcpToolName(aliasMossPrefix(normalizeMossMcpIdentifier(toolName)));
  return name !== null && MOSS_USER_ANSWER_TOOL_NAMES.has(name);
}

function resolveMossBrowserToolName(
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

function fallbackMossMcpToolPresentation(toolName: string): MossMcpToolPresentation {
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

function resolveMossMcpToolPresentation(
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

export function isMossBrowserToolCall(input: MossMcpToolTitleInput): boolean {
  return resolveMossBrowserToolName([input.toolName, input.title, input.fallbackLabel]) !== null;
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

export function sanitizeMossMcpToolPreview(input: {
  readonly preview?: string | null | undefined;
  readonly heading: string;
  readonly status?: MossMcpToolStatus | undefined;
}): string | null {
  const preview = input.preview?.trim();
  if (!preview) return null;
  const previewTitle = deriveMossMcpToolTitle({ title: preview, status: input.status });
  if (
    previewTitle &&
    normalizeMossMcpIdentifier(previewTitle) === normalizeMossMcpIdentifier(input.heading)
  ) {
    return null;
  }
  return preview;
}

export function deriveReadableToolTitle(input: ReadableToolTitleInput): string | null {
  const normalizedTitle = normalizeCompactToolLabel(input.title ?? "");
  const normalizedFallback = normalizeCompactToolLabel(input.fallbackLabel);
  const fileChangeLike = input.requestKind === "file-change" || input.itemType === "file_change";

  // Native Codex uses progressive copy while a file edit is active and past
  // tense once the item settles. Providers sometimes send a generic title
  // (or the settled title from a replayed item), so normalize lifecycle-only
  // file-change titles from the actual activity state before the generic title
  // path can freeze the row at “Edited”. Per-file add/delete verbs remain
  // owned by TimelineWorkEntryRow, which has the typed change kind.
  if (fileChangeLike && isFileChangeLifecycleTitle(normalizedTitle)) {
    return deriveFileChangeLifecycleTitle(normalizedTitle, input.isRunning);
  }
  const commandLabel = input.command
    ? deriveReadableCommandDisplay(input.command, input.isRunning).verb
    : null;
  const commandLike = input.itemType === "command_execution" || input.requestKind === "command";

  // Derive a verbal label from requestKind when the title is generic
  const requestKindLabel = humanizeRequestKind(input.requestKind, input.itemType, input.isRunning);

  if (normalizedTitle.length > 0 && !isGenericToolTitle(normalizedTitle)) {
    return (input.itemType === "mcp_tool_call" || input.itemType === "dynamic_tool_call") &&
      /[_-]/.test(normalizedTitle)
      ? (normalizeToolDescriptor(normalizedTitle) ?? normalizedTitle)
      : normalizedTitle;
  }

  if (commandLike && commandLabel) {
    return commandLabel;
  }

  const descriptor = normalizeToolDescriptor(extractToolDescriptorFromPayload(input.payload));
  if (descriptor && !isGenericToolTitle(descriptor)) {
    return descriptor;
  }

  // A generic request kind describes the transport, while the payload can name
  // the actual tool. Only use it after the provider metadata has been checked.
  if (requestKindLabel) {
    return requestKindLabel;
  }

  if (normalizedFallback.length > 0 && !isGenericToolTitle(normalizedFallback)) {
    return normalizedFallback;
  }
  if (normalizedTitle.length > 0) {
    return normalizedTitle;
  }
  if (normalizedFallback.length > 0) {
    return normalizedFallback;
  }
  return null;
}

export interface ReadableCommandDisplay {
  readonly verb: string;
  readonly target: string;
  readonly fullCommand: string;
}

// "read" and "search" split the read-only inspections so a file read and a
// pattern search wear different glyphs; listings (`ls`) are plain commands.
export type CommandVisualKind = "read" | "search" | "git" | "github" | "terminal";

function humanizeRequestKind(
  requestKind: ReadableToolTitleInput["requestKind"],
  itemType: ReadableToolTitleInput["itemType"],
  isRunning = false,
): string | null {
  if (requestKind === "file-read") return "Read";
  if (requestKind === "file-change" || itemType === "file_change") {
    return isRunning ? "Editing" : "Edited";
  }
  if (requestKind === "computer-foreground") return "Computer access";
  if (requestKind === "tool") return "Tool";
  // Don't handle command types here — let humanizeCommandToolLabel produce more specific labels
  if (itemType === "web_search") return "Searched the web";
  if (itemType === "image_generation") return "Generated image";
  if (itemType === "image_view") return "Viewed image";
  if (itemType === "collab_agent_tool_call") return "Agent task";
  return null;
}

export function isGenericToolTitle(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "dynamic tool call" ||
    normalized === "mcp tool call" ||
    normalized === "agent task" ||
    normalized === "subagent task" ||
    normalized === "task" ||
    normalized === "command run" ||
    normalized === "ran command" ||
    normalized === "running command" ||
    normalized === "command execution" ||
    normalized === "file change" ||
    normalized === "find" ||
    normalized === "read file"
  );
}

function normalizeToolDescriptor(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const computerTool = computerToolName(value);
  if (computerTool) {
    return COMPUTER_TOOL_TITLES[computerTool];
  }
  const mcpIdentifier = humanizeMcpToolIdentifier(value);
  if (mcpIdentifier) {
    return mcpIdentifier;
  }
  const normalized = value.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const dedupedTokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (dedupedTokens.at(-1)?.toLowerCase() === token.toLowerCase()) {
      continue;
    }
    dedupedTokens.push(token);
  }
  const collapsed = dedupedTokens.join(" ").trim();
  if (!collapsed) {
    return null;
  }
  const lowerCollapsed = collapsed.toLowerCase();
  if (lowerCollapsed === "read") {
    return "Read";
  }
  if (lowerCollapsed === "search" || lowerCollapsed === "find" || lowerCollapsed === "searched") {
    return "Search";
  }
  const readable = /[_-]/.test(value) ? humanizeMcpToken(collapsed) : collapsed;
  return readable.length > 64 ? `${readable.slice(0, 61).trimEnd()}...` : readable;
}

function humanizeMcpToken(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split(" ")
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower === "mcp") return "MCP";
      if (token.toUpperCase() === token && token.length <= 5) return token;
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function extractToolDescriptorFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const mcpServerTool = extractMcpServerToolDescriptor(payload, 0);
  if (mcpServerTool) {
    return mcpServerTool;
  }
  const descriptorKeys = ["kind", "name", "tool", "tool_name", "toolName", "title"];
  const candidates: string[] = [];
  collectDescriptorCandidates(payload, descriptorKeys, candidates, 0);
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) {
      continue;
    }
    if (isGenericToolTitle(normalizeCompactToolLabel(normalized))) {
      continue;
    }
    return normalized;
  }
  return null;
}

function extractMcpServerToolDescriptor(value: unknown, depth: number): string | null {
  const pair = findMcpServerToolPair(value, depth);
  return pair ? humanizeMcpServerTool(pair.server, pair.tool) : null;
}

// Codex reports MCP calls as `{ server, tool }` somewhere inside the payload.
function findMcpServerToolPair(
  value: unknown,
  depth: number,
): { readonly server: string; readonly tool: string } | null {
  if (depth > 4 || !value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findMcpServerToolPair(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.server === "string" && typeof record.tool === "string") {
    return { server: record.server, tool: record.tool };
  }
  for (const nestedKey of [
    "item",
    "data",
    "event",
    "payload",
    "result",
    "input",
    "call",
    "invocation",
    "source",
  ]) {
    const nested = findMcpServerToolPair(record[nestedKey], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/**
 * The MCP server behind a tool call: Claude names tools `mcp__<server>__<tool>`,
 * Codex reports a `{ server, tool }` pair in the payload. Null for other tools.
 */
export function extractMcpServerName(
  toolName: string | null | undefined,
  payload: unknown,
): string | null {
  const trimmed = toolName?.trim() ?? "";
  if (trimmed.startsWith("mcp__")) {
    const server = trimmed.split("__")[1]?.trim();
    if (server) return server;
  }
  const server = findMcpServerToolPair(payload, 0)?.server.trim();
  return server ? server : null;
}

function collectDescriptorCandidates(
  value: unknown,
  keys: ReadonlyArray<string>,
  target: string[],
  depth: number,
) {
  if (depth > 4 || target.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDescriptorCandidates(entry, keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      const trimmed = (record[key] as string).trim();
      if (trimmed) {
        target.push(trimmed);
      }
    }
  }
  for (const nestedKey of ["item", "data", "event", "payload", "result", "input", "tool", "call"]) {
    if (nestedKey in record) {
      collectDescriptorCandidates(record[nestedKey], keys, target, depth + 1);
      if (target.length >= 24) {
        return;
      }
    }
  }
}

// Read-only inspection commands: file reads wear the file glyph, searches and
// finds the magnifier; listings and everything else keep the terminal icon.
// These sets are the single source of truth for both the command labels below
// and the icon decision.
const READ_FILE_COMMAND_TOOLS = new Set(["cat", "nl", "head", "tail", "sed", "less", "more"]);
const SEARCH_COMMAND_TOOLS = new Set(["rg", "grep", "ag", "ack"]);
const FIND_COMMAND_TOOLS = new Set(["find", "fd"]);
const LIST_COMMAND_TOOLS = new Set(["ls"]);

// Derives the compact command sentence shown inline while preserving the full command for hover/detail UI.
export function deriveReadableCommandDisplay(
  rawCommand: string,
  isRunning = false,
  locale: MossLocaleCode = "en",
): ReadableCommandDisplay {
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const primaryCommand = firstShellCommandSegment(command);
  const [tool, args] = splitToolAndArgs(primaryCommand);

  if (READ_FILE_COMMAND_TOOLS.has(tool)) {
    return {
      verb: localizeToolHeading(isRunning ? "Reading" : "Read", locale),
      target: lastPathComponents(args, "file", locale),
      fullCommand: rawCommand,
    };
  }
  if (SEARCH_COMMAND_TOOLS.has(tool)) {
    return {
      verb: localizeToolHeading(isRunning ? "Searching" : "Searched", locale),
      target: searchSummary(args, locale),
      fullCommand: rawCommand,
    };
  }
  if (LIST_COMMAND_TOOLS.has(tool)) {
    return {
      verb: localizeToolHeading(isRunning ? "Listing" : "Listed", locale),
      target: lastPathComponents(args, "directory", locale),
      fullCommand: rawCommand,
    };
  }
  if (FIND_COMMAND_TOOLS.has(tool)) {
    return {
      verb: localizeToolHeading(isRunning ? "Finding" : "Found", locale),
      target: findTarget(args, "files", locale),
      fullCommand: rawCommand,
    };
  }

  switch (tool) {
    case "mkdir":
      return {
        verb: localizeToolHeading(isRunning ? "Creating" : "Created", locale),
        target: lastPathComponents(args, "directory", locale),
        fullCommand: rawCommand,
      };
    case "rm":
      return {
        verb: localizeToolHeading(isRunning ? "Removing" : "Removed", locale),
        target: lastPathComponents(args, "file", locale),
        fullCommand: rawCommand,
      };
    case "cp":
    case "mv":
      return {
        verb: localizeToolHeading(
          isRunning ? (tool === "cp" ? "Copying" : "Moving") : tool === "cp" ? "Copied" : "Moved",
          locale,
        ),
        target: lastPathComponents(args, "file", locale),
        fullCommand: rawCommand,
      };
    case "git":
      return humanizeGitCommand(args, rawCommand, isRunning, locale);
    case "node":
    case "bun":
    case "deno":
    case "python":
    case "python3":
    case "ruby":
    case "perl":
      return {
        verb: localizeToolHeading(isRunning ? "Running" : "Ran", locale),
        target: inlineScriptTarget(tool, command, args, locale) ?? compactInlineCommand(command),
        fullCommand: rawCommand,
      };
    case "osascript":
      return {
        verb: localizeToolHeading(isRunning ? "Running" : "Ran", locale),
        target: "AppleScript",
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: localizeToolHeading(isRunning ? "Running" : "Ran", locale),
        target: compactInlineCommand(command),
        fullCommand: rawCommand,
      };
  }
}

function firstCommandExecutable(rawCommand: string): string {
  const trimmed = rawCommand.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executable.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

// The object half of a command row's sentence ("Searched <for foo in src>"),
// kept short enough to read inline. Shell wrappers that carry no meaning for a
// human (a full pwsh.exe path) collapse to the shell's friendly name.
export function deriveFriendlyCommandTarget(rawCommand: string): string {
  const executable = firstCommandExecutable(rawCommand);
  if (
    executable === "pwsh" ||
    executable === "pwsh.exe" ||
    executable === "powershell" ||
    executable === "powershell.exe"
  ) {
    return "PowerShell";
  }
  if (executable === "cmd" || executable === "cmd.exe") {
    return "Command Prompt";
  }

  const target = deriveReadableCommandDisplay(rawCommand).target.trim();
  return target.length <= 72 ? target : `${target.slice(0, 69).trimEnd()}…`;
}

// Classifies command rows for transcript glyphs after peeling away shell/env wrappers.
// This keeps `git -C`, `env ... gh`, and `/bin/zsh -lc "cd ... && git ..."` visually branded.
export function resolveCommandVisualKind(rawCommand: string): CommandVisualKind {
  if (deriveCommandReadTargets(rawCommand) !== null) {
    return "read";
  }
  const command = stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
  const [tool] = splitToolAndArgs(firstShellCommandSegment(command));
  if (SEARCH_COMMAND_TOOLS.has(tool) || FIND_COMMAND_TOOLS.has(tool)) {
    return "search";
  }
  if (tool === "git") {
    return "git";
  }
  if (tool === "gh" || tool === "hub") {
    return "github";
  }
  return "terminal";
}

export function deriveInlineCommandCall(rawCommand: string): string {
  return stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
}

// The command a row shows: what actually ran, minus the shell wrapper
// (`/bin/zsh -lc "…"`) and leading `cd <dir> &&` preambles. Pipes, chains and
// quoting stay verbatim, unlike `deriveInlineCommandCall`, which keeps only the
// first pipeline stage for classification.
export function deriveLiteralCommand(rawCommand: string): string {
  let value = rawCommand.trim();
  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    break;
  }
  return stripLeadingShellPreambles(value).replace(/\s+/g, " ").trim();
}

// Files a command only reads, or null when the command does anything else.
// A row may say "Read <file>" instead of the literal command only when that
// is the whole story: no pipes, chains, redirects or substitutions, and no
// in-place edit (`sed -i`).
export function deriveCommandReadTargets(rawCommand: string): string[] | null {
  const literal = deriveLiteralCommand(rawCommand);
  if (literal.length === 0 || hasUnquotedShellOperator(literal)) {
    return null;
  }
  const [tool, args] = splitToolAndArgs(stripCommandDisplayWrappers(literal));
  if (!READ_FILE_COMMAND_TOOLS.has(tool)) {
    return null;
  }
  const tokens = tokenizeCommandArgs(args);
  const files: string[] = [];
  let skipNext = false;
  let sedScriptPending = tool === "sed";
  let sedPrintOnly = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (tool === "sed") {
        if (token === "-i" || token.startsWith("-i") || token.startsWith("--in-place")) {
          return null;
        }
        if (token === "-n" || token === "--quiet" || token === "--silent") {
          sedPrintOnly = true;
        }
        if (token === "-e" || token === "--expression") {
          sedScriptPending = false;
          skipNext = true;
        }
      }
      if ((tool === "head" || tool === "tail") && (token === "-n" || token === "-c")) {
        skipNext = true;
      }
      continue;
    }
    if (sedScriptPending) {
      sedScriptPending = false;
      continue;
    }
    files.push(compactPath(token));
  }
  if (tool === "sed" && !sedPrintOnly) {
    return null;
  }
  return files.length > 0 ? files : null;
}

const SHELL_WRAPPER_PREFIXES = [
  "/usr/bin/bash -lc ",
  "/usr/bin/bash -c ",
  "/bin/bash -lc ",
  "/bin/bash -c ",
  "/usr/bin/zsh -lc ",
  "/usr/bin/zsh -c ",
  "/bin/zsh -lc ",
  "/bin/zsh -c ",
  "/bin/sh -lc ",
  "/bin/sh -c ",
  "bash -lc ",
  "bash -c ",
  "zsh -lc ",
  "zsh -c ",
  "sh -lc ",
  "sh -c ",
];

// Pipes, chains, redirects, background jobs and substitutions outside quotes.
function hasUnquotedShellOperator(value: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      char === "|" ||
      char === "&" ||
      char === ";" ||
      char === ">" ||
      char === "<" ||
      char === "`" ||
      (char === "$" && value[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function humanizeGitCommand(
  args: string,
  rawCommand: string,
  isRunning: boolean,
  locale: MossLocaleCode,
): ReadableCommandDisplay {
  const normalizedArgs = stripGitGlobalOptions(args);
  const subcommand = normalizedArgs.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (subcommand) {
    case "status":
      return {
        verb: localizeToolHeading(isRunning ? "Checking" : "Checked", locale),
        target: "git status",
        fullCommand: rawCommand,
      };
    case "diff":
      return {
        verb: localizeToolHeading(isRunning ? "Comparing" : "Compared", locale),
        target: fixedCommandTarget("changes", locale),
        fullCommand: rawCommand,
      };
    case "show":
      return {
        verb: localizeToolHeading(isRunning ? "Inspecting" : "Inspected", locale),
        target: fixedCommandTarget("commit", locale),
        fullCommand: rawCommand,
      };
    case "log":
      return {
        verb: localizeToolHeading(isRunning ? "Reviewing" : "Reviewed", locale),
        target: fixedCommandTarget("git history", locale),
        fullCommand: rawCommand,
      };
    case "add":
      return {
        verb: localizeToolHeading(isRunning ? "Staging" : "Staged", locale),
        target: fixedCommandTarget("changes", locale),
        fullCommand: rawCommand,
      };
    case "commit":
      return {
        verb: localizeToolHeading(isRunning ? "Committing" : "Committed", locale),
        target: fixedCommandTarget("changes", locale),
        fullCommand: rawCommand,
      };
    case "push":
      return {
        verb: localizeToolHeading(isRunning ? "Pushing" : "Pushed", locale),
        target: fixedCommandTarget("to remote", locale),
        fullCommand: rawCommand,
      };
    case "pull":
      return {
        verb: localizeToolHeading(isRunning ? "Pulling" : "Pulled", locale),
        target: fixedCommandTarget("from remote", locale),
        fullCommand: rawCommand,
      };
    case "checkout":
    case "switch":
      return {
        verb: localizeToolHeading(isRunning ? "Switching to" : "Switched to", locale),
        target: checkoutTarget(normalizedArgs.slice(subcommand.length).trim(), locale),
        fullCommand: rawCommand,
      };
    default:
      return {
        verb: localizeToolHeading(isRunning ? "Running" : "Ran", locale),
        target: compactInlineCommand(`git ${normalizedArgs}`.trim()),
        fullCommand: rawCommand,
      };
  }
}

function stripGitGlobalOptions(args: string): string {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index).join(" ");
}

function checkoutTarget(args: string, locale: MossLocaleCode): string {
  const branch = tokenizeCommandArgs(args).at(-1)?.trim();
  return branch ? branch : fixedCommandTarget("branch", locale);
}

function lastPathComponents(
  args: string,
  fallback: Extract<FixedCommandTarget, "file" | "directory">,
  locale: MossLocaleCode,
): string {
  const tokens = tokenizeCommandArgs(args);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) {
      continue;
    }
    return compactPath(token, locale);
  }
  return fixedCommandTarget(fallback, locale);
}

function findTarget(
  args: string,
  fallback: Extract<FixedCommandTarget, "files">,
  locale: MossLocaleCode,
): string {
  const tokens = tokenizeCommandArgs(args);
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-maxdepth" ||
        token === "-mindepth" ||
        token === "-name" ||
        token === "-type" ||
        token === "-path"
      ) {
        skipNext = true;
      }
      continue;
    }
    return compactPath(token, locale);
  }
  return fixedCommandTarget(fallback, locale);
}

function compactPath(path: string, locale: MossLocaleCode = "en"): string {
  if (path === ".") {
    return locale === "zh-CN" ? "当前目录" : "current directory";
  }
  if (path === "..") {
    return locale === "zh-CN" ? "上级目录" : "parent directory";
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join("/");
}

function compactInlineCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function firstShellCommandSegment(command: string): string {
  const chain = findShellChain(command);
  return chain ? command.slice(0, chain.operatorStart).trim() : command;
}

function inlineScriptTarget(
  tool: string,
  command: string,
  args: string,
  locale: MossLocaleCode,
): string | null {
  const normalizedTool = tool === "python3" ? "python" : tool;
  if (containsHeredoc(command) || hasInlineScriptFlag(args)) {
    return locale === "zh-CN" ? `${normalizedTool} 脚本` : `${normalizedTool} script`;
  }
  return null;
}

function containsHeredoc(command: string): boolean {
  return /(^|\s)<<-?\s*['"]?[A-Za-z0-9_]+/.test(command);
}

function hasInlineScriptFlag(args: string): boolean {
  const tokens = tokenizeCommandArgs(args);
  return tokens.some((token) => token === "-e" || token === "-c" || token.startsWith("-e="));
}

function searchSummary(args: string, locale: MossLocaleCode): string {
  const { pattern, path } = extractSearchPatternAndPath(args, locale);
  if (locale === "zh-CN") {
    if (pattern && path) {
      return `${pattern}（${path}）`;
    }
    return pattern ?? path ?? fixedCommandTarget("files", locale);
  }
  if (pattern && path) {
    return `for ${pattern} in ${path}`;
  }
  if (pattern) {
    return `for ${pattern}`;
  }
  if (path) {
    return `in ${path}`;
  }
  return fixedCommandTarget("files", locale);
}

function extractSearchPatternAndPath(
  args: string,
  locale: MossLocaleCode,
): {
  pattern: string | null;
  path: string | null;
} {
  const tokens = tokenizeCommandArgs(args);
  let pattern: string | null = null;
  let path: string | null = null;
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      if (
        token === "-t" ||
        token === "-g" ||
        token === "--type" ||
        token === "--glob" ||
        token === "--max-count"
      ) {
        skipNext = true;
      }
      continue;
    }
    if (!pattern) {
      const normalizedPattern = normalizeSearchPatternToken(token);
      if (!normalizedPattern) {
        const normalizedPath = normalizeSearchPathToken(token, locale);
        if (normalizedPath && (!path || path === compactPath(".", locale))) {
          path = normalizedPath;
        }
        continue;
      }
      pattern = normalizedPattern;
      continue;
    }
    if (!path || path === compactPath(".", locale)) {
      path = normalizeSearchPathToken(token, locale) ?? path;
      continue;
    }
  }

  if (pattern && path === compactPath(".", locale) && looksLikeSearchPath(pattern)) {
    path = normalizeSearchPathToken(pattern, locale);
    pattern = null;
  }

  return { pattern, path };
}

function normalizeSearchPatternToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return null;
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return null;
  }
  return trimmed.length > 30 ? `${trimmed.slice(0, 27)}...` : trimmed;
}

function normalizeSearchPathToken(token: string, locale: MossLocaleCode): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  return compactPath(trimmed, locale);
}

function looksLikeSearchPath(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || token.includes("\\");
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < args.length) {
    while (args[index] === " ") {
      index += 1;
    }
    if (index >= args.length) {
      break;
    }

    const quote = args[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let token = "";
      while (index < args.length && args[index] !== quote) {
        if (args[index] === "\\" && index + 1 < args.length) {
          token += args[index + 1];
          index += 2;
          continue;
        }
        token += args[index];
        index += 1;
      }
      if (args[index] === quote) {
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    let token = "";
    while (index < args.length && args[index] !== " ") {
      token += args[index];
      index += 1;
    }
    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

function splitToolAndArgs(command: string): [tool: string, args: string] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return ["", ""];
  }
  const separator = normalized.indexOf(" ");
  if (separator === -1) {
    return [basenameOfPath(normalized).toLowerCase(), ""];
  }
  const tool = basenameOfPath(normalized.slice(0, separator)).toLowerCase();
  const args = normalized.slice(separator + 1).trim();
  return [tool, args];
}

function unwrapShellCommandIfPresent(rawCommand: string): string {
  let value = rawCommand.trim();
  if (!value) {
    return value;
  }

  const lowered = value.toLowerCase();
  for (const prefix of SHELL_WRAPPER_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    value = value.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    value = stripLeadingShellPreambles(value);
    break;
  }

  const pipeIndex = value.indexOf("|");
  if (pipeIndex > 0) {
    value = value.slice(0, pipeIndex).trim();
  }

  return value;
}

function stripLeadingShellPreambles(value: string): string {
  let current = value.trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const chain = findShellChain(current);
    if (!chain) {
      return current;
    }
    const head = current.slice(0, chain.operatorStart).trim();
    if (!isShellSetupPreamble(head)) {
      return current;
    }
    current = current.slice(chain.commandStart).trim();
  }
  return current;
}

function isShellSetupPreamble(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:builtin\s+)?cd\s+/.test(normalized)) {
    return true;
  }
  if (/^(?:source|\.)\s+/.test(normalized)) {
    return true;
  }
  if (/^set\s+[-+][A-Za-z]/.test(normalized)) {
    return true;
  }
  if (
    /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\s]+(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function findShellChain(value: string): { operatorStart: number; commandStart: number } | null {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    const next = value[index + 1];
    if (char === "&" && next === "&") {
      return { operatorStart: index, commandStart: index + 2 };
    }
    if (char === ";") {
      return { operatorStart: index, commandStart: index + 1 };
    }
  }

  return null;
}

function stripCommandDisplayWrappers(command: string): string {
  let current = command.replace(/\s+/g, " ").trim();
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const [tool, args] = splitToolAndArgs(current);
    const next =
      tool === "env"
        ? stripEnvCommand(args)
        : tool === "timeout" || tool === "gtimeout"
          ? stripTimeoutCommand(args)
          : tool === "nice"
            ? stripNiceCommand(args)
            : tool === "arch"
              ? stripArchCommand(args)
              : tool === "command"
                ? args
                : null;
    if (!next || next === current) {
      return current;
    }
    current = next.trim();
  }
  return current;
}

function stripEnvCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 2;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripTimeoutCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    index += tokens[index] === "-s" || tokens[index] === "-k" ? 2 : 1;
  }
  if (index < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index]!)) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripNiceCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  if (tokens[index] === "-n") {
    index += 2;
  } else {
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

function stripArchCommand(args: string): string | null {
  const tokens = tokenizeCommandArgs(args);
  let index = 0;
  while (tokens[index]?.startsWith("-")) {
    index += 1;
  }
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

type FixedCommandTarget =
  | "file"
  | "directory"
  | "files"
  | "changes"
  | "commit"
  | "git history"
  | "to remote"
  | "from remote"
  | "branch";

const ZH_CN_FIXED_COMMAND_TARGETS: Record<FixedCommandTarget, string> = {
  file: "文件",
  directory: "目录",
  files: "文件",
  changes: "更改",
  commit: "提交",
  "git history": "Git 历史",
  "to remote": "到远程仓库",
  "from remote": "从远程仓库",
  branch: "分支",
};

function fixedCommandTarget(target: FixedCommandTarget, locale: MossLocaleCode): string {
  return locale === "zh-CN" ? ZH_CN_FIXED_COMMAND_TARGETS[target] : target;
}

// The upstream rebrand renamed the public server/tool prefix from moss_ to
// moss_; records and fixtures from that lineage resolve to the same Moss
// presentations. Only a leading prefix is rewritten, so titles like
// "Moss: Moss Create Threads" and ids like "mcp__moss__moss_run" both
// collapse onto the Moss keys.
function aliasMossPrefix(normalizedCandidate: string): string {
  return normalizedCandidate
    .replace(/^mcp_moss_/, "mcp_moss_")
    .replace(/^moss_moss_/, "moss_")
    .replace(/^moss_/, "moss_")
    .replace(/^moss_moss_/, "moss_");
}

/** T3 replaces a completed `html_render` tool item with the page itself. */
export function isHtmlRenderToolCall(input: MossMcpToolTitleInput): boolean {
  return (
    resolveMossMcpToolPresentation([input.toolName, input.title, input.fallbackLabel], {
      requireHtmlToolIdentity: input.toolName !== undefined && input.toolName !== null,
    }) === MOSS_MCP_TOOL_PRESENTATIONS.html_render
  );
}

/** Both HTML tools can carry an input title in provider-specific envelopes. */
export function isHtmlPageToolCall(input: MossMcpToolTitleInput): boolean {
  const presentation = resolveMossMcpToolPresentation(
    [input.toolName, input.title, input.fallbackLabel],
    {
      requireHtmlToolIdentity: input.toolName !== undefined && input.toolName !== null,
    },
  );
  return (
    presentation === MOSS_MCP_TOOL_PRESENTATIONS.html_render ||
    presentation === MOSS_MCP_TOOL_PRESENTATIONS.html_preview
  );
}

const FILE_CHANGE_LIFECYCLE_TITLES = new Set([
  "filechange",
  "edit",
  "edited",
  "editing",
  "create",
  "created",
  "creating",
  "delete",
  "deleted",
  "deleting",
]);

function isFileChangeLifecycleTitle(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  return FILE_CHANGE_LIFECYCLE_TITLES.has(normalized);
}

function deriveFileChangeLifecycleTitle(value: string, isRunning = false): string {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "create" || normalized === "created" || normalized === "creating") {
    return isRunning ? "Creating" : "Created";
  }
  if (normalized === "delete" || normalized === "deleted" || normalized === "deleting") {
    return isRunning ? "Deleting" : "Deleted";
  }
  return isRunning ? "Editing" : "Edited";
}

/** Turns a WebMCP identifier into a sentence-style activity label. */
export function humanizeToolCallIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized
    .split(" ")
    .map((token, index) => {
      if (token.length <= 5 && token.toUpperCase() === token && /[A-Z]/u.test(token)) {
        return token;
      }
      const lower = token.toLowerCase();
      return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    })
    .join(" ");
}

/** Installed Codex Bqs/Uqs: a js invocation's concise title precedes app/tool fallbacks. */
export function codexMcpInvocationTitle(tool: string, args: unknown): string | null {
  if (
    tool.trim().toLowerCase() !== "js" ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return null;
  const title = (args as Record<string, unknown>).title;
  if (typeof title !== "string") return null;
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79).trimEnd()}…`;
}
