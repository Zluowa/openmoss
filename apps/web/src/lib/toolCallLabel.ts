// FILE: toolCallLabel.ts
// Purpose: Normalizes generic tool-call titles and humanizes command executions for timeline rows.
// Layer: UI utility
// Exports: deriveReadableToolTitle, deriveReadableCommandDisplay, deriveFriendlyCommandTarget, command icon classifiers, deriveInlineCommandCall, deriveLiteralCommand, deriveCommandReadTargets, normalizeCompactToolLabel, isGenericToolTitle, extractWebFetchUrl
// Depends on: @moss/contracts tool lifecycle item types

import {
  AGENT_FEEDBACK_TOOL_NAME,
  DEVS_REPORT_DRAFT_TOOL_NAME,
  type ToolLifecycleItemType,
} from "@moss/contracts";
import { BROWSER_TOOL_TITLES } from "@moss/shared/browserAutomationPresentation";
import {
  isMossAppsServer,
  MOSS_APPS_DISPLAY_NAME,
  mossAppsToolAction,
} from "@moss/shared/mossAppsPresentation";
import {
  COMPUTER_TOOL_TITLES,
  computerToolName,
  type ComputerToolName,
} from "./computerToolPresentation";
import { extractToolArgumentField } from "./toolArgumentSummary";
import type { MossLocaleCode } from "~/uiLocale";
import {
  CMD_READ_FILE_COMMAND_TOOLS,
  FIND_COMMAND_TOOLS,
  POSIX_READ_FILE_COMMAND_TOOLS,
  POWERSHELL_READ_FILE_COMMAND_TOOLS,
  SEARCH_COMMAND_TOOLS,
  compactPath,
  deriveCommandReadTargets,
  deriveCommandScript,
  firstCommandExecutable,
  firstShellCommandSegment,
  splitToolAndArgs,
  stripCommandDisplayWrappers,
  tokenizeCommandArgs,
  unwrapShellCommandIfPresent,
} from "@moss/shared/shellCommandShape";
import {
  MOSS_MCP_TOOL_PRESENTATIONS,
  type MossMcpToolStatus,
  type MossMcpToolTitleInput,
  deriveMossMcpToolTitle,
  localizeMossToolHeading,
  normalizeMossMcpIdentifier,
  resolveMossBrowserToolName,
  resolveMossMcpToolPresentation,
} from "@moss/shared/mossToolPresentation";

export {
  deriveCommandReadTargets,
  resolveCommandVisualKind,
  unwrapWindowsShellCommand,
  type CommandVisualKind,
} from "@moss/shared/shellCommandShape";
export {
  deriveMossMcpToolTitle,
  isMossMediaJobToolCall,
  isMossUserAnswerToolCall,
  type MossMcpToolStatus,
  type MossMcpToolTitleInput,
} from "@moss/shared/mossToolPresentation";

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
  "Search tools:": "搜索工具：",
  "Loading tools": "正在加载工具",
  "Loaded tools": "已加载工具",
  "Running code": "正在运行代码",
  "Ran code": "已运行代码",
  ...Object.fromEntries(
    Object.entries(ZH_CN_MOSS_APPS_ACTIONS).map(([action, translated]) => [
      `${MOSS_APPS_DISPLAY_NAME}: ${action}`,
      `Moss 应用：${translated}`,
    ]),
  ),
};

/** Claude's `ToolSearch` (deferred tools loaded on demand) reads like Claude: "Loaded tools". */
export function deriveToolSearchTitle(
  toolName: string | null | undefined,
  isRunning: boolean,
): string | null {
  if (toolName?.trim() !== "ToolSearch") return null;
  return isRunning ? "Loading tools" : "Loaded tools";
}

export function localizeToolHeading(value: string, locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? (ZH_CN_TOOL_HEADINGS[value] ?? localizeMossToolHeading(value) ?? value)
    : value;
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

  const [, server, ...rest] = trimmed.split("__");
  return humanizeMcpServerTool(server ?? "", rest.join("__"));
}

/**
 * Claude's Code-tab label for an MCP call: "{server}: {tool}". The server keeps the name it
 * was configured with (the widget header says the same); the tool name becomes words,
 * underscores to spaces, lower-case first unless the first word is cased on purpose.
 */
function humanizeMcpServerTool(server: string, tool: string): string | null {
  const serverLabel = mcpServerLabel(server);
  const toolLabel = mossAppsToolLabel(server, tool) ?? mcpToolWords(tool);
  if (!serverLabel || !toolLabel) {
    return null;
  }
  return `${serverLabel}: ${toolLabel}`;
}

