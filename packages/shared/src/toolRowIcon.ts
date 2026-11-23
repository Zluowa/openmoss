// FILE: toolRowIcon.ts
// Purpose: Which icon a tool row wears, decided once for the desktop and the phone: a git
//          command wears the GitHub mark on both, an image generation the zap, an MCP tool
//          the building blocks. Each side maps the answer to its own drawing of the same
//          glyph (the desktop's Central icons, the phone's copies generated from them).
// Layer: Shared pure logic (no DOM, no React, no other package imports), so the phone app
//          can import it through Metro.
// Exports: toolRowBrandIcon, toolRowIcon, commandRowIcon, computerToolNameOf,
//          toolIdentityWord, isFileReadToolWord, isSearchToolWord, ToolRowIcon,
//          ToolRowBrandIcon
// Moved from apps/web/src/components/chat/TimelineWorkEntryRow.tsx (2026-11-24); the rules
// are unchanged.

import {
  MOSS_COMPUTER_TOOL_PRESENTATIONS,
  deriveMossMcpToolTitle,
  resolveMossBrowserToolName,
} from "./mossToolPresentation";
import { resolveCommandVisualKind } from "./shellCommandShape";

export type ToolRowIcon =
  | "file"
  | "search"
  | "github"
  | "terminal"
  | "pencil"
  | "mcp"
  | "zap"
  | "eye"
  | "web-search"
  | "skill-cube"
  | "hammer"
  | "agent";

export interface ToolRowIconInput {
  /** What an approval or question asks for, when the row is one. */
  readonly requestKind?: string | null | undefined;
  /** The provider's item type, snake_case or camelCase (`command_execution`, `mcpToolCall`). */
  readonly itemType?: string | null | undefined;
  /** The command a command row ran, as shown. */
  readonly command?: string | null | undefined;
  /** The command as the provider sent it, when only that is known. */
  readonly rawCommand?: string | null | undefined;
  /** The tool's own name (`Read`, `Grep`, `read_file`). */
  readonly toolName?: string | null | undefined;
  /** The row's title, whose first word names the tool when the name is missing. */
  readonly toolTitle?: string | null | undefined;
  /** The row's label, the last place a Moss tool's identity can show up. */
  readonly label?: string | null | undefined;
}

/** Product and surface marks that win over the kind of a tool row. */
export type ToolRowBrandIcon = "computer-use" | "github" | "globe" | "moss" | "mcp";

/** The gateway's Computer tools, without the `moss_` prefix. */
export const COMPUTER_TOOL_NAMES: readonly string[] = Object.keys(
  MOSS_COMPUTER_TOOL_PRESENTATIONS,
).map((name) => name.slice("moss_".length));

/**
 * The bare Computer tool name inside whatever wrapping a provider applied
 * (`computer_click`, `mcp__moss__computer_click`), or null.
 */
export function computerToolNameOf(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const name of COMPUTER_TOOL_NAMES) {
    if (normalized === name || normalized.endsWith(`_${name}`)) return name;
  }
  return null;
}

/**
 * The mark a tool row wears before its kind is considered: the Computer glyph for the
 * Computer tools, the GitHub mark for the GitHub app's tools, the globe for Moss's browser
 * tools, the Moss mark for Moss's own tools, the MCP mark for other MCP tools. Null when
 * none applies.
 */
export function toolRowBrandIcon(input: ToolRowIconInput): ToolRowBrandIcon | null {
  if (
    computerToolNameOf(input.toolName) !== null ||
    /^Computer Use:/i.test(input.toolTitle ?? "")
  ) {
    return "computer-use";
  }
  if (input.toolName?.trim().toLowerCase().startsWith("mcp__codex_apps__github")) return "github";
  const identity = [input.toolName, input.toolTitle, input.label];
  if (resolveMossBrowserToolName(identity) !== null) return "globe";
  if (
    deriveMossMcpToolTitle({
      toolName: input.toolName,
      title: input.toolTitle,
      fallbackLabel: input.label,
    }) !== null
  ) {
    return "moss";
  }
  if (snakeItemType(input.itemType) === "mcp_tool_call") return "mcp";
  return null;
}

