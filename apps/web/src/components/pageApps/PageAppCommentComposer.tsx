// FILE: PageAppCommentComposer.tsx
// Purpose: Moss's shared non-invasive selection bubble and comment-to-Moss composer rendered in
//          Moss's own host layer above an 应用页 iframe, keeping the app itself untouched while
//          letting users highlight, comment, dictate, and send directly to live Moss chats.
// Layer: Web pageApps

import { PAGE_APP_COMMENT_MAX_CHARS, type PageAppCommentAnchor } from "@moss/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ArrowUpIcon, PageCommentIcon, SparklesIcon, XIcon } from "~/lib/icons";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";

import {
  PAGE_COMMENT_CARD_MAX_HEIGHT,
  PAGE_COMMENT_CARD_WIDTH,
  PAGE_COMMENT_PIN_SIZE,
  pageCommentMentionsAgent,
  placePageCommentCard,
  removePageCommentAgentMention,
} from "../chat/pageComments/pageComments.logic";
import { MossLogoMark } from "../MossLogoMark";
import { PageDictationButton } from "../pages/chrome/PageDictationButton";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { IconButton } from "../ui/icon-button";
import { TooltipProvider } from "../ui/tooltip";

const UI_FONT = { fontFamily: "var(--font-ui-family)" } as const;

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

export function PageAppSelectionBubble(props: {
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly containerWidth: number;
  readonly containerHeight: number;
  readonly onComment: () => void;
  readonly onAskMoss: () => void;
}) {
  const bubbleWidth = 156;
  const rawLeft = props.rect.x + props.rect.width / 2 - bubbleWidth / 2;
  const left = Math.max(8, Math.min(Math.max(8, props.containerWidth - bubbleWidth - 8), rawLeft));
  const preferTop = props.rect.y - 42;
  const top =
    preferTop >= 8
      ? preferTop
      : Math.min(Math.max(8, props.containerHeight - 44), props.rect.y + props.rect.height + 8);
  return (
    <div
      role="toolbar"
      aria-label="选区操作"
      data-testid="page-app-selection-bubble"
      className={cn(
        "pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-full border border-[color:var(--color-border)] bg-popover px-1.5 py-1 text-popover-foreground shadow-xl",
      )}
      style={{ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        size="xs"
        variant="ghost"
        className="h-7 gap-1 rounded-full px-2 text-ui-xs font-medium text-foreground"
        data-testid="page-app-selection-comment-btn"
        onClick={props.onComment}
      >
        <PageCommentIcon className="size-3.5 shrink-0" aria-hidden />
        <span>评论</span>
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="h-7 gap-1 rounded-full px-2 text-ui-xs font-medium text-foreground"
        data-testid="page-app-selection-ask-btn"
        onClick={props.onAskMoss}
      >
        <SparklesIcon className="size-3.5 shrink-0 text-[var(--color-text-accent)]" aria-hidden />
        <span>问 Moss</span>
      </Button>
    </div>
  );
}

function Composer(props: {
  readonly pageTitle: string;
  readonly pageKey?: string;
  readonly anchor: PageAppCommentAnchor;
  readonly position: { readonly left: number; readonly top: number };
  readonly canSendToMoss?: boolean;
  readonly defaultSendToAgent?: boolean;
  readonly onPost: (body: string, options: { readonly sendToAgent: boolean }) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [sendToAgent, setSendToAgent] = useState(
    Boolean(props.canSendToMoss && props.defaultSendToAgent),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const text = body.trim();
  const effectiveSendToAgent = Boolean(props.canSendToMoss && sendToAgent);
  const post = () => {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    props.onPost(text, { sendToAgent: effectiveSendToAgent }).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "评论没有发出去，请重试。");
    });
  };
  return (
    <div
      role="dialog"
      aria-label="添加评论"
      data-testid="page-app-comment-composer"
      className="pointer-events-auto fixed z-[60] flex flex-col overflow-hidden rounded-panel border border-[color:var(--color-border)] bg-popover text-popover-foreground shadow-xl motion-safe:animate-[moss-comment-card-in_280ms_cubic-bezier(.4,0,.2,1)]"
      style={{
        width: PAGE_COMMENT_CARD_WIDTH,
        maxHeight: PAGE_COMMENT_CARD_MAX_HEIGHT,
        ...props.position,
      }}
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
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
          <div className="rounded-control border-s-2 border-[color-mix(in_srgb,var(--color-text-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-2.5 py-1.5 text-ui-sm text-foreground line-clamp-3 dark:bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]">
            {props.anchor.quote}
          </div>
        ) : null}
        <div className="flex flex-wrap items-start gap-1.5">
          {effectiveSendToAgent ? (
            <span
              data-page-app-comment-mention
              className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--color-text-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_8%,transparent)] px-2 text-ui-xs font-medium text-[var(--color-text-accent)]"
            >
              @Moss
            </span>
          ) : null}
          <textarea
            ref={fieldRef}
            aria-label="评论内容"
            rows={2}
            maxLength={PAGE_APP_COMMENT_MAX_CHARS}
            value={body}
            placeholder={props.canSendToMoss ? "使用 @ 提及 Moss，或提出修改建议…" : "添加评论…"}
            style={UI_FONT}
            className="max-h-36 min-h-10 min-w-24 flex-1 resize-none bg-transparent text-ui leading-6 text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
            onChange={(event) => {
              const value = event.target.value;
              if (props.canSendToMoss && pageCommentMentionsAgent(value)) {
                setSendToAgent(true);
                setBody(removePageCommentAgentMention(value));
              } else {
                setBody(value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !isImeComposingKeyEvent(event)) {
                event.preventDefault();
                post();
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onCancel();
              }
            }}
          />
        </div>
        {error ? <span className="truncate text-ui-xs text-destructive">{error}</span> : null}
        <div className="flex items-center gap-1.5 pt-0.5">
          {props.canSendToMoss ? (
            <label className="flex min-w-0 flex-1 cursor-interaction items-center gap-1.5 text-ui-sm text-foreground">
              <Checkbox
                checked={sendToAgent}
                onCheckedChange={(checked) => setSendToAgent(checked === true)}
                data-testid="page-app-comment-send-to-moss"
              />
              <MossLogoMark className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">发送给 Moss</span>
            </label>
          ) : (
            <span className="flex-1" />
          )}
          <div data-testid="page-app-comment-mic">
            <PageDictationButton
              pageKey={props.pageKey ?? "app-comment"}
              disabled={busy}
              onText={(spoken) => setBody((current) => (current ? `${current} ${spoken}` : spoken))}
            />
          </div>
          <IconButton
            label="发布评论"
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
  readonly pageKey?: string;
  readonly anchor: PageAppCommentAnchor;
  readonly target: PageAppComposerPlacement;
  readonly canSendToMoss?: boolean;
  readonly defaultSendToAgent?: boolean;
  readonly post: (body: string, options: { readonly sendToAgent: boolean }) => Promise<T>;
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
      <TooltipProvider>
        <Composer
          pageTitle={input.pageTitle}
          {...(input.pageKey ? { pageKey: input.pageKey } : {})}
          anchor={input.anchor}
          position={position}
          {...(input.canSendToMoss !== undefined ? { canSendToMoss: input.canSendToMoss } : {})}
          {...(input.defaultSendToAgent !== undefined
            ? { defaultSendToAgent: input.defaultSendToAgent }
            : {})}
          onPost={async (body, options) => finish(await input.post(body, options))}
          onCancel={() => finish(null)}
        />
      </TooltipProvider>,
    );
  });
}