function mcpServerLabel(server: string): string {
  const trimmed = server.trim();
  if (isMossAppsServer(trimmed)) return MOSS_APPS_DISPLAY_NAME;
  if (trimmed.toLowerCase() === "moss") return "Moss";
  // Built-in ids like `codex_apps` or `computer-use` read as words; a configured name stays.
  return /[_-]/u.test(trimmed) ? humanizeMcpToken(trimmed) : trimmed;
}

/** A word cased on purpose ("GitHub", "iOS"): an upper-case letter after the first. */
const casedOnPurpose = (word: string) => /\p{Lu}/u.test(word.slice(1));

/**
 * A tool name as words, the way Claude writes a tool title it has no declared title for:
 * `display_pdf`, `show-map`, `getIssue` and `GET_ISSUE` all split into words (`_ . -`, space,
 * else camel case), each word lower-case unless cased on purpose, the first letter capital
 * ("Display pdf"). A name that already has spaces is a title and stays as it is.
 */
export function mcpToolTitleFromName(tool: string): string {
  const name = tool.trim();
  if (!name || /\s/u.test(name)) return name;
  const source = /\p{Ll}/u.test(name) ? name : name.toLowerCase();
  const words = (/[_.:-]/u.test(source) ? source : source.replace(/([a-z0-9])([A-Z])/gu, "$1 $2"))
    .split(/[_.:\s-]+/u)
    .filter((word) => word !== "");
  const [first] = words;
  if (first === undefined) return name;
  const joined = words.map((word) => (casedOnPurpose(word) ? word : word.toLowerCase())).join(" ");
  return casedOnPurpose(first) ? joined : `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
}

/** The tool part of a row label: the same words, lower-case first mid-sentence ("map: show map"). */
function mcpToolWords(tool: string): string {
  const title = mcpToolTitleFromName(tool);
  if (/\s/u.test(tool.trim()) || casedOnPurpose(title.split(" ")[0] ?? "")) return title;
  return `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
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

/**
 * An agent's tool-search step that looked for the Moss media tool (Grok's
 * `search_tool` before `use_tool`). It is plumbing for the same image call.
 */
export function isMossMediaToolSearch(input: {
  readonly toolName?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly label?: string | null | undefined;
  /** The searched words, when the row keeps them apart from its title. */
  readonly query?: string | null | undefined;
}): boolean {
  const names = [input.toolName, input.title, input.label, input.query].filter(
    (value): value is string => typeof value === "string",
  );
  return (
    names.some((value) => /^search[ _-]?tools?\b/iu.test(value.trim())) &&
    names.some((value) => /\bmoss[\s_-]+media\b/iu.test(value))
  );
}

/** True for `moss_report_friction` however a provider prefixes MCP names. */
export function isAgentFeedbackToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === AGENT_FEEDBACK_TOOL_NAME || name.endsWith(`__${AGENT_FEEDBACK_TOOL_NAME}`);
}

/** True for `moss_draft_devs_report` however a provider prefixes MCP names. */
export function isDevsReportDraftToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === DEVS_REPORT_DRAFT_TOOL_NAME || name.endsWith(`__${DEVS_REPORT_DRAFT_TOOL_NAME}`);
}

const ZH_CN_TOOL_AREA_FALLBACKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^moss_pages_/u, "资料页面"],
  [/^moss_canvas_/u, "画布"],
  [/^moss_media_/u, "图像与视频"],
  [/^moss_kanban_/u, "看板"],
  [/^moss_.*automation/u, "自动化"],
  [/^moss_.*todo/u, "待办"],
  [/^moss_.*task/u, "任务"],
  [/^moss_.*thread/u, "对话"],
  [/^moss_.*theme/u, "外观主题"],
  [/^(?:moss_)?browser_/u, "浏览器"],
  [/^(?:moss_)?computer_/u, "电脑操控"],
];

/**
 * Plain-language label for a Moss tool name (e.g. `moss_pages_mutate` -> "更新文档" / "Updating a page")
 * so Settings UI never exposes raw snake_case tool identifiers to ordinary users.
 */
