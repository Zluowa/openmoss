// FILE: pageDocComments.tsx
// Purpose: Comments on words in a 资料空间 page, host side. The page editor marks the words and
//          draws the thread cards; Moss keeps the threads with the page (the server's
//          pages_text_comments, mirrored in the device store slides and browser comments use),
//          sends them to the editor, and, when 发送给 Moss is ticked, asks the page's agent and
//          puts its answer into the thread. Also hands the editor the page's stored doc style.
// Layer: Space page UI
// Exports: docCommentsKey, docCommentThreads, postDocComment, PageDocBridge, pageDocStyleOf,
//          nextPageDocStyle, PAGE_DOC_STYLE_DEFAULT

import type { PageDocStyle, SpaceId } from "@moss/contracts";
import { useEffect, useMemo, useRef } from "react";

import type {
  PageEditorCommentThread,
  PageEditorDocEvent,
  PageEditorDocStyle,
  PageEditorDocStylePatch,
  PageRichEditorChannel,
} from "~/lib/pageRichEditorChannel";
import {
  newPageCommentId,
  usePageComments,
  usePageCommentsStore,
  type PageComment,
  type PageCommentAuthor,
  type PageCommentReply,
} from "~/pageCommentsStore";

import { pageCommentInitials } from "../../chat/pageComments/pageComments.logic";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import { usePageCommentSync } from "../../spaceTypes/shared/pageCommentSync";
import { DeckCommentAgentReplies } from "../../spaceTypes/slides/deckComments";

export const docCommentsKey = (pageId: string) => `doc:${pageId}`;

function reactionsOf(
  reactions: Readonly<Record<string, readonly string[]>> | undefined,
  me: string,
): Pick<PageEditorCommentThread["messages"][number], "reactions"> {
  const entries = Object.entries(reactions ?? {}).filter(([, names]) => names.length > 0);
  return entries.length
    ? {
        reactions: entries.map(([emoji, names]) => ({
          emoji,
          count: names.length,
          mine: names.includes(me),
          names: [...names],
        })),
      }
    : {};
}

/** The threads as the editor draws them; the anchor's selector is the block id. */
export function docCommentThreads(
  comments: readonly PageComment[],
  me = "",
): PageEditorCommentThread[] {
  return comments.map((comment) => ({
    id: comment.id,
    anchor: { blockId: comment.anchor.selector, quote: comment.anchor.text },
    resolved: comment.resolved === true,
    working: comment.replies.some((reply) => reply.kind === "agent" && reply.status === "thinking"),
    messages: [
      {
        id: comment.id,
        kind: "person" as const,
        author: comment.author.name,
        initials: comment.author.initials,
        body: comment.body,
        createdAt: comment.createdAt,
        ...(comment.sentToAgentAt !== null ? { sentToAgent: true } : {}),
        ...reactionsOf(comment.reactions, me),
      },
      ...comment.replies.map((reply) => ({
        id: reply.id,
        kind: reply.kind,
        author: reply.author.name,
        initials: reply.author.initials,
        body: reply.body,
        createdAt: reply.createdAt,
        ...(reply.kind === "agent" ? { status: reply.status } : {}),
        ...(reply.kind === "person" && reply.request ? { sentToAgent: true } : {}),
        ...reactionsOf(reply.reactions, me),
      })),
    ],
  }));
}

export type DocCommentAsk = (input: {
  body: string;
  blockId: string;
  quote: string;
}) => Promise<string | null>;

/**
 * A person's message: a new thread (its id comes from the editor, which already marked the
 * words) or a reply. Sent to Moss, an agent reply waits in the thread until the answer comes.
 */
export function postDocComment(input: {
  pageKey: string;
  author: PageCommentAuthor;
  event: Extract<PageEditorDocEvent, { event: "comment-post" | "comment-reply" }>;
  ask: DocCommentAsk | null;
}) {
  const store = usePageCommentsStore.getState();
  const now = new Date().toISOString();
  const { event } = input;
  const sendToAgent = event.sendToAgent && input.ask !== null;
  let anchor: { blockId: string; quote: string };
  if (event.event === "comment-reply") {
    const existing = store.commentsByPage[input.pageKey]?.find((c) => c.id === event.threadId);
    if (!existing) return;
    anchor = { blockId: existing.anchor.selector, quote: existing.anchor.text };
    store.addReply(input.pageKey, existing.id, {
      id: newPageCommentId(),
      kind: "person",
      author: input.author,
      body: event.body,
      createdAt: now,
      status: "done",
      ...(sendToAgent ? { request: { body: event.body, sentAt: now } } : {}),
    });
    if (existing.resolved) store.setResolved(input.pageKey, existing.id, false);
  } else {
    if (store.commentsByPage[input.pageKey]?.some((c) => c.id === event.threadId)) return;
    anchor = event.anchor;
    store.addComment({
      id: event.threadId,
      pageKey: input.pageKey,
      threadId: "",
      anchor: { selector: anchor.blockId, label: anchor.quote.slice(0, 60), text: anchor.quote },
      author: input.author,
      body: event.body,
      createdAt: now,
      sentToAgentAt: sendToAgent ? now : null,
      replies: [],
      read: true,
    });
  }
  if (!sendToAgent || !input.ask) return;
  const placeholder: PageCommentReply = {
    id: newPageCommentId(),
    kind: "agent",
    author: input.author,
    body: "",
    createdAt: now,
    status: "thinking",
    request: { body: event.body, sentAt: now },
  };
  store.addReply(input.pageKey, event.threadId, placeholder);
  const fail = () =>
    store.updateReply(input.pageKey, event.threadId, placeholder.id, { status: "failed" });
  void input.ask({ body: event.body, blockId: anchor.blockId, quote: anchor.quote }).then(
    (threadId) =>
      threadId
        ? store.updateReply(input.pageKey, event.threadId, placeholder.id, {
            agentThreadId: threadId,
          })
        : fail(),
    fail,
  );
}

