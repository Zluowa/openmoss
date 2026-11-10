// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
// Moss owns the bar: RouteSurfaceHeader (sidebar controls, drag region, window-control and
// traffic-light gutters) and the chat header's title and control sizes.
import type { RefObject, ReactNode } from "react";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { CHAT_HEADER_CONTROL_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { cn } from "~/lib/utils";
import type { RoomBot } from "./host";
import { BotAvatar } from "./host";
import { MossbotGroupAvatar } from "../MossbotGroupAvatar";
import { useMossbotCopy } from "../mossbot.copy";
export function RoomHeader({
  group,
  members,
  onOpenMembers,
  membersTriggerRef,
  navigation,
  menu,
}: {
  group: { name: string; description?: string | undefined };
  members: RoomBot[];
  onOpenMembers: () => void;
  membersTriggerRef: RefObject<HTMLButtonElement | null>;
  navigation: ReactNode;
  menu?: ReactNode;
}) {
  const { t } = useMossbotCopy();
  const SIMPLE_FACES = 3;
  const more = members.length - SIMPLE_FACES;
  const membersLabel = `${t("Manage members")} · ${members.length}`;
  const faces = members.map((bot) => (
    <span key={bot.id} className="rounded-full border-2 border-background bg-background">
      <BotAvatar bot={bot} size={20} />
    </span>
  ));
  return (
    <RouteSurfaceHeader divider={false} className="mossbot-room-header shrink-0">
      <div data-roomhead-row className="flex min-w-0 flex-1 items-center gap-1">
        {navigation}
        <button
          type="button"
          data-room-name
          onClick={() => onOpenMembers()}
          title={t("Group settings")}
          aria-label={`${t("Group settings")} · ${group.name}`}
          aria-haspopup="dialog"
          className={cn(
            CHAT_HEADER_CONTROL_CLASS_NAME,
            "flex min-w-0 items-center gap-2 px-1.5 text-ui text-foreground outline-none [-webkit-app-region:no-drag] hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-ring/60",
          )}
        >
          <MossbotGroupAvatar members={members} className="mossbot-row-avatar" />
          <span className="truncate font-medium">{group.name}</span>
        </button>
        <div className="min-w-0 flex-1" />
        <div
          data-roomhead-controls
          className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
        >
          {menu ?? (
            <button
              ref={membersTriggerRef}
              type="button"
              data-room-faces
              onClick={onOpenMembers}
              title={t("Manage members")}
              aria-label={membersLabel}
              className={cn(
                CHAT_HEADER_CONTROL_CLASS_NAME,
                "flex items-center px-1 hover:bg-[var(--color-background-button-secondary-hover)]",
              )}
            >
              <span className="flex items-center -space-x-1.5">
                {faces.slice(0, SIMPLE_FACES)}
                {more > 0 && (
                  <span className="relative flex h-5 min-w-5 items-center justify-center rounded-full border border-background bg-muted px-1 text-ui-xs font-medium tabular-nums text-muted-foreground">
                    +{more}
                  </span>
                )}
              </span>
            </button>
          )}
        </div>
      </div>
    </RouteSurfaceHeader>
  );
}
