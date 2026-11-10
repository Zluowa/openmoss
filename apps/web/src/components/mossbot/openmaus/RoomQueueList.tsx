// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { RoomBot } from "./host";
import { useMossbotCopy } from "../mossbot.copy";
export function RoomQueueList({
  queued,
  members,
}: {
  queued: { botId: string; position: number; status: string }[];
  members: readonly RoomBot[];
}) {
  const { t } = useMossbotCopy();
  if (!queued.length) return null;
  return (
    <ul
      data-testid="room-queue"
      className="flex flex-col gap-0.5 pl-12 text-ui-sm text-muted-foreground"
    >
      {queued.map((entry) => (
        <li key={`${entry.botId}:${entry.position}`}>
          {`${members.find((m) => m.id === entry.botId)?.name ?? t("Assistant")} · ${entry.status}`}
        </li>
      ))}
    </ul>
  );
}
