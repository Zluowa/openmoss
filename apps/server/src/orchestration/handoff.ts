import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatImageAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@moss/contracts";
import { unicodeSafeEndOffset } from "@moss/shared/text";

const RECENT_MESSAGE_COUNT = 6;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
// Hard ceiling for any bootstrap transcript: it replays as one uncached user
// message, so long threads must drop their oldest summaries rather than grow.
const BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET = 32_000;

export interface TranscriptBootstrap {
  readonly text: string;
  readonly omittedMessages: number;
  readonly shortenedMessages: number;
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const requestedEndOffset = Math.max(0, maxChars - 3);
  const endOffset = unicodeSafeEndOffset(value, requestedEndOffset);
  return `${value.slice(0, endOffset).trimEnd()}...`;
}

function roleLabel(message: Pick<OrchestrationMessage, "role">): "User" | "Assistant" {
  return message.role === "assistant" ? "Assistant" : "User";
}

function earlierSummaryHeader(omittedCount: number): string {
  return omittedCount > 0
    ? `Earlier conversation summary (${omittedCount} older ${
        omittedCount === 1 ? "message" : "messages"
      } omitted to fit the context budget):`
    : "Earlier conversation summary:";
}

export function listImportedHandoffMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "handoff-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function listImportedForkMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "fork-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function hasNativeHandoffMessages(thread: Pick<OrchestrationThread, "messages">): boolean {
  return thread.messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      (message.source === "native" || message.source === "async-user-input") &&
      message.streaming === false,
  );
}

export function hasNativeAssistantMessagesBefore(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): boolean {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return false;
  }
  return thread.messages.slice(0, currentIndex).some((message) => {
    return (
      message.role === "assistant" && message.source === "native" && message.streaming === false
    );
  });
}

export function listPriorTranscriptMessages(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): ReadonlyArray<OrchestrationMessage> {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return [];
  }

  return thread.messages.slice(0, currentIndex).filter((message) => {
    return (
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false &&
      message.text.trim().length > 0
    );
  });
}

/** The most earlier images a fresh session is shown again on its first turn. */
export const PRIOR_IMAGE_CARRY_LIMIT = 4;

export interface PriorImageAttachment {
  readonly messageId: string;
  readonly attachment: ChatImageAttachment;
}

/**
 * The person's earlier images, newest last. A session that starts without the
 * conversation's native history (a handoff to another provider, model or
 * account, or a restart) only gets a text transcript; these are what it would
 * otherwise never see.
 */
export function listPriorImageAttachments(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
  limit = PRIOR_IMAGE_CARRY_LIMIT,
): ReadonlyArray<PriorImageAttachment> {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  const prior = currentIndex < 0 ? thread.messages : thread.messages.slice(0, currentIndex);
  const images: PriorImageAttachment[] = [];
  for (const message of prior) {
    if (message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === "image") images.push({ messageId: message.id, attachment });
    }
  }
  return limit > 0 ? images.slice(-limit) : [];
}

/** What the fresh session is told about those images, so it can say so plainly. */
export function priorImagesContextNote(input: {
  readonly total: number;
  readonly attached: number;
}): string | null {
  if (input.total === 0) return null;
  if (input.attached === 0) {
    return `Earlier messages in this conversation included ${input.total} image(s). The current model cannot view images, so they are not included. If the user asks about them, say plainly that this model cannot see images and suggest switching to a model that can.`;
  }
  return input.attached === input.total
    ? `The ${input.attached} image(s) the user shared earlier in this conversation are attached to this message again.`
    : `The user shared ${input.total} images earlier in this conversation; the latest ${input.attached} are attached to this message again.`;
}

