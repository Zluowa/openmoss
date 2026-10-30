// FILE: quickChatReference.ts
// Purpose: Versioned, compact reference payload for attaching a durable Quick Chat
//   conversation to another task without copying its transcript into the composer.
// Layer: Web composer context adapter

const QUICK_CHAT_REFERENCE_OPEN = "<quick_chat_reference>";
const QUICK_CHAT_REFERENCE_CLOSE = "</quick_chat_reference>";
const QUICK_CHAT_REFERENCE_PATTERN =
  /^<quick_chat_reference>\n([\s\S]+)\n<\/quick_chat_reference>$/u;
const QUICK_CHAT_REFERENCE_VERSION = 1 as const;
const UNTITLED_QUICK_CHAT = "Untitled chat";
const QUICK_CHAT_REFERENCE_TITLE_MAX_CHARS = 160;

export interface QuickChatReference {
  readonly type: "quick-chat";
  readonly version: typeof QUICK_CHAT_REFERENCE_VERSION;
  /** Provider conversation id when available; otherwise the durable Moss thread id. */
  readonly conversationId: string;
  /** Moss orchestration thread id used to resolve the conversation locally. */
  readonly threadId: string;
  readonly title: string;
}

export type QuickChatReferenceInput = Pick<
  QuickChatReference,
  "conversationId" | "threadId" | "title"
>;

function normalizeReferenceId(value: string): string {
  return value.trim();
}

export function normalizeQuickChatReferenceTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim() || UNTITLED_QUICK_CHAT;
  return normalized.length <= QUICK_CHAT_REFERENCE_TITLE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, QUICK_CHAT_REFERENCE_TITLE_MAX_CHARS - 1)}…`;
}

function normalizeQuickChatReference(
  reference: QuickChatReferenceInput,
): QuickChatReference | null {
  const conversationId = normalizeReferenceId(reference.conversationId);
  const threadId = normalizeReferenceId(reference.threadId);
  if (conversationId.length === 0 || threadId.length === 0) {
    return null;
  }
  return {
    type: "quick-chat",
    version: QUICK_CHAT_REFERENCE_VERSION,
    conversationId,
    threadId,
    title: normalizeQuickChatReferenceTitle(reference.title),
  };
}

/**
 * The current provider turn contract has no first-class conversation-reference
 * attachment. Keep this payload versioned inside the existing persisted composer
 * context lane so it can be resolved by a future backend adapter without another
 * draft migration. It intentionally contains no transcript text.
 */
export function buildQuickChatReferenceContext(input: QuickChatReferenceInput): string {
  const reference = normalizeQuickChatReference(input);
  if (!reference) {
    return "";
  }
  return [QUICK_CHAT_REFERENCE_OPEN, JSON.stringify(reference), QUICK_CHAT_REFERENCE_CLOSE].join(
    "\n",
  );
}

export function parseQuickChatReferenceContext(text: string): QuickChatReference | null {
  const match = QUICK_CHAT_REFERENCE_PATTERN.exec(text.replace(/\r\n?/gu, "\n").trim());
  if (!match) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const candidate = parsed as Partial<QuickChatReference>;
    if (
      candidate.type !== "quick-chat" ||
      candidate.version !== QUICK_CHAT_REFERENCE_VERSION ||
      typeof candidate.conversationId !== "string" ||
      typeof candidate.threadId !== "string" ||
      typeof candidate.title !== "string"
    ) {
      return null;
    }
    return normalizeQuickChatReference({
      conversationId: candidate.conversationId,
      threadId: candidate.threadId,
      title: candidate.title,
    });
  } catch {
    return null;
  }
}