function snakeItemType(itemType: string | null | undefined): string {
  return (itemType ?? "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** The tool's name reduced to letters, or the first word of its title. */
export function toolIdentityWord(input: ToolRowIconInput): string {
  if (input.toolName) {
    return input.toolName.toLowerCase().replace(/[^a-z]/g, "");
  }
  // A derived "Searched the web" label still describes a real web search.
  if (snakeItemType(input.itemType) === "web_search") return "";
  const firstWord = input.toolTitle?.trim().split(/\s+/, 1)[0] ?? "";
  return firstWord.toLowerCase().replace(/[^a-z]/g, "");
}

// Provider read tools (Claude's `Read`, Grok/ACP `read_file`/`view`) arrive as generic
// dynamic tool calls without a `file-read` requestKind, so match their tool name to surface
// the file icon instead of the generic tool fallback. The desktop's collapsed group summary
// shares the same read-name set (apps/web toolCallGroup.logic.ts READ_TOOL_NAMES).
const FILE_READ_TOOL_WORDS: ReadonlySet<string> = new Set([
  "read",
  "reading",
  "readfile",
  "readfiles",
  "readtextfile",
  "view",
  "viewfile",
  "viewtextfile",
  "hashlineread",
]);

// Provider search tools (Claude's `Grep`/`Glob`, Grok/ACP `search`/`find`) wear the
// magnifier like search commands do. Keep in sync with SEARCH_TOOL_NAMES in the desktop's
// toolCallGroup.logic.ts.
const SEARCH_TOOL_WORDS: ReadonlySet<string> = new Set([
  "grep",
  "glob",
  "search",
  "searching",
  "searched",
  "find",
  "finding",
  "found",
  "findfiles",
  "searchfiles",
  "searchtool",
  "hashlinegrep",
]);

export function isFileReadToolWord(input: ToolRowIconInput): boolean {
  return FILE_READ_TOOL_WORDS.has(toolIdentityWord(input));
}

export function isSearchToolWord(input: ToolRowIconInput): boolean {
  return SEARCH_TOOL_WORDS.has(toolIdentityWord(input));
}

/**
 * A command row: reads wear the file glyph, searches the magnifier, git and gh commands
 * (also inside shell wrappers) the GitHub mark, and other commands the terminal. Structured
 * read/search actions carry no command string; their tool name picks the icon instead.
 */
export function commandRowIcon(input: ToolRowIconInput): ToolRowIcon {
  const command = input.command ?? input.rawCommand;
  if (!command) {
    if (isFileReadToolWord(input)) return "file";
    if (isSearchToolWord(input)) return "search";
    return "terminal";
  }
  switch (resolveCommandVisualKind(command)) {
    case "read":
      return "file";
    case "search":
      return "search";
    case "git":
    case "github":
      return "github";
    case "terminal":
      return "terminal";
  }
}

/**
 * The icon of a tool row, or null when the row is not a tool call (the caller then uses
 * its own icon for notices, thinking and the like).
 */
export function toolRowIcon(input: ToolRowIconInput): ToolRowIcon | null {
  if (input.requestKind === "command") return commandRowIcon(input);
  if (input.requestKind === "file-read") return "file";
  if (input.requestKind === "file-change") return "pencil";
  if (input.requestKind === "tool") return "mcp";

  const itemType = snakeItemType(input.itemType);
  if (itemType === "command_execution" || input.command) return commandRowIcon(input);
  if (itemType === "file_change") return "pencil";
  if (itemType === "image_generation") return "zap";
  if (itemType === "image_view") return "eye";
  // Read/search names outrank the generic buckets: Pi maps its native `grep`/`find` to
  // web_search, and ACP read/execute kinds land on dynamic_tool_call; the icon follows what
  // the tool actually is.
  if (isFileReadToolWord(input)) return "file";
  if (isSearchToolWord(input)) return "search";
  if (itemType === "web_search") return "web-search";

  switch (itemType) {
    case "mcp_tool_call":
      return "skill-cube";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "agent";
  }
  return null;
}
