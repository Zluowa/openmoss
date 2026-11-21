// FILE: ProfileAvatar.tsx
// Purpose: Single source of truth for the profile avatar — renders a Notion-style Moss
//          preset SVG or uploaded photo when set, otherwise the accent-colored circle
//          with initials. Shared by the Profile header, Avatar picker, and shareable card.
// Layer: web profile feature.

import { cn } from "~/lib/utils";

interface ProfileAvatarProps {
  readonly initials: string;
  readonly color: string;
  readonly image?: string | null;
  /** Sizing/shape utility classes for the circle, e.g. "size-24". */
  readonly className?: string;
  /** Type scale for the initials fallback, e.g. "text-2xl". */
  readonly textClassName?: string;
}

export function ProfileAvatar({
  initials,
  color,
  image,
  className,
  textClassName,
}: ProfileAvatarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-full text-white",
        image && "bg-card",
        className,
      )}
      style={image ? undefined : { backgroundColor: color }}
    >
      {image ? (
        <img src={image} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className={cn("font-medium tracking-tight", textClassName)}>{initials}</span>
      )}
    </div>
  );
}