export function localizeMossToolName(toolName: string, locale: MossLocaleCode): string {
  const trimmed = toolName.trim();
  if (!trimmed) return "";
  const bare = trimmed.replace(/^mcp__[^_]+__/u, "");
  const runningTitle = deriveMossMcpToolTitle({ toolName: bare, status: "running" });
  if (runningTitle && !runningTitle.startsWith("Moss is handling ")) {
    if (locale === "zh-CN") {
      const zh = localizeToolHeading(runningTitle, "zh-CN")
        .replace(/^正在/u, "")
        .trim();
      if (zh && zh !== runningTitle) return zh;
    } else {
      const stripped = runningTitle.startsWith("Moss is ")
        ? runningTitle.slice("Moss is ".length)
        : runningTitle;
      return stripped.length > 0 ? stripped[0]!.toUpperCase() + stripped.slice(1) : runningTitle;
    }
  }
  if (/^(?:moss_apps_|COMPOSIO_)/u.test(bare)) {
    return localizeMossAppsToolAction(bare, locale);
  }
  if (locale === "zh-CN") {
    for (const [pattern, label] of ZH_CN_TOOL_AREA_FALLBACKS) {
      if (pattern.test(bare)) return label;
    }
    if (/^[a-z0-9_]+$/u.test(bare) && bare.includes("_")) {
      return bare.startsWith("moss_") ? "Moss 工具" : mcpToolTitleFromName(bare);
    }
    return bare;
  }
  if (/^[a-z0-9_]+$/u.test(bare) && bare.includes("_")) {
    return mcpToolTitleFromName(bare.replace(/^moss_/u, ""));
  }
  return bare;
}

export function isMossBrowserToolCall(input: MossMcpToolTitleInput): boolean {
  return resolveMossBrowserToolName([input.toolName, input.title, input.fallbackLabel]) !== null;
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
  // `_`/`-` names here are tools that arrive without their server (OpenCode joins MCP tools
  // as `server_tool`): Claude's words for a tool with no title (`show-map` → Show map).
  const readable = /[_-]/.test(value) ? mcpToolTitleFromName(dedupedTokens.join("_")) : collapsed;
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
const READ_FILE_COMMAND_TOOLS = new Set([
  ...POSIX_READ_FILE_COMMAND_TOOLS,
  ...POWERSHELL_READ_FILE_COMMAND_TOOLS,
  ...CMD_READ_FILE_COMMAND_TOOLS,
]);
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

  // "Read <files>" only when the whole command is provably one read; any other
  // reader command falls through to "Ran <command>".
  const readTargets = READ_FILE_COMMAND_TOOLS.has(tool)
    ? deriveCommandReadTargets(rawCommand)
    : null;
  if (readTargets) {
    return {
      verb: localizeToolHeading(isRunning ? "Reading" : "Read", locale),
      target: readTargets.join(", "),
      fullCommand: rawCommand,
    };
  }
  if (READ_FILE_COMMAND_TOOLS.has(tool)) {
    // Not provably one read: name the whole command, never just its first stage.
    return {
      verb: localizeToolHeading(isRunning ? "Running" : "Ran", locale),
      target: deriveLiteralCommand(rawCommand),
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

export function deriveInlineCommandCall(rawCommand: string): string {
  return stripCommandDisplayWrappers(unwrapShellCommandIfPresent(rawCommand));
}

// The command a row shows: what actually ran, minus the shell wrapper
// (`/bin/zsh -lc "…"`) and leading `cd <dir> &&` preambles. Pipes, chains and
// quoting stay verbatim, unlike `deriveInlineCommandCall`, which keeps only the
// first pipeline stage for classification.
export function deriveLiteralCommand(rawCommand: string): string {
  return shortenPowerShellCallOperator(deriveCommandScript(rawCommand).replace(/\s+/g, " ").trim());
}

// PowerShell runs a program by path through its call operator
// (`& 'E:	oolsunun.exe' run test`); the row names the program the way a
// person types it (`bun run test`). The full line stays in the details.
function shortenPowerShellCallOperator(command: string): string {
  const match = /^&\s*(?:'([^']+)'|"([^"]+)"|(\S+))(?=\s|$)/u.exec(command);
  const program = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !program || program.startsWith("{") || program.startsWith("$")) return command;
  const name = program
    .split(/[\\/]/u)
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat|ps1)$/iu, "");
  return name ? `${name}${command.slice(match[0].length)}` : command;
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

function compactInlineCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
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
  return formatSearchTarget(pattern, path, locale);
}

function formatSearchTarget(
  pattern: string | null,
  path: string | null,
  locale: MossLocaleCode,
): string {
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

/**
 * The object of a search row built from a search tool's own arguments (Claude
 * `Grep`/`Glob`, ACP `search`), worded exactly like a searched shell command,
 * so `rg` and `Grep` read the same: "for foo in src" / "foo（src）".
 */
export function describeSearchToolTarget(
  input: { pattern: string | null; path: string | null },
  locale: MossLocaleCode = "en",
): string | null {
  const pattern = input.pattern ? normalizeSearchPatternToken(input.pattern) : null;
  const path = input.path ? normalizeSearchPathToken(input.path, locale) : null;
  return pattern || path ? formatSearchTarget(pattern, path, locale) : null;
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