// ── Page width, fonts and language: stored on the page, the same for everyone ───────────────
export const PAGE_DOC_STYLE_DEFAULT: PageEditorDocStyle = {
  width: "default",
  headingFont: "sans",
  textFont: "sans",
};

/** The page's doc style, or the default when it has none. */
export function pageDocStyleOf(page: {
  docStyle?: PageDocStyle | null | undefined;
}): PageEditorDocStyle {
  const style = page.docStyle;
  if (!style) return PAGE_DOC_STYLE_DEFAULT;
  return {
    width: style.width,
    headingFont: style.headingFont,
    textFont: style.textFont,
    ...(style.lang ? { lang: style.lang } : {}),
  };
}

/** The style after a change; null when it is back to the default (the page then stores none). */
export function nextPageDocStyle(
  current: PageEditorDocStyle,
  patch: PageEditorDocStylePatch,
): PageEditorDocStyle | null {
  const lang = "lang" in patch ? patch.lang : current.lang;
  const next: PageEditorDocStyle = {
    width: patch.width ?? current.width,
    headingFont: patch.headingFont ?? current.headingFont,
    textFont: patch.textFont ?? current.textFont,
    ...(lang ? { lang } : {}),
  };
  return next.width === "default" &&
    next.headingFont === "sans" &&
    next.textFont === "sans" &&
    !next.lang
    ? null
    : next;
}

/** Wires one page editor to its comments and its style. Renders the agent reply watchers. */
export function PageDocBridge(props: {
  channel: PageRichEditorChannel;
  pageId: string;
  scopeSpaceId: SpaceId | null;
  /** The page's stored doc style (width, fonts, language). */
  docStyle: PageEditorDocStyle;
  ready: boolean;
  /** Starts the page agent on a comment; null where the page has no agent. */
  ask: DocCommentAsk | null;
  onOpenThread?: ((threadId: string) => void) | undefined;
  onSuggestingChange?: ((on: boolean) => void) | undefined;
}) {
  const { channel, pageId, ready } = props;
  const pageKey = docCommentsKey(pageId);
  const comments = usePageComments(pageKey);
  const style = props.docStyle;
  usePageCommentSync({ pageId, scopeSpaceId: props.scopeSpaceId, pageKey });
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () =>
      identity.kind === "authenticated" || identity.kind === "saved"
        ? { name: identity.label, initials: identity.initials }
        : { name: "我", initials: pageCommentInitials("我") },
    [identity],
  );
  const latest = useRef({
    me,
    ask: props.ask,
    onOpenThread: props.onOpenThread,
    onSuggestingChange: props.onSuggestingChange,
    pageKey,
  });
  latest.current = {
    me,
    ask: props.ask,
    onOpenThread: props.onOpenThread,
    onSuggestingChange: props.onSuggestingChange,
    pageKey,
  };

  useEffect(() => {
    channel.setComments(docCommentThreads(comments, me.name));
  }, [channel, comments, me.name, ready]);
  const styleKey = JSON.stringify(style);
  useEffect(() => {
    channel.setDocStyle(JSON.parse(styleKey) as PageEditorDocStyle);
  }, [channel, styleKey, ready]);
  useEffect(() => {
    channel.onDocEvent = (event) => {
      const current = latest.current;
      const store = usePageCommentsStore.getState();
      switch (event.event) {
        case "comment-post":
        case "comment-reply":
          postDocComment({ pageKey: current.pageKey, author: current.me, event, ask: current.ask });
          return;
        case "comment-resolve":
          store.setResolved(current.pageKey, event.threadId, event.resolved);
          return;
        case "comment-delete":
          store.deleteComment(current.pageKey, event.threadId);
          return;
        case "comment-open":
          current.onOpenThread?.(event.threadId);
          return;
        case "suggesting-changed":
          current.onSuggestingChange?.(event.on);
          return;
        case "comment-react":
          store.toggleReaction(
            current.pageKey,
            event.threadId,
            event.messageId,
            event.emoji,
            current.me.name,
          );
          return;
      }
    };
    return () => {
      channel.onDocEvent = () => {};
    };
  }, [channel]);

  return <DeckCommentAgentReplies pageKey={pageKey} comments={comments} />;
}
