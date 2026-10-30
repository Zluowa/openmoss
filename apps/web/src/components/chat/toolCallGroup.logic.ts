// FILE: toolCallGroup.logic.ts
// Purpose: Summarizes a settled run of tool-call work entries into one compact
//          verb label ("Read 2 files, ran 3 commands") plus a failed count for
//          the collapsed tool-group disclosure in the transcript.
// Layer: Web chat presentation helpers
// Exports: MIN_COLLAPSIBLE_TOOL_GROUP_SIZE, workEntryRowCount,
//          multiFileEditLabel, ToolCallSummaryCategory,
//          ToolCallGroupSummary, isSummarizableToolCallEntry,
//          classifyToolCallSummaryCategory, summarizeToolCallGroup

import { isFileChangeWorkLogEntry, type WorkLogEntry } from "../../session-logic";
import type { TranslationKey } from "../../localization";
import { extractToolArgumentField } from "../../lib/toolArgumentSummary";
import {
  deriveCommandReadTargets,
  deriveReadableCommandDisplay,
  extractWebFetchUrl,
  resolveCommandVisualKind,
} from "../../lib/toolCallLabel";
import { isReasoningUpdateWorkEntry } from "./agentActivity.logic";

// A single tool row collapses into nothing useful; only runs of 2+ rows fold.
export const MIN_COLLAPSIBLE_TOOL_GROUP_SIZE = 2;

// Rows an entry occupies when listed: a file-change call renders one
// "Edited <file>" row per changed file, so one patch can be a whole column.
// Fold thresholds count these rows, not calls.
export function workEntryRowCount(entry: WorkLogEntry): number {
  return isFileChangeWorkLogEntry(entry) ? Math.max(1, entry.changedFiles?.length ?? 0) : 1;
}

// One-line label for a call that would list several edited-file rows.
export function multiFileEditLabel(entry: WorkLogEntry): string | null {
  const rowCount = workEntryRowCount(entry);
  return rowCount > 1 ? summaryPartPhrase({ category: "edit", count: rowCount }, true) : null;
}

export type ToolCallSummaryCategory =
  | "read"
  | "edit"
  | "search"
  | "command"
  | "fetch"
  | "agent"
  | "tool"
  | "other";

export interface ToolCallGroupSummaryPart {
  category: ToolCallSummaryCategory;
  count: number;
  // File search stays "Searched"; only a web-search bucket uses Codex's
  // "Searched the web" segment (localConversation.agentActivity.summary.webSearch).
  webSearch?: boolean;
}

export interface ToolCallGroupSummary {
  // Verb summary in the order the work happened: "Read 2 files, ran 3 commands".
  label: string;
  parts: ReadonlyArray<ToolCallGroupSummaryPart>;
  // Calls that failed; the row appends `failedLabel` in the error tone.
  failedCount: number;
  failedLabel: string | null;
  entryCount: number;
  // A group with in-flight work must never present itself as settled.
  hasRunningEntry: boolean;
  // The one kind every summarized call shares, or "mixed": the collapsed row
  // wears that kind's glyph instead of borrowing an arbitrary entry's.
  iconCategory: ToolCallSummaryCategory | "mixed";
  // First summarized entry, for kinds whose glyph is per entry (MCP servers,
  // fetched sites).
  iconEntry: WorkLogEntry;
}

type ToolCallGroupTranslationFormat = (
  key: TranslationKey,
  values: Record<string, string | number>,
) => string;

function summaryPartTranslationKey(
  category: ToolCallSummaryCategory,
  count: number,
  isSolePart: boolean,
): TranslationKey {
  const plural = count === 1 ? "one" : "many";
  switch (category) {
    case "command":
      return `chat.toolGroup.command.${plural}`;
    case "edit":
      return `chat.toolGroup.edit.${plural}`;
    case "read":
      return `chat.toolGroup.read.${plural}`;
    case "search":
      return `chat.toolGroup.search.${plural}`;
    case "fetch":
      return `chat.toolGroup.fetch.${plural}`;
    case "agent":
      return `chat.toolGroup.agent.${plural}`;
    case "tool":
      return `chat.toolGroup.tool.${plural}`;
    case "other":
      return isSolePart
        ? `chat.toolGroup.other.sole.${plural}`
        : `chat.toolGroup.other.part.${plural}`;
  }
}

/**
 * Localize the collapsed tool-group sentence at render time. The summary stays
 * semantic (category + count) so a locale switch updates existing transcripts
 * without re-deriving their work-log entries.
 */
