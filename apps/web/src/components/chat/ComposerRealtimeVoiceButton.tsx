// FILE: ComposerRealtimeVoiceButton.tsx
// Purpose: Launch Realtime Voice without conflating it with the voice-note recorder.
// Layer: Chat composer presentation

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function RealtimeVoiceBarsIcon({ busy }: { readonly busy: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-4 items-center justify-center gap-[1.167px] ${busy ? "animate-pulse motion-reduce:animate-none" : ""}`}
      data-moss-realtime-voice-bars-icon="true"
    >
      {[4.15, 12.17, 6.83, 9.5, 4.15].map((height, index) => (
        <span
          // Clean-room bars reproduce build 5973's measured 16px silhouette
          // without shipping its private SVG path.
          key={`${height}-${index}`}
          className="w-[1.5px] rounded-full bg-current"
          style={{ height }}
        />
      ))}
    </span>
  );
}

export function ComposerRealtimeVoiceButton(props: {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly mode?: "start" | "return";
  readonly onClick: () => void;
}) {
  const mode = props.mode ?? "start";
  const label = props.busy
    ? "Starting voice chat"
    : mode === "return"
      ? "Open voice chat"
      : "Start voice chat";
  // The tooltip hangs on a wrapper so it also names the button while it is disabled
  // (walk 2026-11-24, V-1: hovering it showed nothing).
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Button
          type="button"
          size={mode === "return" ? "icon-xs" : "icon-sm"}
          variant={mode === "return" ? "prominent" : "ghost"}
          className={
            mode === "return" ? "size-7 shrink-0 rounded-full" : "shrink-0 rounded-control"
          }
          disabled={props.disabled || props.busy}
          aria-label={label}
          data-moss-realtime-voice-launch="true"
          data-moss-realtime-voice-action={mode}
          onClick={props.onClick}
        >
          <RealtimeVoiceBarsIcon busy={props.busy} />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
