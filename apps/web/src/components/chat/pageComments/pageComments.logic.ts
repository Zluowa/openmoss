// FILE: pageComments.logic.ts
// Purpose: Where page-comment pins and cards sit over a visual page, and how a comment
//   sent to the agent finds the agent's answer in the thread.
// Layer: Web chat presentation logic
// Spec: docs/design/annotate-and-comment/SPEC.md, "Pin", "Cards", "Sending to the agent".

import type { HtmlRenderCommentRect } from "@moss/shared/htmlRender";

import type { PageComment } from "../../../pageCommentsStore";
import type { ChatMessage, Thread } from "../../../types";

/** Compact avatar (20px) plus 12px of frame, as in the spec. */
export const PAGE_COMMENT_PIN_SIZE = 32;
export const PAGE_COMMENT_CARD_WIDTH = 300;
export const PAGE_COMMENT_CARD_MAX_HEIGHT = 320;
const EDGE_GAP = 8;
const CARD_GAP = 8;

export interface PaneSize {
  readonly width: number;
  readonly height: number;
}

export interface PinPlacement {
  readonly left: number;
  readonly top: number;
  /** The square corner points at the element: bottom-left above it, top-left below it. */
  readonly side: "above" | "below";
}

/**
 * A pin sits on the element's top-right corner, its square corner touching it. When there
 * is no room above, it drops just inside the element's top edge instead.
 */
export function placePageCommentPin(
  rect: HtmlRenderCommentRect,
  zoom: number,
  pane: PaneSize,
): PinPlacement | null {
  const right = (rect.x + rect.width) * zoom;
  const top = rect.y * zoom;
  const bottom = (rect.y + rect.height) * zoom;
  if (bottom < 0 || top > pane.height || right < 0 || rect.x * zoom > pane.width) return null;
  const left = Math.min(
    Math.max(right - 4, EDGE_GAP),
    pane.width - PAGE_COMMENT_PIN_SIZE - EDGE_GAP,
  );
  const above = top - PAGE_COMMENT_PIN_SIZE + 4;
  return above >= EDGE_GAP
    ? { left, top: above, side: "above" }
    : { left, top: Math.max(top + 4, EDGE_GAP), side: "below" };
}

/** A card beside its pin, on the right unless that would leave the pane. */
export function placePageCommentCard(
  pin: { readonly left: number; readonly top: number },
  pane: PaneSize,
): { readonly left: number; readonly top: number } {
  const rightSide = pin.left + PAGE_COMMENT_PIN_SIZE + CARD_GAP;
  const left =
    rightSide + PAGE_COMMENT_CARD_WIDTH <= pane.width - EDGE_GAP
      ? rightSide
      : Math.max(EDGE_GAP, pin.left - CARD_GAP - PAGE_COMMENT_CARD_WIDTH);
  const maxTop = Math.max(EDGE_GAP, pane.height - PAGE_COMMENT_CARD_MAX_HEIGHT - EDGE_GAP);
  return { left, top: Math.min(Math.max(pin.top, EDGE_GAP), maxTop) };
}

export type PageCommentAgentReplyState =
  | { readonly status: "waiting" }
  | { readonly status: "thinking" }
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "failed" };

// A sent comment is the thread's message from the moment it was sent; allow for clock skew
// between the app and the server's timestamps.
const SEND_SKEW_MS = 5_000;

function messageTime(message: ChatMessage): number {
  return Date.parse(message.createdAt);
}

/**
 * Follows a comment sent to the agent: the user message carrying it, then the agent's
 * answer in that turn. "waiting" means the message is still in the composer.
 */
export function resolvePageCommentAgentReply(
  thread: Pick<Thread, "messages" | "latestTurn"> | undefined,
  comment: Pick<PageComment, "body" | "sentToAgentAt">,
): PageCommentAgentReplyState {
  if (!thread || !comment.sentToAgentAt) return { status: "waiting" };
  const sentAt = Date.parse(comment.sentToAgentAt) - SEND_SKEW_MS;
  const needle = comment.body.trim().slice(0, 200);
  const messages = thread.messages;
  const userIndex = messages.findIndex(
    (message) =>
      message.role === "user" && messageTime(message) >= sentAt && message.text.includes(needle),
  );
  if (userIndex < 0) return { status: "waiting" };
  let answer: ChatMessage | null = null;
  for (const message of messages.slice(userIndex + 1)) {
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim().length > 0) answer = message;
  }
  const userAt = messageTime(messages[userIndex]!);
  const turn = thread.latestTurn;
  const turnStartedAfter = turn?.startedAt
    ? Date.parse(turn.startedAt) >= userAt - SEND_SKEW_MS
    : false;
  const running = (turnStartedAfter && turn?.state === "running") || answer?.streaming === true;
  if (running) return { status: "thinking" };
  if (answer) return { status: "done", text: answer.text.trim() };
  return turnStartedAfter ? { status: "failed" } : { status: "thinking" };
}

/** Initials from a name, as the sidebar avatar shows them. */
export function pageCommentInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toLocaleUpperCase();
  }
  return Array.from(name.replace(/\s+/gu, "")).slice(0, 2).join("").toLocaleUpperCase() || "?";
}

/** Whether a draft asks for the agent: the checkbox, or an @Moss mention typed in it. */
export function pageCommentMentionsAgent(body: string): boolean {
  return /(^|\s)@moss\b/iu.test(body);
}

/**
 * The draft without its @Moss mention, which the chip and checkbox carry instead. Spacing
 * around the cursor is kept, so typing continues where it was.
 */
export function removePageCommentAgentMention(body: string): string {
  return body.replace(/(^|\s)@moss\b[,:]?\s?/iu, "$1");
}
