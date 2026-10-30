// FILE: threadSummaryPanelModel.ts
// Purpose: Derives stable rows for the Codex-style thread summary card.
// Layer: Pure chat presentation model

export interface ThreadSummaryArtifact {
  target: string;
  label: string;
  kind: "file" | "external";
}

export type ThreadSummarySourceKind = "file" | "image" | "external" | "tool" | "web";

export interface ThreadSummarySource {
  id: string;
  label: string;
  kind: ThreadSummarySourceKind;
  target?: string;
  previewUrl?: string;
}

export interface ThreadSummarySubagent {
  id: string;
  label: string;
  active: boolean;
  statusLabel: string;
}

export interface ThreadSummaryProcess {
  id: string;
  label: string;
  active: boolean;
}

export interface ThreadSummarySubagentPreview {
  preview: ReadonlyArray<ThreadSummarySubagent>;
  workingCount: number;
  doneCount: number;
}

interface DiffSummaryInput {
  completedAt: string;
  files: ReadonlyArray<{ path: string }>;
}

interface AssistantMessageInput {
  createdAt: string;
  text: string;
}

interface SourceAttachmentInput {
  id: string;
  type: "image" | "file" | "assistant-selection";
  name?: string;
  previewUrl?: string;
}

interface SourceMessageInput {
  role: "user" | "assistant" | "system";
  createdAt: string;
  text: string;
  attachments?: ReadonlyArray<SourceAttachmentInput>;
  mentions?: ReadonlyArray<{ name: string; path: string }>;
}

interface SourceWorkLogInput {
  id: string;
  createdAt: string;
  label: string;
  toolName?: string;
  toolTitle?: string;
  itemType?: string;
}

const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_SOURCE_LINK_PATTERN = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const BARE_SOURCE_URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

function artifactLabel(target: string, kind: ThreadSummaryArtifact["kind"]): string {
  if (kind === "external") {
    try {
      const url = new URL(target);
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      return `${url.host}${path}`;
    } catch {
      return target;
    }
  }
  const normalized = target.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || normalized;
}

function normalizeArtifactTarget(rawTarget: string): ThreadSummaryArtifact | null {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#") || target.startsWith("mailto:")) return null;
  const kind = /^(?:https?:\/\/|app:\/\/)/i.test(target) ? "external" : "file";
  return { target, label: artifactLabel(target, kind), kind };
}

