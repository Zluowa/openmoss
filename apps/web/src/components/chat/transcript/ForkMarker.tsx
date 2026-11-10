// FILE: ForkMarker.tsx
// Purpose: The desktop chat's fork point in the source chat: under the message a fork
//          was taken from, "Forked here" (or "N forks from here") with a live chip to
//          each fork.
// Layer: Chat transcript primitive
// Exports: ForkMarker

import type { ThreadId } from "@moss/contracts";

import { GitForkIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

import { TranscriptThreadChip } from "./TranscriptThreadChip";

export function ForkMarker(props: {
  forks: readonly ThreadId[];
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  if (props.forks.length === 0) return null;
  const label =
    props.forks.length === 1
      ? t("transcript.fork.here")
      : format("transcript.fork.manyHere", { count: props.forks.length });
  return (
    <div
      data-fork-marker=""
      role="note"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-3 text-ui-sm text-muted-foreground"
    >
      <GitForkIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      {props.forks.map((threadId) => (
        <TranscriptThreadChip
          key={threadId}
          threadId={threadId}
          fallbackLabel={t("transcript.peer.anotherThread")}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </div>
  );
}
