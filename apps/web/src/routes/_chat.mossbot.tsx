import { MossbotRoomConversation } from "~/components/mossbot/MossbotRooms";
import { createFileRoute } from "@tanstack/react-router";
import { MossbotWorkspace } from "~/components/mossbot/MossbotWorkspace";
import { useEffect } from "react";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { isMossbot } from "~/components/mossbot/mossbot.logic";

export const Route = createFileRoute("/_chat/mossbot")({
  validateSearch: (search: Record<string, unknown>): { bot?: string; room?: string } => ({
    ...(typeof search.bot === "string" && search.bot.length <= 256 ? { bot: search.bot } : {}),
    ...(typeof search.room === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(search.room)
      ? { room: search.room }
      : {}),
  }),
  component: MossbotRoute,
});

function MossbotRoute() {
  const { bot, room } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { summariesByProjectId } = useProjectAgentSummaries();
  const assistant = [...summariesByProjectId.values()].find(
    (item) => item.projectId === bot && isMossbot(item),
  );
  useEffect(() => {
    if (assistant?.coordinatorThreadId)
      void navigate({
        to: "/$threadId",
        params: { threadId: assistant.coordinatorThreadId },
        replace: true,
      });
  }, [assistant?.coordinatorThreadId, navigate]);
  return room ? <MossbotRoomConversation key={room} roomId={room} /> : <MossbotWorkspace />;
}
