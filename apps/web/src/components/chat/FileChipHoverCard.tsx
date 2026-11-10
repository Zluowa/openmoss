// FILE: FileChipHoverCard.tsx
// Purpose: The small card a file or page chip in a reply shows on hover, as in the
//          desktop chat: what the file is and when the reply that named it was written
//          on one line, the file's name under it.
// Layer: Chat inline chip UI
// Exports: FileChipHoverCardContent, FILE_CHIP_HOVER_CARD_POPUP_CLASS_NAME
//
// Measured from the desktop chat's compact scale: the popup is 12px of padding around
// a 216px column with 4px between lines; the meta line is the footnote size in the
// secondary tone, the name the body size at a tight leading. It opens below the chip,
// start-aligned, 6px away.

import type { MessageId, ThreadId } from "@moss/contracts";

import { basenameOfPath } from "~/file-icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useStore } from "~/store";

import { chatFileKindLabel, formatChatRelativeTimeAgo } from "./chatFileKind";
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { MentionChipIcon } from "./MentionChipIcon";

export const FILE_CHIP_HOVER_CARD_POPUP_CLASS_NAME = cn(
  APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
  "min-w-50 max-w-90 p-3 text-ui",
);

export const FILE_CHIP_HOVER_CARD_SIDE_OFFSET_PX = 6;

export function FileChipHoverCardContent(props: {
  path: string;
  theme: "light" | "dark";
  threadId?: string | undefined;
  messageId?: string | undefined;
}) {
  const { locale } = useTranslation();
  const { threadId, messageId } = props;
  // Read only while the card is open (this component mounts with the popup).
  const writtenAt = useStore((state) =>
    threadId && messageId
      ? (state.messageByThreadId?.[threadId as ThreadId]?.[messageId as MessageId]?.createdAt ??
        null)
      : null,
  );
  const name = basenameOfPath(props.path) || props.path;
  return (
    <div className="flex w-54 min-w-0 flex-col gap-1" data-file-chip-hover-card>
      <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <MentionChipIcon path={props.path} theme={props.theme} className="size-4 shrink-0" />
        </span>
        <span className="min-w-0 flex-1 truncate">{chatFileKindLabel(props.path)}</span>
        {writtenAt ? (
          <span className="shrink-0 tabular-nums">
            {formatChatRelativeTimeAgo(writtenAt, locale)}
          </span>
        ) : null}
      </div>
      <span
        className="leading-tight text-foreground [overflow-wrap:anywhere]"
        title={props.path}
        data-translation-skip="true"
      >
        {name}
      </span>
    </div>
  );
}
