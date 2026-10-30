// FILE: TimelineWorkEntryRow.tsx
// Purpose: Renders transcript work/tool rows and their inline details.
// Layer: Web chat presentation component
// Exports: TimelineWorkEntryRow, EditedFileRowContent, prefersCompactWorkEntryRow

import { conversationDisclosureStyle } from "~/lib/disclosureMotion";
import { ConversationShimmer } from "./ConversationShimmer";
import { ThreadId, type ModelSelection, type TurnId } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { motion } from "motion/react";
import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { basenameOfPath } from "~/file-icons";
import type { MossLocaleCode } from "~/appSettings";
import type { TimestampFormat } from "../../appSettings";
import { formatTimestamp } from "../../timestampFormat";
import {
  ArrowUpCircleIcon,
  BackgroundTrayIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ContextCompactionIcon,
  ComputerUseIcon,
  EyeIcon,
  FileIcon,
  GitHubIcon,
  GlobeIcon,
  HammerIcon,
  HandoffIcon,
  HistoryIcon,
  type LucideIcon,
  McpIcon,
  PencilIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  ZapIcon,
} from "~/lib/icons";
import { describeLinkChip } from "~/lib/linkChips";
import { localizeAntigravityRuntimeMessage } from "~/lib/antigravityRuntimeMessages";
import { localizeProviderRuntimeMessage } from "~/lib/providerRuntimeMessages";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { CentralIcon } from "~/lib/central-icons";
import { computerToolName, describeComputerToolCall } from "~/lib/computerToolPresentation";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import type { FastModeNotice } from "~/lib/fastModeState";
import { formatThreadModelSummaryLabel, resolveThreadModelSummary } from "~/lib/threadModelSummary";

import {
  formatClockDuration,
  formatClockElapsed,
  isFileChangeWorkLogEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { wasDeclinedByAutoReview, type WorkLogSubagent } from "../../workLog";
import {
  formatAgentActivityEntryPreview,
  isAgentActivityWorkEntry,
  isCodexActivityStatusWorkEntry,
  isPlainRuntimeNoticeWorkEntry,
  isReasoningUpdateWorkEntry,
} from "./agentActivity.logic";
import { AutomationCreatedCard } from "./AutomationCreatedCard";
import { BackgroundTaskRow } from "./BackgroundTaskRow";
import { INLINE_COMMAND_CHIP_CLASS_NAME } from "./chatTypography";
import { SubagentRunCard } from "./SubagentRunCard";
import { InlineSubagentActivity } from "./InlineSubagentActivity";
import type { InlineSubagentStatus } from "./inlineSubagentActivity.logic";
import { ConnectedComputerSetupRequiredCard } from "./ComputerSetupRequiredCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { ComputerControlDeniedCard } from "./ComputerControlDeniedCard";
import ChatMarkdown from "../ChatMarkdown";
import { DiffStatLabel } from "./DiffStatLabel";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { LinkChipIcon } from "../LinkChipIcon";
import { McpServerIcon } from "./McpServerIcon";
import { normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { MossLogo } from "../MossLogo";
import { ToolCallDetailsContent } from "./ToolCallDetailsDialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { fileDiffStatsByPath, resolveFileDiffStatByChangedPath } from "~/lib/diffRendering";
import {
  extractToolArgumentField,
  isPrefixedToolArgumentSummary,
} from "../../lib/toolArgumentSummary";
import {
  deriveReadableCommandDisplay,
  codexMcpInvocationTitle,
  deriveMossMcpToolTitle,
  deriveCommandReadTargets,
  deriveFriendlyCommandTarget,
  deriveLiteralCommand,
  extractWebFetchUrl,
  isHtmlPageToolCall,
  localizeToolHeading,
  isMossBrowserToolCall,
  isMossUserAnswerToolCall,
  isGenericToolTitle,
  normalizeToolTextForComparison,
  resolveCommandVisualKind,
  sanitizeMossMcpToolPreview,
  type MossMcpToolStatus,
} from "../../lib/toolCallLabel";
import {
  formatLiveActivityElapsed,
  formatLiveActivityMeta,
  isLiveActivityInProgress,
  useLiveActivityNow,
} from "../../lib/liveActivityPresentation";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../../lib/workspaceFileOpener";
import { resolveThreadErrorPresentation } from "./threadErrorPresentation";
import { resolveSubagentPresentation } from "../../lib/subagentPresentation";
import { TimelineSubagentActivityGroup } from "./TimelineSubagentActivityGroup";
import { TimelineStreamErrorRow } from "./TimelineStreamErrorRow";
import { McpAppCard } from "./McpAppCard";
import {
  McpAutomaticApprovalReviewContent,
  McpRawDiagnosticAction,
  McpRawDiagnosticDialog,
  McpToolResultDetails,
} from "./McpToolResultDetails";
import { WebMcpActivity } from "./WebMcpActivity";
import type { McpAppHostPhase } from "~/lib/mcpAppHost";
import { deriveToolFailureSummary } from "../../lib/toolCallDetails";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../../lib/disclosureMotion";
import { MUTED_LABEL_TEXT_CLASS_NAME, MUTED_LABEL_TEXT_COLOR } from "~/surfaceStyles";
import { isTimelineMultiAgentAction } from "../../lib/multiAgentAction";
import { MultiAgentActionDisclosure } from "./MultiAgentActionDisclosure";
import { commandActivitySummary } from "./commandActivitySummary";
import { toolActivityBodyClassName } from "./toolActivityLayout";

// Rest tone is the shared quiet-label gray (same one the composer pickers use for
// their effort/thinking labels) so a tool row and the picker below it read as one
// muted tone; hover still lifts the whole row to full foreground.
const WORK_ROW_MUTED_HOVER_TONE: Record<"tool-row" | "file-row", string> = {
  "tool-row": `text-text/60 transition-colors group-hover/tool-row:!text-foreground group-focus-within/tool-row:!text-foreground group-focus-visible/tool-row:!text-foreground`,
  "file-row": `${MUTED_LABEL_TEXT_CLASS_NAME} transition-colors group-hover/file-row:text-foreground group-focus-within/file-row:text-foreground group-focus-visible/file-row:text-foreground`,
};
const CODEX_STATUS_ROW_MUTED_HOVER_TONE =
  "text-text/60 transition-colors group-hover/tool-row:!text-foreground group-focus-within/tool-row:!text-foreground group-focus-visible/tool-row:!text-foreground";
const EMPTY_FILE_DIFF_STATS: ReadonlyMap<string, { additions: number; deletions: number }> =
  new Map();

type TimelineWorkEntry = WorkLogEntry;

const AgentTaskIcon: LucideIcon = (props) => <BotIcon {...props} />;

const MossToolIcon: LucideIcon = ({ className }) => (
  <MossLogo className={cn("text-current", className)} />
);

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-muted-foreground/50",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground/40",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground/50",
    };
  }
  // Generic tool calls with no recognizable kind read as "consulted something".
  return {
    icon: BookOpenIcon,
    className: "text-muted-foreground/45",
  };
}

/**
 * Try to extract a clean file path from a detail string that may contain JSON.
 * Handles patterns like:
 *   Read {"file_path":"/Users/foo/bar.ts","offset":10}
 *   {"file_path":"/path/to/file.ts"}
 */
function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }
  // "path" is generic enough that a nested match (e.g. inside a config object)
  // may not be the file the tool acted on — only regex-scan truncated JSON.
  return extractToolArgumentField(detail, ["file_path", "filePath", "path", "filename"], {
    fallbackScan: "whenUnparsed",
  });
}

function localizeGeneratedWorkPreview(value: string, locale: MossLocaleCode): string {
  if (locale !== "zh-CN") return value;
  const filesFound = /^(\d+) files? found(?: \(truncated\))?$/iu.exec(value.trim());
  if (filesFound?.[1]) {
    const truncated = /\(truncated\)$/iu.test(value.trim()) ? "（已截断）" : "";
    return `${filesFound[1]} 个文件${truncated}`;
  }
  const filesMatch = /^(\d+) files$/u.exec(value);
  if (filesMatch?.[1]) return `${filesMatch[1]} 个文件`;
  const linesMatch = /^(\d+)\s+lines?$/iu.exec(value);
  if (linesMatch?.[1]) return `${linesMatch[1]} 行`;
  const subagentsMatch = /^(\d+) subagents$/u.exec(value);
  if (subagentsMatch?.[1]) return `${subagentsMatch[1]} 个子代理`;
  return value;
}

function localizeKnownRuntimeMessage(value: string, locale: MossLocaleCode): string {
  return localizeProviderRuntimeMessage(localizeAntigravityRuntimeMessage(value, locale), locale);
}

