// FILE: SubagentSeededAvatar.tsx
// Purpose: The timeline's subagent mark (SubagentMark), with the seed on the element for the
//          row's lookups and tests.
// Layer: Chat UI

import type { ComponentProps } from "react";

import { SubagentMark } from "./SubagentMark";
import { cn } from "~/lib/utils";

export function SubagentSeededAvatar({
  seed,
  running,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children" | "style"> & { seed: string; running?: boolean }) {
  return (
    <SubagentMark
      {...props}
      seed={seed}
      running={running === true}
      className={cn("size-4 shrink-0", className)}
      data-avatar-seed={seed}
    />
  );
}
