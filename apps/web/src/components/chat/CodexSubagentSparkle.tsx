// Codex 26.1007 subagent mark.
// Source: app-initial `KOc` renders `<img class="size-4" src={palette[qOc(seed)]}>`.
// `nk` in sites-end-resource passes `className: size-4` and `seed`.

import { CODEX_SUBAGENT_SPARKLE_ASSETS } from "./codexSubagentSparkleAssets";
import { codexSubagentSparkleIndex } from "./codexSubagentSparkleSeed";
import { cn } from "~/lib/utils";

export function CodexSubagentSparkle(props: {
  seed: string;
  className?: string;
  accentColor?: string;
  "data-subagent-chip"?: string;
}) {
  const pair =
    CODEX_SUBAGENT_SPARKLE_ASSETS[
      codexSubagentSparkleIndex(props.seed, CODEX_SUBAGENT_SPARKLE_ASSETS.length)
    ] ?? CODEX_SUBAGENT_SPARKLE_ASSETS[0];
  return (
    <span
      className={cn("inline-block size-4 shrink-0", props.className)}
      data-subagent-sparkle=""
      {...(props["data-subagent-chip"]
        ? { "data-subagent-chip": props["data-subagent-chip"] }
        : {})}
      {...(props.accentColor ? { "data-subagent-accent": props.accentColor } : {})}
    >
      <img src={pair.light} alt="" draggable={false} className="size-full dark:hidden" />
      <img src={pair.dark} alt="" draggable={false} className="hidden size-full dark:block" />
    </span>
  );
}