function workEntryPreview(
  workEntry: TimelineWorkEntry,
  locale: MossLocaleCode = "en",
): string | null {
  if (isReasoningUpdateWorkEntry(workEntry)) {
    const preview = formatAgentActivityEntryPreview(workEntry);
    return preview ? localizeKnownRuntimeMessage(preview, locale) : null;
  }
  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    const command = workEntry.command ?? workEntry.rawCommand;
    if (command) return deriveReadableCommandDisplay(command, false, locale).target;
  }

  if (workEntry.preview) {
    return localizeKnownRuntimeMessage(
      localizeGeneratedWorkPreview(workEntry.preview, locale),
      locale,
    );
  }

  // HTML tool transport labels often end in a local payload filename. A page
  // title is added by the work-log projection when available; otherwise this
  // row deliberately has no subtitle instead of exposing the filename or MCP
  // identifier as a faux page title.
  if (
    isHtmlPageToolCall({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
    })
  ) {
    return null;
  }

  // Prefer clean basenames from changedFiles
  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((p) => basenameOfPath(p));
    if (names.length === 1) return names[0]!;
    return localizeGeneratedWorkPreview(`${names.length} files`, locale);
  }

  if (workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0) {
    if (workEntry.subagentAction?.summaryText) {
      return workEntry.subagentAction.summaryText;
    }
    const labels = workEntry.subagents!.map((subagent) => {
      const presentation = subagentPrimaryLabel(subagent);
      return (
        presentation.nickname ?? presentation.primaryLabel ?? basenameOfPath(subagent.threadId)
      );
    });
    return labels.length === 1
      ? labels[0]!
      : localizeGeneratedWorkPreview(`${labels.length} subagents`, locale);
  }

  if (workEntry.itemType === "collab_agent_tool_call") {
    return workEntry.detail
      ? localizeKnownRuntimeMessage(workEntry.detail, locale)
      : (workEntry.subagentAction?.prompt ?? null);
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const localizedRuntimeDetail = localizeKnownRuntimeMessage(workEntry.detail, locale);
    if (localizedRuntimeDetail !== workEntry.detail) return localizedRuntimeDetail;
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basenameOfPath(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    // Dynamic/MCP tool calls surface their arguments as `ToolName: {json}` —
    // transport detail, not a human summary. The raw call stays in toolDetails.
    // Failed calls keep their detail inline: it may carry the error text (e.g.
    // an MCP error serialized as `McpError: {json}`), and on a failure more
    // information beats a tidy row.
    if (toolWorkEntryStatus(workEntry) !== "failed" && isPrefixedToolArgumentSummary(trimmedDetail))
      return null;

    const readLinesMatch = /^Read\s+(\d+\s+lines?)$/i.exec(trimmedDetail);
    if (readLinesMatch?.[1]) return localizeGeneratedWorkPreview(readLinesMatch[1], locale);

    // Clean, non-JSON detail — show it
    return localizeGeneratedWorkPreview(trimmedDetail, locale);
  }

  return null;
}

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match their tool name to surface the file icon
// instead of the generic tool/wrench fallback.
function isFileReadToolEntry(workEntry: TimelineWorkEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

// Provider search tools (Claude's `Grep`/`Glob`) wear the magnifier like
// search commands do.
function isSearchToolEntry(workEntry: TimelineWorkEntry): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "grep" || name === "glob";
}

// Command rows reuse toolCallLabel's wrapper-aware classifier so reads wear the
// file glyph, searches the magnifier, wrapped git/gh commands the GitHub mark,
// and ordinary commands keep the terminal icon.
function commandWorkEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  const command = workEntry.command ?? workEntry.rawCommand;
  switch (command ? resolveCommandVisualKind(command) : "terminal") {
    case "read":
      return FileIcon;
    case "search":
      return SearchIcon;
    case "git":
    case "github":
      return GitHubIcon;
    case "terminal":
      return TerminalIcon;
  }
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  // User-input rows read as a question (awaiting an answer) and an upload
  // (answer submitted) rather than the generic "info" checkmark.
  if (workEntry.activityKind === "user-input.requested") return CircleQuestionIcon;
  if (workEntry.activityKind === "user-input.resolved") return ArrowUpCircleIcon;
  if (workEntry.activityKind === "context-compaction") return ContextCompactionIcon;
  if (workEntry.activityKind === "checkpoint.baseline.skipped") return CircleAlertIcon;
  // "Moved to background" notices read as a tray drop, not a warning check.
  if (workEntry.nativeEventType === "background_tasks_changed") return BackgroundTrayIcon;
  if (workEntry.monitorNotification)
    return workEntry.monitorNotification.outcome === "failed" ? CircleAlertIcon : EyeIcon;
  if (workEntry.backgroundTaskCompletion) {
    return workEntry.backgroundTaskCompletion.taskType === "local_agent"
      ? AgentTaskIcon
      : BackgroundTrayIcon;
  }
  // A subagent's progress is its live status, not a finished step: never the
  // success check, and a warning once it failed.
  if (workEntry.subagentProgress) {
    return workEntry.subagentProgress.outcome === "failed" ? CircleAlertIcon : AgentTaskIcon;
  }
  if (workEntry.providerHandoff) {
    return workEntry.providerHandoff.status === "failed" ? CircleAlertIcon : HandoffIcon;
  }
  if (workEntry.providerContextLifecycle) {
    return workEntry.providerContextLifecycle.nativeHistory === "unavailable"
      ? CircleAlertIcon
      : HistoryIcon;
  }

  if (workEntry.requestKind === "command") return commandWorkEntryIcon(workEntry);
  if (workEntry.requestKind === "file-read") return FileIcon;
  if (workEntry.requestKind === "file-change") return PencilIcon;
  if (workEntry.requestKind === "tool") return McpIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return commandWorkEntryIcon(workEntry);
  }
  if (workEntry.itemType === "file_change") {
    return PencilIcon;
  }
  if (workEntry.itemType === "web_search") return WebSearchIcon;
  if (workEntry.itemType === "image_generation") return ZapIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (isFileReadToolEntry(workEntry)) return FileIcon;
  if (isSearchToolEntry(workEntry)) return SearchIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return SkillCubeIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return AgentTaskIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

// Dynamic icon selection is data, not a component declaration. Keeping the
// createElement call in this module helper avoids presenting a render-local
// component binding to React Compiler.
export function renderWorkEntryIcon(Icon: LucideIcon, className: string): ReactElement {
  return createElement(Icon, { className });
}

// The leading glyph for a tool row: recognizable product and surface icons win
// over the kind-derived entry icon. Shared with the collapsed tool-group summary
// row, which borrows its first entry's icon.
export function workEntryLeftIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (isComputerWorkEntry(workEntry)) return ComputerUseIcon;
  if (isGitHubMcpToolCall(workEntry)) return GitHubIcon;
  if (isMossBrowserWorkEntry(workEntry)) return GlobeIcon;
  if (isMossToolCall(workEntry)) return MossToolIcon;
  if (workEntry.itemType === "mcp_tool_call") return McpIcon;
  return workEntryIcon(workEntry);
}

function isComputerWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    computerToolName(workEntry.toolName) !== null ||
    /^Computer Use:/i.test(workEntry.toolTitle ?? "")
  );
}

function isGitHubMcpToolCall(workEntry: TimelineWorkEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Moss's own agent-gateway tools (moss_list_threads, moss_create_thread,
// ...) get the Moss mark instead of the generic MCP glyph. Providers report
// the call differently: Claude prefixes the MCP server (mcp__moss__*), ACP
// agents surface the bare tool name (moss_*), and Codex reports server/tool
// pairs that the label humanizer renders as "Moss: ...".
function toolWorkEntryStatus(workEntry: TimelineWorkEntry): MossMcpToolStatus {
  if (workEntry.toolStatus) return workEntry.toolStatus;
  if (workEntry.liveActivity && isLiveActivityInProgress(workEntry.liveActivity)) return "running";
  return workEntry.activityKind !== undefined && workEntry.activityKind !== "tool.completed"
    ? "running"
    : "completed";
}

function isMossBrowserWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return isMossBrowserToolCall({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
}

function isMossToolCall(workEntry: TimelineWorkEntry): boolean {
  return (
    deriveMossMcpToolTitle({
      toolName: workEntry.toolName,
      title: workEntry.toolTitle,
      fallbackLabel: workEntry.label,
      status: toolWorkEntryStatus(workEntry),
    }) !== null
  );
}

// Render command, agent-task, file-change, and file-read rows at the tighter
// compact density so every tool-call line shares one height regardless of whether
// it carries a disclosure chevron.
export function prefersCompactWorkEntryRow(workEntry: TimelineWorkEntry): boolean {
  if (isCodexActivityStatusWorkEntry(workEntry) || workEntry.monitorNotification) {
    return true;
  }
  // Commands stay compact even when surfaced with a non-terminal icon (reads like
  // `cat` wear the file icon, searches the magnifier).
  if (workEntry.itemType === "command_execution" || workEntry.command || workEntry.rawCommand) {
    return true;
  }
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === PencilIcon ||
    EntryIcon === SkillCubeIcon ||
    // File-read and search rows (e.g. `Read …`) have no disclosure chevron; keep
    // them at the same compact height as command rows.
    EntryIcon === FileIcon ||
    EntryIcon === SearchIcon
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry, locale: MossLocaleCode = "en"): string {
  if (computerToolName(workEntry.toolName)) {
    // Work-log projection already resolves the action and target. The generic
    // MCP presentation would replace that with "Moss clicked the desktop".
    const title = normalizeCompactToolLabel(workEntry.toolTitle ?? "");
    if (title && !isGenericToolTitle(title) && !computerToolName(title))
      return capitalizePhrase(title);
    return describeComputerToolCall({ toolName: workEntry.toolName, args: undefined })!.summary;
  }
  const invocationTitle = workEntry.mcpToolResult
    ? codexMcpInvocationTitle(workEntry.mcpToolResult.tool, workEntry.mcpToolResult.arguments)
    : null;
  if (invocationTitle) return invocationTitle;
  // Task progress is semantic copy, not a tool lifecycle status. Preserve the
  // trailing "completed" instead of passing it through the compact tool-label
  // normalizer, which intentionally strips lifecycle suffixes.
  if (workEntry.activityKind === "turn.tasks.updated" || workEntry.monitorNotification) {
    return capitalizePhrase(workEntry.label);
  }
  const mossTitle = deriveMossMcpToolTitle({
    toolName: workEntry.toolName,
    title: workEntry.toolTitle,
    fallbackLabel: workEntry.label,
    status: toolWorkEntryStatus(workEntry),
  });
  if (mossTitle) {
    return localizeKnownRuntimeMessage(localizeToolHeading(mossTitle, locale), locale);
  }
  if (!workEntry.toolTitle) {
    return localizeKnownRuntimeMessage(
      localizeToolHeading(capitalizePhrase(normalizeCompactToolLabel(workEntry.label)), locale),
      locale,
    );
  }
  return localizeKnownRuntimeMessage(
    localizeToolHeading(capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle)), locale),
    locale,
  );
}

