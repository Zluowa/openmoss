// FILE: RealtimeVoiceComposerControls.tsx
// Purpose: Keep active Realtime Voice controls at the right edge of the normal composer.
// Layer: Chat composer presentation

import type { RealtimeVoiceState } from "@synara/contracts";
import { MicIcon, MicrophoneOffIcon, VolumeIcon, VolumeOffIcon, XIcon } from "~/lib/icons";

import { Button } from "../ui/button";

export function RealtimeVoiceComposerControls(props: {
  readonly state: RealtimeVoiceState;
  readonly onStop: () => void;
  readonly onToggleInputMuted: () => void;
  readonly onToggleOutputMuted: () => void;
}) {
  const mediaReady = props.state.phase === "starting" || props.state.phase === "active";

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      aria-label="Realtime Voice controls"
      data-moss-realtime-voice-composer-controls="true"
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="rounded-full"
        style={{ width: 28, height: 28 }}
        disabled={!mediaReady}
        aria-label={props.state.outputMuted ? "Unmute voice output" : "Mute voice output"}
        title={props.state.outputMuted ? "Unmute voice output" : "Mute voice output"}
        aria-pressed={props.state.outputMuted}
        onClick={props.onToggleOutputMuted}
      >
        {props.state.outputMuted ? (
          <VolumeOffIcon aria-hidden="true" style={{ width: 14, height: 14 }} />
        ) : (
          <VolumeIcon aria-hidden="true" style={{ width: 14, height: 14 }} />
        )}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="rounded-full"
        style={{ width: 28, height: 28 }}
        disabled={!mediaReady}
        aria-label={props.state.inputMuted ? "Unmute microphone" : "Mute microphone"}
        title={props.state.inputMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={props.state.inputMuted}
        onClick={props.onToggleInputMuted}
      >
        {props.state.inputMuted ? (
          <MicrophoneOffIcon aria-hidden="true" style={{ width: 14, height: 14 }} />
        ) : (
          <MicIcon aria-hidden="true" style={{ width: 14, height: 14 }} />
        )}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="prominent"
        className="rounded-full"
        style={{ width: 28, height: 28 }}
        aria-label="End voice chat"
        title="End voice chat"
        onClick={props.onStop}
      >
        <XIcon aria-hidden="true" style={{ width: 14, height: 14 }} />
      </Button>
    </div>
  );
}
