// FILE: GuestPendingMessages.tsx
// Purpose: A guest's waiting messages, as a decision card above the composer. Each one is
//          drawn like a user message (name, text, files) with Dismiss and Send; a sent one
//          becomes an ordinary user message once the server dispatches the turn.
// Layer: Chat composer UI
// Exports: GuestPendingMessages
// Depends on: guestShareStore (share state), nativeApi guestShare.resolveMessage

import type {
  GuestMessageAttachment,
  GuestMessageDecision,
  GuestMessageId,
  ThreadGuestMessage,
  ThreadId,
} from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

import { selectThreadGuestShare, useGuestShareStore } from "~/guestShareStore";
import { useTheme } from "~/hooks/useTheme";
import { UsersIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { resolveAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import { useTranslation } from "~/localization";
import { ensureGuestShareApi } from "~/nativeApi";
import type { ChatImageAttachment } from "../../../types";
import { Button } from "../../ui/button";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "../chatTypography";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "../composerPickerStyles";
import type { ExpandedImagePreview } from "../ExpandedImagePreview";
import { FileAttachmentChip } from "../FileAttachmentChip";
import { UserImageAttachmentThumbnail } from "../UserImageAttachmentThumbnail";
import { describeGuestShareError } from "./guestShare.logic";

const NO_MESSAGES: ReadonlyArray<ThreadGuestMessage> = [];

export function GuestPendingMessages({
  threadId,
  onImageExpand,
}: {
  threadId: ThreadId;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { format, t } = useTranslation();
  const share = useGuestShareStore(selectThreadGuestShare(threadId));
  const pending = useMemo(
    () => share?.messages.filter((message) => message.status === "pending") ?? NO_MESSAGES,
    [share],
  );
  const open = pending.length > 0;
  // The card opens a tick after its first message lands and keeps the last list on screen
  // while it closes, so both edges run through the shared disclosure motion instead of
  // snapping.
  const [revealed, setRevealed] = useState(false);
  const [retained, setRetained] = useState(pending);
  useEffect(() => {
    if (!open) {
      setRevealed(false);
      return;
    }
    setRetained(pending);
    const timeoutId = window.setTimeout(() => setRevealed(true), 0);
    return () => window.clearTimeout(timeoutId);
  }, [open, pending]);
  const shown = open ? pending : retained;
  const [busyIds, setBusyIds] = useState<ReadonlySet<GuestMessageId>>(() => new Set());

  if (shown.length === 0) return null;
  const guestName = share?.guestName ?? t("chat.guestShare.guestFallbackName");
  const heading =
    shown.length === 1
      ? format("chat.guestShare.pending.one", { name: guestName })
      : format("chat.guestShare.pending.many", { name: guestName, count: shown.length });

  const resolve = async (guestMessageId: GuestMessageId, decision: GuestMessageDecision) => {
    setBusyIds((ids) => new Set(ids).add(guestMessageId));
    try {
      await ensureGuestShareApi().resolveMessage({ threadId, guestMessageId, decision });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("chat.guestShare.pending.resolveFailed"),
        description: describeGuestShareError(error, t).message,
        data: { threadId },
      });
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(guestMessageId);
        return next;
      });
    }
  };

  return (
    <DisclosureRegion open={open && revealed}>
      <div className="pb-2">
        <section
          aria-label={heading}
          aria-live="polite"
          data-guest-pending-messages=""
          className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "px-3.5 py-3")}
        >
          <p className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
            <UsersIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{heading}</span>
          </p>
          <ol className="mt-2.5 flex flex-col gap-3">
            {shown.map((message) => (
              <GuestPendingMessageRow
                key={message.id}
                message={message}
                guestName={guestName}
                busy={busyIds.has(message.id)}
                onResolve={resolve}
                onImageExpand={onImageExpand}
              />
            ))}
          </ol>
        </section>
      </div>
    </DisclosureRegion>
  );
}

function GuestPendingMessageRow({
  message,
  guestName,
  busy,
  onResolve,
  onImageExpand,
}: {
  message: ThreadGuestMessage;
  guestName: string;
  busy: boolean;
  onResolve: (guestMessageId: GuestMessageId, decision: GuestMessageDecision) => Promise<void>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { format, t } = useTranslation();
  const { resolvedTheme } = useTheme();
  // Guest files are stored as thread attachments, so they load like a sent message's.
  const images: ChatImageAttachment[] = message.attachments
    .filter(
      (attachment): attachment is Extract<GuestMessageAttachment, { type: "image" }> =>
        attachment.type === "image",
    )
    .map((attachment) => ({
      type: "image",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: resolveAttachmentPreviewUrl(attachment.id),
    }));
  const files = message.attachments.filter((attachment) => attachment.type === "file");
  return (
    <li className="flex flex-col items-end gap-1" data-guest-message-id={message.id}>
      <p className="pe-1 text-ui-xs text-muted-foreground">
        {guestName}
        <span className="sr-only"> · {t("chat.guestShare.pending.guest")}</span>
      </p>
      <div
        className={cn(
          "flex max-w-[85%] flex-col items-end gap-2 border border-dashed border-border bg-transparent text-foreground",
          USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
          USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
        )}
      >
        {images.length > 0 ? (
          <div className="flex max-w-[240px] flex-wrap justify-end gap-2">
            {images.map((image) => (
              <UserImageAttachmentThumbnail
                key={image.id}
                image={image}
                userImages={images}
                onImageExpand={onImageExpand}
                resolvedTheme={resolvedTheme}
              />
            ))}
          </div>
        ) : null}
        {files.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {files.map((file) => (
              <FileAttachmentChip key={file.id} file={file} variant="pill" />
            ))}
          </div>
        ) : null}
        {message.text ? (
          <p className="self-stretch whitespace-pre-wrap text-chat [overflow-wrap:anywhere]">
            {message.text}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1 pe-1">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          aria-label={format("chat.guestShare.pending.dismissNamed", { name: guestName })}
          onClick={() => void onResolve(message.id, "dismiss")}
        >
          {t("chat.guestShare.pending.dismiss")}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={busy}
          aria-label={format("chat.guestShare.pending.sendNamed", { name: guestName })}
          onClick={() => void onResolve(message.id, "send")}
        >
          {busy ? <Spinner className="size-4" /> : null}
          {t("chat.guestShare.pending.send")}
        </Button>
      </div>
    </li>
  );
}
