// Subagent mark. The sub-agent list and the environment panel share it (SubagentMark.tsx).
// `accentColor` stays on the element for callers that still key off the
// presentation palette; the mark itself comes from the subagent's place in the chat.

import { SubagentMark } from "./SubagentMark";
import { cn } from "~/lib/utils";
export function SubagentAvatar({
  seed,
  accentColor,
  running,
  className,
}: {
  /** Stable per-subagent key (the provider thread id). */
  seed: string;
  accentColor: string;
  /** True while the subagent works. */
  running?: boolean;
  className?: string;
}) {
  return (
    <SubagentMark
      seed={seed}
      accentColor={accentColor}
      running={running === true}
      className={cn("size-4", className)}
    />
  );
}

export function SubagentAvatarStack({
  items,
  className,
}: {
  items: ReadonlyArray<{ key: string; accentColor: string; isActive?: boolean }>;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)} aria-hidden>
      {items.map((item) => (
        <SubagentAvatar
          key={item.key}
          seed={item.key}
          accentColor={item.accentColor}
          running={item.isActive === true}
        />
      ))}
    </span>
  );
}
