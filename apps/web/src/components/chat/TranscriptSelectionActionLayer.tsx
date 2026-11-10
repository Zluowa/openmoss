// FILE: TranscriptSelectionActionLayer.tsx
// Purpose: Renders the transcript selection floating action from controller state: the
//          desktop chat's "Start a side chat | Reply" toolbar, and the reply box that
//          Reply opens above the selection.
// Layer: Chat transcript interaction UI

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTranslation } from "~/localization";
import { toastManager } from "../ui/toast";
import type { TranscriptAssistantSelection } from "./chatSelectionActions";
import { TranscriptReplyBox } from "./transcript/TranscriptReplyBox";
import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";

interface TranscriptSelectionActionLayerProps {
  action: PendingTranscriptSelectionAction | null;
  canAddToSide: boolean;
  /** A side chat is already open for this chat. */
  sideChatStarted?: boolean | undefined;
  onDismiss: () => void;
  onAddToSide: (selection: TranscriptAssistantSelection) => Promise<void>;
  /** Sends the reply (quote + comment) as a message in this chat. */
  onSendReply: (prompt: string) => Promise<boolean>;
}

interface PendingReply {
  quote: string;
  range: Range | null;
}

function captureSelectionRange(): Range | null {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
}

export function TranscriptSelectionActionLayer(props: TranscriptSelectionActionLayerProps) {
  const { t } = useTranslation();
  const [reply, setReply] = useState<PendingReply | null>(null);
  const [sideBusy, setSideBusy] = useState(false);
  const sideInFlightRef = useRef(false);

  if (reply) {
    return (
      <TranscriptReplyBox
        quote={reply.quote}
        range={reply.range}
        onSend={props.onSendReply}
        onClose={() => setReply(null)}
      />
    );
  }
  const action = props.action;
  if (!action) return null;

  return createPortal(
    <TranscriptSelectionAction
      left={action.left}
      top={action.top}
      placement={action.placement}
      disabled={sideBusy}
      sideDisabled={!props.canAddToSide}
      sideChatStarted={props.sideChatStarted}
      onReply={() => {
        setReply({ quote: action.selection.text, range: captureSelectionRange() });
        props.onDismiss();
        window.getSelection()?.removeAllRanges();
      }}
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