function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeToolTextForComparison(heading) === normalizeToolTextForComparison(preview)
    ? heading
    : heading.endsWith("：")
      ? `${heading}${preview}`
      : `${heading} ${preview}`;
}

// Shell command rows read "Ran <command>" with the command verbatim; a plain
// read of files says "Read <files>" instead, since that is exactly what it did.
// A humanized guess ("Found current directory") is never shown. Approval and
// status rows keep their own wording.
function commandElapsedLabel(
  workEntry: TimelineWorkEntry,
  locale: string,
  nowMs: number,
): string | null {
  const activity = workEntry.liveActivity;
  if (activity?.startedAt) {
    const endIso = isLiveActivityInProgress(activity)
      ? new Date(nowMs).toISOString()
      : activity.lastActivityAt;
    const label = formatClockElapsed(activity.startedAt, endIso, locale);
    if (label && label !== "0s" && label !== "0秒") return label;
  }
  const seconds = activity?.elapsedSeconds;
  if (seconds != null && Number.isFinite(seconds) && seconds >= 1) {
    return formatClockDuration(seconds * 1000, locale);
  }
  return null;
}

function commandRowDisplay(
  workEntry: TimelineWorkEntry,
  locale: MossLocaleCode,
  nowMs: number,
  expanded: boolean,
): { heading: string; object: string; literal: boolean } | null {
  const command = workEntry.rawCommand ?? workEntry.command;
  if (
    (workEntry.tone !== "tool" && workEntry.toolStatus !== "failed") ||
    !command ||
    !(
      workEntry.itemType === "command_execution" ||
      workEntry.requestKind === "command" ||
      workEntry.command
    )
  ) {
    return null;
  }
  const running = toolWorkEntryStatus(workEntry) === "running";
  const readTargets = deriveCommandReadTargets(command);
  if (readTargets) {
    return {
      heading: localizeToolHeading(running ? "Reading" : "Read", locale),
      object: readTargets.join(", "),
      literal: false,
    };
  }
  // An expanded unclassified shell says "Ran command in {elapsed}"
  // and the argv lives in the Shell card. Collapsed rows still name the command.
  if (resolveCommandVisualKind(command) === "terminal") {
    if (!expanded) {
      const literal = deriveLiteralCommand(command);
      if (literal) {
        const zh = locale === "zh-CN";
        return {
          heading: running ? (zh ? "正在运行" : "Running") : zh ? "已运行" : "Ran",
          object: literal,
          literal: true,
        };
      }
    }
    const summary = commandActivitySummary(
      command,
      workEntry.liveActivity,
      commandElapsedLabel(workEntry, locale, nowMs),
      locale,
      true,
    );
    if (summary) {
      return { heading: summary, object: "", literal: false };
    }
  }
  const literal = deriveLiteralCommand(command);
  return literal
    ? {
        heading: localizeToolHeading(running ? "Running" : "Ran", locale),
        object: literal,
        literal: true,
      }
    : null;
}

export interface WorkEntryDisplayParts {
  heading: string;
  preview: string | null;
  displayText: string;
  // Verbatim command shown in mono after the heading, for shell command rows.
  commandLiteral: string | null;
}

// Renders a row sentence: plain text, or the heading plus the command chip.
export function renderWorkEntrySentence(parts: WorkEntryDisplayParts): ReactNode {
  if (parts.commandLiteral === null) {
    return parts.displayText;
  }
  return (
    <>
      {parts.heading}{" "}
      <code className={INLINE_COMMAND_CHIP_CLASS_NAME} data-command-literal="true">
        {parts.commandLiteral}
      </code>
    </>
  );
}

// One sentence per row, live or settled: the tool's own verb plus what it acted
// on ("Read calc.py", "Ran `ls`"). Lifecycle state is never spelled out here —
// the verb already carries the tense and `liveActivityMetaText` covers the rest.
// Shared with the live tool-group line, which wears its newest call's sentence.
export function workEntryDisplayParts(
  workEntry: TimelineWorkEntry,
  locale: MossLocaleCode = "en",
  nowMs = Date.now(),
  expanded = false,
): WorkEntryDisplayParts {
  const commandDisplay = commandRowDisplay(workEntry, locale, nowMs, expanded);
  if (commandDisplay) {
    return {
      heading: commandDisplay.heading,
      preview: commandDisplay.object,
      displayText: commandDisplay.object
        ? `${commandDisplay.heading} ${commandDisplay.object}`
        : commandDisplay.heading,
      commandLiteral: commandDisplay.literal ? commandDisplay.object : null,
    };
  }
  const webFetchUrl = extractWebFetchUrl(workEntry);
  const heading = toolWorkEntryHeading(workEntry, locale);
  const rawPreview =
    workEntry.monitorNotification ||
    (workEntry.mcpToolResult &&
      codexMcpInvocationTitle(workEntry.mcpToolResult.tool, workEntry.mcpToolResult.arguments))
      ? null
      : workEntryPreview(workEntry, locale);
  const preview =
    !isGitHubMcpToolCall(workEntry) &&
    (isMossBrowserWorkEntry(workEntry) || isMossToolCall(workEntry))
      ? sanitizeMossMcpToolPreview({
          preview: rawPreview,
          heading,
          status: toolWorkEntryStatus(workEntry),
        })
      : rawPreview;
  const displayText = webFetchUrl
    ? describeLinkChip(webFetchUrl).label
    : (isReasoningUpdateWorkEntry(workEntry) || workEntry.activityKind === "tool.summary") &&
        preview
      ? preview
      : combineWorkEntryDisplayText(heading, preview);
  return { heading, preview, displayText, commandLiteral: null };
}

function isFileChangeWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return isFileChangeWorkLogEntry(workEntry);
}

function subagentPrimaryLabel(
  subagent: NonNullable<TimelineWorkEntry["subagents"]>[number],
): ReturnType<typeof resolveSubagentPresentation> {
  return resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
}

function subagentCardSummary(workEntry: TimelineWorkEntry, locale: MossLocaleCode): string {
  return (
    workEntry.subagentAction?.summaryText ??
    workEntryPreview(workEntry, locale) ??
    toolWorkEntryHeading(workEntry, locale)
  );
}

function commandTooltipContent(
  command: string,
  displayText: string,
  labels: { summary: string; rawCall: string },
) {
  return (
    <div className="max-w-96 whitespace-pre-wrap leading-tight">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <div className="text-muted-foreground/70">{labels.summary}</div>
          <div>{displayText}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-muted-foreground/70">{labels.rawCall}</div>
          <code className="block whitespace-pre-wrap break-words font-chat-code text-ui-xs text-foreground/92">
            {command}
          </code>
        </div>
      </div>
    </div>
  );
}

// Hover content for a tool-call row: the rich command card when a raw command is
// present, otherwise the plain label (used to reveal truncated text / file paths).
// Returns null when there's nothing worth showing so the row renders untouched.
function toolRowTooltipContent(
  rawCommand: string | null | undefined,
  displayText: string,
  fallback: string | undefined,
  labels: { summary: string; rawCall: string },
): ReactNode {
  if (rawCommand) {
    return commandTooltipContent(rawCommand, displayText, labels);
  }
  return fallback ? <span className="whitespace-pre-wrap">{fallback}</span> : null;
}

// Frosted hover tooltip for tool-call rows — the same surface (via the `default`
// variant) as the sidebar thread/project hover cards, so the rows read as one
// system. Replaces the native `title` tooltip; renders the trigger untouched when
// there's no content to show.
function ToolRowTooltip(props: {
  content: ReactNode;
  children: ReactElement;
  variant?: "default" | "command" | undefined;
}) {
  if (!props.content) {
    return props.children;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        delay={props.variant === "command" ? 200 : undefined}
        render={props.children}
      />
      <TooltipPopup
        side="top"
        align="start"
        variant={props.variant ?? "default"}
        className="max-w-96 whitespace-normal"
      >
        {props.content}
      </TooltipPopup>
    </Tooltip>
  );
}

function inlineSubagentItemsFromWorkEntry(workEntry: WorkLogEntry) {
  return (workEntry.subagents ?? []).flatMap((agent) => {
    const nickname = agent.nickname?.trim() || agent.title?.trim();
    if (!nickname) return [];
    const presentation = resolveSubagentPresentation({
      nickname: agent.nickname,
      role: agent.role,
      title: agent.title,
      fallbackId: agent.threadId,
    });
    return [
      {
        id: agent.threadId,
        label: nickname,
        accentColor: presentation.accentColor,
      },
    ];
  });
}

function inlineSubagentStatusFromWorkEntry(workEntry: WorkLogEntry): InlineSubagentStatus {
  return inlineSubagentStatusFromAgents(workEntry.subagents ?? []);
}

