// FILE: RealtimeVoiceLaunchOverlay.tsx
// Purpose: Hold the chat surface during the optimistic Realtime Voice handoff.
// Layer: Chat surface presentation

import { useEffect, useRef } from "react";

import { useTranslation } from "../../localization";
import { Button } from "../ui/button";
import { useRealtimeVoiceReducedMotion } from "./RealtimeVoiceHandoffTarget";
import { presentRealtimeVoiceError } from "./realtimeVoiceErrorPresentation";

export function RealtimeVoiceConnectingPulse(props: { readonly reduceMotion: boolean }) {
  const pulseRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const pulse = pulseRef.current;
    if (!pulse || props.reduceMotion || typeof pulse.animate !== "function") return;
    const animation = pulse.animate(
      [
        { transform: "scale(1)" },
        { offset: 0.5, transform: "scale(1.25)" },
        { transform: "scale(1)" },
      ],
      { duration: 1_250, easing: "ease-in-out", iterations: Infinity },
    );
    return () => animation.cancel();
  }, [props.reduceMotion]);

  return (
    <div
      ref={pulseRef}
      className="size-[50px] rounded-full bg-foreground"
      data-moss-realtime-voice-connecting-pulse="true"
    />
  );
}

export function RealtimeVoiceLaunchOverlay(props: {
  readonly visible: boolean;
  readonly failed: boolean;
  readonly connected: boolean;
  readonly handoffComplete: boolean;
  readonly error: string | null;
  readonly onHandoffComplete: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useRealtimeVoiceReducedMotion();
  const presentedError = presentRealtimeVoiceError({ cause: props.error }, t);

  useEffect(() => {
    if (!props.visible || props.failed || !props.connected || props.handoffComplete) return;
    const frame = window.requestAnimationFrame(props.onHandoffComplete);
    return () => window.cancelAnimationFrame(frame);
  }, [
    props.connected,
    props.failed,
    props.handoffComplete,
    props.onHandoffComplete,
    props.visible,
  ]);

  return (
    <div
      className={
        "absolute inset-0 z-30 bg-background text-foreground " +
        (props.failed ? "flex items-center justify-center " : "") +
        (props.visible ? "opacity-100" : "pointer-events-none opacity-0")
      }
      aria-hidden={!props.visible}
      aria-label={
        props.failed ? t("realtimeVoice.launch.failedAria") : t("realtimeVoice.launch.startingAria")
      }
      aria-modal={props.visible ? true : undefined}
      inert={!props.visible}
      role={props.visible ? "dialog" : undefined}
      style={{
        transition: reduceMotion ? "none" : "opacity 200ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
      data-moss-realtime-voice-launch-overlay={props.visible ? "true" : "false"}
      data-handoff-complete={props.handoffComplete ? "true" : "false"}
      data-mode={props.failed ? "failed" : props.connected ? "connected" : "starting"}
    >
      {props.failed ? (
        <div className="flex flex-col items-center gap-4 text-center" role="alert">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium text-foreground">
              {t("realtimeVoice.launch.failedTitle")}
            </h2>
            <p className="text-ui-lg text-muted-foreground">{presentedError}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" autoFocus onClick={props.onRetry}>
              {t("realtimeVoice.launch.retry")}
            </Button>
            <Button type="button" variant="secondary" onClick={props.onBack}>
              {t("realtimeVoice.launch.back")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <span className="sr-only" role="status">
            {t("realtimeVoice.launch.startingAria")}
          </span>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto h-52 w-full max-w-[900px] px-12">
            <div
              className="absolute inset-x-12 top-0 flex flex-col items-center gap-1"
              style={{ transform: "translateY(52px)" }}
            >
              <div
                className="relative flex items-center justify-center"
                style={{ width: 112, height: 112 }}
                aria-hidden="true"
              >
                <RealtimeVoiceConnectingPulse reduceMotion={reduceMotion} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