export function formatToolCallGroupSummary(
  summary: Pick<ToolCallGroupSummary, "parts">,
  format: ToolCallGroupTranslationFormat,
): string {
  return summary.parts
    .map((part) =>
      part.category === "search" && part.webSearch
        ? format("chat.toolGroup.search.web", {})
        : format(summaryPartTranslationKey(part.category, part.count, summary.parts.length === 1), {
            count: part.count,
          }),
    )
    .join(format("chat.toolGroup.separator", {}));
}

// Rich rows (subagent strips, automation cards, thread-creation recaps,
// background tasks) and non-tool tones (errors, approvals, info) must stay
// individually visible, so they never fold into a summary group.
export function isSummarizableToolCallEntry(entry: WorkLogEntry): boolean {
  return (
    (entry.tone === "tool" ||
      (entry.tone === "error" &&
        entry.toolStatus === "failed" &&
        entry.activityKind?.startsWith("tool.") === true)) &&
    !(entry.toolCallId && isReasoningUpdateWorkEntry(entry)) &&
    !entry.mossThreadCreation &&
    !entry.automation &&
    !entry.subagentAction &&
    !entry.subagentRun &&
    !entry.backgroundTask &&
    (entry.subagents?.length ?? 0) === 0 &&
    entry.codexNotice === undefined &&
    entry.itemType !== "image_generation"
  );
}

const READ_VERBS = new Set(["Read", "Reading"]);
const SEARCH_VERBS = new Set(["Searched", "Searching", "Found", "Finding"]);
// Provider tools that only read or search, named the way Claude and ACP agents
// report them (`Read`, `Grep`, `Glob`, `WebSearch`).
const READ_TOOL_NAMES = new Set(["read", "readfile", "viewfile"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "glob", "websearch", "findfiles", "searchfiles"]);

