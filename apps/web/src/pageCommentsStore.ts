// FILE: pageCommentsStore.ts
// Purpose: Comments readers leave on visual pages: anchored to an element of one page,
//   with replies, read state, and the agent's answer when a comment was sent to it.
//   Kept on this device and across restarts.
// Layer: Web UI state store
// Spec: docs/design/annotate-and-comment/SPEC.md, "Page comments".

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const PAGE_COMMENTS_STORAGE_KEY = "moss:page-comments:v1";
const MAX_PAGES = 200;
const MAX_COMMENTS_PER_PAGE = 200;
export const PAGE_COMMENT_MAX_LENGTH = 4000;

export interface PageCommentAnchor {
  readonly selector: string;
  /** `tag#id`, `tag.class` or the tag, as shown in the breadcrumb. */
  readonly label: string;
  /** The element's visible text when it was picked, trimmed. */
  readonly text: string;
}

export interface PageCommentAuthor {
  readonly name: string;
  readonly initials: string;
}

export interface PageCommentReply {
  readonly id: string;
  readonly kind: "person" | "agent";
  /** For an agent reply, the person whose request it answered ("Moss · via {name}"). */
  readonly author: PageCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly status: "done" | "thinking" | "failed";
  /** Agent replies on slides: the conversation that answers, once it has started. */
  readonly agentThreadId?: string;
  /** Agent replies on slides: the message that conversation was sent, to find its answer. */
  readonly request?: { readonly body: string; readonly sentAt: string };
}

export interface PageComment {
  readonly id: string;
  readonly pageKey: string;
  readonly threadId: string;
  readonly anchor: PageCommentAnchor;
  readonly author: PageCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  /** Set when the comment went to the agent as the thread's next message. */
  readonly sentToAgentAt: string | null;
  readonly replies: readonly PageCommentReply[];
  readonly read: boolean;
  readonly resolved?: boolean;
}

interface PageCommentsState {
  readonly commentsByPage: Readonly<Record<string, readonly PageComment[]>>;
  readonly addComment: (comment: PageComment) => void;
  readonly addReply: (pageKey: string, commentId: string, reply: PageCommentReply) => void;
  readonly updateReply: (
    pageKey: string,
    commentId: string,
    replyId: string,
    patch: Partial<Pick<PageCommentReply, "body" | "status" | "createdAt" | "agentThreadId">>,
  ) => void;
  readonly setResolved: (pageKey: string, commentId: string, resolved: boolean) => void;
  readonly deleteComment: (pageKey: string, commentId: string) => void;
  readonly markPageRead: (pageKey: string) => void;
}

export function newPageCommentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function updateComment(
  state: PageCommentsState,
  pageKey: string,
  commentId: string,
  update: (comment: PageComment) => PageComment,
): Pick<PageCommentsState, "commentsByPage"> {
  const comments = state.commentsByPage[pageKey];
  if (!comments) return { commentsByPage: state.commentsByPage };
  return {
    commentsByPage: {
      ...state.commentsByPage,
      [pageKey]: comments.map((comment) => (comment.id === commentId ? update(comment) : comment)),
    },
  };
}

function retainRecentPages(
  pages: Record<string, readonly PageComment[]>,
): Record<string, readonly PageComment[]> {
  return Object.fromEntries(Object.entries(pages).slice(-MAX_PAGES));
}

export const usePageCommentsStore = create<PageCommentsState>()(
  persist(
    (set) => ({
      commentsByPage: {},
      addComment: (comment) =>
        set((state) => {
          const { [comment.pageKey]: existing = [], ...rest } = state.commentsByPage;
          return {
            commentsByPage: retainRecentPages({
              ...rest,
              [comment.pageKey]: [...existing, comment].slice(-MAX_COMMENTS_PER_PAGE),
            }),
          };
        }),
      addReply: (pageKey, commentId, reply) =>
        set((state) =>
          updateComment(state, pageKey, commentId, (comment) => ({
            ...comment,
            replies: [...comment.replies, reply],
          })),
        ),
      updateReply: (pageKey, commentId, replyId, patch) =>
        set((state) =>
          updateComment(state, pageKey, commentId, (comment) => ({
            ...comment,
            // An agent's answer arriving makes the comment unread again.
            read: patch.status === "done" ? false : comment.read,
            replies: comment.replies.map((reply) =>
              reply.id === replyId ? { ...reply, ...patch } : reply,
            ),
          })),
        ),
      setResolved: (pageKey, commentId, resolved) =>
        set((state) =>
          updateComment(state, pageKey, commentId, (comment) => ({ ...comment, resolved })),
        ),
      deleteComment: (pageKey, commentId) =>
        set((state) => {
          const comments = state.commentsByPage[pageKey];
          if (!comments) return state;
          return {
            commentsByPage: {
              ...state.commentsByPage,
              [pageKey]: comments.filter((comment) => comment.id !== commentId),
            },
          };
        }),
      markPageRead: (pageKey) =>
        set((state) => {
          const comments = state.commentsByPage[pageKey];
          if (!comments?.some((comment) => !comment.read)) return state;
          return {
            commentsByPage: {
              ...state.commentsByPage,
              [pageKey]: comments.map((comment) =>
                comment.read ? comment : { ...comment, read: true },
              ),
            },
          };
        }),
    }),
    {
      name: PAGE_COMMENTS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ commentsByPage: state.commentsByPage }),
    },
  ),
);

const EMPTY_COMMENTS: readonly PageComment[] = [];

export function usePageComments(pageKey: string): readonly PageComment[] {
  return usePageCommentsStore((state) => state.commentsByPage[pageKey] ?? EMPTY_COMMENTS);
}

/**
 * The message the agent receives for a comment: the comment first, then where on the page
 * it points, so the agent can find the element in the page it made.
 */
export function pageCommentAgentMessage(input: {
  readonly pageTitle: string;
  readonly anchor: PageCommentAnchor;
  readonly body: string;
}): string {
  const lines = [
    input.body.trim(),
    "",
    `(Comment on the page "${input.pageTitle}", element \`${input.anchor.label}\`, selector \`${input.anchor.selector}\`${input.anchor.text ? `, which reads: "${input.anchor.text}"` : ""}.)`,
  ];
  return lines.join("\n");
}

/** "now", "5m", "3h", "2d", then the date. */
export function pageCommentAge(createdAt: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(createdAt).toLocaleDateString();
}
