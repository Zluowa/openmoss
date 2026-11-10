// Adapted from OpenMaus GroupView.tsx:1104–1126 @ 58378e8 (Apache-2.0).
// See third_party/openmaus/UI-PORTS.md. The host supplies its actual routing hint.
import { BotAvatar, type RoomBot } from "./host";
export function RoomEmpty({
  name,
  members,
  hint,
}: {
  name: string;
  members: RoomBot[];
  hint: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="flex -space-x-2">
        {members.slice(0, 3).map((bot) => (
          <BotAvatar key={bot.id} bot={bot} state="happy" size={44} animated={false} />
        ))}
      </div>
      <div className="text-ui-lg font-semibold text-foreground">{name}</div>
      <div className="max-w-[380px] text-ui text-muted-foreground">{hint}</div>
    </div>
  );
}