function inlineSubagentStatusFromAgents(agents: readonly WorkLogSubagent[]): InlineSubagentStatus {
  if (agents.some((agent) => /interrupt|abort/i.test(agent.rawStatus ?? ""))) return "interrupted";
  if (agents.some((agent) => /fail/i.test(agent.rawStatus ?? ""))) return "failed";
  if (
    agents.length > 0 &&
    agents.every((agent) => /complete|done|settled|success/i.test(agent.rawStatus ?? ""))
  ) {
    return "completed";
  }
  if (agents.some((agent) => agent.latestUpdate)) return "updated";
  if (agents.some((agent) => agent.isActive !== false)) return "active";
  return "completed";
}

export const TimelineWorkEntryRow = memo(function TimelineWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenAgentActivity?: (activityId: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenAutomation?: (automationId: string) => void;
  /** Current conversation id used only for the authenticated MCP App resource read. */
  threadId?: string;
  theme?: "light" | "dark";
  onMcpAppPresentation?: (presentation: {
    phase: McpAppHostPhase;
    prefersBorder: boolean;
    isCollapsible: boolean;
  }) => void;
  computerControlEnabled?: boolean;
  onEnableComputerControl?: () => void;
  timestampFormat: TimestampFormat;
}) {
  const { locale, t } = useTranslation();
  // Defaults are applied in the body (not in the destructuring pattern): a default
  // value inside a destructuring pattern makes React Compiler bail out on the whole
  // component, silently dropping memoization for every tool-call row.
  const {
    workEntry,
    chatMetaFontSizePx,
    textFontSizePx: textFontSizePxProp,
    density: densityProp,
    fileDiffStatByPath,
    markdownCwd,
    onImageExpand,
    turnId,
    onOpenTurnDiff,
    onOpenAgentActivity,
    onOpenThread,
    onOpenAutomation,
    threadId,
    theme,
    onMcpAppPresentation,
    computerControlEnabled,
    onEnableComputerControl,
    timestampFormat,
  } = props;
  const textFontSizePx = textFontSizePxProp ?? chatMetaFontSizePx;
  const density = densityProp ?? "default";
  const compact = density === "compact";
  const isCodexStatusRow =
    workEntry.activityKind !== "context-compaction" && isCodexActivityStatusWorkEntry(workEntry);
  const isPlainRuntimeNoticeRow = isPlainRuntimeNoticeWorkEntry(workEntry);
  const EntryIcon = workEntryIcon(workEntry);
  // Web-fetch tool calls surface the target site (favicon + URL) instead of the raw
  // `WebFetch: {json}` arguments, reusing the same link-chip icon/label path as
  // composer and markdown links so every site reference looks identical.
  const webFetchUrl = extractWebFetchUrl(workEntry);
  // Standard tool rows keep one discoverable left glyph. Codex status rows
  // deliberately skip it and reuse only the shared tool-label typography.
  const isGitHubToolRow = isGitHubMcpToolCall(workEntry);
  const isMossBrowserToolRow = !isGitHubToolRow && isMossBrowserWorkEntry(workEntry);
  const isMossToolRow = !isGitHubToolRow && !isMossBrowserToolRow && isMossToolCall(workEntry);
  const isComputerToolRow = isComputerWorkEntry(workEntry);
  const isMcpToolRow =
    workEntry.itemType === "mcp_tool_call" &&
    !isGitHubToolRow &&
    !isComputerToolRow &&
    !isMossBrowserToolRow &&
    !isMossToolRow;
  const LeftIcon = workEntryLeftIcon(workEntry);
  const leftIconKind = webFetchUrl
    ? "web-fetch"
    : isComputerToolRow
      ? "computer"
      : isGitHubToolRow || EntryIcon === GitHubIcon
        ? "github"
        : isMossBrowserToolRow
          ? "browser"
          : isMossToolRow
            ? "moss"
            : isMcpToolRow
              ? "mcp"
              : undefined;
  const isQuotaExhaustedActivity = workEntry.activityKind === "account.quota-exhausted";
  const heading = isQuotaExhaustedActivity
    ? t("mossQuota.exhausted.activity")
    : toolWorkEntryHeading(workEntry, locale);
  const rawPreview = workEntry.monitorNotification
    ? null
    : workEntry.mcpToolResult &&
        codexMcpInvocationTitle(workEntry.mcpToolResult.tool, workEntry.mcpToolResult.arguments)
      ? null
      : workEntryPreview(workEntry, locale);
  const preview =
    isMossBrowserToolRow || isMossToolRow
      ? (sanitizeMossMcpToolPreview({
          preview: rawPreview,
          heading,
          status: toolWorkEntryStatus(workEntry),
        }) ?? null)
      : rawPreview;
  // One sentence per row, live or settled: the tool's own verb plus what it acted
  // on ("Searched for foo in src"). Lifecycle state is never spelled out here —
  // the verb already carries the tense and `liveActivityMetaText` covers the rest.
  const historicalThreadError =
    (workEntry.activityKind === "provider.turn.start.failed" ||
      workEntry.activityKind === "runtime.error") &&
    workEntry.detail
      ? resolveThreadErrorPresentation(
          workEntry.detail,
          locale,
          workEntry.activityKind === "provider.turn.start.failed"
            ? "provider-start-failure"
            : "thread",
        ).title
      : null;
  const displayText = isQuotaExhaustedActivity
    ? heading
    : historicalThreadError
      ? historicalThreadError
      : webFetchUrl
        ? describeLinkChip(webFetchUrl).label
        : isReasoningUpdateWorkEntry(workEntry) && preview
          ? preview
          : combineWorkEntryDisplayText(heading, preview);
  const showInlineAgentTaskPreview =
    workEntry.itemType === "collab_agent_tool_call" &&
    Boolean(preview) &&
    normalizeToolTextForComparison(heading) !== normalizeToolTextForComparison(preview ?? "");
  const rawCommand = workEntry.rawCommand ?? workEntry.command;
  const openShellByDefault = rawCommand
    ? resolveCommandVisualKind(rawCommand) === "terminal" &&
      deriveLiteralCommand(rawCommand).length > 72 &&
      toolWorkEntryStatus(workEntry) !== "running"
    : false;
  const shellDetails =
    workEntry.toolDetails ??
    (openShellByDefault && rawCommand
      ? { kind: "command" as const, title: "Shell", command: rawCommand }
      : undefined);
  const hoverText = isQuotaExhaustedActivity
    ? heading
    : historicalThreadError
      ? historicalThreadError
      : (rawCommand ?? (showInlineAgentTaskPreview ? heading : (webFetchUrl ?? displayText)));
  const changedFiles = workEntry.changedFiles ?? [];
  const showEditedRows = isFileChangeWorkEntry(workEntry) && changedFiles.length > 0;
  const showSubagentRows =
    workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0;
  const showMultiAgentAction =
    workEntry.itemType === "collab_agent_tool_call" &&
    isTimelineMultiAgentAction(workEntry.subagentAction?.tool);
  const subagentSummary = subagentCardSummary(workEntry, locale);
  const canOpenAgentActivity = Boolean(onOpenAgentActivity) && isAgentActivityWorkEntry(workEntry);
  const openAgentActivity = canOpenAgentActivity
    ? () => onOpenAgentActivity?.(workEntry.id)
    : undefined;
  const hasToolDetails = Boolean(workEntry.toolDetails);
  const providerContextLifecycle = workEntry.providerContextLifecycle;
  const providerHandoff = workEntry.providerHandoff;
  const monitorNotification = workEntry.monitorNotification;
  // File-read rows open the referenced file in the in-app viewer when the
  // hosting surface provides an opener (right-dock file pane / editor pane).
  const opener = useWorkspaceFileOpener();
  // Per-file +N/-M parsed from this tool call's own patch, used as a fallback when
  // the turn-diff summary isn't in scope (e.g. standalone work rows) so every
  // "Edited <file>" row can still show diff stats.
  const toolDiffStatsByPath = useMemo(
    () =>
      isFileChangeWorkEntry(workEntry)
        ? fileDiffStatsByPath(workEntry.toolDetails?.diff)
        : EMPTY_FILE_DIFF_STATS,
    [workEntry],
  );
  const liveActivityNowMs = useLiveActivityNow(workEntry.liveActivity);
  // A failed call says so explicitly, with its exit code and the first line
  // that explains it, instead of the generic lifecycle meta.
  const failure =
    toolWorkEntryStatus(workEntry) === "failed"
      ? deriveToolFailureSummary(workEntry.toolDetails)
      : null;
  const liveActivityMetaText = failure
    ? null
    : workEntry.liveActivity
      ? formatLiveActivityMeta(workEntry.liveActivity, liveActivityNowMs, {
          subagent: workEntry.itemType === "collab_agent_tool_call",
          awaitingUser: isMossUserAnswerToolCall(workEntry.toolName),
        })
      : null;
  const failureMetaText = failure
    ? failure.exitCode !== null
      ? `Failed · exit ${failure.exitCode}`
      : "Failed"
    : null;
  // Reasoning and progress narration reads as prose: it wraps instead of
  // being cut to one line.
  const wrapsFullText =
    isReasoningUpdateWorkEntry(workEntry) || workEntry.activityKind === "tool.summary";

  // A computer-control denial renders as an actionable card (enable + retry)
  // instead of a buried tool-error line. Kept after the hooks above so the
  // early return never changes hook order.
  if (workEntry.computerSetupRequired) {
    return (
      <ConnectedComputerSetupRequiredCard
        {...workEntry.computerSetupRequired}
        textFontSizePx={textFontSizePx}
        metaFontSizePx={chatMetaFontSizePx}
      />
    );
  }

  const computerControlDenied = workEntry.computerControlDenied;
  if (computerControlDenied) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <ComputerControlDeniedCard
          {...(computerControlEnabled !== undefined ? { computerControlEnabled } : {})}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
          {...(onEnableComputerControl ? { onEnable: onEnableComputerControl } : {})}
        />
      </div>
    );
  }

  // An agent waiting on a secret is answered here, privately. Kept after the
  // hooks above so the early return never changes hook order.
  if (workEntry.secretRequest) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <SecretRequestCard
          request={workEntry.secretRequest}
          threadId={threadId ? ThreadId.makeUnsafe(threadId) : undefined}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
        />
      </div>
    );
  }

  // A background task keeps one row for its whole life. Kept after the hooks
  // above so the early return never changes hook order.
  if (workEntry.backgroundTask) {
    return <BackgroundTaskRow task={workEntry.backgroundTask} fontSizePx={textFontSizePx} />;
  }

  // A turn's subagents fold into one entry that renders as the subagent card.
  // An unfolded collab call also draws the chip sentence.
  if (
    workEntry.itemType === "collab_agent_tool_call" &&
    !workEntry.subagentRun &&
    !workEntry.subagentActivity &&
    !isTimelineMultiAgentAction(workEntry.subagentAction?.tool)
  ) {
    const inlineItems = inlineSubagentItemsFromWorkEntry(workEntry);
    if (inlineItems.length > 0) {
      return (
        <div className={cn(compact ? "py-0.5" : "py-1")} data-subagent-activity-row="true">
          <InlineSubagentActivity
            items={inlineItems}
            status={inlineSubagentStatusFromWorkEntry(workEntry)}
          />
        </div>
      );
    }
  }
  if (workEntry.subagentRun) {
    return <SubagentRunCard workEntry={workEntry} />;
  }

  // A created-automation row renders as its own card instead of a tool-call line.
  // Kept after the hooks above so the early return never changes hook order.
  const automation = workEntry.automation;
  if (automation) {
    return (
      <div className={cn(compact ? "py-0.5" : "py-1")}>
        <AutomationCreatedCard
          automationId={automation.id}
          name={automation.name}
          cadenceLabel={automation.cadenceLabel}
          {...(automation.proposalState ? { proposalState: automation.proposalState } : {})}
          textFontSizePx={textFontSizePx}
          metaFontSizePx={chatMetaFontSizePx}
          {...(onOpenAutomation ? { onOpen: () => onOpenAutomation(automation.id) } : {})}
        />
      </div>
    );
  }

  if (workEntry.streamRetry) {
    return (
      <TimelineStreamErrorRow
        streamRetry={workEntry.streamRetry}
        chatMetaFontSizePx={chatMetaFontSizePx}
        textFontSizePx={textFontSizePx}
        density={density}
      />
    );
  }

  const readFilePath =
    opener !== null &&
    !canOpenAgentActivity &&
    workEntry.detail &&
    (workEntry.requestKind === "file-read" || isFileReadToolEntry(workEntry))
      ? extractFilePathFromDetail(workEntry.detail)
      : null;
  const canOpenReadFile = readFilePath !== null;
  const canOpenToolDetails =
    !canOpenAgentActivity &&
    Boolean(
      providerContextLifecycle ||
      workEntry.mcpToolResult ||
      providerHandoff ||
      monitorNotification ||
      workEntry.toolDetails ||
      (workEntry.liveActivity && !canOpenReadFile),
    );
  const commandIsInProgress = Boolean(
    workEntry.liveActivity && isLiveActivityInProgress(workEntry.liveActivity),
  );
  const commandElapsed = workEntry.liveActivity
    ? formatLiveActivityElapsed(workEntry.liveActivity, liveActivityNowMs)
    : null;
  const declinedByAutoReview = wasDeclinedByAutoReview(workEntry);
  const commandSummaryOptions = {
    wasDeclinedByAutoReview: declinedByAutoReview,
    isBackgroundTerminalRunning: workEntry.backgroundTerminal === "running",
    isBackgroundTerminalFinished: workEntry.backgroundTerminal === "finished",
    // Generic "Running command/Ran command" fallbacks lose to the upstream
    // heading+preview display (which also restores the live activity meta).
    suppressGenericFallback: true,
  };
  const commandSummary =
    canOpenToolDetails && rawCommand?.trim()
      ? commandActivitySummary(
          rawCommand,
          workEntry.liveActivity,
          commandElapsed,
          locale,
          false,
          commandSummaryOptions,
        )
      : null;
  const visibleLiveActivityMetaText =
    failureMetaText ?? (commandSummary ? null : liveActivityMetaText);
  const openReadFile = readFilePath
    ? () => openWorkspaceFileReference(opener, readFilePath)
    : undefined;
  const prefetchReadFile =
    readFilePath && opener?.prefetchFile ? () => opener.prefetchFile?.(readFilePath) : undefined;

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;

  if (workEntry.activityKind === "approval.resolved") return null;
  if (workEntry.activityKind === "approval.requested") {
    return (
      <div
        className="relative min-w-0 overflow-visible py-0 text-size-chat text-text/30"
        data-testid="permission-request-pending"
        role="status"
      >
        {t("chat.timeline.awaitingApproval")}
      </div>
    );
  }

  return (
    <div className={cn(compact ? "py-0.5" : "rounded-lg py-1")}>
      {showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            // Prefer the turn-diff summary's per-file stat; fall back to the stat
            // parsed from this tool call's own patch so the +N/-M shows even when
            // no summary is in scope (standalone work rows) or it lacks the file.
            const summaryStat = fileDiffStatByPath?.get(changedFilePath);
            const changedFileStat =
              summaryStat && summaryStat.additions + summaryStat.deletions > 0
                ? summaryStat
                : (resolveFileDiffStatByChangedPath(
                    toolDiffStatsByPath,
                    changedFilePath,
                    changedFiles.length,
                  ) ?? summaryStat);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            const canOpenEditedRow = canOpenToolDetails || canOpenEditedDiff;
            const editedRowClassName = cn(
              "group/file-row flex w-full max-w-full items-center text-left transition-colors duration-150",
              compact ? "gap-1.5" : "gap-2",
              canOpenEditedRow ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
            );
            const editedRowChildren = (
              <EditedFileRowContent
                filePath={changedFilePath}
                additions={changedFileStat?.additions}
                deletions={changedFileStat?.deletions}
                fontSizePx={rowFontSizePx}
                compact={compact}
                active={commandIsInProgress && !declinedByAutoReview}
                editedLabel={localizeToolHeading(
                  workEntry.fileChangeKinds?.[changedFilePath] === "add"
                    ? commandIsInProgress
                      ? "Creating"
                      : "Created"
                    : workEntry.fileChangeKinds?.[changedFilePath] === "delete"
                      ? commandIsInProgress
                        ? "Deleting"
                        : "Deleted"
                      : commandIsInProgress
                        ? "Editing"
                        : "Edited",
                  locale,
                )}
              />
            );
            if (hasToolDetails || (canOpenToolDetails && !canOpenEditedDiff)) {
              return (
                <ToolDetailsDisclosure
                  key={`${workEntry.id}:${changedFilePath}`}
                  details={workEntry.toolDetails}
                  activity={workEntry.liveActivity}
                  compact={compact}
                  tooltip={<span className="whitespace-pre-wrap">{changedFilePath}</span>}
                  summaryClassName={editedRowClassName}
                  dataFileChangeRow
                  timestampFormat={timestampFormat}
                >
                  {editedRowChildren}
                </ToolDetailsDisclosure>
              );
            }
            return (
              <button
                key={`${workEntry.id}:${changedFilePath}`}
                type="button"
                data-file-change-row="true"
                className={editedRowClassName}
                title={changedFilePath}
                disabled={!canOpenEditedRow}
                onClick={() => {
                  if (!turnId || !onOpenTurnDiff) {
                    return;
                  }
                  onOpenTurnDiff(turnId, changedFilePath);
                }}
              >
                {editedRowChildren}
              </button>
            );
          })}
        </div>
      ) : workEntry.subagentActivity ? (
        <TimelineSubagentActivityGroup
          groupId={workEntry.id}
          subagents={workEntry.subagents ?? []}
          activityKind={workEntry.subagentActivity}
          onOpenThread={onOpenThread}
        />
      ) : showMultiAgentAction ? (
        <MultiAgentActionDisclosure
          items={[workEntry]}
          fontSizePx={rowFontSizePx}
          {...(onOpenThread ? { onOpenThread } : {})}
        />
      ) : showSubagentRows ? (
        <div className="space-y-1.5">
          <AgentActivityOpenSurface
            canOpen={canOpenAgentActivity}
            compact={compact}
            title={hoverText}
            onOpen={openAgentActivity}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center text-muted-foreground/40",
                compact ? "size-4" : "size-5",
              )}
            >
              {renderWorkEntryIcon(EntryIcon, compact ? "size-2.5" : "size-3")}
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <p
                className={cn(
                  compact ? "truncate leading-5" : "truncate leading-6",
                  "font-medium text-foreground/72",
                )}
                style={{ fontSize: `${rowFontSizePx}px` }}
                title={hoverText}
              >
                <span>{subagentSummary}</span>
              </p>
            </div>
          </AgentActivityOpenSurface>
          <TimelineSubagentActivityGroup
            groupId={workEntry.id}
            subagents={workEntry.subagents ?? []}
            onOpenThread={onOpenThread}
          />
        </div>
      ) : (
        (() => {
          const renderRowContentChildren = (expanded: boolean) => {
            const commandParts =
              rawCommand && !declinedByAutoReview && !workEntry.backgroundTerminal
                ? workEntryDisplayParts(workEntry, locale, liveActivityNowMs, expanded)
                : null;
            const summaryText =
              commandSummary && rawCommand
                ? (commandActivitySummary(
                    rawCommand,
                    workEntry.liveActivity,
                    commandElapsed,
                    locale,
                    expanded,
                    commandSummaryOptions,
                  ) ?? displayText)
                : displayText;
            return (
              <>
                {!isCodexStatusRow && !isPlainRuntimeNoticeRow ? (
                  <span
                    className={cn(
                      "flex shrink-0 items-center justify-center",
                      WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                      compact ? "size-4" : "size-5",
                    )}
                    data-tool-icon={leftIconKind}
                    data-work-entry-icon="true"
                  >
                    {webFetchUrl ? (
                      <LinkChipIcon url={webFetchUrl} className={compact ? "size-4" : "size-4"} />
                    ) : isMcpToolRow && LeftIcon === McpIcon && workEntry.mcpServer ? (
                      <McpServerIcon
                        serverName={workEntry.mcpServer}
                        className={compact ? "size-4" : "size-4"}
                      />
                    ) : (
                      renderWorkEntryIcon(LeftIcon, compact ? "size-4" : "size-4")
                    )}
                  </span>
                ) : null}
                <div
                  className={cn(
                    "min-w-0 overflow-hidden",
                    // Single-line tool labels size to their content so the disclosure
                    // chevron can sit right after the name; the multi-line markdown
                    // preview still needs the full row width.
                    showInlineAgentTaskPreview && "flex-1",
                  )}
                >
                  {showInlineAgentTaskPreview ? (
                    <div className={cn(compact ? "space-y-[1px]" : "space-y-0.5")}>
                      <p
                        className={cn(
                          "truncate font-medium leading-5",
                          MUTED_LABEL_TEXT_CLASS_NAME,
                        )}
                        style={{ fontSize: `${rowFontSizePx}px` }}
                      >
                        <span data-work-entry-display-text="true">{heading}</span>
                        {visibleLiveActivityMetaText ? (
                          <span data-live-activity-meta="true">
                            · {visibleLiveActivityMetaText}
                          </span>
                        ) : null}
                      </p>
                      <ChatMarkdown
                        text={preview ?? ""}
                        cwd={markdownCwd}
                        isStreaming={false}
                        className="leading-relaxed"
                        style={{
                          color: MUTED_LABEL_TEXT_COLOR,
                          fontSize: `${Math.max(11, rowFontSizePx - 1)}px`,
                          lineHeight: compact ? "18px" : "19px",
                        }}
                        onImageExpand={onImageExpand}
                      />
                    </div>
                  ) : (
                    <p
                      className={cn(
                        wrapsFullText ? "whitespace-pre-wrap break-words" : "truncate",
                        compact ? "leading-5" : "leading-6",
                        isPlainRuntimeNoticeRow && "italic",
                        // Match the leading icon's tone so the row reads as one muted unit, and
                        // brighten the whole row to foreground on hover/focus instead of a fill.
                        isCodexStatusRow
                          ? CODEX_STATUS_ROW_MUTED_HOVER_TONE
                          : WORK_ROW_MUTED_HOVER_TONE["tool-row"],
                      )}
                      data-runtime-notice-row={isPlainRuntimeNoticeRow ? "true" : undefined}
                      data-codex-status-row={isCodexStatusRow ? "true" : undefined}
                      data-tool-detail-summary-state={
                        commandSummary ? (expanded ? "semantic" : "raw-command") : undefined
                      }
                      style={{ fontSize: `${rowFontSizePx}px` }}
                    >
                      <ConversationShimmer
                        data-work-entry-display-text="true"
                        data-translation-skip="true"
                        active={
                          commandIsInProgress || workEntry.mcpToolResult?.status === "inProgress"
                        }
                      >
                        {commandParts ? renderWorkEntrySentence(commandParts) : summaryText}
                      </ConversationShimmer>
                      {visibleLiveActivityMetaText ? (
                        <span data-live-activity-meta="true"> · {visibleLiveActivityMetaText}</span>
                      ) : null}
                    </p>
                  )}
                </div>
                {workEntry.mcpToolResult?.automaticApprovalReviews?.length ? (
                  <CentralIcon
                    aria-hidden="true"
                    name="shield-code"
                    className="icon-xs shrink-0 text-tertiary"
                    data-automatic-approval-review-accessory="true"
                  />
                ) : null}
              </>
            );
          };
          if (canOpenToolDetails || openShellByDefault) {
            const parentRow = (
              <ToolDetailsDisclosure
                details={shellDetails}
                mcpToolResult={workEntry.mcpToolResult}
                activity={workEntry.liveActivity}
                mcpApp={
                  workEntry.mcpToolResult?.app && threadId
                    ? {
                        projection: workEntry.mcpToolResult,
                        threadId,
                        theme: theme ?? "light",
                      }
                    : undefined
                }
                onMcpAppPresentation={onMcpAppPresentation}
                onImageExpand={onImageExpand}
                detailContent={
                  monitorNotification ? (
                    <div className="space-y-1 text-ui-sm">
                      <time
                        className="text-ui-xs text-muted-foreground"
                        dateTime={workEntry.createdAt}
                      >
                        {formatTimestamp(workEntry.createdAt, timestampFormat)}
                      </time>
                      <pre className="whitespace-pre-wrap break-words font-chat-code">
                        {monitorNotification.output}
                      </pre>
                    </div>
                  ) : providerContextLifecycle ? (
                    <ProviderContextLifecycleDetails info={providerContextLifecycle} />
                  ) : providerHandoff ? (
                    <ProviderHandoffDetails info={providerHandoff} />
                  ) : undefined
                }
                compact={compact}
                timestampFormat={timestampFormat}
                {...(commandSummary ? { semanticSummary: displayText } : {})}
                tooltip={
                  rawCommand && resolveCommandVisualKind(rawCommand) === "terminal"
                    ? deriveLiteralCommand(rawCommand)
                    : toolRowTooltipContent(rawCommand, displayText, displayText, {
                        summary: locale === "zh-CN" ? "摘要" : "Summary",
                        rawCall: locale === "zh-CN" ? "原始调用" : "Raw call",
                      })
                }
                tooltipVariant={
                  rawCommand && resolveCommandVisualKind(rawCommand) === "terminal"
                    ? "command"
                    : "default"
                }
                defaultOpen={openShellByDefault}
                afterSummary={
                  failure?.excerpt ? (
                    <p
                      data-tool-failure-excerpt="true"
                      className="pl-7 text-ui-sm text-muted-foreground"
                    >
                      {failure.excerpt}
                    </p>
                  ) : null
                }
                renderSummary={renderRowContentChildren}
              >
                {renderRowContentChildren(true)}
              </ToolDetailsDisclosure>
            );
            return workEntry.mcpToolResult?.webMcpCalls?.length ? (
              <div
                className="flex min-w-0 flex-col gap-[var(--conversation-grouped-item-gap,4px)]"
                data-webmcp-parent="true"
              >
                {parentRow}
                <WebMcpActivity
                  calls={workEntry.mcpToolResult.webMcpCalls}
                  {...(workEntry.mcpToolResult.webMcpFallbackHostname
                    ? { fallbackHostname: workEntry.mcpToolResult.webMcpFallbackHostname }
                    : {})}
                  parentCallId={workEntry.mcpToolResult.callId}
                  compact={compact}
                  fontSizePx={rowFontSizePx}
                />
              </div>
            ) : (
              parentRow
            );
          }

          const rowContent = (
            <AgentActivityOpenSurface
              canOpen={canOpenAgentActivity || canOpenReadFile}
              compact={compact}
              onOpen={openAgentActivity ?? openReadFile}
              onHover={prefetchReadFile}
              tooltip={toolRowTooltipContent(
                rawCommand,
                displayText,
                canOpenReadFile ? (readFilePath ?? hoverText) : hoverText,
                {
                  summary: locale === "zh-CN" ? "摘要" : "Summary",
                  rawCall: locale === "zh-CN" ? "原始调用" : "Raw call",
                },
              )}
            >
              {renderRowContentChildren(false)}
            </AgentActivityOpenSurface>
          );

          return (
            <>
              {rowContent}
              {workEntry.tone === "error" &&
              deriveToolFailureSummary(workEntry.toolDetails)?.excerpt ? (
                <p
                  data-tool-failure-excerpt="true"
                  className="pl-7 text-ui-sm text-muted-foreground"
                >
                  {deriveToolFailureSummary(workEntry.toolDetails)?.excerpt}
                </p>
              ) : null}
            </>
          );
        })()
      )}
    </div>
  );
});

