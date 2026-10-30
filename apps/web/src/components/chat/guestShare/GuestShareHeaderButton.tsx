// FILE: GuestShareHeaderButton.tsx
// Purpose: The chat header's Share control. Idle it reads "Share"; with a live guest share
//          it reads "Sharing" with the share's status dot and the count of waiting
//          messages. Either way it opens the Share with guest dialog.
// Layer: Chat shell header
// Exports: GuestShareHeaderButton

import { pendingGuestMessageCount, type ThreadId } from "@synara/contracts";

import { openGuestShareDialog } from "~/guestShareDialogStore";
import { selectThreadGuestShare, useGuestShareStore } from "~/guestShareStore";
import { useNowMs } from "~/hooks/useNowMs";
import { ShareOsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { StatusDot } from "../../ui/status-chip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ChatHeaderButton, ChatHeaderIconButton } from "../chatHeaderControls";
import {
  GUEST_SHARE_INDICATOR_DOT_CLASS_NAME,
  resolveGuestShareIndicatorTone,
} from "./guestShare.logic";

/**
 * Ghost toolbar button with the share mark at `icon-xs`, label
 * `codex.sharedSnapshot.shareHeaderButton` ("Share" / "分享"). Moss shares the thread with
 * a guest through the share relay instead of publishing a snapshot.
 */
export function GuestShareHeaderButton({
  threadId,
  compact,
}: {
  threadId: ThreadId;
  /** Narrow headers keep the icon and move the label into the tooltip. */
  compact: boolean;
}) {
  const { format, t } = useTranslation();
  const share = useGuestShareStore(selectThreadGuestShare(threadId));
  const nowMs = useNowMs(share !== null, 60_000);
  const tone = share === null ? null : resolveGuestShareIndicatorTone(share, nowMs);
  const sharing = share !== null && tone !== null;
  const pendingCount = sharing ? pendingGuestMessageCount(share) : 0;
  const label = sharing ? t("chat.header.sharing") : t("chat.header.share");
  const tooltip = sharing
    ? [
        share.guestName !== null
          ? format("chat.guestShare.header.joined", { name: share.guestName })
          : t("chat.guestShare.header.sharing"),
        pendingCount > 0 ? format("chat.guestShare.header.pending", { count: pendingCount }) : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")
    : t("chat.guestShare.title");
  const open = () => openGuestShareDialog(threadId);
  const dot = tone ? (
    <StatusDot
      data-guest-share-tone={tone}
      className={cn(
        GUEST_SHARE_INDICATOR_DOT_CLASS_NAME[tone],
        compact && "absolute -top-px -right-px",
      )}
      pulse={share?.relayStatus === "connecting"}
    />
  ) : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          compact ? (
            <ChatHeaderIconButton
              type="button"
              tone="plain"
              label={tooltip}
              className="relative overflow-visible !text-[rgb(136,137,138)]"
              onClick={open}
            >
              <ShareOsIcon className="size-4" />
              {dot}
            </ChatHeaderIconButton>
          ) : (
            <ChatHeaderButton
              type="button"
              tone="plain"
              aria-label={tooltip}
              className="gap-1.5 px-2 !text-[rgb(136,137,138)]"
              onClick={open}
            >
              <ShareOsIcon className="size-4" />
              {label}
              {dot}
              {pendingCount > 0 ? (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-ui-xs tabular-nums text-amber-700 dark:text-amber-300">
                  {pendingCount}
                </span>
              ) : null}
            </ChatHeaderButton>
          )
        }
      />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
