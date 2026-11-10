// FILE: ComposerUnconfirmedSendNotice.tsx
// Purpose: Shows a sent message whose delivery is not confirmed yet, re-checks it whenever
//          the connection returns or the thread updates, and lets the person send it again
//          (never twice: the original command id is reused) or discard it back to the composer.
// Layer: Web chat composer notice
// Exports: ComposerUnconfirmedSendNotice

import type { MessageId, ThreadId } from "@moss/contracts";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  confirmUnconfirmedTurnSend,
  discardUnconfirmedTurnSend,
  retryUnconfirmedTurnSend,
  useUnconfirmedTurnSends,
} from "~/lib/unconfirmedTurnSends";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import { onServerWelcome } from "../../wsNativeApi";
import { hasServerReceivedSentMessage } from "../ChatView.logic";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";

export function ComposerUnconfirmedSendNotice({
  threadId,
  onDiscard,
}: {
  threadId: ThreadId;
  /** Receives the discarded message's text so it can go back into the composer. */
  onDiscard: (prompt: string, messageId: MessageId) => void;
}) {
  const { t } = useTranslation();
  const send = useUnconfirmedTurnSends((state) => state.sends[threadId] ?? null);
  const messageId = send?.command.message.messageId ?? null;
  const shownInThread = useStore((state) =>
    messageId === null
      ? false
      : hasServerReceivedSentMessage(getThreadFromState(state, threadId), messageId),
  );
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  // The thread now shows the message: it arrived.
  useEffect(() => {
    if (messageId !== null && shownInThread) {
      useUnconfirmedTurnSends.getState().release(threadId, messageId);
    }
  }, [messageId, shownInThread, threadId]);

  // Check the server's copy now (this also covers a page reload) and after every reconnect.
  useEffect(() => {
    if (messageId === null) return undefined;
    const api = readNativeApi();
    if (!api) return undefined;
    return onServerWelcome(() => {
      void confirmUnconfirmedTurnSend(api.orchestration, threadId);
    });
  }, [messageId, threadId]);

  if (!send) return null;

  const retry = async () => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    const outcome = await retryUnconfirmedTurnSend(api.orchestration, threadId);
    setRefused(outcome === "rejected");
    setBusy(false);
  };
  const discard = () => {
    const discarded = discardUnconfirmedTurnSend(threadId);
    if (discarded) onDiscard(discarded.prompt, discarded.command.message.messageId);
  };

  return (
    <ComposerStackedPanel
      detached
      className={cn(COMPOSER_NOTICE_CONTENT_CLASS_NAME, "mb-2")}
      role="status"
      data-moss-unconfirmed-send={send.command.message.messageId}
    >
      <p className="font-medium text-foreground">{t("chat.unconfirmedSend.title")}</p>
      <p>{t("chat.unconfirmedSend.description")}</p>
      {send.prompt.trim().length > 0 ? (
        <p className="mt-1 line-clamp-2 italic">{send.prompt}</p>
      ) : null}
      {refused ? (
        <p className="mt-1 text-destructive">{t("chat.unconfirmedSend.refused")}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3">
        <button
          type="button"
          className={COMPOSER_INLINE_ACTION_PILL_CLASS_NAME}
          disabled={busy}
          onClick={() => void retry()}
        >
          {busy ? t("chat.unconfirmedSend.checking") : t("chat.unconfirmedSend.retry")}
        </button>
        <button
          type="button"
          className={COMPOSER_INLINE_ACTION_PILL_CLASS_NAME}
          disabled={busy}
          onClick={discard}
        >
          {t("chat.unconfirmedSend.discard")}
        </button>
      </div>
    </ComposerStackedPanel>
  );
}
