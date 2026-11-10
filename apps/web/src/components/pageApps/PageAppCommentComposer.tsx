// FILE: PageAppCommentComposer.tsx
// Purpose: Moss's comment composer opened by an 应用页 (`comments.open()`):
// a card beside the element the page pointed at, in Moss's own UI on top of
// the frame, so the page never sees or draws the text box. Posting writes to
// the page's comment store through the `comments` capability.
// Layer: Web pageApps

import { PAGE_APP_COMMENT_MAX_CHARS, type PageAppCommentAnchor } from "@moss/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ArrowUpIcon, XIcon } from "~/lib/icons";

import {
  PAGE_COMMENT_CARD_MAX_HEIGHT,
  PAGE_COMMENT_CARD_WIDTH,
  PAGE_COMMENT_PIN_SIZE,
  placePageCommentCard,
} from "../chat/pageComments/pageComments.logic";
import { IconButton } from "../ui/icon-button";

export interface PageAppComposerPlacement {
  /** The element's box in the Moss window's coordinates. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function pageAppComposerPosition(
  target: PageAppComposerPlacement,
  pane: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const pin = {
    left: Math.min(
      Math.max(target.left + target.width - 4, 8),
      pane.width - PAGE_COMMENT_PIN_SIZE - 8,
    ),
    top: Math.max(target.top - 4, 8),
  };
  return placePageCommentCard(pin, pane);
}

function Composer(props: {
  readonly pageTitle: string;
  readonly anchor: PageAppCommentAnchor;
  readonly position: { readonly left: number; readonly top: number };
  readonly onPost: (body: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const text = body.trim();
  const post = () => {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    props.onPost(text).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "评论没有发出去，请重试。");
    });
  };
  return (
    <div
      role="dialog"
      aria-label="添加评论"
      data-testid="page-app-comment-composer"
      className="pointer-events-auto fixed z-[60] flex flex-col overflow-hidden rounded-panel border border-border bg-popover text-popover-foreground shadow-lg motion-safe:animate-[moss-comment-card-in_280ms_cubic-bezier(.4,0,.2,1)]"
      style={{
        width: PAGE_COMMENT_CARD_WIDTH,
        maxHeight: PAGE_COMMENT_CARD_MAX_HEIGHT,
        ...props.position,
      }}
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground">
          <span className="max-w-[45%] shrink-0 truncate">{props.pageTitle}</span>
          {props.anchor.label ? (
            <>
              <span aria-hidden>›</span>
              <span className="min-w-0 truncate">{props.anchor.label}</span>
            </>
          ) : null}
          <IconButton
            label="取消"
            variant="ghost"
            className="ms-auto size-6 text-muted-foreground"
            onClick={props.onCancel}
          >
            <XIcon />
          </IconButton>
        </div>
        {props.anchor.quote ? (
          <div className="border-s-2 border-border ps-2 text-ui-sm text-muted-foreground line-clamp-2">
            {props.anchor.quote}
          </div>
        ) : null}
        <textarea
          ref={fieldRef}
          aria-label="评论"
          rows={2}
          maxLength={PAGE_APP_COMMENT_MAX_CHARS}
          value={body}
          placeholder="添加评论…"
          className="min-h-12 w-full resize-none bg-transparent text-ui leading-6 text-foreground outline-none [field-sizing:content] max-h-40 placeholder:text-muted-foreground/70"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              post();
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm text-destructive">{error}</span>
          <IconButton
            label="发布评论"
            tooltip="发布（Enter）"
            variant="default"
            className="size-7 rounded-full"
            disabled={!text || busy}
            data-testid="page-app-comment-post"
            onClick={post}
          >
            <ArrowUpIcon />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

let open: { readonly close: () => void } | null = null;

/**
 * Shows the composer once (a second open replaces the first). Resolves the
 * posted body's result, or null when the viewer cancels or the frame goes away.
 */
export function openPageAppCommentComposer<T>(input: {
  readonly pageTitle: string;
  readonly anchor: PageAppCommentAnchor;
  readonly target: PageAppComposerPlacement;
  readonly post: (body: string) => Promise<T>;
  readonly signal: AbortSignal;
}): Promise<T | null> {
  open?.close();
  return new Promise<T | null>((resolve) => {
    const host = document.createElement("div");
    host.dataset.pageAppComposer = "";
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      window.removeEventListener("keydown", onKey, true);
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
      if (open === handle) open = null;
      resolve(value);
    };
    const onAbort = () => finish(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(null);
    };
    const handle = { close: () => finish(null) };
    open = handle;
    input.signal.addEventListener("abort", onAbort);
    window.addEventListener("keydown", onKey, true);
    const position = pageAppComposerPosition(input.target, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    root.render(
      <Composer
        pageTitle={input.pageTitle}
        anchor={input.anchor}
        position={position}
        onPost={async (body) => finish(await input.post(body))}
        onCancel={() => finish(null)}
      />,
    );
  });
}
