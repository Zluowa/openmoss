// FILE: deckComments.tsx
// Purpose: Comments on a 幻灯片: kept with the other page comments on this device, shown in the
//          deck editor as pins and thread cards, and, when "发送给 Moss" is ticked, handed to the
//          deck's agent as a change request whose answer comes back into the thread.
// Layer: 资料空间 幻灯片 (host side)

import type { ThreadId } from "@moss/contracts";
import { useEffect, useMemo } from "react";

import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";

import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";
import {
  newPageCommentId,
  usePageCommentsStore,
  type PageComment,
  type PageCommentAuthor,
  type PageCommentReply,
} from "~/pageCommentsStore";
import { resolvePageCommentAgentReply } from "../../chat/pageComments/pageComments.logic";
import type { DeckCommentAnchor, DeckCommentThread } from "~/lib/deckEditorChannel";

export const deckCommentsKey = (pageId: string) => `deck:${pageId}`;

/** An answer that has not come back by then is shown as "finished without replying here". */
export const DECK_COMMENT_REPLY_TIMEOUT_MS = 15 * 60_000;

const anchorSelector = (anchor: DeckCommentAnchor) => `${anchor.slideId}/${anchor.elementId ?? ""}`;
function anchorOf(comment: PageComment): DeckCommentAnchor {
  const [slideId = "", elementId = ""] = comment.anchor.selector.split("/");
  return elementId ? { slideId, elementId } : { slideId };
}

/** The threads as the editor draws them: one pin per thread, its messages in the card. */
export function deckCommentThreads(comments: readonly PageComment[]): DeckCommentThread[] {
  return comments.map((comment) => {
    const messages = [
      {
        id: comment.id,
        kind: "person" as const,
        author: comment.author.name,
        initials: comment.author.initials,
        body: comment.body,
        createdAt: comment.createdAt,
        sentToAgent: comment.sentToAgentAt !== null,
      },
      ...comment.replies.map((reply) => ({
        id: reply.id,
        kind: reply.kind,
        author: reply.author.name,
        initials: reply.author.initials,
        body: reply.body,
        createdAt: reply.createdAt,
        ...(reply.kind === "agent" ? { status: reply.status } : {}),
        ...(reply.request ? { sentToAgent: true } : {}),
      })),
    ];
    return {
      id: comment.id,
      anchor: anchorOf(comment),
      label: comment.anchor.label,
      count: messages.length,
      resolved: comment.resolved === true,
      working: comment.replies.some(
        (reply) => reply.kind === "agent" && reply.status === "thinking",
      ),
      messages,
    };
  });
}

function agentPlaceholder(via: PageCommentAuthor, body: string, sentAt: string): PageCommentReply {
  return {
    id: newPageCommentId(),
    kind: "agent",
    author: via,
    body: "",
    createdAt: sentAt,
    status: "thinking",
    request: { body, sentAt },
  };
}

/**
 * Adds a person's message (a new thread, or a reply in one). When it goes to the agent, an
 * agent reply waits in the thread and `ask` starts the agent's turn; the turn's conversation is
 * recorded on that reply as soon as it is known.
 */
export function postDeckComment(input: {
  pageKey: string;
  author: PageCommentAuthor;
  threadId: string | null;
  anchor: DeckCommentAnchor | null;
  label: string;
  body: string;
  sendToAgent: boolean;
  ask: (body: string, anchor: DeckCommentAnchor) => Promise<string | null>;
}) {
  const store = usePageCommentsStore.getState();
  const now = new Date().toISOString();
  let commentId = input.threadId;
  let anchor = input.anchor;
  if (commentId) {
    const existing = store.commentsByPage[input.pageKey]?.find((c) => c.id === commentId);
    if (!existing) return;
    anchor = anchorOf(existing);
    store.addReply(input.pageKey, commentId, {
      id: newPageCommentId(),
      kind: "person",
      author: input.author,
      body: input.body,
      createdAt: now,
      status: "done",
      ...(input.sendToAgent ? { request: { body: input.body, sentAt: now } } : {}),
    });
    if (existing.resolved) store.setResolved(input.pageKey, commentId, false);
  } else {
    if (!anchor) return;
    commentId = newPageCommentId();
    store.addComment({
      id: commentId,
      pageKey: input.pageKey,
      threadId: "",
      anchor: { selector: anchorSelector(anchor), label: input.label, text: "" },
      author: input.author,
      body: input.body,
      createdAt: now,
      sentToAgentAt: input.sendToAgent ? now : null,
      replies: [],
      read: true,
    });
  }
  if (!input.sendToAgent || !anchor) return;
  const placeholder = agentPlaceholder(input.author, input.body, now);
  store.addReply(input.pageKey, commentId, placeholder);
  const id = commentId;
  void input.ask(input.body, anchor).then(
    (threadId) =>
      threadId
        ? store.updateReply(input.pageKey, id, placeholder.id, { agentThreadId: threadId })
        : store.updateReply(input.pageKey, id, placeholder.id, { status: "failed" }),
    () => store.updateReply(input.pageKey, id, placeholder.id, { status: "failed" }),
  );
}

function AgentReplyWatcher(props: {
  pageKey: string;
  commentId: string;
  reply: PageCommentReply & { agentThreadId: string; request: { body: string; sentAt: string } };
}) {
  const { pageKey, commentId, reply } = props;
  const thread = useStore(
    useMemo(() => createThreadSelector(reply.agentThreadId as ThreadId), [reply.agentThreadId]),
  );
  // The web store streams messages only for chats someone holds open; this one runs in the
  // background, so hold it while its answer is awaited.
  useEffect(
    () => retainThreadDetailSubscription(reply.agentThreadId as ThreadId),
    [reply.agentThreadId],
  );
  useEffect(() => {
    const left = Date.parse(reply.request.sentAt) + DECK_COMMENT_REPLY_TIMEOUT_MS - Date.now();
    const fail = () => {
      const store = usePageCommentsStore.getState();
      const current = store.commentsByPage[pageKey]
        ?.find((comment) => comment.id === commentId)
        ?.replies.find((entry) => entry.id === reply.id);
      if (current?.status === "thinking")
        store.updateReply(pageKey, commentId, reply.id, { status: "failed" });
    };
    if (left <= 0) {
      fail();
      return;
    }
    const timer = setTimeout(fail, left);
    return () => clearTimeout(timer);
  }, [commentId, pageKey, reply.id, reply.request.sentAt]);
  useEffect(() => {
    const state = resolvePageCommentAgentReply(thread, {
      body: reply.request.body,
      sentToAgentAt: reply.request.sentAt,
    });
    const update = usePageCommentsStore.getState().updateReply;
    if (state.status === "done")
      update(pageKey, commentId, reply.id, {
        status: "done",
        body: state.text,
        createdAt: new Date().toISOString(),
      });
    else if (state.status === "failed") update(pageKey, commentId, reply.id, { status: "failed" });
  }, [commentId, pageKey, reply, thread]);
  return null;
}

/** Follows every agent reply still waiting for its conversation's answer. */
export function DeckCommentAgentReplies(props: {
  pageKey: string;
  comments: readonly PageComment[];
}) {
  return (
    <>
      {props.comments.flatMap((comment) =>
        comment.replies.flatMap((reply) =>
          reply.kind === "agent" &&
          reply.status === "thinking" &&
          reply.agentThreadId &&
          reply.request
            ? [
                <AgentReplyWatcher
                  key={reply.id}
                  pageKey={props.pageKey}
                  commentId={comment.id}
                  reply={reply as never}
                />,
              ]
            : [],
        ),
      )}
    </>
  );
}
