// FILE: TranscriptSelectionAction.tsx
// Purpose: The floating pill for a text selection: desktop chat's "Start a side chat | Reply"
//          on assistant replies, "Add to Chat" on file and diff selections. Ghost buttons in
//          one rounded popover pill, split by hairlines that fade while a button is hovered.
// Layer: Chat transcript interaction UI

import { Fragment, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { TRANSCRIPT_SELECTION_ACTION_WIDTH_PX } from "./chatSelectionActions";
import { useSelectionAnchor } from "./transcriptSelectionAnchor";

/** Pinned to the selected text itself (assistant replies). */
interface RangeAnchor {
  range: Range;
  /** The transcript scroller: the pill stays inside it. */
  boundary: HTMLElement | null;
}

interface TranscriptSelectionActionProps {
  /** Anchors the pill to the selection; without it the pill sits at `left`/`top`. */
  anchor?: RangeAnchor | undefined;
  left?: number | undefined;
  top?: number | undefined;
  placement?: "top" | "bottom" | undefined;
  /** Opens the Reply card for the selection (desktop chat "Reply", also Enter). */
  onReply?: (() => void) | undefined;
  /** File and diff selections attach to the composer instead of replying. */
  onAddToChat?: (() => void) | undefined;
  onAddToSide?: (() => void) | undefined;
  /** A side chat is already open for this chat: the action sends into it. */
  sideChatStarted?: boolean | undefined;
  sideDisabled?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The anchored text is gone (re-rendered or scrolled away). */
  onLost?: (() => void) | undefined;
}

/** Popover surface shared by the pill and the Reply card. */
export const SELECTION_POPOVER_SURFACE_CLASS_NAME =
  "rounded-popover border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] shadow-lg";

interface PillAction {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
}

function SelectionPill({ actions }: { actions: ReadonlyArray<PillAction> }) {
  if (actions.length === 0) return null;
  return (
    <div
      className={cn(
        SELECTION_POPOVER_SURFACE_CLASS_NAME,
        // Desktop chat squares the pill to the control radius (8), not the popover's 12.
        "group/split pointer-events-auto flex w-max max-w-[calc(100vw-16px)] overflow-hidden rounded-control",
      )}
    >
      {actions.map((action, index) => (
        <Fragment key={action.key}>
          {index > 0 ? (
            <span
              aria-hidden="true"
              className="my-[7px] w-px shrink-0 bg-[var(--color-border)] transition-opacity motion-reduce:transition-none group-focus-within/split:opacity-0 group-hover/split:opacity-0"
            />
          ) : null}
          <button
            type="button"
            title={action.label}
            disabled={action.disabled}
            className="inline-flex h-7 flex-none items-center justify-center whitespace-nowrap px-3 text-ui leading-snug text-[var(--color-text-foreground)] outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:bg-[var(--color-background-elevated-secondary)] disabled:pointer-events-none disabled:opacity-40"
            onMouseDown={(event) => {
              // Keep the selection: a press on the pill must not collapse it.
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function AnchoredPill(props: {
  anchor: RangeAnchor;
  onLost?: (() => void) | undefined;
  actions: PillAction[];
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  useSelectionAnchor({
    surfaceRef,
    range: props.anchor.range,
    boundary: props.anchor.boundary,
    onLost: props.onLost,
  });
  return (
    <div
      ref={surfaceRef}
      data-transcript-selection-action="true"
      role="toolbar"
      aria-label="Selection actions"
      className="pointer-events-none fixed top-0 left-0 z-50 will-change-transform"
      style={{ visibility: "hidden" }}
    >
      <SelectionPill actions={props.actions} />
    </div>
  );
}

export function TranscriptSelectionAction(props: TranscriptSelectionActionProps) {
  const { t } = useTranslation();
  const { onReply, disabled } = props;
  // Enter replies while the pill is up, unless the reader is typing in a field. The
  // composer keeps focus while transcript text is selected, so a focused editor whose
  // text does not hold the selection is not typing. That Enter belongs to the pill:
  // it stops here, and until the key comes up no Enter reaches the field that Reply
  // focuses, so neither this press nor a held key can send anything.
  useEffect(() => {
    if (!onReply) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (event.isComposing || disabled || isTypingIn(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      holdEnterUntilRelease();
      onReply();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [disabled, onReply]);

  const actions: PillAction[] = [];
  if (props.onAddToSide) {
    actions.push({
      key: "side-chat",
      label: props.sideChatStarted
        ? t("transcript.selection.sendToSideChat")
        : t("transcript.selection.startSideChat"),
      onSelect: props.onAddToSide,
      disabled: props.disabled || props.sideDisabled,
    });
  }
  if (props.onReply) {
    actions.push({
      key: "reply",
      label: t("transcript.selection.reply"),
      onSelect: props.onReply,
      disabled: props.disabled,
    });
  }
  if (props.onAddToChat) {
    actions.push({
      key: "add-to-chat",
      label: "Add to Chat",
      onSelect: props.onAddToChat,
      disabled: props.disabled,
    });
  }

  if (props.anchor) {
    return <AnchoredPill anchor={props.anchor} onLost={props.onLost} actions={actions} />;
  }
  return (
    <div
      data-transcript-selection-action="true"
      className="pointer-events-none fixed z-50 flex justify-center"
      style={{
        left: props.left ?? 0,
        top: props.top ?? 0,
        width: TRANSCRIPT_SELECTION_ACTION_WIDTH_PX,
      }}
      role="toolbar"
      aria-label="Selection actions"
    >
      <SelectionPill actions={actions} />
    </div>
  );
}

function isTypingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
    return true;
  if (!target.isContentEditable) return false;
  const anchor = window.getSelection()?.anchorNode ?? null;
  return anchor !== null && target.contains(anchor);
}

function swallowEnter(event: KeyboardEvent): void {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

// Swallows Enter keydowns (a held key's repeats) until Enter is released or the window
// loses focus.
export function holdEnterUntilRelease(): void {
  const release = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== "Enter") return;
    window.removeEventListener("keydown", swallowEnter, true);
    window.removeEventListener("keyup", release, true);
    window.removeEventListener("blur", release);
  };
  window.addEventListener("keydown", swallowEnter, true);
  window.addEventListener("keyup", release, true);
  window.addEventListener("blur", release);
}