// Inner content for an "Edited <file> +n/-m" row. Mirrors the tool-call row treatment
// (muted leading icon + label that brightens to foreground on hover/focus, same font
// size) so edited rows read as the same visual unit. Callers own the interactive wrapper
// (`group/file-row` button or disclosure summary) and pass the diff stat when available.
export function EditedFileRowContent(props: {
  filePath: string;
  additions: number | undefined;
  deletions: number | undefined;
  fontSizePx: number;
  compact: boolean;
  editedLabel?: string;
  active?: boolean;
}) {
  const {
    filePath,
    additions,
    deletions,
    fontSizePx,
    compact,
    editedLabel: editedLabelProp,
  } = props;
  const editedLabel = editedLabelProp ?? "Edited";
  const hasStat = (additions ?? 0) + (deletions ?? 0) > 0;
  return (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          compact ? "size-4" : "size-5",
        )}
        data-tool-icon="edit"
      >
        <PencilIcon className={compact ? "size-4" : "size-4"} />
      </span>
      <ConversationShimmer
        active={props.active ?? false}
        className={cn("font-system-ui shrink-0", WORK_ROW_MUTED_HOVER_TONE["file-row"])}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        {editedLabel}
      </ConversationShimmer>
      <span
        className={cn(
          "font-system-ui max-w-[28rem] truncate underline-offset-2",
          WORK_ROW_MUTED_HOVER_TONE["file-row"],
          // Filename doubles as a link affordance: underline on the same row hover/focus.
          "group-hover/file-row:underline group-focus-visible/file-row:underline",
        )}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        {basenameOfPath(filePath)}
      </span>
      {hasStat ? (
        <span
          className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
          style={{ fontSize: `${fontSizePx}px` }}
        >
          <DiffStatLabel additions={additions ?? 0} deletions={deletions ?? 0} />
        </span>
      ) : null}
    </>
  );
}

