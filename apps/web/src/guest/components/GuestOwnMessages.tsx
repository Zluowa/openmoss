// FILE: GuestOwnMessages.tsx
// Purpose: The guest's own proposals, drawn like the owner's waiting-messages card above the
//          composer: each as a user bubble with its files, plus what happened to it.
// Layer: Guest page UI
// Depends on: the same bubble, thumbnail, and chip primitives as GuestPendingMessages.

import type { GuestMessageAttachment, ThreadGuestMessage } from "@synara/contracts";

import { useTheme } from "~/hooks/useTheme";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { FileAttachmentChip } from "~/components/chat/FileAttachmentChip";
import { UserImageAttachmentThumbnail } from "~/components/chat/UserImageAttachmentThumbnail";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "~/components/chat/chatTypography";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { CheckIcon, ClockIcon, UsersIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { resolveAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import { useTranslation } from "~/localization";
import type { ChatImageAttachment } from "~/types";

const STATUS: Record<
  ThreadGuestMessage["status"],
  { readonly icon: typeof ClockIcon; readonly className: string }
> = {
  pending: { icon: ClockIcon, className: "text-warning" },
  sent: { icon: CheckIcon, className: "text-success" },
  dismissed: { icon: XIcon, className: "text-muted-foreground" },
};

function OwnMessageRow({
  message,
  onImageExpand,
}: {
  readonly message: ThreadGuestMessage;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  // A dismissed message's files are deleted on the owner's side; only their names remain.
  const served = message.status !== "dismissed";
  const images: ChatImageAttachment[] = message.attachments
    .filter(
      (attachment): attachment is Extract<GuestMessageAttachment, { type: "image" }> =>
        attachment.type === "image",
    )
    .map((attachment) => {
      const image: ChatImageAttachment = {
        type: "image",
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      if (served) image.previewUrl = resolveAttachmentPreviewUrl(attachment.id);
      return image;
    });
  const files = message.attachments.filter((attachment) => attachment.type === "file");
  const status = STATUS[message.status];
  const StatusIcon = status.icon;
  const dismissed = message.status === "dismissed";
  return (
    <li className="flex flex-col items-end gap-1" data-guest-own-message-id={message.id}>
      <p className="pe-1 text-ui-xs text-muted-foreground">{t("guest.own.you")}</p>
      <div
        className={cn(
          "flex max-w-[85%] flex-col items-end gap-2 border text-foreground",
          message.status === "pending"
            ? "border-dashed border-border bg-transparent"
            : "border-transparent bg-[var(--app-user-message-background)]",
          dismissed && "text-muted-foreground",
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
            {files.map((file) =>
              served ? (
                <a
                  key={file.id}
                  href={resolveAttachmentPreviewUrl(file.id)}
                  download={file.name}
                  className="rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileAttachmentChip file={file} variant="pill" />
                </a>
              ) : (
                <FileAttachmentChip
                  key={file.id}
                  file={file}
                  variant="pill"
                  className="opacity-70"
                />
              ),
            )}
          </div>
        ) : null}
        {message.text ? (
          <p
            className={cn(
              "self-stretch whitespace-pre-wrap text-ui leading-relaxed [overflow-wrap:anywhere]",
              dismissed && "line-through decoration-muted-foreground/50",
            )}
          >
            {message.text}
          </p>
        ) : null}
      </div>
      <p className={cn("flex items-center gap-1 pe-1 text-ui-xs", status.className)} role="status">
        <StatusIcon className="size-3.5" />
        {t(`guest.own.status.${message.status}`)}
      </p>
    </li>
  );
}

/** Renders inside the composer column, above the input, like the owner's decision card. */
export function GuestOwnMessages({
  messages,
  onImageExpand,
}: {
  readonly messages: ReadonlyArray<ThreadGuestMessage>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { t, format } = useTranslation();
  const open = messages.length > 0;
  const pendingCount = messages.filter((message) => message.status === "pending").length;
  const heading =
    pendingCount === 0
      ? t("guest.own.heading")
      : pendingCount === 1
        ? t("guest.own.pendingOne")
        : format("guest.own.pendingMany", { count: pendingCount });
  return (
    <DisclosureRegion open={open}>
      <div className="pb-2">
        <section
          aria-label={heading}
          aria-live="polite"
          data-guest-own-messages=""
          className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "px-3.5 py-3")}
        >
          <p className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
            <UsersIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{heading}</span>
          </p>
          <ol className="mt-2.5 flex flex-col gap-3">
            {messages.map((message) => (
              <OwnMessageRow key={message.id} message={message} onImageExpand={onImageExpand} />
            ))}
          </ol>
        </section>
      </div>
    </DisclosureRegion>
  );
}
