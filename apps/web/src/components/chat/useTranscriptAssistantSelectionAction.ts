// FILE: useTranscriptAssistantSelectionAction.ts
// Purpose: Own the assistant highlight -> floating action -> composer insertion flow for transcript selections.
// Layer: Chat transcript interaction controller

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@moss/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEventHandler,
  type PointerEventHandler,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { toastManager } from "../ui/toast";
import { type ComposerAssistantSelectionAttachment } from "../../composerDraftStore";
import {
  createAssistantSelectionAttachment,
  getAssistantSelectionValidationError,
} from "../../lib/assistantSelections";
import {
  readTranscriptAssistantSelection,
  resolveTranscriptSelectionActionLayout,
  type TranscriptAssistantSelection,
} from "./chatSelectionActions";

export interface PendingTranscriptSelectionAction {
  selection: TranscriptAssistantSelection;
  left: number;
  top: number;
  placement: "top" | "bottom";
  /** The selected text, kept so the pill and the Reply card stay on it. */
  range: Range | null;
  /** The transcript scroller the selection lives in. */
  boundary: HTMLElement | null;
  /** "pill" while choosing an action, "reply" once Reply opened the card. */
  mode: "pill" | "reply";
}

interface UseTranscriptAssistantSelectionActionOptions {
  threadId: string;
  enabled: boolean;
  composerImagesRef: MutableRefObject<ReadonlyArray<unknown>>;
  composerFilesRef: MutableRefObject<ReadonlyArray<unknown>>;
  composerAssistantSelectionsRef: MutableRefObject<
    ReadonlyArray<ComposerAssistantSelectionAttachment>
  >;
  addComposerAssistantSelectionToDraft: (
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
  canReferenceAssistantSelection?: (selection: TranscriptAssistantSelection) => boolean;
  scheduleComposerFocus: () => void;
  onMessagesClickCaptureBase: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerDownBase: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUpBase: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerCancelBase: PointerEventHandler<HTMLDivElement>;
  onMessagesScrollBase: () => void;
  onMessagesWheelBase: WheelEventHandler<HTMLDivElement>;
  onMessagesTouchStartBase: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMoveBase: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchEndBase: TouchEventHandler<HTMLDivElement>;
}

export function useTranscriptAssistantSelectionAction(
  options: UseTranscriptAssistantSelectionActionOptions,
) {
  const {
    threadId,
    enabled,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection,
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesWheelBase,
    onMessagesTouchStartBase,
    onMessagesTouchMoveBase,
    onMessagesTouchEndBase,
  } = options;
  // Pending action keyed to its thread: a thread switch or disable derives
  // straight back to null with no state-resetting effects. The setter reads
  // the current thread from a ref so empty-deps callbacks never go stale.
  const [pendingActionState, setPendingActionState] = useState<{
    threadId: typeof threadId;
    action: PendingTranscriptSelectionAction;
  } | null>(null);
  const pendingActionThreadIdRef = useRef(threadId);
  useEffect(() => {
    pendingActionThreadIdRef.current = threadId;
  }, [threadId]);
  const pendingTranscriptSelectionAction =
    enabled && pendingActionState !== null && pendingActionState.threadId === threadId
      ? pendingActionState.action
      : null;
  const setPendingTranscriptSelectionAction = useCallback(
    (action: PendingTranscriptSelectionAction | null) =>
      setPendingActionState(
        action === null ? null : { threadId: pendingActionThreadIdRef.current, action },
      ),
    [],
  );

  const dismissTranscriptSelectionAction = useCallback(() => {
    setPendingTranscriptSelectionAction(null);
  }, [setPendingTranscriptSelectionAction]);
  // The Reply card follows its text while the transcript scrolls and decides for itself
  // when a press outside closes it; only the pill closes on transcript input.
  const replyCardOpenRef = useRef(false);
  replyCardOpenRef.current = pendingTranscriptSelectionAction?.mode === "reply";
  const dismissPill = useCallback(() => {
    if (!replyCardOpenRef.current) setPendingTranscriptSelectionAction(null);
  }, [setPendingTranscriptSelectionAction]);

  const onMessagesClickCapture: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesClickCaptureBase(event);
    },
    [dismissPill, onMessagesClickCaptureBase],
  );

  const onMessagesPointerDown: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesPointerDownBase(event);
    },
    [dismissPill, onMessagesPointerDownBase],
  );

  const onMessagesPointerUp: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      onMessagesPointerUpBase(event);
    },
    [onMessagesPointerUpBase],
  );

  const onMessagesPointerCancel: PointerEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesPointerCancelBase(event);
    },
    [dismissPill, onMessagesPointerCancelBase],
  );

  const onMessagesScroll = useCallback(() => {
    dismissPill();
    onMessagesScrollBase();
  }, [dismissPill, onMessagesScrollBase]);

  const onMessagesWheel: WheelEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesWheelBase(event);
    },
    [dismissPill, onMessagesWheelBase],
  );

  const onMessagesTouchStart: TouchEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesTouchStartBase(event);
    },
    [dismissPill, onMessagesTouchStartBase],
  );

  const onMessagesTouchMove: TouchEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      dismissPill();
      onMessagesTouchMoveBase(event);
    },
    [dismissPill, onMessagesTouchMoveBase],
  );

  const onMessagesTouchEnd: TouchEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      onMessagesTouchEndBase(event);
    },
    [onMessagesTouchEndBase],
  );

  const onMessagesMouseUp: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const container = event.currentTarget;
      const clientX = event.clientX;
      const clientY = event.clientY;
      window.requestAnimationFrame(() => {
        // A release while the Reply card is open is not a new selection.
        if (replyCardOpenRef.current) return;
        if (!enabled || !container) {
          setPendingTranscriptSelectionAction(null);
          return;
        }

        const selectionState = readTranscriptAssistantSelection({ container });
        if (
          !selectionState ||
          (canReferenceAssistantSelection &&
            !canReferenceAssistantSelection(selectionState.selection))
        ) {
          setPendingTranscriptSelectionAction(null);
          return;
        }

        const layout = resolveTranscriptSelectionActionLayout({
          selectionRect: selectionState.selectionRect,
          pointer: { x: clientX, y: clientY },
        });
        const liveSelection = window.getSelection();
        setPendingTranscriptSelectionAction({
          selection: selectionState.selection,
          left: layout.left,
          top: layout.top,
          placement: layout.placement,
          range:
            liveSelection && liveSelection.rangeCount > 0
              ? liveSelection.getRangeAt(0).cloneRange()
              : null,
          boundary: container,
          mode: "pill",
        });
      });
    },
    [canReferenceAssistantSelection, enabled, setPendingTranscriptSelectionAction],
  );

  /**
   * Adds the selection to the composer as a quote, with the reader's reply if any. Returns
   * the new quote's id, or null when nothing was added.
   */
  const commitTranscriptAssistantSelection = useCallback(
    (comment = ""): string | null => {
      const pendingSelection = pendingTranscriptSelectionAction;
      if (!pendingSelection) {
        return null;
      }

      if (
        canReferenceAssistantSelection &&
        !canReferenceAssistantSelection(pendingSelection.selection)
      ) {
        setPendingTranscriptSelectionAction(null);
        window.getSelection()?.removeAllRanges();
        return null;
      }

      if (
        composerImagesRef.current.length +
          composerFilesRef.current.length +
          composerAssistantSelectionsRef.current.length >=
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        setPendingTranscriptSelectionAction(null);
        toastManager.add({
          type: "warning",
          title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
        });
        return null;
      }

      const nextSelection = createAssistantSelectionAttachment({
        ...pendingSelection.selection,
        comment,
      });
      if (!nextSelection) {
        setPendingTranscriptSelectionAction(null);
        if (getAssistantSelectionValidationError(pendingSelection.selection) === "too-long") {
          toastManager.add({
            type: "warning",
            title: "Selections can be up to 4,000 characters.",
          });
        }
        return null;
      }

      const inserted = addComposerAssistantSelectionToDraft(nextSelection);
      setPendingTranscriptSelectionAction(null);
      if (inserted) {
        window.getSelection()?.removeAllRanges();
        scheduleComposerFocus();
      }
      return inserted ? nextSelection.id : null;
    },
    [
      addComposerAssistantSelectionToDraft,
      canReferenceAssistantSelection,
      composerAssistantSelectionsRef,
      composerFilesRef,
      composerImagesRef,
      pendingTranscriptSelectionAction,
      scheduleComposerFocus,
      setPendingTranscriptSelectionAction,
    ],
  );
  const commitRef = useRef(commitTranscriptAssistantSelection);
  commitRef.current = commitTranscriptAssistantSelection;

  /** Reply: swaps the pill for the Reply card on the same text. */
  const openTranscriptReplyCard = useCallback(() => {
    const pendingSelection = pendingTranscriptSelectionAction;
    if (!pendingSelection) return;
    if (!pendingSelection.range) {
      // Nothing to pin a card to: add the quote straight away.
      commitRef.current("");
      return;
    }
    setPendingTranscriptSelectionAction({ ...pendingSelection, mode: "reply" });
    // The card paints the passage as selected itself; focus moves into its field.
    window.getSelection()?.removeAllRanges();
  }, [pendingTranscriptSelectionAction, setPendingTranscriptSelectionAction]);

  useEffect(() => {
    // The Reply card owns its own closing (Escape, a press outside while empty).
    if (!pendingTranscriptSelectionAction || pendingTranscriptSelectionAction.mode === "reply") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-transcript-selection-action='true']")
      ) {
        return;
      }
      setPendingTranscriptSelectionAction(null);
    };
    const handleWindowChange = () => {
      setPendingTranscriptSelectionAction(null);
    };
    const handleSelectionChange = () => {
      // The browser can deliver the release's selectionchange after the toolbar mounts.
      // Keep it open while that event still describes the quote we just captured.
      const current = readTranscriptAssistantSelection({ container: document.body });
      if (
        current?.selection.assistantMessageId !==
          pendingTranscriptSelectionAction.selection.assistantMessageId ||
        current?.selection.text !== pendingTranscriptSelectionAction.selection.text
      ) {
        setPendingTranscriptSelectionAction(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [pendingTranscriptSelectionAction, setPendingTranscriptSelectionAction]);

  return {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    openTranscriptReplyCard,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  };
}