function assistantLinkedArtifacts(text: string): ThreadSummaryArtifact[] {
  const artifacts: ThreadSummaryArtifact[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const artifact = normalizeArtifactTarget(match[1] ?? "");
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

function sourceUrlLabel(target: string): string {
  try {
    const url = new URL(target);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.host.replace(/^www\./, "")}${path}`;
  } catch {
    return target;
  }
}

function normalizeSourceUrl(
  rawTarget: string,
  preferredLabel?: string,
): ThreadSummarySource | null {
  const target = rawTarget.trim().replace(/[.,;!?]+$/, "");
  try {
    const url = new URL(target);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    const normalizedTarget = url.href;
    return {
      id: `external:${normalizedTarget}`,
      label: preferredLabel?.trim() || sourceUrlLabel(normalizedTarget),
      kind: "external",
      target: normalizedTarget,
    };
  } catch {
    return null;
  }
}

function messageExternalSources(text: string): ThreadSummarySource[] {
  const sources: ThreadSummarySource[] = [];
  const markdownTargets = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_SOURCE_LINK_PATTERN)) {
    const source = normalizeSourceUrl(match[2] ?? "", match[1]);
    if (!source) continue;
    markdownTargets.add(source.target ?? "");
    sources.push(source);
  }
  for (const match of text.matchAll(BARE_SOURCE_URL_PATTERN)) {
    const source = normalizeSourceUrl(match[0]);
    if (source && !markdownTargets.has(source.target ?? "")) sources.push(source);
  }
  return sources;
}

function newestFirstWorkLogEntries(
  entries: ReadonlyArray<SourceWorkLogInput>,
): ReadonlyArray<SourceWorkLogInput> {
  let isChronological = true;
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.createdAt.localeCompare(entries[index]!.createdAt) > 0) {
      isChronological = false;
      break;
    }
  }
  if (!isChronological) {
    return [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  // Reverse timestamp runs, not individual entries, so the fast path preserves
  // stable-sort behavior when several activities share the same timestamp.
  const newestFirst: SourceWorkLogInput[] = [];
  let end = entries.length;
  while (end > 0) {
    const timestamp = entries[end - 1]!.createdAt;
    let start = end - 1;
    while (start > 0 && entries[start - 1]!.createdAt === timestamp) {
      start -= 1;
    }
    for (let index = start; index < end; index += 1) {
      newestFirst.push(entries[index]!);
    }
    end = start;
  }
  return newestFirst;
}

/**
 * Conversation-source grouping: newest user-provided
 * files first, then external resources, MCP/tool providers, and web search.
 */
export function collectThreadSummarySources(input: {
  messages: ReadonlyArray<SourceMessageInput>;
  workLogEntries: ReadonlyArray<SourceWorkLogInput>;
}): ThreadSummarySource[] {
  const fileSources: ThreadSummarySource[] = [];
  const externalSources: ThreadSummarySource[] = [];
  const toolSources: ThreadSummarySource[] = [];
  const seen = new Set<string>();
  const append = (target: ThreadSummarySource[], source: ThreadSummarySource) => {
    if (seen.has(source.id)) return;
    seen.add(source.id);
    target.push(source);
  };

  const messages = [...input.messages]
    .filter((message) => message.role === "user")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const label = attachment.name?.trim() || (attachment.type === "image" ? "图片" : "对话选段");
      append(fileSources, {
        id: `attachment:${attachment.id}`,
        label,
        kind: attachment.type === "image" ? "image" : "file",
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
      });
    }
    for (const mention of message.mentions ?? []) {
      const target = mention.path.trim();
      if (!target) continue;
      append(fileSources, {
        id: `file:${target}`,
        label: mention.name.trim() || artifactLabel(target, "file"),
        kind: "file",
        target,
      });
    }
    for (const source of messageExternalSources(message.text)) {
      append(externalSources, source);
    }
  }

  let hasWebSearch = false;
  for (const entry of newestFirstWorkLogEntries(input.workLogEntries)) {
    if (entry.itemType === "web_search") {
      hasWebSearch = true;
      continue;
    }
    if (entry.itemType !== "mcp_tool_call" && entry.itemType !== "dynamic_tool_call") continue;
    const identity = entry.toolName?.trim() || entry.toolTitle?.trim() || entry.label.trim();
    if (!identity || identity === "node_repl") continue;
    append(toolSources, {
      id: `tool:${identity.toLowerCase()}`,
      label: entry.toolTitle?.trim() || entry.toolName?.trim() || entry.label,
      kind: "tool",
    });
  }

  const webSources: ThreadSummarySource[] = hasWebSearch
    ? [{ id: "web-search", label: "网页搜索", kind: "web" }]
    : [];
  return [...fileSources, ...externalSources, ...toolSources, ...webSources];
}

export function collectThreadSummaryArtifacts(input: {
  diffSummaries: ReadonlyArray<DiffSummaryInput>;
  assistantMessages: ReadonlyArray<AssistantMessageInput>;
}): ThreadSummaryArtifact[] {
  const artifacts: ThreadSummaryArtifact[] = [];
  const seen = new Set<string>();
  const append = (artifact: ThreadSummaryArtifact | null) => {
    if (!artifact || seen.has(artifact.target)) return;
    seen.add(artifact.target);
    artifacts.push(artifact);
  };

  for (const message of [...input.assistantMessages].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )) {
    for (const artifact of assistantLinkedArtifacts(message.text)) append(artifact);
  }

  for (const summary of [...input.diffSummaries].sort((a, b) =>
    b.completedAt.localeCompare(a.completedAt),
  )) {
    for (const file of summary.files) append(normalizeArtifactTarget(file.path));
  }

  return artifacts;
}

interface WorkLogSubagentInput {
  threadId?: string | undefined;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  title?: string | undefined;
  statusLabel?: string | undefined;
  isActive?: boolean | undefined;
}

export function collectThreadSummarySubagents(
  entries: ReadonlyArray<{ subagents?: ReadonlyArray<WorkLogSubagentInput> | undefined }>,
): ThreadSummarySubagent[] {
  const byId = new Map<string, ThreadSummarySubagent>();
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      const id =
        subagent.threadId ??
        subagent.agentId ??
        subagent.nickname ??
        subagent.role ??
        subagent.title;
      if (!id) continue;
      const active = subagent.isActive !== false;
      byId.set(id, {
        id,
        label: subagent.nickname ?? subagent.role ?? subagent.title ?? "Agent",
        active,
        statusLabel: subagent.statusLabel ?? (active ? "Working" : "Done"),
      });
    }
  }
  return [...byId.values()];
}

/**
 * Codex's compact subagent overview previews working agents first and caps the
 * avatar strip at four. Completed agents become the preview only once no agent
 * is still working.
 */
export function selectThreadSummarySubagentPreview(
  subagents: ReadonlyArray<ThreadSummarySubagent>,
): ThreadSummarySubagentPreview {
  const working = subagents.filter((subagent) => subagent.active);
  const done = subagents.filter((subagent) => !subagent.active);
  return {
    preview: (working.length > 0 ? working : done).slice(0, 4),
    workingCount: working.length,
    doneCount: done.length,
  };
}

export function collectThreadSummaryProcesses(input: {
  terminalIds: ReadonlyArray<string>;
  runningTerminalIds: ReadonlyArray<string>;
  terminalLabelsById: Readonly<Record<string, string | undefined>>;
}): ThreadSummaryProcess[] {
  const running = new Set(input.runningTerminalIds);
  return input.terminalIds
    .filter((terminalId) => running.has(terminalId))
    .map((terminalId) => ({
      id: terminalId,
      label: input.terminalLabelsById[terminalId] || "Terminal",
      active: true,
    }));
}
