// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { RefObject, ReactNode } from "react";
import { ChevronRight } from "./icons";
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
    <span key={bot.id} className="rounded-full border-2 border-background bg-background p-0.5">
      <BotAvatar bot={bot} size={24} />
    </span>
  ));
  return (
    <div className="mossbot-room-header @container/roomhead">
      <div data-roomhead-row className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="shrink-0">{navigation}</div>
        <div data-roomhead-identity className="flex min-w-0 items-center">
          <button
            type="button"
            data-room-name
            onClick={() => onOpenMembers()}
            title={t("Group settings")}
            aria-label={`${t("Group settings")} · ${group.name}`}
            aria-haspopup="dialog"
            className="mossbot-room-identity group flex min-w-0 items-center gap-2"
          >
            <MossbotGroupAvatar members={members} className="mossbot-room-header-avatar" />
            <span className="truncate text-ui font-semibold text-foreground">{group.name}</span>
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="-ml-1 w-0 shrink-0 text-muted-foreground opacity-0 transition-[width,margin,opacity] duration-150 group-hover:ml-0 group-hover:w-3.5 group-hover:opacity-100 group-focus-visible:ml-0 group-focus-visible:w-3.5 group-focus-visible:opacity-100"
            />
          </button>
        </div>
        <div data-roomhead-controls className="flex shrink-0 items-center">
          {menu ?? (
            <button
              ref={membersTriggerRef}
              type="button"
              data-room-faces
              onClick={onOpenMembers}
              title={t("Manage members")}
              aria-label={membersLabel}
              className="flex items-center rounded-full py-0.5 pl-1 pr-1.5 hover:bg-muted/60"
            >
              <span className="flex items-center -space-x-1.5">
                {faces.slice(0, SIMPLE_FACES)}
                {more > 0 && (
                  <span className="relative flex h-6 min-w-6 items-center justify-center rounded-full border border-background bg-muted px-1 text-ui-xs font-medium tabular-nums text-muted-foreground">
                    +{more}
                  </span>
                )}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
