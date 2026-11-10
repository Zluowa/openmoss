import type { ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ProjectAgentSummary, MossbotRoom } from "@moss/contracts";
import { useSidebar } from "~/components/ui/sidebar";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { usePinnedProjectAgentsStore } from "~/pinnedProjectAgentsStore";
import { useStore } from "~/store";
import { PinIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MossbotAvatar } from "./MossbotAvatar";
import { MossbotGroupAvatar } from "./MossbotGroupAvatar";
import { MossbotAssistantMenu } from "./MossbotAssistantMenu";
import { MossbotRoomMenu } from "./MossbotRoomMenu";
import { useMossbotRoomList } from "./MossbotRooms";
import { MossbotFolderSection } from "./MossbotConversationFolders";
import { useMossbotCopy } from "./mossbot.copy";
import { isMossbot, mossbotStatus } from "./mossbot.logic";

function ConversationRow({
  name,
  avatar,
  preview,
  at,
  pinned,
  unread,
  active,
  compact,
  onOpen,
  disabled,
  menu,
  kind,
}: {
  name: string;
  avatar: ReactNode;
  preview: string;
  at?: string | undefined;
  pinned: boolean;
  unread: boolean;
  active: boolean;
  compact: boolean;
  onOpen: () => void;
  disabled?: boolean | undefined;
  menu: ReactNode;
  kind: "assistant" | "room";
}) {
  const { t, locale } = useMossbotCopy();
  const date = at ? new Date(at) : null;
  const timestamp =
    date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
      : null;
  return (
    <li
      className="mossbot-list-item"
      data-conversation-kind={kind}
      data-active={active || undefined}
      data-compact={compact || undefined}
      onContextMenu={(event) => {
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
          "[data-slot=menu-trigger]",
        );
        if (trigger) {
          event.preventDefault();
          trigger.click();
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-current={active ? "page" : undefined}
        className="mossbot-assistant-row"
        onClick={onOpen}
      >
        {avatar}
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-2">
            <span className="truncate text-ui-lg font-medium">{name}</span>
            {pinned && (
              <PinIcon className="size-3 text-muted-foreground" aria-label={t("Pinned")} />
            )}
          </span>
          {!compact && (
            <span className="mt-1 block truncate text-ui-sm text-muted-foreground">
              {preview.replace(/\s+/g, " ")}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-2">
          {!compact && timestamp && (
            <time dateTime={at} className="text-ui-xs text-muted-foreground">
              {timestamp}
            </time>
          )}
          {unread && <span className="mossbot-unread-dot" aria-label={t("Unread")} />}
        </span>
      </button>
      {menu}
    </li>
  );
}

function AssistantRow({
  assistant,
  active,
  compact,
  onOpen,
  onNewRoom,
}: {
  assistant: ProjectAgentSummary;
  active: boolean;
  compact: boolean;
  onOpen: () => void;
  onNewRoom: () => void;
}) {
  const { t } = useMossbotCopy();
  const id = assistant.coordinatorThreadId;
  const thread = useStore((state) => (id ? state.sidebarThreadSummaryById[id] : undefined));
  const preview = useStore((state) => {
    if (!id) return undefined;
    const lastId = state.messageIdsByThreadId?.[id]?.at(-1);
    return lastId ? state.messageByThreadId?.[id]?.[lastId]?.text : undefined;
  });
  const pinned = usePinnedProjectAgentsStore((s) =>
    s.pinnedProjectAgentIds.includes(assistant.projectId),
  );
  const manualUnread = useMossbotPreferencesStore((s) =>
    s.unreadProjectIds.includes(assistant.projectId),
  );
  const unread =
    manualUnread ||
    Boolean(
      thread?.latestTurn?.completedAt &&
      (!thread.lastVisitedAt || thread.latestTurn.completedAt > thread.lastVisitedAt),
    );
  return (
    <ConversationRow
      name={assistant.coordinatorName ?? "Moss"}
      kind="assistant"
      avatar={
        <MossbotAvatar
          icon={assistant.coordinatorIcon}
          color={assistant.coordinatorColor}
          className="mossbot-list-avatar"
        />
      }
      preview={preview || t(mossbotStatus(assistant))}
      at={thread?.updatedAt ?? thread?.createdAt}
      pinned={pinned}
      unread={unread}
      active={active}
      compact={compact}
      onOpen={onOpen}
      disabled={!id}
      menu={compact ? null : <MossbotAssistantMenu assistant={assistant} onNewGroup={onNewRoom} />}
    />
  );
}

function RoomRow({
  room,
  active,
  compact,
  onOpen,
}: {
  room: MossbotRoom;
  active: boolean;
  compact: boolean;
  onOpen: () => void;
}) {
  const { t } = useMossbotCopy();
  const pinned = useMossbotPreferencesStore((s) => s.pinnedRoomIds.includes(room.id));
  const manualUnread = useMossbotPreferencesStore((s) => s.unreadRoomIds.includes(room.id));
  const visited = useMossbotPreferencesStore((s) => s.lastVisitedRoomAt[room.id]);
  const last = room.lines.at(-1);
  const working = room.deliveries.some((d) => d.state === "running" || d.state === "queued");
  return (
    <ConversationRow
      name={room.name}
      kind="room"
      avatar={<MossbotGroupAvatar members={room.members.filter((m) => !m.hidden)} />}
      preview={
        working
          ? t("Working")
          : last?.text || `${room.members.filter((m) => !m.hidden).length} ${t("members")}`
      }
      at={last?.createdAt ?? room.createdAt}
      pinned={pinned}
      unread={manualUnread || Boolean(!active && last && (!visited || last.createdAt > visited))}
      active={active}
      compact={compact}
      onOpen={onOpen}
      menu={compact ? null : <MossbotRoomMenu room={room} />}
    />
  );
}

type Entry =
  | { key: `assistant:${string}`; assistant: ProjectAgentSummary; room?: never }
  | { key: `room:${string}`; room: MossbotRoom; assistant?: never };

/** One mixed, grouped roster for the phone landing and desktop sidebar. */
export function MossbotConversationRoster({
  query = "",
  showHidden = false,
  showArchived = false,
  activeProjectId,
  activeRoomId,
  sidebar = false,
  compact = false,
  onNewRoom,
}: {
  query?: string;
  showHidden?: boolean;
  showArchived?: boolean;
  activeProjectId?: string | null | undefined;
  activeRoomId?: string | undefined;
  sidebar?: boolean;
  compact?: boolean;
  onNewRoom: (memberId?: string) => void;
}) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const routeRoomId = useRouterState({
    select: (s) => (s.location.search as { room?: string }).room,
  });
  const selectedRoomId = activeRoomId ?? routeRoomId;
  const { isMobile, setOpenMobile } = useSidebar();
  const { summariesByProjectId, loaded, loadFailed } = useProjectAgentSummaries();
  const rooms = useMossbotRoomList();
  const folders = useMossbotPreferencesStore((s) => s.folders);
  const assignment = useMossbotPreferencesStore((s) => s.folderByConversation);
  const hiddenIds = useMossbotPreferencesStore((s) => s.hiddenProjectIds);
  const hiddenRoomIds = useMossbotPreferencesStore((s) => s.hiddenRoomIds);
  const pinnedRooms = useMossbotPreferencesStore((s) => s.pinnedRoomIds);
  const pinnedBots = usePinnedProjectAgentsStore((s) => s.pinnedProjectAgentIds);
  const summaries = useStore((s) => s.sidebarThreadSummaryById);
  const search = query.trim().toLocaleLowerCase();
  const entries: Entry[] = [
    ...[...summariesByProjectId.values()]
      .filter(
        (bot) =>
          isMossbot(bot) &&
          (showArchived || !bot.archivedAt) &&
          (showHidden || !hiddenIds.includes(bot.projectId)),
      )
      .map((assistant): Entry => ({ key: `assistant:${assistant.projectId}`, assistant })),
    ...(rooms.data ?? [])
      .filter((room) => showHidden || !hiddenRoomIds.includes(room.id))
      .map((room): Entry => ({ key: `room:${room.id}`, room })),
  ];
  const pinned = (entry: Entry) =>
    entry.assistant
      ? pinnedBots.includes(entry.assistant.projectId)
      : pinnedRooms.includes(entry.room.id);
  const at = (entry: Entry) =>
    entry.assistant
      ? ((entry.assistant.coordinatorThreadId
          ? summaries[entry.assistant.coordinatorThreadId]?.updatedAt
          : "") ?? "")
      : (entry.room.lines.at(-1)?.createdAt ?? entry.room.createdAt);
  const visible = entries
    .filter((entry) =>
      (entry.assistant?.coordinatorName ?? entry.room?.name ?? "")
        .toLocaleLowerCase()
        .includes(search),
    )
    .toSorted((a, b) => Number(pinned(b)) - Number(pinned(a)) || at(b).localeCompare(at(a)));
  const render = (entry: Entry) =>
    entry.assistant ? (
      <AssistantRow
        key={entry.key}
        assistant={entry.assistant}
        active={activeProjectId === entry.assistant.projectId}
        compact={compact}
        onNewRoom={() => onNewRoom(entry.assistant.projectId)}
        onOpen={() => {
          if (!entry.assistant.coordinatorThreadId) return;
          useMossbotPreferencesStore.getState().setUnread(entry.assistant.projectId, false);
          void navigate({
            to: "/$threadId",
            params: { threadId: entry.assistant.coordinatorThreadId },
          });
          if (isMobile) setOpenMobile(false);
        }}
      />
    ) : (
      <RoomRow
        key={entry.key}
        room={entry.room}
        active={selectedRoomId === entry.room.id}
        compact={compact}
        onOpen={() => {
          useMossbotPreferencesStore.getState().visitRoom(entry.room.id);
          void navigate({ to: "/mossbot", search: { room: entry.room.id } });
          if (isMobile) setOpenMobile(false);
        }}
      />
    );
  const ungrouped = visible.filter((entry) => !folders.some((f) => f.id === assignment[entry.key]));
  // A failed assistant list ends the wait too: the rooms still show, with the reason.
  const loading = (!loaded && !loadFailed) || rooms.isPending;
  const assistantsFailed = !loaded && loadFailed;
  return (
    <div
      data-mossbot-roster
      role="region"
      aria-busy={loading}
      className={cn("mossbot-conversation-roster", sidebar && "mossbot-sidebar-roster")}
      aria-label={t("Conversations")}
    >
      {folders.length ? (
        <>
          {folders.map((folder) => {
            const rows = visible.filter((entry) => assignment[entry.key] === folder.id);
            return search && !rows.length ? null : (
              <MossbotFolderSection
                key={folder.id}
                folder={folder}
                count={rows.length}
                searching={Boolean(search)}
              >
                {rows.map(render)}
                {!rows.length && (
                  <li className="px-4 py-3 text-ui-sm text-muted-foreground">
                    {t("Move conversations here from their menu.")}
                  </li>
                )}
              </MossbotFolderSection>
            );
          })}
          {ungrouped.length > 0 && (
            <MossbotFolderSection count={ungrouped.length} searching={Boolean(search)}>
              {ungrouped.map(render)}
            </MossbotFolderSection>
          )}
        </>
      ) : (
        <ul className="mossbot-assistant-list">{visible.map(render)}</ul>
      )}
      {/* The compact list under the sidebar entry fills in quietly, like recents. */}
      {loading && !compact && (
        <p role="status" className="px-4 py-6 text-ui-sm text-muted-foreground">
          {t("Loading conversations…")}
        </p>
      )}
      {loaded && rooms.isSuccess && visible.length === 0 && (
        <p className="px-4 py-6 text-ui-sm text-muted-foreground">
          {t(search ? "No matching conversations." : "Your conversations will live here.")}
        </p>
      )}
      {assistantsFailed && !compact && (
        <p role="alert" className="px-4 py-3 text-ui-sm text-destructive">
          {t("Could not load assistants.")}
        </p>
      )}
      {rooms.isError && (
        <p role="alert" className="px-4 py-3 text-ui-sm text-destructive">
          {t("Could not load group chats.")}
        </p>
      )}
    </div>
  );
}
