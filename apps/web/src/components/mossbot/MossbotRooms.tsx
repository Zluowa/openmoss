import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SecretRequestCard } from "~/components/chat/SecretRequestCard";
import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, ProjectId, type MossbotRoomView } from "@moss/contracts";
import { readNativeApi } from "~/nativeApi";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { useComposerThreadDraft, useComposerDraftStore } from "~/composerDraftStore";
import { useSidebar } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import { ArrowLeftIcon } from "~/lib/icons";
import ChatMarkdown from "~/components/ChatMarkdown";
import { VisualFollowUpContext } from "~/lib/visualFollowUp";
import { MossbotAvatar } from "./MossbotAvatar";
import { MossbotRoomMenu } from "./MossbotRoomMenu";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { isMossbot } from "./mossbot.logic";
import { useMossbotCopy } from "./mossbot.copy";
import { cn } from "~/lib/utils";
import { NewRoomPanel } from "./openmaus/NewRoomPanel";
import { RoomEmpty } from "./openmaus/RoomEmpty";
import { RoomHeader } from "./openmaus/RoomHeader";
import { ManageMembersPanel } from "./openmaus/ManageMembersPanel";
import { Composer } from "./openmaus/Composer";
import { RoomQueueList } from "./openmaus/RoomQueueList";
import { RoomBubble } from "./openmaus/RoomBubble";
import { JumpToLatestButton } from "./openmaus/JumpToLatestButton";
import { useChatScroll } from "./threebot/chatScroll";
const ROOM_LIST_KEY = ["mossbot", "rooms"] as const;
function roomApi() {
  const api = readNativeApi()?.mossbotRooms;
  if (!api) throw new Error("Mossbot groups are unavailable.");
  return api;
}
function useAvailableBots() {
  const { summariesByProjectId } = useProjectAgentSummaries();
  return [...summariesByProjectId.values()]
    .filter((b) => isMossbot(b) && !b.archivedAt && !b.pausedAt)
    .map((b) => ({
      id: b.projectId,
      name: b.coordinatorName ?? "Assistant",
      icon: b.coordinatorIcon,
      color: b.coordinatorColor,
    }));
}
export function useMossbotRoomList() {
  return useQuery({
    queryKey: ROOM_LIST_KEY,
    queryFn: () => roomApi().list(),
    refetchInterval: 5_000,
  });
}

