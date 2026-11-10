// FILE: ReadAloudButton.tsx
// Purpose: The turn footer's Read aloud action (speaker glyph; Pause / Resume while
//          this message is speaking), as in the desktop chat.
// Layer: Chat transcript action
// Exports: ReadAloudButton

import { PauseIcon, VolumeIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

import { MESSAGE_ACTION_ICON_CLASS_NAME, MessageActionButton } from "../MessageActionButton";
import { readAloudSupported, useReadAloud } from "./readAloud";

export function ReadAloudButton(props: { messageId: string; getText: () => string }) {
  const { t } = useTranslation();
  const { state, toggle } = useReadAloud(props.messageId, props.getText);
  if (!readAloudSupported()) return null;
  const label =
    state === "playing"
      ? t("transcript.readAloud.pause")
      : state === "paused"
        ? t("transcript.readAloud.resume")
        : t("transcript.readAloud.start");
  return (
    <MessageActionButton
      label={label}
      tooltip={label}
      aria-pressed={state !== "idle"}
      data-read-aloud-state={state}
      onClick={toggle}
    >
      {state === "playing" ? (
        <PauseIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      ) : (
        <VolumeIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      )}
    </MessageActionButton>
  );
}
