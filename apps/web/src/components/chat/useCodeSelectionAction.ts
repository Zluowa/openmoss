// FILE: useCodeSelectionAction.ts
// Purpose: Generic highlight -> floating "Add to chat" flow for read-only code
//          surfaces (file preview, diff view), mirroring the transcript behavior.
// Layer: Chat selection interaction controller

import { useEffect, useEffectEvent, useRef, useState, type MouseEventHandler } from "react";

import {
  getActiveSelectionRect,
  resolveTranscriptSelectionActionLayout,
} from "./chatSelectionActions";

export interface PendingCodeSelectionAction<T> {
  payload: T;
  left: number;
  top: number;
  placement: "top" | "bottom";
}

// Caller attaches `onContainerMouseUp` to the selectable surface and renders
// `TranscriptSelectionAction` while `pendingAction` is set. `readSelection`
// inspects the live window selection scoped to the container and returns the
// commit payload (or null when the selection is not actionable).
export function useCodeSelectionAction<T>(options: {
  enabled: boolean;
  readSelection: (container: HTMLElement) => T | null;
  onCommit: (payload: T) => void;
}): {
  pendingAction: PendingCodeSelectionAction<T> | null;
  onContainerMouseUp: MouseEventHandler<HTMLElement>;
  commit: () => void;
} {
  const { enabled, onCommit, readSelection } = options;
  const [pendingActionState, setPendingAction] = useState<PendingCodeSelectionAction<T> | null>(
    null,
  );
  // Derived: disabling clears the visible action in the same render, with no
  // state-resetting effect (the stale state simply stops being surfaced).
  const pendingAction = enabled ? pendingActionState : null;
  // The surface and pointer of the release that offered the action, so a later
  // selection change can be re-read against the same surface.
  const sourceRef = useRef<{ container: HTMLElement; pointer: { x: number; y: number } } | null>(
    null,
  );

  const offerFor = (container: HTMLElement, pointer: { x: number; y: number }) => {
    if (!enabled || !container.isConnected) {
      setPendingAction(null);
      return;
    }
    const payload = readSelection(container);
    if (payload === null) {
      setPendingAction(null);
      return;
    }
    sourceRef.current = { container, pointer };
    const layout = resolveTranscriptSelectionActionLayout({
      selectionRect: getActiveSelectionRect(),
      pointer,
    });
    setPendingAction({ payload, ...layout });
  };

  const rereadSelection = useEffectEvent(() => {
    const source = sourceRef.current;
    if (!source) {
      setPendingAction(null);
      return;
    }
    offerFor(source.container, source.pointer);
  });

  const onContainerMouseUp: MouseEventHandler<HTMLElement> = (event) => {
    const container = event.currentTarget;
    const pointer = { x: event.clientX, y: event.clientY };
    // Wait a frame so the browser finalizes the selection before reading it.
    window.requestAnimationFrame(() => offerFor(container, pointer));
  };

  const commit = () => {
    if (!pendingAction) {
      return;
    }
    onCommit(pendingAction.payload);
    setPendingAction(null);
    window.getSelection()?.removeAllRanges();
  };

  useEffect(() => {
    if (!pendingAction) {
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
      setPendingAction(null);
    };
    const handleWindowChange = () => {
      setPendingAction(null);
    };
    // The browser delivers `selectionchange` as a task, so the change for the very
    // selection that offered the action can arrive after the action is shown (a busy
    // or cold page). Clearing on it hid the pill a moment after it appeared. A change
    // is re-read instead: the action stays, with the current text and position, while
    // the surface still holds an actionable selection, and goes when it does not
    // (collapsed, moved elsewhere).
    const handleSelectionChange = () => rereadSelection();

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [pendingAction]);

  return { pendingAction, onContainerMouseUp, commit };
}
