// FILE: chatThreads.ts
// Purpose: Shared chat-thread title helpers used by web and server flows.
// Layer: Shared util
// Exports: generic title checks plus fallback/generated title sanitizers

export const GENERIC_CHAT_THREAD_TITLE = "New thread";
const MAX_CHAT_THREAD_TITLE_LENGTH = 60;
export const THREAD_TITLE_CONTEXT_MAX_CHARS = 8_000;
export const THREAD_TITLE_CONTEXT_MAX_MESSAGES = 12;
const THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS = 1_200;
const GENERIC_GENERATED_THREAD_TITLES = new Set([
  "chat",
  "conversation",
  "new chat",
  "new conversation",
  "new session",
  GENERIC_CHAT_THREAD_TITLE.toLowerCase(),
  "session",
  "thread",
  "untitled",
]);
// Single source for the title word cap. Exported so the server-side title prompt
// (textGenerationShared.buildThreadTitlePrompt) derives its wording and fallback
// limits from the same number the sanitizers enforce here.
export const MAX_CHAT_THREAD_TITLE_WORDS = 6;

export const CODEX_CHAT_THREAD_TITLE_KINDS = [
  "功能",
  "设计",
  "修复",
  "优化",
  "发布",
  "探索",
  "文档",
  "研究",
] as const;

export type CodexChatThreadTitleKind = (typeof CODEX_CHAT_THREAD_TITLE_KINDS)[number];

const CODEX_CHAT_THREAD_TITLE_PATTERN =
  /^(\d{4})｜(功能|设计|修复|优化|发布|探索|文档|研究)｜(.+)$/;

function normalizeTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimTitleToken(token: string): string {
  return token.replace(/^[\s"'`([{]+|[\s"'`)\]}:;,.!?]+$/g, "");
}

function titleWords(value: string): string[] {
  return normalizeTitleWhitespace(value)
    .split(" ")
    .map(trimTitleToken)
    .filter((token) => token.length > 0);
}

function removeReasoningWrappers(value: string): string {
  const withoutClosedWrappers = value.replace(
    /<(?:analysis|reasoning|think)>[\s\S]*?<\/(?:analysis|reasoning|think)>/gi,
    "",
  );
  return withoutClosedWrappers.replace(/<(?:analysis|reasoning|think)>[\s\S]*$/gi, "");
}

function firstGeneratedTitleLine(value: string): string {
  const lines = removeReasoningWrappers(value)
    .split(/\r?\n/)
    .map((line) => line.trim());
  return lines.find((line) => line.length > 0 && !/^```/.test(line)) ?? "";
}

function truncateConversationMessage(value: string): string {
  const normalized = normalizeTitleWhitespace(value);
  if (normalized.length <= THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS) {
    return normalized;
  }
  const headLength = Math.floor((THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS - 3) * 0.6);
  const tailLength = THREAD_TITLE_CONTEXT_MESSAGE_MAX_CHARS - headLength - 3;
  return `${normalized.slice(0, headLength)}...${normalized.slice(-tailLength)}`;
}

type ThreadTitleConversationAttachment =
  | {
      readonly type: "image" | "file";
      readonly name: string;
    }
  | {
      readonly type: "assistant-selection";
      readonly text: string;
    };

function formatConversationAttachment(attachment: ThreadTitleConversationAttachment): string {
  if (attachment.type === "assistant-selection") {
    const selection = normalizeTitleWhitespace(attachment.text);
    return selection.length > 0 ? `[assistant selection: ${selection}]` : "[assistant selection]";
  }
  const name = normalizeTitleWhitespace(attachment.name);
  return name.length > 0 ? `[${attachment.type}: ${name}]` : `[${attachment.type}]`;
}

function threadTitleConversationMessageText(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ThreadTitleConversationAttachment> | undefined;
}): string {
  return [
    normalizeTitleWhitespace(message.text),
    ...(message.attachments ?? []).map(formatConversationAttachment),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export function buildThreadTitleConversationContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ThreadTitleConversationAttachment> | undefined;
    readonly streaming?: boolean | undefined;
  }>,
): string | null {
  const eligible = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.streaming !== true &&
      threadTitleConversationMessageText(message).length > 0,
  );
  const latestUserIndex = eligible.findLastIndex((message) => message.role === "user");
  if (latestUserIndex < 0) {
    return null;
  }
  const tail = eligible.slice(-(THREAD_TITLE_CONTEXT_MAX_MESSAGES - 1));
  const candidates = tail.some((message) => message.role === "user")
    ? eligible.slice(-THREAD_TITLE_CONTEXT_MAX_MESSAGES)
    : [eligible[latestUserIndex]!, ...tail];

  const candidateLines = candidates.map(
    (message) =>
      `${message.role === "user" ? "User" : "Assistant"}: ${truncateConversationMessage(threadTitleConversationMessageText(message))}`,
  );
  const requiredUserIndex = candidates.findLastIndex((message) => message.role === "user");
  const selectedIndexes = new Set([requiredUserIndex]);
  let contextLength = candidateLines[requiredUserIndex]!.length;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (index === requiredUserIndex) continue;
    const line = candidateLines[index]!;
    const nextLength = contextLength + line.length + 1;
    if (nextLength > THREAD_TITLE_CONTEXT_MAX_CHARS) {
      continue;
    }
    selectedIndexes.add(index);
    contextLength = nextLength;
  }
  return candidateLines.filter((_, index) => selectedIndexes.has(index)).join("\n");
}

export function truncateChatThreadTitle(
  text: string,
  maxLength = MAX_CHAT_THREAD_TITLE_LENGTH,
): string {
  const trimmed = normalizeTitleWhitespace(text);
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

// Build a short deterministic title while the model-generated rename is pending.
export function buildPromptThreadTitleFallback(message: string): string {
  const words = titleWords(message).slice(0, MAX_CHAT_THREAD_TITLE_WORDS);
  if (words.length === 0) {
    return GENERIC_CHAT_THREAD_TITLE;
  }
  return truncateChatThreadTitle(words.join(" "));
}

// Keep generated titles compact so the sidebar never renders sentence-length prompts.
export function sanitizeGeneratedThreadTitle(raw: string): string {
  const unquoted = firstGeneratedTitleLine(raw).replace(/^['"`]+|['"`]+$/g, "");
  const words = titleWords(unquoted).slice(0, MAX_CHAT_THREAD_TITLE_WORDS);
  if (words.length === 0) {
    return GENERIC_CHAT_THREAD_TITLE;
  }
  return truncateChatThreadTitle(words.join(" "));
}

export function isUsableGeneratedThreadTitle(title: string | null | undefined): boolean {
  const normalized = normalizeTitleWhitespace(title ?? "").toLowerCase();
  return normalized.length > 0 && !GENERIC_GENERATED_THREAD_TITLES.has(normalized);
}

export function isGenericChatThreadTitle(title: string | null | undefined): boolean {
  return normalizeTitleWhitespace(title ?? "") === GENERIC_CHAT_THREAD_TITLE;
}

/**
 * Infer the smallest useful work category from the request and generated topic.
 * This is intentionally conservative: an unknown category must keep the
 * original title instead of guessing a label that would mislead the sidebar.
 */
export function inferCodexChatThreadTitleKind(source: string): CodexChatThreadTitleKind | null {
  const text = normalizeTitleWhitespace(source).toLocaleLowerCase();
  if (!text) return null;

  const rules: ReadonlyArray<readonly [CodexChatThreadTitleKind, RegExp]> = [
    ["修复", /修复|排查|故障|错误|崩溃|回归|bug|fix|broken|crash|regression/iu],
    ["发布", /发布|上线|部署|打包|安装|推送|合并|release|deploy|package|install|publish|merge/iu],
    ["优化", /优化|完善|改进|重构|清理|收口|性能|optimi[sz]|refactor|cleanup|polish/iu],
    ["功能", /功能|实现|新增|添加|接入|集成|整合|构建|开发|feature|implement|build|add|integrat/iu],
    ["设计", /设计|界面|交互|布局|视觉|样式|对齐|原型|design|ui|layout|visual|prototype/iu],
    ["文档", /文档|说明|指南|readme|docs?|documentation|guide/iu],
    ["研究", /研究|调研|学习|分析|梳理|复核|审查|research|investigat|review|audit|analy[sz]e/iu],
    ["探索", /探索|查找|检查|验证|测试|状态|探索|explore|inspect|check|verify|test|status/iu],
  ];

  for (const [kind, pattern] of rules) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

function codexChatThreadDate(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return month && day ? `${month}${day}` : null;
}

export function isStructuredCodexChatThreadTitle(title: string | null | undefined): boolean {
  return CODEX_CHAT_THREAD_TITLE_PATTERN.test(normalizeTitleWhitespace(title ?? ""));
}

/**
 * Add the Moss/Codex sidebar contract to an automatically generated title.
 * Invalid dates or unclear categories return the original topic unchanged.
 */
export function formatCodexChatThreadTitle(input: {
  readonly createdAt: string;
  readonly topic: string;
  readonly source?: string;
}): string {
  const topic = sanitizeGeneratedThreadTitle(input.topic);
  if (topic === GENERIC_CHAT_THREAD_TITLE || isStructuredCodexChatThreadTitle(topic)) {
    return topic;
  }

  const date = codexChatThreadDate(input.createdAt);
  const kind = inferCodexChatThreadTitleKind(`${input.source ?? ""} ${topic}`);
  if (!date || !kind) return topic;

  const prefix = `${date}｜${kind}｜`;
  return `${prefix}${truncateChatThreadTitle(topic, MAX_CHAT_THREAD_TITLE_LENGTH - prefix.length)}`;
}
