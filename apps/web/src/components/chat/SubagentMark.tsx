// FILE: SubagentMark.tsx
// Purpose: The mark that stands for one subagent in the timeline, the sub-agent list and the
//          environment panel: Moss's leaf pinwheel, drawn here as SVG from parameters (two flat
//          tones per mark, light and dark). Marks go out in order of first appearance in the
//          parent chat (subagentMarkOrder.ts). While the subagent works the pinwheel turns
//          slowly; reduced motion keeps it still.
// Layer: Chat UI primitive
// Exports: SubagentMark

import type { ComponentProps, CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { SUBAGENT_MARK_TONES } from "~/theme/subagentMarkColors";

import { SUBAGENT_MARK_SHAPES } from "./subagentMarkGeometry";
import { subagentMarkAppearance, useSubagentMarkIndex } from "./subagentMarkOrder";

// Moss's dark theme is the `.dark` class, not the system preference (`body` declares
// `color-scheme: light dark`, so `light-dark()` would follow the OS), hence the dark variant.
const PART_CLASS = {
  face: "fill-(--subagent-mark-face) dark:fill-(--subagent-mark-face-dark)",
  fold: "fill-(--subagent-mark-fold) dark:fill-(--subagent-mark-fold-dark)",
} as const;

export function SubagentMark({
  seed,
  running,
  accentColor,
  className,
  ...rest
}: Omit<ComponentProps<"span">, "children" | "style"> & {
  /** Stable per-subagent key (the provider thread id, or the child thread id). */
  seed: string;
  /** True while the subagent works: the pinwheel turns. */
  running?: boolean;
  /** Kept on the element for callers that key off the presentation palette. */
  accentColor?: string;
}) {
  const index = useSubagentMarkIndex(seed);
  const { shape, tone } = subagentMarkAppearance(index);
  const drawing = SUBAGENT_MARK_SHAPES[shape]!;
  const colours = SUBAGENT_MARK_TONES[tone]!;
  return (
    <span
      aria-hidden
      {...rest}
      className={cn("inline-block size-4 shrink-0", className)}
      style={
        {
          "--subagent-mark-face": colours.light.face,
          "--subagent-mark-fold": colours.light.fold,
          "--subagent-mark-face-dark": colours.dark.face,
          "--subagent-mark-fold-dark": colours.dark.fold,
        } as CSSProperties
      }
      data-subagent-mark=""
      data-subagent-mark-index={index}
      data-subagent-mark-shape={drawing.name}
      data-subagent-mark-tone={colours.name}
      {...(running ? { "data-running": "" } : {})}
      {...(accentColor ? { "data-subagent-accent": accentColor } : {})}
    >
      <svg
        viewBox="0 0 32 32"
        className={cn(
          "block size-full",
          running && "animate-[spin_9s_linear_infinite] motion-reduce:animate-none",
        )}
        focusable="false"
      >
        {drawing.parts.map((part) => (
          <path key={part.d} d={part.d} className={PART_CLASS[part.role]} />
        ))}
      </svg>
    </span>
  );
}
