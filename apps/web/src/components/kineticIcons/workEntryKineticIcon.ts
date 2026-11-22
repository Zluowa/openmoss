// FILE: workEntryKineticIcon.ts
// Purpose: Maps transcript work entries and tool-group summaries to Moss Kinetic Icons while preserving excluded status/brand glyphs.
// Layer: Web chat presentation helper
// Exports: resolveWorkEntryKineticIcon, resolveToolGroupSummaryKineticIcon

import type { ToolCallGroupSummary } from "~/components/chat/toolCallGroup.logic";
import {
  ArrowUpCircleIcon,
  BackgroundTrayIcon,
  BookIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleQuestionIcon,
  ClockIcon,
  CloudSyncIcon,
  CloudUploadIcon,
  CompassLineIcon,
  ComputerUseIcon,
  ContextCompactionIcon,
  CreatePullRequestIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileEditIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FoldersIcon,
  GitBranchIcon,
  GitForkIcon,
  GitHubIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HammerIcon,
  HandoffIcon,
  HistoryIcon,
  ImageIcon,
  ImagesIcon,
  type LucideIcon,
  McpIcon,
  MessageCircleIcon,
  MossbotIcon,
  PencilIcon,
  PluginIcon,
  PushIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  WorkDetailsIcon,
  WorkingIcon,
  ZapIcon,
} from "~/lib/icons";
import type { WorkLogEntry } from "~/workLog";
import type { MossKineticIconId } from "./kineticIconDefinitions";

const EXCLUDED_ICONS: ReadonlySet<LucideIcon> = new Set([
  GitHubIcon,
  CircleAlertIcon,
  CheckIcon,
  CircleQuestionIcon,
  ArrowUpCircleIcon,
  ContextCompactionIcon,
  BackgroundTrayIcon,
  HandoffIcon,
  HistoryIcon,
]);

const DIRECT_ICON_MAP: ReadonlyMap<LucideIcon, MossKineticIconId> = new Map([
  [FileIcon, "reading"],
  [BookOpenIcon, "book"],
  [BookIcon, "book"],
  [WorkDetailsIcon, "book"],
  [TerminalIcon, "terminal"],
  [SearchIcon, "search"],
  [PencilIcon, "editing"],
  [FileEditIcon, "editing"],
  [BrainIcon, "thinking"],
  [BotIcon, "mossbot"],
  [MossbotIcon, "mossbot"],
  [SkillCubeIcon, "skills"],
  [HammerIcon, "skills"],
  [WorkingIcon, "skills"],
  [PluginIcon, "plugins"],
  [McpIcon, "plugins"],
  [GitBranchIcon, "branch"],
  [GitForkIcon, "branch"],
  [GitPullRequestIcon, "pull-request"],
  [CreatePullRequestIcon, "pull-request"],
  [GlobeIcon, "browser"],
  [WebSearchIcon, "browser"],
  [ClockIcon, "automations"],
  [FolderIcon, "library"],
  [FolderOpenIcon, "library"],
  [FoldersIcon, "library"],
  [ImageIcon, "images"],
  [ImagesIcon, "images"],
  [CloudSyncIcon, "cloud-sync"],
  [CloudUploadIcon, "cloud-sync"],
  [PushIcon, "cloud-sync"],
  [ComputerUseIcon, "computer"],
  [EyeIcon, "vision-scan"],
  [CompassLineIcon, "navigate"],
  [ExternalLinkIcon, "navigate"],
  [MessageCircleIcon, "navigate"],
]);

const DEEP_RESEARCH_PATTERN = /deep[_-]?research|^research$/i;
const PLUGIN_PATTERN = /plugin/i;
const BRANCH_PATTERN = /branch|worktree/i;
const PULL_REQUEST_PATTERN = /pull[_-]?request|\bpr\b/i;
const AUTOMATION_PATTERN = /automation|schedule|cron/i;
const CLOUD_SYNC_PATTERN = /cloud[_-]?sync|sync/i;
const NAVIGATE_PATTERN = /navigate|open_url|route/i;
const LIBRARY_PATTERN = /library|list_dir|list_files|workspace/i;

function normalizedToolSignal(workEntry: WorkLogEntry): string {
  return `${workEntry.toolName ?? ""} ${workEntry.toolTitle ?? ""}`.trim();
}

export function resolveWorkEntryKineticIcon(
  workEntry: WorkLogEntry,
  leftIcon: LucideIcon,
): MossKineticIconId | null {
  if (EXCLUDED_ICONS.has(leftIcon)) {
    return null;
  }

  // Only swap known outline icons (plus image-generation ZapIcon) so brand wrappers like MossToolIcon stay intact.
  const isImageGenerationZap = leftIcon === ZapIcon && workEntry.itemType === "image_generation";
  const directId = DIRECT_ICON_MAP.get(leftIcon);
  if (!directId && !isImageGenerationZap) {
    return null;
  }

  const toolName = workEntry.toolName?.trim() ?? "";
  if (DEEP_RESEARCH_PATTERN.test(toolName)) {
    return "deep-research";
  }
  if (workEntry.itemType === "image_generation") {
    return "images";
  }
  if (workEntry.itemType === "image_view") {
    return "vision-scan";
  }

  const signal = normalizedToolSignal(workEntry);
  if (PLUGIN_PATTERN.test(signal)) {
    return "plugins";
  }
  if (BRANCH_PATTERN.test(signal)) {
    return "branch";
  }
  if (PULL_REQUEST_PATTERN.test(signal)) {
    return "pull-request";
  }
  if (AUTOMATION_PATTERN.test(signal)) {
    return "automations";
  }
  if (CLOUD_SYNC_PATTERN.test(signal)) {
    return "cloud-sync";
  }
  if (NAVIGATE_PATTERN.test(toolName)) {
    return "navigate";
  }
  if (LIBRARY_PATTERN.test(toolName)) {
    return "library";
  }

  return directId ?? "images";
}

export function resolveToolGroupSummaryKineticIcon(
  summary: ToolCallGroupSummary,
  icon: LucideIcon,
): MossKineticIconId | null {
  if (EXCLUDED_ICONS.has(icon)) {
    return null;
  }

  switch (summary.iconCategory) {
    case "read":
      return "reading";
    case "search":
      return "search";
    case "command":
      return "terminal";
    case "edit":
      return "editing";
    case "agent":
      return "mossbot";
    case "message":
      return "navigate";
    case "fetch":
      return "browser";
    case "mixed":
      return "skills";
    case "tool":
    case "other":
      return resolveWorkEntryKineticIcon(summary.iconEntry, icon);
  }
}
