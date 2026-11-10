// FILE: TranscriptSelectionAction.tsx
// Purpose: Renders the floating toolbar for assistant transcript selections.
// Layer: Chat transcript interaction UI

import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { TRANSCRIPT_SELECTION_ACTION_WIDTH_PX } from "./chatSelectionActions";

interface TranscriptSelectionActionProps {
  left: number;
  top: number;
  placement: "top" | "bottom";
  /** Opens the reply box above the selection (desktop chat "Reply", also Enter). */
  onReply?: (() => void) | undefined;
  /** File and diff selections attach to the composer instead of replying. */
  onAddToChat?: (() => void) | undefined;
  onAddToSide?: (() => void) | undefined;
  /** A side chat is already open for this chat: the action sends into it. */
  sideChatStarted?: boolean | undefined;
  sideDisabled?: boolean | undefined;
  disabled?: boolean | undefined;
}

function TranscriptSelectionToolbarButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        "pointer-events-auto inline-flex h-7 flex-none items-center justify-center whitespace-nowrap px-2.5 text-ui leading-snug text-[var(--color-text-foreground)] outline-none focus-visible:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-40",
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <span>{label}</span>
    </button>
  );
}

export function TranscriptSelectionAction(props: TranscriptSelectionActionProps) {
  const { t } = useTranslation();
  const { onReply, disabled } = props;
  // Enter replies while the toolbar is up and focus is not in a text field.
  useEffect(() => {
    if (!onReply) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (disabled || isEditableTarget(event.target)) return;
      event.preventDefault();
      onReply();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [disabled, onReply]);
  return (
    <div
      data-transcript-selection-action="true"
      className="pointer-events-none fixed z-50 flex justify-center"
      style={{ left: props.left, top: props.top, width: TRANSCRIPT_SELECTION_ACTION_WIDTH_PX }}
      role="toolbar"
      aria-label="Selection actions"
    >
      {/* Sized to its labels and centered in the layout's slot, so labels never clip
          regardless of font size or which actions are present. */}
      <div className="pointer-events-auto inline-flex w-max max-w-[calc(100vw-16px)] shrink-0 items-center divide-x divide-[var(--color-border)] overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] shadow-md">
        {props.onAddToSide ? (
          <TranscriptSelectionToolbarButton
            label={
              props.sideChatStarted
                ? t("transcript.selection.sendToSideChat")
                : t("transcript.selection.startSideChat")
            }
            onClick={props.onAddToSide}
            disabled={props.disabled || props.sideDisabled}
          />
        ) : null}
        {props.onReply ? (
          <TranscriptSelectionToolbarButton
            label={t("transcript.selection.reply")}
            onClick={props.onReply}
            disabled={props.disabled}
          />
        ) : null}
        {props.onAddToChat ? (
          <TranscriptSelectionToolbarButton
            label="Add to Chat"
            onClick={props.onAddToChat}
            disabled={props.disabled}
          />
        ) : null}
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}
