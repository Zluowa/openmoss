// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "~/components/chat/chatTypography";
export interface BubbleJoin {
  above: boolean;
  below: boolean;
}

export function joinedCorners(side: "start" | "end", join: BubbleJoin): string {
  return cn(
    join.above && (side === "start" ? "rounded-ss-[6px]" : "rounded-se-[6px]"),
    join.below && (side === "start" ? "rounded-es-[6px]" : "rounded-ee-[6px]"),
  );
}

export function RoomBubble({
  id,
  user,
  speaker,
  avatar,
  join,
  children,
}: {
  id: string;
  user: boolean;
  speaker?: ReactNode;
  avatar?: ReactNode;
  join: BubbleJoin;
  children: ReactNode;
}) {
  return (
    <div
      data-chat-entry={id}
      className={cn(
        "group flex w-full flex-col",
        user ? "items-end" : "items-start",
        join.above && "-mt-3",
      )}
    >
      {speaker && !join.above && (
        <div
          className={cn("mb-1 px-1 text-ui-xs font-medium text-muted-foreground", avatar && "ml-9")}
        >
          {speaker}
        </div>
      )}
      <div className={cn("flex w-full items-end gap-2", user ? "justify-end" : "justify-start")}>
        {!user && avatar && (
          <span
            aria-hidden="true"
            className={cn("mb-1 flex size-6 shrink-0", join.below && "invisible")}
          >
            {avatar}
          </span>
        )}
        <div
          data-chat-bubble="simple"
          data-author={user ? "user" : "assistant"}
          className={cn(
            "w-fit min-w-9 text-chat leading-relaxed",
            // The user turn is Moss's own bubble; an assistant reply is plain transcript prose.
            user
              ? cn(
                  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                  "max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] bg-[var(--app-user-message-background)] font-normal",
                )
              : "min-w-0 max-w-full py-0.5 text-foreground",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
