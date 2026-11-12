// FILE: TranscriptSelectionActionLayer.tsx
// Purpose: Renders the transcript selection surfaces from controller state, as desktop chat
//          does: the "Start a side chat | Reply" pill, then, after Reply, the Reply card on
//          the same text. The card's Enter adds the quote (with any reply) to the composer;
//          nothing is sent unless the reader sends it (Ctrl/⌘+Enter in the card, or later).
// Layer: Chat transcript interaction UI

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTranslation } from "~/localization";
import { toastManager } from "../ui/toast";
import type { TranscriptAssistantSelection } from "./chatSelectionActions";
import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { TranscriptReplyCard } from "./TranscriptReplyCard";
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";

interface TranscriptSelectionActionLayerProps {
  action: PendingTranscriptSelectionAction | null;
  canAddToSide: boolean;
  /** A side chat is already open for this chat. */
  sideChatStarted?: boolean | undefined;
  onDismiss: () => void;
  onAddToSide: (selection: TranscriptAssistantSelection) => Promise<void>;
  /** Reply on the pill: opens the Reply card on the selection. */
  onOpenReply: () => void;
  /**
   * The card's "Add to prompt": adds the selection, with the reader's reply if any, to this
   * chat's composer as a quote and focuses the composer. It never sends.
   */
  onQuoteToComposer: (comment: string) => boolean;
  /** The card's "Send reply": sends the quote with the reply now. */
  onSendReply?: ((comment: string) => boolean) | undefined;
}

export function TranscriptSelectionActionLayer(props: TranscriptSelectionActionLayerProps) {
  const { t } = useTranslation();
  const [sideBusy, setSideBusy] = useState(false);
  const sideInFlightRef = useRef(false);

  const action = props.action;
  if (!action) return null;

  if (action.mode === "reply" && action.range) {
    return createPortal(
      <TranscriptReplyCard
        key={`${action.selection.assistantMessageId}:${action.selection.text}`}
        range={action.range}
        boundary={action.boundary}
        quote={action.selection.text}
        onAddToPrompt={props.onQuoteToComposer}
        onSendReply={props.onSendReply}
        onDismiss={props.onDismiss}
      />,
      document.body,
    );
  }

  return createPortal(
    <TranscriptSelectionAction
      anchor={action.range ? { range: action.range, boundary: action.boundary } : undefined}
      left={action.left}
      top={action.top}
      placement={action.placement}
      disabled={sideBusy}
      sideDisabled={!props.canAddToSide}
      sideChatStarted={props.sideChatStarted}
      onLost={props.onDismiss}
      onReply={props.onOpenReply}
      onAddToSide={() => {
        if (sideInFlightRef.current) return;
        sideInFlightRef.current = true;
        setSideBusy(true);
        void props
          .onAddToSide(action.selection)
          .then(() => {
            props.onDismiss();
            window.getSelection()?.removeAllRanges();
          })
          .catch(() => {
            toastManager.add({
              type: "error",
              title: t("transcript.selection.sideChatFailed"),
            });
          })
          .finally(() => {
            sideInFlightRef.current = false;
            setSideBusy(false);
          });
      }}
    />,
    document.body,
  );
}
