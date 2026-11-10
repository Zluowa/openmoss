// FILE: pageCommentFeed.ts
// Purpose: Present page-local comments and share comments together without copying their records.
// Layer: Web page presentation

import type { PageComment, PageGuestComment } from "@moss/contracts";

export interface PageCommentFeedItem {
  readonly key: string;
  readonly source: "page" | "share";
  readonly authorKind: "owner" | "agent" | "member" | "guest";
  readonly authorName: string | null;
  readonly content: string;
  readonly createdAt: string;
}

export function mergePageComments(
  local: readonly PageComment[] = [],
  shared: readonly PageGuestComment[] = [],
): readonly PageCommentFeedItem[] {
  const entries = new Map<string, PageCommentFeedItem>();
  for (const comment of local) {
    const key = `page:${comment.id}`;
    entries.set(key, {
      key,
      source: "page",
      authorKind: comment.author === "agent" ? "agent" : "owner",
      authorName: null,
      content: comment.content,
      createdAt: comment.createdAt,
    });
  }
  for (const comment of shared) {
    const key = `share:${comment.id}`;
    entries.set(key, {
      key,
      source: "share",
      authorKind: comment.authorKind,
      authorName: comment.authorName,
      content: comment.content,
      createdAt: comment.createdAt,
    });
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key),
  );
}