function AgentActivityOpenSurface(props: {
  canOpen: boolean;
  children: ReactNode;
  compact: boolean;
  /** Warm-up hook fired on hover/focus so opening feels instant. */
  onHover?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  title?: string | undefined;
  /** Styled frosted hover tooltip (preferred over the native `title`). */
  tooltip?: ReactNode;
  dataToolDetailTrigger?: boolean | undefined;
}) {
  const className = cn(
    "group/tool-row flex w-full items-center text-left transition-[opacity,translate] duration-200",
    props.compact ? "gap-1.5" : "gap-2",
    props.canOpen ? "cursor-pointer focus-visible:outline-none" : "cursor-default",
  );

  // Wrap the real DOM element (not this component) so Base UI's tooltip trigger
  // can attach its hover handlers and compose with our own onClick/onPointerEnter.
  const surface = props.canOpen ? (
    <button
      type="button"
      className={className}
      title={props.title}
      onClick={props.onOpen}
      data-tool-detail-trigger={props.dataToolDetailTrigger ? "true" : undefined}
      {...(props.onHover ? { onPointerEnter: props.onHover, onFocus: props.onHover } : {})}
    >
      {props.children}
    </button>
  ) : (
    <div className={className} title={props.title}>
      {props.children}
    </div>
  );

  return <ToolRowTooltip content={props.tooltip}>{surface}</ToolRowTooltip>;
}

