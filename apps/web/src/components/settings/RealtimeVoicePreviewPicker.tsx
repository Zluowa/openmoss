import type { RealtimeVoiceDescriptor } from "@synara/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { RealtimeVoiceOrb } from "~/components/chat/RealtimeVoiceOrb";
import { cn } from "~/lib/utils";

import type { RealtimeVoicePreviewUrls } from "./realtimeVoicePreviewManifest";

type PreviewState = "ended" | "error" | "idle" | "playing";

export function realtimeVoicePreviewOrbAudioLevel(previewState: PreviewState): number {
  return previewState === "playing" ? 0.48 : 0.08;
}

export function resetRealtimeVoicePreviewElement(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

export function RealtimeVoicePreviewPicker({
  previewAvailability,
  previewUrls,
  selectedVoiceId,
  voices,
  onVoiceChange,
}: {
  readonly previewAvailability: "loading" | "ready";
  readonly previewUrls: RealtimeVoicePreviewUrls;
  readonly selectedVoiceId: RealtimeVoiceDescriptor["id"];
  readonly voices: readonly RealtimeVoiceDescriptor[];
  readonly onVoiceChange: (voice: RealtimeVoiceDescriptor) => void;
}) {
  const pickerLabelId = useId();
  const optionIdPrefix = useId();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playGenerationRef = useRef(0);
  const autoplaySelectionRef = useRef(false);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");

  const selectedIndex = voices.findIndex((voice) => voice.id === selectedVoiceId);
  const selectedVoice = voices[selectedIndex] ?? voices[0];
  const previewUrl = selectedVoice ? previewUrls[selectedVoice.id] : undefined;

  const stopPreview = useCallback(() => {
    playGenerationRef.current += 1;
    resetRealtimeVoicePreviewElement(audioRef.current);
    setPreviewState("idle");
  }, []);

  const pausePreview = useCallback(() => {
    playGenerationRef.current += 1;
    audioRef.current?.pause();
    setPreviewState("idle");
  }, []);

  const playPreview = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !previewUrl || previewAvailability !== "ready") return;
    if (previewState === "ended" || previewState === "error") audio.currentTime = 0;
    const generation = playGenerationRef.current + 1;
    playGenerationRef.current = generation;
    try {
      await audio.play();
      if (playGenerationRef.current === generation) setPreviewState("playing");
    } catch {
      if (playGenerationRef.current === generation) setPreviewState("error");
    }
  }, [previewAvailability, previewState, previewUrl]);

  const selectVoice = useCallback(
    (index: number, moveFocus = false) => {
      if (voices.length === 0) return;
      const nextVoice = voices[(index + voices.length) % voices.length];
      if (!nextVoice || nextVoice.id === selectedVoice?.id) return;
      stopPreview();
      autoplaySelectionRef.current =
        previewAvailability === "ready" && previewUrls[nextVoice.id] !== undefined;
      onVoiceChange(nextVoice);
      if (moveFocus) {
        requestAnimationFrame(() => {
          document.getElementById(`${optionIdPrefix}-${nextVoice.id}`)?.focus();
        });
      }
    },
    [
      onVoiceChange,
      optionIdPrefix,
      previewAvailability,
      previewUrls,
      selectedVoice?.id,
      stopPreview,
      voices,
    ],
  );

  useEffect(() => {
    if (!autoplaySelectionRef.current) return;
    autoplaySelectionRef.current = false;
    void playPreview();
  }, [playPreview, selectedVoice?.id]);

  useEffect(
    () => () => {
      playGenerationRef.current += 1;
      resetRealtimeVoicePreviewElement(audioRef.current);
    },
    [],
  );

  if (!selectedVoice) {
    return (
      <p role="status" className="text-ui-lg text-muted-foreground">
        No compatible voices are available
      </p>
    );
  }

  const previewMissing = previewAvailability === "ready" && !previewUrl;
  const previewDisabled = previewAvailability === "loading" || previewMissing;
  const previewLabel = previewDisabled
    ? previewAvailability === "loading"
      ? `${selectedVoice.displayName} preview loading`
      : `${selectedVoice.displayName} preview unavailable`
    : previewState === "ended"
      ? `Replay ${selectedVoice.displayName} preview`
      : previewState === "error"
        ? `Retry ${selectedVoice.displayName} preview`
        : previewState === "playing"
          ? `Pause ${selectedVoice.displayName} preview`
          : `Play ${selectedVoice.displayName} preview`;
  const previewMessage =
    previewAvailability === "loading"
      ? "Loading preview…"
      : previewMissing || previewState === "error"
        ? "Preview unavailable"
        : null;
  const handlePickerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = selectedIndex - 1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = selectedIndex + 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = voices.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectVoice(nextIndex, true);
  };

  return (
    <div className="flex w-full flex-col items-center pt-5 pb-1 text-center">
      <button
        type="button"
        aria-label={previewLabel}
        className="relative flex size-36 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-4 focus-visible:ring-offset-popover disabled:cursor-default disabled:opacity-64"
        disabled={previewDisabled}
        onClick={() => {
          if (previewState === "playing") {
            pausePreview();
            return;
          }
          void playPreview();
        }}
      >
        <RealtimeVoiceOrb
          activity={previewState === "playing" ? "speaking" : "listening"}
          canvasSize={184}
          phase="active"
          previewAudioLevel={realtimeVoicePreviewOrbAudioLevel(previewState)}
          previewTimeMs="live"
          glowEnabled={false}
          layoutSize={144}
        />
      </button>
      <audio
        ref={audioRef}
        className="hidden"
        preload="auto"
        src={previewAvailability === "ready" ? previewUrl : undefined}
        onEnded={() => setPreviewState("ended")}
        onError={() => setPreviewState("error")}
        onPause={(event) => {
          if (event.currentTarget.paused) setPreviewState("idle");
        }}
        onPlay={() => setPreviewState("playing")}
      />

      <div className="mt-3 flex items-center gap-6">
        <button
          type="button"
          aria-label="Previous voice"
          className="inline-flex cursor-pointer items-center justify-center rounded-full p-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70 disabled:cursor-default disabled:opacity-40"
          disabled={voices.length < 2}
          onClick={() => selectVoice(selectedIndex - 1)}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-[18px]" />
        </button>
        <div className="flex w-56 flex-col gap-1">
          <p className="text-xl font-semibold">{selectedVoice.displayName}</p>
          <p className="text-ui-lg text-muted-foreground">{selectedVoice.description}</p>
        </div>
        <button
          type="button"
          aria-label="Next voice"
          className="inline-flex cursor-pointer items-center justify-center rounded-full p-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70 disabled:cursor-default disabled:opacity-40"
          disabled={voices.length < 2}
          onClick={() => selectVoice(selectedIndex + 1)}
        >
          <ChevronRightIcon aria-hidden="true" className="size-[18px]" />
        </button>
      </div>

      {previewMessage ? (
        <p
          role={previewState === "error" ? "alert" : "status"}
          className={cn(
            "mt-2 text-ui-sm",
            previewState === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {previewMessage}
        </p>
      ) : null}

      <div
        role="radiogroup"
        aria-labelledby={pickerLabelId}
        className="mt-4 flex items-center gap-3"
        onKeyDown={handlePickerKeyDown}
      >
        <span id={pickerLabelId} className="sr-only">
          Choose a voice
        </span>
        {voices.map((voice, index) => {
          const selected = voice.id === selectedVoice.id;
          return (
            <button
              key={voice.id}
              id={`${optionIdPrefix}-${voice.id}`}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${voice.displayName}: ${voice.description}`}
              aria-posinset={index + 1}
              aria-setsize={voices.length}
              className={cn(
                "size-2.5 shrink-0 cursor-pointer rounded-full bg-blue-500 ring-offset-2 ring-offset-popover outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
                !selected && "opacity-30",
              )}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectVoice(index)}
              data-realtime-voice-radio-dot
            />
          );
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        Selected voice: {selectedVoice.displayName}. {selectedVoice.description}
      </span>
    </div>
  );
}