function normalizedToolName(entry: WorkLogEntry): string {
  return (entry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function isWebSearchEntry(entry: WorkLogEntry): boolean {
  return entry.itemType === "web_search" || normalizedToolName(entry) === "websearch";
}

function classifyCommandVerb(verb: string): ToolCallSummaryCategory {
  if (READ_VERBS.has(verb)) return "read";
  if (SEARCH_VERBS.has(verb)) return "search";
  return "command";
}

export function classifyToolCallSummaryCategory(entry: WorkLogEntry): ToolCallSummaryCategory {
  if (isFileChangeWorkLogEntry(entry)) {
    return "edit";
  }
  const toolName = normalizedToolName(entry);
  if (entry.requestKind === "file-read" || READ_TOOL_NAMES.has(toolName)) {
    return "read";
  }
  if (entry.itemType === "web_search" || SEARCH_TOOL_NAMES.has(toolName)) {
    return "search";
  }
  if (extractWebFetchUrl(entry)) {
    return "fetch";
  }
  if (entry.requestKind === "tool") {
    return "tool";
  }
  const command = entry.command ?? entry.rawCommand;
  if (entry.itemType === "command_execution" || entry.requestKind === "command" || command) {
    if (command) {
      const kind = resolveCommandVisualKind(command);
      return kind === "read" ? "read" : kind === "search" ? "search" : "command";
    }
    // Structured command actions (e.g. Codex read/search) carry the verb as the
    // derived tool title without any shell command string.
    const titleVerb = entry.toolTitle?.trim().split(/\s+/, 1)[0] ?? "";
    return classifyCommandVerb(titleVerb);
  }
  if (entry.itemType === "collab_agent_tool_call") {
    return "agent";
  }
  if (entry.itemType === "mcp_tool_call" || entry.itemType === "dynamic_tool_call") {
    return "tool";
  }
  if (entry.toolName) {
    return "tool";
  }
  return "other";
}

// Distinct-file identity for an edit/read entry. Entries with no file info
// count as one unit each so the total never under-reports work.
function entryFileKeys(entry: WorkLogEntry): ReadonlyArray<string> {
  if (entry.changedFiles && entry.changedFiles.length > 0) {
    return entry.changedFiles;
  }
  const detailFiles = entry.toolDetails?.files;
  if (detailFiles && detailFiles.length > 0) {
    return detailFiles;
  }
  const command = entry.command ?? entry.rawCommand;
  if (command) {
    const readTargets = deriveCommandReadTargets(command);
    if (readTargets) {
      return readTargets;
    }
    const target = deriveReadableCommandDisplay(command).target.trim();
    if (target.length > 0) {
      return [target];
    }
  }
  const argumentPath = entry.detail
    ? extractToolArgumentField(entry.detail, ["file_path", "filePath", "path"], {
        fallbackScan: "whenUnparsed",
      })
    : null;
  if (argumentPath) {
    return [argumentPath];
  }
  if (entry.preview?.trim()) {
    return [entry.preview.trim()];
  }
  return [];
}

// Collapsed summaries (joined by Intl.ListFormat type "unit") name the kind, not
// the count. The first segment uses the leading (capitalized) string; later
// segments use the following form.
function summaryPartPhrase(part: ToolCallGroupSummaryPart, leading: boolean): string {
  const one = part.count === 1;
  switch (part.category) {
    case "read":
      return leading ? "Read files" : "read files";
    case "edit":
      return leading
        ? one
          ? "Edited a file"
          : "Edited files"
        : one
          ? "edited a file"
          : "edited files";
    case "search":
      if (part.webSearch) {
        return leading ? "Searched the web" : "searched the web";
      }
      return leading ? "Searched" : "searched";
    case "command":
      return leading
        ? one
          ? "Ran a command"
          : "Ran commands"
        : one
          ? "ran a command"
          : "ran commands";
    case "fetch":
      return leading
        ? one
          ? "Fetched a page"
          : "Fetched pages"
        : one
          ? "fetched a page"
          : "fetched pages";
    case "agent":
    case "tool":
    case "other":
      return leading
        ? one
          ? "Called a tool"
          : "Called tools"
        : one
          ? "called a tool"
          : "called tools";
  }
}

function joinSummaryParts(parts: ReadonlyArray<ToolCallGroupSummaryPart>): string {
  const phrases = parts.map((part, index) => summaryPartPhrase(part, index === 0));
  return new Intl.ListFormat("en", { type: "unit", style: "long" }).format(phrases);
}

export function summarizeToolCallGroup(
  entries: ReadonlyArray<WorkLogEntry>,
): ToolCallGroupSummary | null {
  const summarizable = entries.filter(isSummarizableToolCallEntry);
  const rowCount = summarizable.reduce((total, entry) => total + workEntryRowCount(entry), 0);
  if (rowCount < MIN_COLLAPSIBLE_TOOL_GROUP_SIZE) {
    return null;
  }

  // Map insertion order is first appearance, so parts read in the order the
  // agent did the work.
  const countByCategory = new Map<ToolCallSummaryCategory, number>();
  const webSearchCountByCategory = new Map<ToolCallSummaryCategory, number>();
  const distinctFilesByCategory = new Map<ToolCallSummaryCategory, Set<string>>();
  let hasRunningEntry = false;
  let failedCount = 0;

  for (const entry of summarizable) {
    if (entry.toolStatus === "running") {
      hasRunningEntry = true;
    }
    if (entry.toolStatus === "failed") {
      failedCount += 1;
    }
    const category = classifyToolCallSummaryCategory(entry);
    const count = countByCategory.get(category) ?? 0;
    if (category === "edit" || category === "read") {
      const fileKeys = entryFileKeys(entry);
      if (fileKeys.length === 0) {
        countByCategory.set(category, count + 1);
        continue;
      }
      countByCategory.set(category, count);
      const distinctFiles =
        distinctFilesByCategory.get(category) ??
        distinctFilesByCategory.set(category, new Set()).get(category)!;
      for (const fileKey of fileKeys) {
        distinctFiles.add(fileKey);
      }
      continue;
    }
    countByCategory.set(category, count + 1);
    if (category === "search" && isWebSearchEntry(entry)) {
      webSearchCountByCategory.set(category, (webSearchCountByCategory.get(category) ?? 0) + 1);
    }
  }

  for (const [category, distinctFiles] of distinctFilesByCategory) {
    countByCategory.set(category, (countByCategory.get(category) ?? 0) + distinctFiles.size);
  }

  // "Other" calls always trail the named kinds.
  const parts = [...countByCategory.entries()]
    .filter(([, count]) => count > 0)
    .toSorted(([left], [right]) => Number(left === "other") - Number(right === "other"))
    .map(([category, count]) => ({
      category,
      count,
      ...(category === "search" && (webSearchCountByCategory.get(category) ?? 0) === count
        ? { webSearch: true }
        : {}),
    }));

  return {
    label: joinSummaryParts(parts),
    parts,
    failedCount,
    failedLabel: failedCount > 0 ? `${failedCount} failed` : null,
    entryCount: summarizable.length,
    hasRunningEntry,
    iconCategory: parts.length === 1 ? parts[0]!.category : "mixed",
    iconEntry: summarizable[0]!,
  };
}
