// FILE: RealtimeVoiceSessionSurface.tsx
// Purpose: Present the immersive, full-pane Realtime Voice session and its controlled composer.
// Layer: Chat surface presentation

import type { RealtimeVoiceQuotaSnapshot, RealtimeVoiceState } from "@synara/contracts";
import { type FormEvent, type KeyboardEvent, useId } from "react";

import type { RealtimeVoiceOutputSignal } from "../../lib/realtimeVoiceWebRtc";
import { RealtimeVoiceComposerControls } from "./RealtimeVoiceComposerControls";
import type {
  RealtimeVoiceDetachMotion,
  RealtimeVoiceHandoffMotion,
} from "./RealtimeVoiceHandoffTarget";
import { RealtimeVoiceStage } from "./RealtimeVoiceStage";

export function isRealtimeVoiceSessionInteractive(
  phase: RealtimeVoiceState["phase"],
  disabled = false,
): boolean {
  return phase === "active" && !disabled;
}

export function canSubmitRealtimeVoiceSessionText(input: {
  readonly phase: RealtimeVoiceState["phase"];
  readonly text: string;
  readonly disabled?: boolean;
}): boolean {
  return (
    isRealtimeVoiceSessionInteractive(input.phase, input.disabled) && input.text.trim().length > 0
  );
}

export interface RealtimeVoiceSessionSurfaceProps {
  readonly state: RealtimeVoiceState;
  readonly transcript: string;
  readonly quota: RealtimeVoiceQuotaSnapshot | null;
  readonly readOutputSignal: () => RealtimeVoiceOutputSignal;
  readonly handoff?: RealtimeVoiceHandoffMotion | null;
  readonly presentationAnchorRef?: (element: HTMLDivElement | null) => void;
  readonly canDetachToGlobalOverlay?: boolean;
  readonly onDetachToGlobalOverlay?: (motion: RealtimeVoiceDetachMotion) => void;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly onSubmit: (text: string) => void;
  readonly onStop: () => void;
  readonly onToggleInputMuted: () => void;
  readonly onToggleOutputMuted: () => void;
  readonly disabled?: boolean;
  readonly reduceMotion?: boolean;
  /** Pins the clean-room shader clock for deterministic visual regression captures. */
  readonly previewTimeMs?: number;
}

function submitRealtimeVoiceTextarea(event: KeyboardEvent<HTMLTextAreaElement>): void {
  const nativeKeyCode = event.nativeEvent.keyCode || event.nativeEvent.which;
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    nativeKeyCode === 229 ||
    event.defaultPrevented
  ) {
    return;
  }
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function RealtimeVoiceSessionSurface(props: RealtimeVoiceSessionSurfaceProps) {
  const composerLabelId = useId();
  const composerHintId = useId();
  const interactionDisabled = !isRealtimeVoiceSessionInteractive(props.state.phase, props.disabled);
  const canSubmit = canSubmitRealtimeVoiceSessionText({
    phase: props.state.phase,
    text: props.text,
    ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    props.onSubmit(props.text);
  };

  return (
    <section
      className="relative isolate flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
      aria-label="Realtime Voice session"
      aria-busy={props.state.phase !== "active" && props.state.phase !== "failed"}
      role="region"
      data-moss-realtime-voice-session-surface="true"
      data-phase={props.state.phase}
      data-interactive={interactionDisabled ? "false" : "true"}
      data-theme="inherit"
    >
      <div
        className="flex h-full min-h-0 w-full justify-center px-3 pt-3 sm:px-5 sm:pt-5"
        style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
      >
        <div
          className="mx-auto flex h-full min-h-0 w-full max-w-[900px] flex-col justify-end"
          data-moss-realtime-voice-session-column="true"
        >
          <RealtimeVoiceStage
            state={props.state}
            transcript={props.transcript}
            quota={props.quota}
            readOutputSignal={props.readOutputSignal}
            handoff={props.handoff ?? null}
            {...(props.presentationAnchorRef === undefined
              ? {}
              : { presentationAnchorRef: props.presentationAnchorRef })}
            {...(props.canDetachToGlobalOverlay === undefined
              ? {}
              : { canDetachToGlobalOverlay: props.canDetachToGlobalOverlay })}
            {...(props.onDetachToGlobalOverlay === undefined
              ? {}
              : { onDetachToGlobalOverlay: props.onDetachToGlobalOverlay })}
            {...(props.reduceMotion === undefined ? {} : { reduceMotion: props.reduceMotion })}
            {...(props.previewTimeMs === undefined ? {} : { previewTimeMs: props.previewTimeMs })}
          />

          <form
            className="mx-auto flex h-24 min-h-24 w-full max-w-[900px] shrink-0 items-end gap-3 rounded-composer border border-border bg-[var(--color-background-surface)] p-2 transition-[border-color,box-shadow] duration-150 focus-within:border-[color:var(--color-border-focus)] focus-within:ring-1 focus-within:ring-[color:var(--color-border-focus)]/40 motion-reduce:transition-none"
            aria-label="Send a message during voice chat"
            data-moss-realtime-voice-session-composer="true"
            onSubmit={submit}
          >
            <label className="flex h-full min-w-0 flex-1" htmlFor={composerLabelId}>
              <span className="sr-only">Message</span>
              <textarea
                id={composerLabelId}
                className="h-full min-h-0 w-full resize-none overflow-y-auto border-0 bg-transparent px-2 py-2 text-ui-lg leading-5 text-foreground caret-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-describedby={composerHintId}
                autoComplete="off"
                autoFocus={!interactionDisabled}
                disabled={interactionDisabled}
                enterKeyHint="send"
                placeholder="Type anything"
                rows={2}
                value={props.text}
                onChange={(event) => props.onTextChange(event.currentTarget.value)}
                onKeyDown={submitRealtimeVoiceTextarea}
              />
            </label>

            <RealtimeVoiceComposerControls
              state={props.state}
              onStop={props.onStop}
              onToggleInputMuted={props.onToggleInputMuted}
              onToggleOutputMuted={props.onToggleOutputMuted}
            />
          </form>

          <p id={composerHintId} className="sr-only">
            Press Enter to send. Press Shift and Enter for a new line.
          </p>
        </div>
      </div>
    </section>
  );
}