/** Store/network adapter only; the group UI lives in the upstream ports. */
export function MossbotRoomCreateDialog({
  onClose,
  initialMemberIds = [],
}: {
  onClose: () => void;
  initialMemberIds?: readonly string[];
}) {
  const bots = useAvailableBots(),
    client = useQueryClient(),
    navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  return (
    <NewRoomPanel
      bots={bots}
      initialMemberIds={initialMemberIds}
      onClose={onClose}
      onCreate={async (value) => {
        const fingerprint = JSON.stringify(value);
        if (attempt.current?.fingerprint !== fingerprint)
          attempt.current = { fingerprint, id: crypto.randomUUID() };
        const room = await roomApi().create({
          requestId: attempt.current.id,
          name: value.name,
          section: value.section,
          memberProjectIds: value.memberIds.map((id) => ProjectId.makeUnsafe(id)),
          responder: "lead",
        });
        void client.invalidateQueries({ queryKey: ROOM_LIST_KEY });
        onClose();
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/mossbot", search: { room: room.id } });
      }}
    />
  );
}
export function MossbotRoomConversation({ roomId }: { roomId: string }) {
  const { t, errorText } = useMossbotCopy();
  const navigate = useNavigate(),
    client = useQueryClient(),
    availableBots = useAvailableBots();
  const draftId = ThreadId.makeUnsafe(`mossbot-room-draft-${roomId}`);
  const { prompt } = useComposerThreadDraft(draftId);
  const setPrompt = (value: string) => useComposerDraftStore.getState().setPrompt(draftId, value);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [managing, setManaging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    sending = useRef(false);
  const attempt = useRef<{ text: string; picked: string[]; id: string } | null>(null);
  const query = useQuery({
    queryKey: [...ROOM_LIST_KEY, roomId],
    queryFn: () => roomApi().get({ roomId }),
    refetchInterval: (q) =>
      q.state.data?.room.deliveries.some((d) => d.state === "running" || d.state === "queued")
        ? 1000
        : 5000,
  });
  const data = query.data;
  const latestLineAt = data?.room.lines.at(-1)?.createdAt;
  const latestReplyAt = data?.replies.at(-1)?.message.updatedAt;
  useEffect(() => {
    useMossbotPreferencesStore.getState().visitRoom(roomId);
  }, [roomId, latestLineAt, latestReplyAt]);
  const entries = useMemo(() => (data ? roomEntries(data) : []), [data]);
  const scroll = useChatScroll({
    threadKey: `mossbot:${roomId}`,
    loaded: query.isSuccess,
    entries,
  });
  const activeMembers = data?.room.members.filter((m) => !m.hidden) ?? [];
  const working = Boolean(
    data?.room.deliveries.some((d) => d.state === "running" || d.state === "queued"),
  );
  const send = async (picked: string[]) => {
    if (sending.current || !prompt.trim()) return false;
    const text = prompt.trim();
    if (
      attempt.current?.text !== text ||
      JSON.stringify(attempt.current.picked) !== JSON.stringify(picked)
    )
      attempt.current = { text, picked, id: crypto.randomUUID() };
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await roomApi().send({
        roomId,
        requestId: attempt.current.id,
        text,
        picked: picked.map((id) => ProjectId.makeUnsafe(id)),
      });
      if (useComposerDraftStore.getState().draftsByThreadId[draftId]?.prompt.trim() === text)
        setPrompt("");
      attempt.current = null;
      void query.refetch();
      void client.invalidateQueries({ queryKey: ROOM_LIST_KEY });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const roster = [
    ...activeMembers,
    ...availableBots.filter((b) => !activeMembers.some((m) => m.id === b.id)),
  ];
  return (
    <main
      data-mossbot-room
      className={cn(
        "mossbot-simple mossbot-reference-room relative flex h-full min-h-0 w-full flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      <RoomHeader
        group={{ name: data?.room.name ?? t("Group chat"), description: data?.room.section }}
        members={activeMembers}
        onOpenMembers={() => setManaging(true)}
        membersTriggerRef={trigger}
        navigation={
          <Button
            variant="ghost"
            size="icon"
            className="mossbot-round-button"
            aria-label={t("Back to assistants")}
            onClick={() => void navigate({ to: "/mossbot" })}
          >
            <ArrowLeftIcon />
          </Button>
        }
        menu={
          data && <MossbotRoomMenu room={data.room} onManageMembers={() => setManaging(true)} />
        }
      />
      <div
        ref={scroll.scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6"
        onScrollCapture={scroll.onScrollCapture}
        onWheelCapture={scroll.onUserScrollIntent}
        onPointerDownCapture={scroll.onUserScrollIntent}
        onTouchStartCapture={scroll.onUserScrollIntent}
        onKeyDownCapture={scroll.onUserScrollIntent}
      >
        <div className="chat-messages mx-auto flex max-w-3xl flex-col gap-4">
          {query.isPending && <p className="text-ui text-muted-foreground">{t("Loading…")}</p>}
          {query.isError && (
            <p role="alert" className="text-ui text-destructive">
              {errorText(query.error)}
            </p>
          )}
          {query.isSuccess && data && !entries.length && (
            <RoomEmpty
              name={data.room.name}
              members={activeMembers}
              hint={t("Use @name to ask one assistant, or @everyone to hear from the group.")}
            />
          )}
          {scroll.hiddenCount > 0 && (
            <button
              type="button"
              className="self-center text-ui-sm text-muted-foreground"
              onClick={scroll.loadEarlier}
            >
              {t("Load earlier messages")}
            </button>
          )}
          <VisualFollowUpContext.Provider
            value={(text) => setPrompt(prompt ? `${prompt}\n${text}` : text)}
          >
            {scroll.visibleEntries.map((entry, index, visible) => {
              const same = (other: typeof entry | undefined) =>
                Boolean(other && (other.member?.id ?? null) === (entry.member?.id ?? null));
              return (
                <RoomBubble
                  key={entry.id}
                  id={entry.id}
                  user={!entry.member}
                  join={{ above: same(visible[index - 1]), below: same(visible[index + 1]) }}
                  avatar={
                    entry.member && (
                      <MossbotAvatar
                        icon={entry.member.icon}
                        color={entry.member.color}
                        className="size-6"
                      />
                    )
                  }
                  // The member's room thread holds the internal group prompt, so the name is a
                  // label, not a link into that thread.
                  speaker={entry.member && <span>{entry.member.name}</span>}
                >
                  {entry.member ? (
                    <ChatMarkdown
                      text={entry.text}
                      cwd={undefined}
                      threadId={entry.member.threadId}
                      messageId={entry.id}
                      variant="assistant"
                      isStreaming={entry.streaming}
                      renderInlineVisualizations
                    />
                  ) : (
                    entry.text
                  )}
                </RoomBubble>
              );
            })}
          </VisualFollowUpContext.Provider>
          {data?.secretRequests.map((item) => (
            <div key={item.request.requestId}>
              <p className="mb-2 text-ui-sm text-muted-foreground">
                {data.room.members.find((m) => m.id === item.memberId)?.name}
              </p>
              <SecretRequestCard request={item.request} threadId={item.threadId} />
            </div>
          ))}
          <RoomQueueList
            members={data?.room.members ?? []}
            queued={
              data?.room.deliveries
                .filter(
                  (d) => d.state === "running" || d.state === "queued" || d.state === "failed",
                )
                .map((d, position) => ({
                  botId: d.memberId,
                  position,
                  status:
                    t(
                      d.state === "running"
                        ? "Working"
                        : d.state === "queued"
                          ? "Queued"
                          : "Failed",
                    ) + (d.error && errorText(d.error, "") ? ` · ${errorText(d.error, "")}` : ""),
                })) ?? []
            }
          />
        </div>
      </div>
      {scroll.showJump && (
        <JumpToLatestButton
          className="bottom-28"
          onClick={() => {
            const node = scroll.scroller.current;
            if (node) {
              node.scrollTop = node.scrollHeight;
              scroll.onUserScrollIntent();
            }
          }}
        />
      )}
      <Composer
        key={roomId}
        draftId={draftId}
        text={prompt}
        editText={setPrompt}
        members={activeMembers}
        working={working}
        disabled={busy || !data}
        onSend={send}
        onStop={() =>
          void roomApi()
            .cancel({ roomId })
            .then(() => query.refetch())
            .catch((e) => setError(errorText(e)))
        }
      />
      {error && (
        <p role="alert" className="mx-auto w-full max-w-3xl px-4 pb-3 text-ui-sm text-destructive">
          {error}
        </p>
      )}
      {managing && data && (
        <ManageMembersPanel
          bots={roster}
          group={{
            name: data.room.name,
            memberIds: activeMembers.map((m) => m.id),
            responder:
              data.room.responder === "lead"
                ? `member:${activeMembers[0]?.id}`
                : data.room.responder,
          }}
          onClose={() => setManaging(false)}
          onSave={async (ids, responder, expected) => {
            if (responder.startsWith("member:")) {
              const lead = responder.slice(7);
              if (!ids.includes(lead))
                throw new Error(t("Choose a responder who is in the group."));
              ids = [lead, ...ids.filter((id) => id !== lead)];
            }
            await roomApi().update({
              roomId,
              memberProjectIds: ids.map((id) => ProjectId.makeUnsafe(id)),
              expectedMemberProjectIds: expected.map((id) => ProjectId.makeUnsafe(id)),
              responder: responder.startsWith("member:")
                ? "lead"
                : (responder as "everyone" | "mentions"),
            });
            await query.refetch();
            void client.invalidateQueries({ queryKey: ROOM_LIST_KEY });
          }}
        />
      )}
    </main>
  );
}
function roomEntries(data: MossbotRoomView) {
  const member = (id: ProjectId | null) => data.room.members.find((m) => m.id === id);
  return [
    ...data.room.lines.map((line) => ({
      id: line.id,
      text: line.text,
      at: line.createdAt,
      member: member(line.senderId),
      streaming: false,
    })),
    ...data.replies.map((r) => ({
      id: r.message.id,
      text: r.message.text,
      at: r.message.createdAt,
      member: member(r.memberId),
      streaming: r.message.streaming,
    })),
  ].toSorted((a, b) => a.at.localeCompare(b.at));
}
