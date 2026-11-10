// FILE: TranscriptSelectionActionLayer.tsx
// Purpose: Renders the transcript selection floating action from controller state: the
//          desktop chat's "Start a side chat | Reply" toolbar. Reply puts the quote into
//          the composer as a reference; nothing is sent until the reader sends it there.
// Layer: Chat transcript interaction UI

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTranslation } from "~/localization";
import { toastManager } from "../ui/toast";
import type { TranscriptAssistantSelection } from "./chatSelectionActions";
import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";

interface TranscriptSelectionActionLayerProps {
  action: PendingTranscriptSelectionAction | null;
  canAddToSide: boolean;
  /** A side chat is already open for this chat. */
  sideChatStarted?: boolean | undefined;
  onDismiss: () => void;
  onAddToSide: (selection: TranscriptAssistantSelection) => Promise<void>;
  /**
   * Reply: adds the selection to this chat's composer as a quote and focuses the
   * composer. It must never send; the reader's own Enter or Send does that.
   */
  onQuoteToComposer: () => void;
}

export function TranscriptSelectionActionLayer(props: TranscriptSelectionActionLayerProps) {
  const { t } = useTranslation();
  const [sideBusy, setSideBusy] = useState(false);
  const sideInFlightRef = useRef(false);

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
      onReply={props.onQuoteToComposer}
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