function providerContextLifecycleReasonLabel(
  reason: NonNullable<TimelineWorkEntry["providerContextLifecycle"]>["restartReason"],
  zh: boolean,
): string {
  // Upstream contracts may omit newer Moss lifecycle reasons; string-based
  // dispatch keeps this renderer forward compatible with those payloads.
  switch (reason as string) {
    case "conversation-rebuilt":
      return zh ? "根据摘要重建了对话" : "Conversation rebuilt from a summary";
    case "fork-from-earlier-turn":
      return zh ? "分支重建到所选的一轮" : "Fork rebuilt up to the chosen turn";
    case "fresh-session":
      return zh ? "开始了新会话" : "New session started";
    case "interrupt-escalation":
      return zh ? "停止这一轮时重启了会话" : "Turn stop escalated to a session restart";
    case "native-history-unavailable":
      return zh ? "之前的历史记录不可用" : "Previous history unavailable";
    case "native-resume-failed":
      return zh ? "没能恢复之前的会话" : "Could not resume the previous session";
    default:
      return zh ? "服务商的上下文已重新开始" : "Provider context restarted";
  }
}

function ProviderContextLifecycleDetails(props: {
  info: NonNullable<TimelineWorkEntry["providerContextLifecycle"]>;
}) {
  const { info } = props;
  const zh = useTranslation().locale === "zh-CN";
  const provider =
    PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === info.provider)?.displayName ??
    info.provider;
  return (
    <div className="space-y-3" data-provider-context-lifecycle-details="true">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">{zh ? "服务商" : "Provider"}</dt>
        <dd className="text-foreground/84">{provider}</dd>
        <dt className="text-muted-foreground/56">{zh ? "之前的历史记录" : "Previous history"}</dt>
        <dd className="text-foreground/84">
          {info.nativeHistory === "available"
            ? zh
              ? "可用"
              : "Available"
            : zh
              ? "已丢失"
              : "Lost"}
        </dd>
        <dt className="text-muted-foreground/56">{zh ? "会话已重启" : "Session restarted"}</dt>
        <dd className="text-foreground/84">
          {info.sessionRestarted ? (zh ? "是" : "Yes") : zh ? "否" : "No"}
        </dd>
        <dt className="text-muted-foreground/56">{zh ? "原因" : "Why"}</dt>
        <dd className="text-foreground/84">
          {providerContextLifecycleReasonLabel(info.restartReason, zh)}
        </dd>
        <dt className="text-muted-foreground/56">{zh ? "附带摘要" : "Summary included"}</dt>
        <dd className="text-foreground/84">
          {info.recapInjected
            ? zh
              ? `${info.recapCharacters.toLocaleString()} 个字符`
              : `${info.recapCharacters.toLocaleString()} characters`
            : zh
              ? "否"
              : "No"}
        </dd>
      </dl>
      {info.recapPreview ? (
        <section className="space-y-2">
          <h3 className="text-ui-sm font-medium text-muted-foreground/56">
            {zh ? "摘要预览" : "Summary preview"}
          </h3>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 font-chat-code text-chat-code leading-relaxed text-foreground/84"
            data-session-context-recap-preview="true"
          >
            {info.recapPreview}
          </pre>
          {info.recapPreviewTruncated ? (
            <p className="text-ui-xs text-muted-foreground/56">
              {zh
                ? "这里只显示随你的消息发送的摘要的一小部分。"
                : "Showing a short preview of the summary sent with your message."}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function providerModelLabel(
  selection: ModelSelection,
  fastModeNotice?: FastModeNotice | null,
): string {
  const displayName =
    PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === selection.provider)
      ?.displayName ?? selection.provider;
  const summary = resolveThreadModelSummary(selection);
  const modelLabel = summary
    ? `${formatThreadModelSummaryLabel(summary)}${summary.fastMode ? ` · ${fastModeNotice?.label ?? "Fast"}` : ""}`
    : selection.model;
  return `${displayName} · ${modelLabel}`;
}

export function ProviderHandoffDetails(props: {
  info: NonNullable<TimelineWorkEntry["providerHandoff"]>;
}) {
  const { info } = props;
  return (
    <div className="space-y-3" data-provider-handoff-details="true">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">From</dt>
        <dd className="text-foreground/84">
          {providerModelLabel(info.sourceModelSelection, info.sourceFastModeNotice)}
        </dd>
        <dt className="text-muted-foreground/56">To</dt>
        <dd className="text-foreground/84">
          {providerModelLabel(info.targetModelSelection, info.targetFastModeNotice)}
        </dd>
        {info.status === "failed" ? (
          <>
            <dt className="text-muted-foreground/56">Error</dt>
            <dd className="text-foreground/84">
              {info.failureDetail ?? "The session did not start."}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground/56">Context</dt>
            <dd className="text-foreground/84">
              {info.contextText ? `${info.contextText.length.toLocaleString()} characters` : "None"}
            </dd>
          </>
        )}
      </dl>
      {info.status === "completed" && info.contextText ? (
        <section className="space-y-2">
          <h3 className="text-ui-sm font-medium text-muted-foreground/56">Transferred context</h3>
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 font-chat-code text-chat-code leading-relaxed text-foreground/84"
            data-provider-handoff-context="true"
          >
            {info.contextText}
          </pre>
          <p className="text-ui-xs text-muted-foreground/56">
            Sent ahead of your next message so the new model can continue this thread.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function ToolDetailsDisclosure(props: {
  children: ReactNode;
  compact: boolean;
  dataFileChangeRow?: boolean | undefined;
  details?: TimelineWorkEntry["toolDetails"] | undefined;
  mcpToolResult?: TimelineWorkEntry["mcpToolResult"] | undefined;
  mcpApp?:
    | {
        projection: NonNullable<TimelineWorkEntry["mcpToolResult"]>;
        threadId: string;
        theme: "light" | "dark";
      }
    | undefined;
  onMcpAppPresentation?:
    | ((presentation: {
        phase: McpAppHostPhase;
        prefersBorder: boolean;
        isCollapsible: boolean;
      }) => void)
    | undefined;
  activity?: TimelineWorkEntry["liveActivity"] | undefined;
  detailContent?: ReactNode;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  renderSummary?: ((open: boolean) => ReactNode) | undefined;
  semanticSummary?: string | undefined;
  summaryClassName?: string | undefined;
  timestampFormat: TimestampFormat;
  tooltip?: ReactNode;
  tooltipVariant?: "default" | "command" | undefined;
  defaultOpen?: boolean;
  // Rendered between the summary row and its details (e.g. a failure excerpt).
  afterSummary?: ReactNode;
}) {
  const summaryClassName =
    props.summaryClassName ??
    cn(
      "group/tool-row group/activity-header inline-flex min-w-0 max-w-full self-start items-center gap-1 text-start",
      "cursor-pointer",
    );
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const bodyId = `tool-details-body-${useId().replace(/[^a-zA-Z0-9-]/gu, "")}`;
  const summaryLabelId = `${bodyId}-summary`;
  const initiallyOpen = props.defaultOpen ?? props.mcpApp !== undefined;
  const [open, setOpen] = useState(initiallyOpen);
  // Upstream mount-on-open disclosure: the detail body only enters the DOM once
  // opened, starts hidden (aria-hidden + inert) for one frame, and unmounts
  // again shortly after the close transition ends.
  const [renderDetails, setRenderDetails] = useState(initiallyOpen);
  const [motionOpen, setMotionOpen] = useState(initiallyOpen);
  const openFrameRef = useRef<number | null>(null);
  const cleanupTimeoutRef = useRef<number | null>(null);
  const clearMotionTimers = useCallback(() => {
    if (openFrameRef.current !== null) {
      window.cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
    if (cleanupTimeoutRef.current !== null) {
      window.clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
  }, []);
  const setDetailsOpen = useCallback(
    (nextOpen: boolean) => {
      clearMotionTimers();
      setOpen(nextOpen);
      if (nextOpen) {
        setRenderDetails(true);
        setMotionOpen(false);
        openFrameRef.current = window.requestAnimationFrame(() => {
          openFrameRef.current = null;
          setMotionOpen(true);
        });
        return;
      }
      setMotionOpen(false);
      cleanupTimeoutRef.current = window.setTimeout(() => {
        cleanupTimeoutRef.current = null;
        setRenderDetails(false);
      }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
    },
    [clearMotionTimers],
  );
  useEffect(() => () => clearMotionTimers(), [clearMotionTimers]);
  const [appPresentation, setAppPresentation] = useState<{
    phase: McpAppHostPhase;
    prefersBorder: boolean;
    isCollapsible: boolean;
  } | null>(null);
  const appIdentityKey = props.mcpApp
    ? JSON.stringify([
        props.mcpApp.threadId,
        props.mcpApp.projection.callId,
        props.mcpApp.projection.server,
        props.mcpApp.projection.app?.resourceUri ?? "",
      ])
    : "";
  const hasMcpApp = props.mcpApp !== undefined;
  const previousAppIdentityKey = useRef(appIdentityKey);
  useEffect(() => {
    if (previousAppIdentityKey.current === appIdentityKey) return;
    previousAppIdentityKey.current = appIdentityKey;
    setAppPresentation(null);
    setOpen(hasMcpApp);
  }, [appIdentityKey, hasMcpApp]);
  const mcpDetailsAvailable =
    !props.mcpToolResult ||
    props.mcpToolResult.status !== "inProgress" ||
    props.mcpToolResult.result != null ||
    props.mcpToolResult.error != null;
  const appCollapsible = props.mcpApp
    ? (appPresentation?.isCollapsible ?? true)
    : mcpDetailsAvailable;
  const disclosureOpen = props.mcpApp && !appCollapsible ? true : open;

  const chevronStyle: CSSProperties = {
    ...conversationDisclosureStyle(reducedMotion),
    transitionProperty: reducedMotion ? "none" : "opacity, transform",
  };
  const summary = props.renderSummary ? props.renderSummary(disclosureOpen) : props.children;
  const appHeaderClassName = props.mcpApp
    ? cn("w-full", disclosureOpen ? "px-4 pt-3 pb-2" : "px-4 py-3", summaryClassName)
    : summaryClassName;
  const summaryHeader = (
    <div
      className={cn(appHeaderClassName, "relative")}
      data-tool-detail-header="true"
      data-tool-detail-semantic-summary={props.semanticSummary}
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("a, area, button, input, select, textarea, [role='button']")
        ) {
          return;
        }
        if (appCollapsible) setDetailsOpen(!open);
      }}
    >
      <div
        id={summaryLabelId}
        className={cn(
          "pointer-events-none relative z-10 inline-flex min-w-0 max-w-full items-center [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_[role=button]]:pointer-events-auto",
          props.compact ? "gap-1.5" : "gap-2",
        )}
      >
        {summary}
      </div>
      <ChevronRightIcon
        aria-hidden="true"
        data-tool-detail-chevron="true"
        className={cn(
          "icon-2xs size-4 shrink-0 text-text/60 opacity-0 transition-[opacity,transform]",
          "[@media(hover:hover)]:group-hover/tool-row:opacity-100",
          "[@media(hover:hover)]:group-hover/file-row:opacity-100",
          "group-focus-within/tool-row:opacity-100 group-focus-within/file-row:opacity-100",
          !appCollapsible && "hidden",
          disclosureOpen && "rotate-90 opacity-100",
          reducedMotion && "transition-none duration-0",
        )}
        style={chevronStyle}
      />
      {appCollapsible ? (
        <button
          type="button"
          aria-controls={bodyId}
          aria-expanded={disclosureOpen}
          aria-labelledby={summaryLabelId}
          className="absolute inset-0 z-0 cursor-pointer rounded-md bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:ring-offset-0"
          data-file-change-row={props.dataFileChangeRow ? "true" : undefined}
          data-tool-detail-trigger="true"
          onClick={(event) => {
            event.stopPropagation();
            setDetailsOpen(!open);
          }}
        />
      ) : null}
    </div>
  );

  if (props.mcpApp) {
    const appResult = props.mcpApp.projection;
    const appFallback =
      appPresentation?.phase === "browser_unavailable" || appPresentation?.phase === "no_content";
    const hasAutomaticApprovalReviews = (appResult.automaticApprovalReviews?.length ?? 0) > 0;
    const appRootClassName = cn(
      "group/tool-details min-w-0",
      appPresentation?.prefersBorder &&
        "overflow-hidden rounded-lg border border-strong bg-surface [border-end-end-radius:max(0px,calc(var(--radius-lg)-1px))] [border-end-start-radius:max(0px,calc(var(--radius-lg)-1px))]",
    );
    return (
      <div className={appRootClassName} data-tool-detail-disclosure="true" data-mcp-app-card="true">
        <ToolRowTooltip content={props.tooltip} variant={props.tooltipVariant}>
          {summaryHeader}
        </ToolRowTooltip>
        <DisclosureRegion
          open={disclosureOpen}
          className="w-full min-w-0"
          contentClassName="w-full min-w-0"
        >
          <div
            id={bodyId}
            data-tool-detail-body="true"
            data-tool-details-inline="true"
            className="w-full min-w-0"
          >
            {appFallback ? (
              <div
                className={cn("min-w-0 max-w-full", props.compact ? "ml-5" : "ml-7")}
                data-mcp-app-generic-fallback="true"
              >
                <div className={cn("min-w-0 max-w-full", toolActivityBodyClassName())}>
                  <McpToolResultDetails
                    result={appResult}
                    {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
                  />
                </div>
              </div>
            ) : hasAutomaticApprovalReviews ? (
              <div className="px-4" data-mcp-app-automatic-approval-reviews="true">
                <McpAutomaticApprovalReviewContent result={appResult} />
              </div>
            ) : null}
            {!appFallback ? (
              <div className="group/mcp-tool-result-details relative w-full min-w-0">
                <McpAppCard
                  projection={appResult}
                  threadId={props.mcpApp.threadId}
                  theme={props.mcpApp.theme}
                  compact={props.compact}
                  onPresentation={(next) => {
                    props.onMcpAppPresentation?.(next);
                    setAppPresentation((current) =>
                      current?.phase === next.phase &&
                      current?.prefersBorder === next.prefersBorder &&
                      current?.isCollapsible === next.isCollapsible
                        ? current
                        : next,
                    );
                  }}
                />
                {disclosureOpen &&
                appPresentation !== null &&
                appPresentation.phase !== "idle" &&
                appPresentation.phase !== "loading" ? (
                  <McpRawDiagnosticDialog
                    result={appResult}
                    trigger={
                      <div className="absolute right-1 bottom-2 z-50">
                        <McpRawDiagnosticAction />
                      </div>
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </DisclosureRegion>
      </div>
    );
  }

  return (
    <div className="group/tool-details min-w-0" data-tool-detail-disclosure="true">
      <ToolRowTooltip content={props.tooltip} variant={props.tooltipVariant}>
        {summaryHeader}
      </ToolRowTooltip>
      {props.afterSummary}
      {renderDetails &&
      (props.details || props.mcpToolResult || props.activity || props.detailContent) ? (
        <DisclosureRegion open={motionOpen} className="min-w-0 max-w-full">
          <div
            id={bodyId}
            data-thread-find-skip={!motionOpen ? "true" : undefined}
            data-testid={props.details?.kind === "command" ? "exec-shell-body" : undefined}
            data-tool-detail-body="true"
            data-tool-details-inline="true"
            className={cn(
              "min-w-0 max-w-full",
              props.details?.kind !== "command" &&
                !props.mcpToolResult &&
                (props.compact ? "ml-5" : "ml-7"),
            )}
          >
            <div
              data-tool-detail-content="true"
              className={cn(
                "min-w-0 max-w-full",
                toolActivityBodyClassName(props.mcpToolResult ? "grouped" : "default"),
              )}
            >
              {props.detailContent ? (
                motionOpen ? (
                  props.detailContent
                ) : null
              ) : (
                <ToolCallDetailsContent
                  details={props.details}
                  mcpToolResult={props.mcpToolResult}
                  activity={props.activity}
                  timestampFormat={props.timestampFormat}
                  variant="embedded"
                  {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
                />
              )}
            </div>
          </div>
        </DisclosureRegion>
      ) : null}
    </div>
  );
}
