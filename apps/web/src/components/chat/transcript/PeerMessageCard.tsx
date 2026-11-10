// FILE: PeerMessageCard.tsx
// Purpose: A message another Moss thread's agent sent into this one (moss_send_message),
//          drawn as the desktop chat draws a peer session's message: one quiet line,
//          "Received message from <thread> ▸", collapsed until opened. The body keeps
//          the sender's text; a long one is clamped behind a fade with Show more.
// Layer: Chat transcript card
// Exports: PeerMessageCard, PEER_MESSAGE_CLAMP_CHARS

import type { MessageId, ThreadId } from "@moss/contracts";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { TranscriptDisclosureRow, useTranscriptDisclosureState } from "./TranscriptDisclosureRow";
import { TranscriptThreadLink, useTranscriptThreadLabel } from "./TranscriptThreadChip";

/** Bodies longer than this open clamped (16rem, faded) with a Show more toggle. */
export const PEER_MESSAGE_CLAMP_CHARS = 1200;

const CLAMPED_BODY_CLASS_NAME =
  "max-h-64 overflow-clip [mask-image:linear-gradient(to_bottom,black_calc(100%_-_3rem),transparent)]";

export function PeerMessageCard(props: {
  messageId: MessageId;
  sourceThreadId: ThreadId;
  /** Length of the sender's text, which decides clamping. */
  textLength: number;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** The rendered message body (markdown with mentions). */
  children: ReactNode;
}) {
  const { t, format } = useTranslation();
  const [open, setOpen] = useTranscriptDisclosureState(`peer:${props.messageId}`);
  const [showAll, setShowAll] = useState(false);
  const senderTitle = useTranscriptThreadLabel(props.sourceThreadId);
  const senderName = senderTitle ?? t("transcript.peer.anotherThread");
  const clampable = props.textLength > PEER_MESSAGE_CLAMP_CHARS;
  const clamped = clampable && !showAll;
  return (
    <TranscriptDisclosureRow
      verb={t("transcript.peer.receivedFrom")}
      subject={
        <TranscriptThreadLink
          threadId={props.sourceThreadId}
          fallbackLabel={senderName}
          onOpenThread={props.onOpenThread}
        />
      }
      open={open}
      onOpenChange={setOpen}
      toggleLabel={format(open ? "transcript.peer.hideFrom" : "transcript.peer.showFrom", {
        sender: senderName,
      })}
      className="peer-message-card"
    >
      <div
        data-peer-message-body=""
        inert={clamped}
        className={cn("min-w-0 select-text text-foreground", clamped && CLAMPED_BODY_CLASS_NAME)}
      >
        {props.children}
      </div>
      {clampable ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="self-start rounded-inline px-1 text-ui-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {showAll ? t("transcript.showLess") : t("transcript.showMore")}
        </button>
      ) : null}
    </TranscriptDisclosureRow>
  );
}