function buildImportedMessagesBootstrap(input: {
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath">;
  importedMessages: ReadonlyArray<OrchestrationMessage>;
  intro: string;
  maxChars: number;
}): TranscriptBootstrap | null {
  if (input.importedMessages.length === 0) {
    return null;
  }

  const maxChars = Math.min(Math.max(0, input.maxChars), BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET);
  const earlierMessages = input.importedMessages.slice(0, -RECENT_MESSAGE_COUNT);
  const recentMessages = input.importedMessages.slice(-RECENT_MESSAGE_COUNT);
  const sections: string[] = [input.intro, `Original conversation title: ${input.thread.title}`];
  const excerpts: Array<{ start: number; end: number; shortened: boolean }> = [];

  if (input.thread.branch) {
    sections.push(`Git branch: ${input.thread.branch}`);
  }
  if (input.thread.worktreePath) {
    sections.push(`Worktree path: ${input.thread.worktreePath}`);
  }

  const renderMessage = (message: OrchestrationMessage, limit: number, earlier: boolean) => {
    const normalized = normalizeMessageText(message.text);
    const prefix = earlier ? `- ${roleLabel(message)}: ` : `${roleLabel(message)}:\n`;
    return {
      text: `${prefix}${truncateText(normalized, limit)}`,
      contentOffset: prefix.length,
      shortened: normalized.length > limit,
    };
  };
  const appendMessageSection = (
    header: string,
    messages: ReadonlyArray<ReturnType<typeof renderMessage>>,
    separator: string,
  ) => {
    let offset =
      sections.reduce((total, section) => total + section.length + 2, 0) + header.length + 1;
    for (const message of messages) {
      excerpts.push({
        start: offset + message.contentOffset,
        end: offset + message.text.length,
        shortened: message.shortened,
      });
      offset += message.text.length + separator.length;
    }
    sections.push(
      messages.length > 0
        ? `${header}\n${messages.map((message) => message.text).join(separator)}`
        : header,
    );
  };
  const recentExcerpts = recentMessages.map((message) =>
    renderMessage(message, RECENT_MESSAGE_CHAR_LIMIT, false),
  );
  const recentHeader = "Most recent imported messages:";
  const recentSectionLength =
    recentHeader.length +
    1 +
    recentExcerpts.reduce(
      (total, message, index) => total + message.text.length + (index > 0 ? 2 : 0),
      0,
    );

  if (earlierMessages.length > 0) {
    // Keep the newest earlier-message summaries that fit the remaining budget;
    // older ones are dropped so long threads cannot inflate the bootstrap.
    let remaining =
      maxChars -
      sections.reduce((total, section) => total + section.length + 2, 0) -
      (recentSectionLength + 2);
    // Reserve space for the omission header up front so accepted summary
    // lines can never push the assembled section past `remaining`. The
    // header only shrinks as more lines are accepted (omittedCount falls
    // monotonically from earlierMessages.length toward 0, and shorter/no
    // counts never produce a longer header), so sizing the reservation off
    // the largest possible omitted count is a true worst-case bound, not
    // just a conservative guess. The extra `+ 1` covers the "\n" that joins
    // the header to the summary lines when at least one line is kept.
    remaining -= earlierSummaryHeader(earlierMessages.length).length + 1;
    const summaryLines: Array<ReturnType<typeof renderMessage>> = [];
    for (let index = earlierMessages.length - 1; index >= 0; index -= 1) {
      const message = earlierMessages[index]!;
      const line = renderMessage(message, EARLIER_MESSAGE_CHAR_LIMIT, true);
      if (remaining < line.text.length + 1) {
        break;
      }
      remaining -= line.text.length + 1;
      summaryLines.push(line);
    }
    summaryLines.reverse();
    const omittedCount = earlierMessages.length - summaryLines.length;
    const header = earlierSummaryHeader(omittedCount);
    appendMessageSection(header, summaryLines, "\n");
  }

  appendMessageSection(recentHeader, recentExcerpts, "\n\n");

  const joined = sections.join("\n\n").trim();
  const text = truncateText(joined, maxChars);
  // The final input budget can also cut the recent-message section. Count
  // only excerpts that actually reached the provider, including partial ones.
  const retainedChars = text === joined ? text.length : Math.max(0, text.length - 3);
  const includedExcerpts = excerpts.filter((excerpt) => excerpt.start < retainedChars);
  return {
    text,
    omittedMessages: input.importedMessages.length - includedExcerpts.length,
    shortenedMessages: includedExcerpts.filter(
      (excerpt) => excerpt.shortened || excerpt.end > retainedChars,
    ).length,
  };
}

export function buildHandoffBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "handoff" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedHandoffMessages(thread);
  if (importedMessages.length === 0 || thread.handoff === null) {
    return null;
  }

  return (
    buildImportedMessagesBootstrap({
      thread,
      importedMessages,
      intro: `This conversation was handed off from ${thread.handoff.sourceProvider}.`,
      maxChars,
    })?.text ?? null
  );
}

export function buildPriorTranscriptBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string | undefined,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  return buildPriorTranscriptBootstrap(thread, currentMessageId, maxChars)?.text ?? null;
}

export function buildPriorTranscriptBootstrap(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string | undefined,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): TranscriptBootstrap | null {
  const priorMessages = listPriorTranscriptMessages(thread, currentMessageId);
  if (priorMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrap({
    thread,
    importedMessages: priorMessages,
    intro:
      "This provider session may have been restarted without native conversation state. Use this prior Moss transcript as context for the latest user message.",
    maxChars,
  });
}

export function buildForkBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedForkMessages(thread);
  if (importedMessages.length === 0) {
    return null;
  }

  return (
    buildImportedMessagesBootstrap({
      thread,
      importedMessages,
      intro: "This sidechat was cloned from an earlier conversation.",
      maxChars,
    })?.text ?? null
  );
}
