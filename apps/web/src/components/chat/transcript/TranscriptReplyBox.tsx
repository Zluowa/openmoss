// FILE: TranscriptReplyBox.tsx
// Purpose: The desktop chat's selection Reply: a small card above the selected text
//          that quotes it and takes a reply ("Reply to the agent"). Enter sends the quote
//          and the reply as one message; Shift+Enter adds a line; Escape closes. The
//          selection stays painted while the card is open.
// Layer: Chat transcript interaction UI
// Exports: TranscriptReplyBox, REPLY_BOX_WIDTH_PX

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ArrowUpIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { buildReplyPrompt } from "./replyQuote";

export const REPLY_BOX_WIDTH_PX = 440;
const REPLY_BOX_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
const HIGHLIGHT_NAME = "moss-reply-selection";

type HighlightRegistry = {
  set: (name: string, value: unknown) => void;
  delete: (name: string) => void;
};

// The Custom Highlight API keeps the quoted words painted after focus moves to the
// reply input, as the desktop chat does; browsers without it simply skip the paint.
function paintSelection(range: Range | null): () => void {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)
    ?.highlights;
  const HighlightCtor = (
    globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (!range || !registry || !HighlightCtor) return () => undefined;
  registry.set(HIGHLIGHT_NAME, new HighlightCtor(range));
  return () => registry.delete(HIGHLIGHT_NAME);
}

export function TranscriptReplyBox(props: {
  quote: string;
  /** The selection's range, for placement and the painted highlight. */
  range: Range | null;
  onSend: (prompt: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null,
  );

  useEffect(() => paintSelection(props.range), [props.range]);

  useLayoutEffect(() => {
    const rect = props.range?.getBoundingClientRect();
    const cardHeight = cardRef.current?.offsetHeight ?? 96;
    const viewportWidth = window.innerWidth;
    const width = Math.min(REPLY_BOX_WIDTH_PX, viewportWidth - VIEWPORT_MARGIN_PX * 2);
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(rect ? rect.left : VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX),
    );
    const above = rect ? rect.top - REPLY_BOX_GAP_PX - cardHeight : VIEWPORT_MARGIN_PX;
    const top = above >= VIEWPORT_MARGIN_PX ? above : (rect?.bottom ?? 0) + REPLY_BOX_GAP_PX;
    setPosition({ left, top, width });
    inputRef.current?.focus();
  }, [props.range]);

  const send = async () => {
    const comment = value.trim();
    if (busy || comment.length === 0) return;
    setBusy(true);
    setFailed(false);
    const sent = await props
      .onSend(buildReplyPrompt(props.quote, comment))
      .catch(() => false)
      .finally(() => setBusy(false));
    if (sent) props.onClose();
    else setFailed(true);
  };

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t("transcript.reply.label")}
      data-transcript-reply-box=""
      className="app-popup-surface fixed z-50 flex flex-col gap-1.5 rounded-xl border border-border p-2.5 shadow-md"
      style={{
        width: position?.width ?? REPLY_BOX_WIDTH_PX,
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <p
        data-reply-quote=""
        className="line-clamp-2 border-s-2 border-border ps-2 text-ui-sm whitespace-pre-wrap break-words text-muted-foreground"
      >
        {props.quote}
      </p>
      <div className="flex items-end gap-1.5">
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          aria-label={t("transcript.reply.label")}
          placeholder={t("transcript.reply.placeholder")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          // Moss sets textareas in the code font; a reply reads in the UI font.
          style={{ fontFamily: "var(--font-ui-family)" }}
          className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-ui leading-6 text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label={t("transcript.reply.send")}
          title={t("transcript.reply.send")}
          disabled={busy || value.trim().length === 0}
          onClick={() => void send()}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background",
            "disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <ArrowUpIcon aria-hidden className="size-3.5" />
        </button>
      </div>
      {failed ? <p role="alert">{t("transcript.reply.sendFailed")}</p> : null}
    </div>,
    document.body,
  );
}
