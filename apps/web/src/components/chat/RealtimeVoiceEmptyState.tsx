// FILE: RealtimeVoiceEmptyState.tsx
// Purpose: Fill a voice chat's empty conversation with what is happening: the status, the live
//          transcript as it arrives, and a one-time hint on how voice chat works.
// Layer: Chat surface presentation
// Exports: RealtimeVoiceEmptyState, REALTIME_VOICE_HINT_STORAGE_KEY

import type { RealtimeVoiceState } from "@moss/contracts";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../localization";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { realtimeVoiceStatus, realtimeVoiceTranscriptLines } from "./RealtimeVoiceStage";

export const REALTIME_VOICE_HINT_STORAGE_KEY = "moss.realtimeVoice.firstOpenHintSeen";
const VISIBLE_TRANSCRIPT_LINES = 4;

function readHintSeen(): boolean {
  try {
    return window.localStorage.getItem(REALTIME_VOICE_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHintSeen(): void {
  try {
    window.localStorage.setItem(REALTIME_VOICE_HINT_STORAGE_KEY, "1");
  } catch {
    // Private or full storage: the hint simply shows again next time.
  }
}

export function RealtimeVoiceEmptyState(props: {
  readonly state: RealtimeVoiceState;
  readonly transcript: string;
}) {
  const { t } = useTranslation();
  const [showHint, setShowHint] = useState(() => !readHintSeen());
  const hintShownRef = useRef(showHint);

  // The hint is for the first voice chat only: once it has been on screen, ending that chat
  // counts as having seen it.
  useEffect(
    () => () => {
      if (hintShownRef.current) writeHintSeen();
    },
    [],
  );

  const status = realtimeVoiceStatus(props.state);
  const lines = realtimeVoiceTranscriptLines(props.transcript).slice(-VISIBLE_TRANSCRIPT_LINES);

  return (
    <div
      className="flex w-full max-w-[440px] flex-col items-center gap-4 px-6 text-center"
      data-moss-realtime-voice-empty-state="true"
      data-tone={status.tone}
    >
      <div className="flex flex-col items-center gap-1">
        <p className="text-ui-sm text-muted-foreground">{t("realtimeVoice.empty.title")}</p>
        <p
          className="text-ui-lg font-medium text-foreground"
          data-moss-realtime-voice-empty-status="true"
        >
          {t(status.key)}
        </p>
      </div>

      <section
        aria-label={t("realtimeVoice.empty.transcriptLabel")}
        className="flex min-h-10 w-full flex-col items-center gap-1"
        data-moss-realtime-voice-live-transcript="true"
      >
        {lines.length === 0 ? (
          <p className="text-ui text-muted-foreground">{t("realtimeVoice.empty.prompt")}</p>
        ) : (
          lines.map((line, index) => (
            <p
              // Lines only ever append at the end, so position is a stable identity here.
              key={`${lines.length - index}`}
              className={cn(
                "w-full text-ui-lg break-words",
                index === lines.length - 1 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {line}
            </p>
          ))
        )}
      </section>

      {showHint ? (
        <section
          aria-label={t("realtimeVoice.hint.label")}
          className="flex w-full flex-col gap-2 rounded-[10px] border border-border bg-[var(--color-background-surface)] p-3 text-left"
          data-moss-realtime-voice-hint="true"
        >
          <p className="text-ui font-medium text-foreground">{t("realtimeVoice.hint.label")}</p>
          <ul className="flex flex-col gap-1 text-ui text-muted-foreground">
            <li>{t("realtimeVoice.hint.speak")}</li>
            <li>{t("realtimeVoice.hint.interrupt")}</li>
            <li>{t("realtimeVoice.hint.end")}</li>
          </ul>
          <div className="flex justify-end">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                writeHintSeen();
                setShowHint(false);
              }}
            >
              {t("realtimeVoice.hint.dismiss")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
