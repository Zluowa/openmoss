// FILE: UserImageAttachmentThumbnail.tsx
// Purpose: Square thumbnail for an image a person attached to a message; click opens the
//          expanded preview with the message's other images beside it.
// Layer: Chat UI
// Exports: UserImageAttachmentThumbnail
// Used by: the timeline's user rows and a guest's waiting messages.

import { memo } from "react";

import type { ChatImageAttachment } from "../../types";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { FileEntryIcon } from "./FileEntryIcon";

export const UserImageAttachmentThumbnail = memo(function UserImageAttachmentThumbnail(props: {
  image: ChatImageAttachment;
  userImages: ReadonlyArray<ChatImageAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  /** The timeline re-measures its tail once the image has a size; other hosts need nothing. */
  onTimelineImageLoad?: (() => void) | undefined;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <button
      type="button"
      className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/82 text-left shadow-[0_1px_0_rgba(255,255,255,0.2)_inset] transition-colors hover:bg-background/94"
      aria-label={`Preview ${props.image.name}`}
      title={props.image.name}
      onClick={() => {
        const preview = buildExpandedImagePreview(props.userImages, props.image.id);
        if (!preview) return;
        props.onImageExpand(preview);
      }}
    >
      {props.image.previewUrl ? (
        <img
          src={props.image.previewUrl}
          alt={props.image.name}
          className="size-full object-cover"
          onLoad={props.onTimelineImageLoad}
          onError={props.onTimelineImageLoad}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <FileEntryIcon
            pathValue={props.image.name}
            kind="file"
            theme={props.resolvedTheme}
            className="size-4 opacity-70"
          />
        </div>
      )}
    </button>
  );
});
