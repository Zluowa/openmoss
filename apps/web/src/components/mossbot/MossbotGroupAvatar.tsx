import { MossbotAvatar } from "./MossbotAvatar";
import { cn } from "~/lib/utils";

/** The same overlapping participant portraits in the roster and room identity. */
export function MossbotGroupAvatar({
  members,
  className,
}: {
  members: readonly {
    id: string;
    icon?: string | null | undefined;
    color?: string | null | undefined;
  }[];
  className?: string | undefined;
}) {
  return (
    <span aria-hidden="true" className={cn("mossbot-group-avatar", className)}>
      {members.slice(0, 4).map((member) => (
        <MossbotAvatar key={member.id} icon={member.icon} color={member.color} />
      ))}
    </span>
  );
}
