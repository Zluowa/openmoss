// Codex 26.1007 subagent mark (`KOc`). The dock and the timeline row share it.
// `accentColor` stays on the element for callers that still key off the
// presentation palette; the glyph itself is the seeded sparkle, not a tint.

import { CodexSubagentSparkle } from "./CodexSubagentSparkle";
import { cn } from "~/lib/utils";
export function SubagentAvatar({
  seed,
  accentColor,
  className,
}: {
  /** Stable per-subagent key (the provider thread id). */
  seed: string;
  accentColor: string;
  className?: string;
}) {
  return (
    <CodexSubagentSparkle
      seed={seed}
      accentColor={accentColor}
      className={cn("size-4", className)}
    />
  );
}

export function SubagentAvatarStack({
  items,
  className,
}: {
  items: ReadonlyArray<{ key: string; accentColor: string }>;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)} aria-hidden>
      {items.map((item) => (
        <SubagentAvatar key={item.key} seed={item.key} accentColor={item.accentColor} />
      ))}
    </span>
  );
}
