// FILE: SheetComments.tsx
// Purpose: Comments on 电子表格 cells, drawn over the grid: the comment-mode hint, a pin on every
//          commented cell while commenting is on, the new-comment card and the thread card beside
//          the cell, and Moss's answers coming back into the thread.
// Layer: 资料空间 电子表格 (overlay)
// Exports: SheetCommentsLayer, SheetCommentOpen.
// Why: The cards, pins and the "发送给 Moss" flow are the page-comment parts the 幻灯片 and 设计
//      editors use, so a comment looks and works the same in every 资料空间 editor. The grid marks
//      commented cells itself (a corner mark painted with the cells).

import { useEffect, useMemo } from "react";

import {
  usePageCommentsStore,
  type PageComment,
  type PageCommentAuthor,
} from "~/pageCommentsStore";
import { CommentPin, NewCommentCard, ThreadCard } from "../../chat/pageComments/PageComments";
import {
  pageCommentInitials,
  pageCommentMentionsAgent,
  placePageCommentCard,
  placePageCommentPin,
} from "../../chat/pageComments/pageComments.logic";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { DeckCommentAgentReplies, postDeckComment } from "../slides/deckComments";
import {
  openSheetComments,
  sheetCommentAnchor,
  sheetCommentCell,
  sheetCommentLabel,
  type SheetCommentCell,
} from "./sheetComments.logic";

/** What is open: a new comment on a cell, or one thread. */
export type SheetCommentOpen =
  | { readonly kind: "new"; readonly r: number; readonly c: number }
  | { readonly kind: "thread"; readonly id: string };

type Box = { left: number; top: number; width: number; height: number };

export function SheetCommentsLayer(props: {
  readonly pageKey: string;
  readonly pageTitle: string;
  /** The conversation the page came from, for dictation in the comment field. */
  readonly sourceThreadId: string;
  readonly sheet: { readonly id: string; readonly name: string };
  readonly comments: readonly PageComment[];
  readonly commenting: boolean;
  readonly onCommentingChange: (on: boolean) => void;
  readonly open: SheetCommentOpen | null;
  readonly onOpenChange: (open: SheetCommentOpen | null) => void;
  /** Where a cell is, relative to the grid; null when it is not laid out. */
  readonly cellBox: (r: number, c: number) => Box | null;
  readonly pane: { readonly width: number; readonly height: number };
  /** Bumped when the grid scrolls or resizes, so pins follow their cells. */
  readonly geometry: number;
  /** Starts Moss's turn for a comment; resolves to the conversation that answers. */
  readonly ask: ((body: string, cell: SheetCommentCell) => Promise<string | null>) | null;
}) {
  const { pageKey, comments, open, onOpenChange, onCommentingChange } = props;
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () =>
      identity.kind === "authenticated" || identity.kind === "saved"
        ? { name: identity.label, initials: identity.initials }
        : { name: "我", initials: pageCommentInitials("我") },
    [identity],
  );
  const threads = useMemo(() => openSheetComments(comments), [comments]);
  const onSheet = useMemo(
    () =>
      [...threads.values()].flatMap((comment) => {
        const cell = sheetCommentCell(comment);
        return cell && cell.sheetId === props.sheet.id ? [{ comment, cell }] : [];
      }),
    [threads, props.sheet.id],
  );

  // Esc leaves comment mode when no card is open (an open card closes itself first).
  useEffect(() => {
    if (!props.commenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (open) onOpenChange(null);
      else onCommentingChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.commenting, open, onOpenChange, onCommentingChange]);

  const ask = props.ask;
  const askFromComment = (body: string, anchor: { slideId: string; elementId?: string }) => {
    if (!ask) return Promise.resolve(null);
    const [r = "0", c = "0"] = (anchor.elementId ?? "0:0").split(":");
    return ask(body, { sheetId: anchor.slideId, r: Number(r), c: Number(c) });
  };

  // The cards sit beside the cell's right edge, inside the grid.
  const besideCell = (box: Box) =>
    placePageCommentCard({ left: box.left + box.width - 28, top: box.top }, props.pane);
  const openThread = open?.kind === "thread" ? comments.find((c) => c.id === open.id) : undefined;
  const threadCell = openThread ? sheetCommentCell(openThread) : null;
  const threadBox =
    threadCell && threadCell.sheetId === props.sheet.id
      ? props.cellBox(threadCell.r, threadCell.c)
      : null;
  const newBox = open?.kind === "new" ? props.cellBox(open.r, open.c) : null;
  void props.geometry;

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-sheet-comments>
      {props.commenting ? (
        <div className="pointer-events-auto absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-card border border-border bg-popover py-1 pr-1 pl-3 text-ui-sm text-muted-foreground shadow-md">
          <span data-sheet-comment-hint>点按一个单元格来评论。按 Esc 退出。</span>
          <Button size="xs" variant="ghost" onClick={() => onCommentingChange(false)}>
            退出
          </Button>
        </div>
      ) : null}
      {props.commenting
        ? onSheet.map(({ comment, cell }) => {
            const box = props.cellBox(cell.r, cell.c);
            if (!box) return null;
            const pin = placePageCommentPin(
              { x: box.left, y: box.top, width: box.width, height: box.height },
              1,
              props.pane,
            );
            if (!pin) return null;
            return (
              <CommentPin
                key={comment.id}
                comment={comment}
                left={pin.left}
                top={pin.top}
                side={pin.side}
                open={open?.kind === "thread" && open.id === comment.id}
                pulse={false}
                onOpen={() => {
                  onOpenChange({ kind: "thread", id: comment.id });
                  usePageCommentsStore.getState().markPageRead(pageKey);
                }}
              />
            );
          })
        : null}
      {openThread && threadBox ? (
        <ThreadCard
          key={openThread.id}
          comment={openThread}
          position={besideCell(threadBox)}
          pulse={false}
          author={me}
          onReply={(body) =>
            postDeckComment({
              pageKey,
              author: me,
              threadId: openThread.id,
              anchor: null,
              label: openThread.anchor.label,
              body,
              sendToAgent:
                ask !== null &&
                (openThread.sentToAgentAt !== null || pageCommentMentionsAgent(body)),
              ask: askFromComment,
            })
          }
          onDelete={() => {
            usePageCommentsStore.getState().deleteComment(pageKey, openThread.id);
            onOpenChange(null);
          }}
          onClose={() => onOpenChange(null)}
        />
      ) : null}
      {open?.kind === "new" && newBox ? (
        <NewCommentCard
          key={`${open.r}:${open.c}`}
          threadId={props.sourceThreadId}
          pageTitle={props.pageTitle}
          anchor={{
            selector: "",
            label: sheetCommentLabel(props.sheet.name, open.r, open.c),
            text: "",
          }}
          position={besideCell(newBox)}
          onCancel={() => onOpenChange(null)}
          onPost={(body, sendToAgent) => {
            postDeckComment({
              pageKey,
              author: me,
              threadId: null,
              anchor: sheetCommentAnchor({ sheetId: props.sheet.id, r: open.r, c: open.c }),
              label: sheetCommentLabel(props.sheet.name, open.r, open.c),
              body,
              sendToAgent: sendToAgent && ask !== null,
              ask: askFromComment,
            });
            if (sendToAgent && ask === null)
              toastManager.add({
                type: "info",
                title: "评论已保存；这个资料空间还没有可用的 Moss 智能体",
              });
            onOpenChange(null);
          }}
        />
      ) : null}
      <DeckCommentAgentReplies pageKey={pageKey} comments={comments} />
    </div>
  );
}
