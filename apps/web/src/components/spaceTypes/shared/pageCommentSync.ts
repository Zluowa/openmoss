// FILE: pageCommentSync.ts
// Purpose: Keeps a page's comment threads with the page on the server (pages_text_comments,
//          the 文档 line's store) as well as in the device store every 资料空间 editor draws from:
//          the server's copy loads first, then every change here is saved, and the page reads the
//          threads again now and then (a guest's reply, another window's edit).
// Layer: 资料空间 shared (comments)
// Exports: usePageCommentSync, storedCommentForm, parseStoredComment.
// Why: One store for every editor's comments. A thread is stored as the device store's
//      PageComment without this device's read state; its anchor.selector says where it points
//      (文档: the block id; 电子表格: "<sheetId>/<row>:<col>", rows and columns from 0).
//      Generalised from the 文档 line's sync so 文档, 电子表格 and the others share it.

import type { PageId, SpaceId } from "@moss/contracts";
import { useEffect } from "react";

import { readNativeApi } from "~/nativeApi";
import { usePageCommentsStore, type PageComment } from "~/pageCommentsStore";

const SYNC_DELAY_MS = 400;
/** How often an open page reads its threads again (guests reply on shared links). */
const PULL_INTERVAL_MS = 20_000;

/**
 * The two calls of the server store. Typed here, and checked at run time, so an editor works
 * from its device store where the server has no such store yet.
 */
interface TextCommentCalls {
  readonly textComments: (input: {
    scopeSpaceId: SpaceId | null;
    pageId: PageId;
  }) => Promise<{ comments: readonly { thread: string }[] }>;
  readonly textCommentMutate: (
    input:
      | {
          op: "save";
          scopeSpaceId: SpaceId | null;
          pageId: PageId;
          commentId: string;
          thread: string;
        }
      | { op: "delete"; scopeSpaceId: SpaceId | null; pageId: PageId; commentId: string },
  ) => Promise<unknown>;
}

/** A thread as the server keeps it: without this device's read state and store key. */
export function storedCommentForm(comment: PageComment): string {
  const { read: _read, pageKey: _key, ...stored } = comment;
  return JSON.stringify(stored);
}

export function parseStoredComment(raw: string, pageKey: string): PageComment | null {
  try {
    const value = JSON.parse(raw) as PageComment;
    if (!value || typeof value !== "object" || typeof value.id !== "string") return null;
    if (!value.anchor || typeof value.anchor.selector !== "string") return null;
    return { ...value, pageKey, replies: Array.isArray(value.replies) ? value.replies : [] };
  } catch {
    return null;
  }
}

/**
 * Keeps the threads under `pageKey` in the device store and on the server alike: the server's
 * copy loads first (threads only this device had are uploaded), then every change is saved.
 */
export function usePageCommentSync(input: {
  readonly pageId: string;
  readonly scopeSpaceId: SpaceId | null;
  /** The device store's key for this page's threads ("doc:<id>", "sheet:<id>"). */
  readonly pageKey: string;
  readonly enabled?: boolean;
}) {
  const { pageId, scopeSpaceId, pageKey, enabled = true } = input;
  useEffect(() => {
    if (!enabled) return;
    const pages = readNativeApi()?.pages as unknown as Partial<TextCommentCalls> | undefined;
    if (!pages?.textComments || !pages.textCommentMutate) return;
    const calls = pages as TextCommentCalls;
    const synced = new Map<string, string>();
    let loaded = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (stopped || !loaded) return;
      const comments = usePageCommentsStore.getState().commentsByPage[pageKey] ?? [];
      const seen = new Set<string>();
      for (const comment of comments) {
        seen.add(comment.id);
        const thread = storedCommentForm(comment);
        if (synced.get(comment.id) === thread) continue;
        synced.set(comment.id, thread);
        void calls
          .textCommentMutate({
            op: "save",
            scopeSpaceId,
            pageId: pageId as PageId,
            commentId: comment.id,
            thread,
          })
          .catch(() => synced.delete(comment.id));
      }
      for (const id of [...synced.keys()]) {
        if (seen.has(id)) continue;
        synced.delete(id);
        void calls
          .textCommentMutate({
            op: "delete",
            scopeSpaceId,
            pageId: pageId as PageId,
            commentId: id,
          })
          .catch(() => undefined);
      }
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(flush, SYNC_DELAY_MS);
    };
    /**
     * Reads the server's threads. A thread this window has not changed since the last sync
     * takes the server's copy; a thread changed here keeps its local copy, which the next flush
     * saves.
     */
    const pull = () =>
      calls
        .textComments({ scopeSpaceId, pageId: pageId as PageId })
        .then((result) => {
          if (stopped) return;
          const store = usePageCommentsStore.getState();
          const local = store.commentsByPage[pageKey] ?? [];
          const byId = new Map(local.map((comment) => [comment.id, comment]));
          const next: PageComment[] = [];
          const remoteIds = new Set<string>();
          for (const entry of result.comments) {
            const remote = parseStoredComment(entry.thread, pageKey);
            if (!remote) continue;
            remoteIds.add(remote.id);
            const mine = byId.get(remote.id);
            const unchangedHere =
              !mine || !synced.has(remote.id) || synced.get(remote.id) === storedCommentForm(mine);
            if (unchangedHere || !loaded) {
              // Something new arrived from elsewhere: the thread is unread here again.
              const arrived =
                synced.has(remote.id) && synced.get(remote.id) !== storedCommentForm(remote);
              const taken = { ...remote, read: arrived ? false : (mine?.read ?? true) };
              synced.set(remote.id, storedCommentForm(taken));
              next.push(taken);
            } else next.push(mine);
          }
          for (const comment of local) {
            if (remoteIds.has(comment.id)) continue;
            // Gone on the server and untouched here: another window deleted it.
            if (
              loaded &&
              synced.has(comment.id) &&
              synced.get(comment.id) === storedCommentForm(comment)
            ) {
              synced.delete(comment.id);
              continue;
            }
            next.push(comment);
          }
          usePageCommentsStore.setState({
            commentsByPage: { ...store.commentsByPage, [pageKey]: next },
          });
          loaded = true;
          schedule();
        })
        .catch(() => {
          // No server copy reachable: keep working from this device and try saving later.
          loaded = true;
        });
    void pull();
    const poll = setInterval(() => void pull(), PULL_INTERVAL_MS);
    const unsubscribe = usePageCommentsStore.subscribe((state, previous) => {
      if (state.commentsByPage[pageKey] !== previous.commentsByPage[pageKey]) schedule();
    });
    return () => {
      unsubscribe();
      clearInterval(poll);
      // Changes still waiting go out before the page closes.
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      stopped = true;
    };
  }, [pageId, scopeSpaceId, pageKey, enabled]);
}
