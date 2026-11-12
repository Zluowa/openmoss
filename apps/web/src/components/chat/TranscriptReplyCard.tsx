// FILE: TranscriptReplyCard.tsx
// Purpose: Desktop chat's selection Reply card: the quoted passage (two lines at most) over a
//          one-line field that grows as the reader types. Enter adds the quote, with the
//          reply if any, to the composer; Ctrl/⌘+Enter sends the reply at once. Escape, or a
//          press outside while the field is empty, closes it.
// Layer: Chat transcript interaction UI

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatBubblePlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  holdEnterUntilRelease,
  SELECTION_POPOVER_SURFACE_CLASS_NAME,
} from "./TranscriptSelectionAction";
import { useReplySelectionHighlight, useSelectionAnchor } from "./transcriptSelectionAnchor";

interface TranscriptReplyCardProps {
  range: Range;
  boundary: HTMLElement | null;
  quote: string;
  /** Adds the quote (and reply) to the composer. Returns false when it could not. */
  onAddToPrompt: (comment: string) => boolean;
  /** Sends the quote with its reply now. Absent when sending now is not possible. */
  onSendReply?: ((comment: string) => boolean) | undefined;
  onDismiss: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function TranscriptReplyCard(props: TranscriptReplyCardProps) {
  const { t } = useTranslation();
  const { onAddToPrompt, onSendReply, onDismiss } = props;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;

  useSelectionAnchor({
    surfaceRef: cardRef,
    range: props.range,
    boundary: props.boundary,
    onLost: onDismiss,
  });
  useReplySelectionHighlight(props.range);

  useEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
  }, []);

  // A press outside closes the card unless the reader has typed a reply: their words are
  // kept until they add, send, or press Escape. Escape and Tab are the card's own while
  // focus is inside it (Tab cycles between the field and the button).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const card = cardRef.current;
      if (event.button !== 0 || !card || card.contains(event.target as Node)) return;
      if (valueRef.current.trim() === "") onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card?.contains(event.target as Node)) return;
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === "Escape") event.stopPropagation();
        return;
      }
      if (event.key === "Tab") {
        const stops = Array.from(
          card.querySelectorAll<HTMLElement>("textarea, button:not([disabled])"),
        );
        if (stops.length === 0) return;
        event.preventDefault();
        const at = stops.indexOf(event.target as HTMLElement);
        const next = event.shiftKey
          ? at <= 0
            ? stops.length - 1
            : at - 1
          : (at + 1) % stops.length;
        stops[next]?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onDismiss]);

  const addToPrompt = useCallback(() => {
    onAddToPrompt(valueRef.current.trim());
  }, [onAddToPrompt]);
  const sendReply = useCallback(() => {
    const comment = valueRef.current.trim();
    // Sending needs words of the reader's own; with none, Ctrl+Enter adds the quote.
    if (comment === "" || !onSendReply) {
      onAddToPrompt(comment);
      return;
    }
    onSendReply(comment);
  }, [onAddToPrompt, onSendReply]);

  const addLabel = t("transcript.reply.addToPrompt");
  const sendLabel = t("transcript.reply.sendReply");
  const chordLabel = isMac ? "⌘ Enter" : "Ctrl+Enter";

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t("transcript.reply.dialogLabel")}
      data-transcript-selection-action="true"
      data-transcript-reply-card="true"
      className={cn(
        SELECTION_POPOVER_SURFACE_CLASS_NAME,
        "fixed top-0 left-0 z-50 flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-1 px-4 py-2.5 outline-none will-change-transform",
      )}
      style={{ visibility: "hidden" }}
      tabIndex={-1}
    >
      <blockquote className="line-clamp-2 border-s-2 border-[color:color-mix(in_srgb,var(--foreground)_22%,transparent)] ps-2 text-ui font-normal text-[var(--color-text-foreground-secondary)] [overflow-wrap:anywhere]">
        {props.quote}
      </blockquote>
      <div className="flex items-center gap-1">
        <textarea
          ref={fieldRef}
          rows={1}
          value={value}
          aria-label={t("transcript.reply.fieldLabel")}
          placeholder={t("transcript.reply.placeholder")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) return;
            // Focus moves to the composer next; a held Enter must not reach it and send.
            holdEnterUntilRelease();
            if (event.ctrlKey || event.metaKey) sendReply();
            else addToPrompt();
          }}
          className="min-w-0 flex-1 resize-none border-none bg-transparent p-0 text-ui leading-[1.25rem] text-[var(--color-text-foreground)] outline-none placeholder:text-muted-foreground focus-visible:outline-hidden"
          style={{
            fontFamily: "var(--font-ui-family)",
            fieldSizing: "content",
            maxHeight: "8lh",
          }}
        />
        <div className="flex h-6 shrink-0 items-center self-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={addLabel}
                  aria-keyshortcuts="Enter"
                  className="text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={addToPrompt}
                >
                  <ChatBubblePlusIcon className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="top">
              <div className="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-0.5 py-0.5">
                <span>{addLabel}</span>
                <span className="text-end text-[var(--color-text-foreground-tertiary)]">Enter</span>
                {onSendReply ? (
                  <>
                    <span>{sendLabel}</span>
                    <span className="text-end text-[var(--color-text-foreground-tertiary)]">
                      {chordLabel}
                    </span>
                  </>
                ) : null}
              </div>
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
