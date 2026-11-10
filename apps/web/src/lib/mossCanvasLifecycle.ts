// FILE: mossCanvasLifecycle.ts
// Purpose: What a conversation's Canvas runtime does when nobody is looking at
//          it. See docs/moss-canvas-lifecycle.md.
// Layer: Web state machine (pure) + React hook
//
//   live ──hide──▶ idle ──after SUSPEND_AFTER_MS──▶ saving ──saved──▶ suspended
//    ▲               │                               │ not saved          │
//    └────show───────┴───────────show────────────────┴──▶ idle (retry)    │
//    └──────────────────────────────show (reload from storage)───────────┘
//
// "live" and "idle" keep the editor mounted, so a quick look elsewhere costs
// nothing. Once it has been out of sight for a while the document is saved and
// the editor (the heavy part: the drawing engine, its images and its frame) is
// unloaded. Showing it again loads the same per-conversation document back.

import { useCallback, useEffect, useReducer, useRef } from "react";

/** How long a hidden Canvas stays loaded before it is saved and unloaded. */
// Long enough to look at the chat, answer and come back without the editor
// starting from scratch, which costs seconds (owner, 2026-11-10: Canvas is slow
// to open). Memory is held for one conversation only.
export const MOSS_CANVAS_SUSPEND_AFTER_MS = 3 * 60_000;
/** A save that did not finish is retried after this long. */
export const MOSS_CANVAS_SUSPEND_RETRY_MS = 10_000;

export type MossCanvasRuntimeState = "live" | "idle" | "saving" | "suspended";

export type MossCanvasRuntimeEvent =
  | { readonly type: "show" }
  | { readonly type: "hide" }
  | { readonly type: "hidden-long-enough" }
  | { readonly type: "saved" }
  | { readonly type: "not-saved" };

export function nextMossCanvasRuntimeState(
  state: MossCanvasRuntimeState,
  event: MossCanvasRuntimeEvent,
): MossCanvasRuntimeState {
  switch (event.type) {
    case "show":
      return "live";
    case "hide":
      return state === "live" ? "idle" : state;
    case "hidden-long-enough":
      return state === "idle" ? "saving" : state;
    case "saved":
      // Shown again while saving: stay loaded.
      return state === "saving" ? "suspended" : state;
    case "not-saved":
      // Never unload unsaved work; try again later.
      return state === "saving" ? "idle" : state;
  }
}

/** Whether the editor frame is loaded in this state. */
export function isMossCanvasRuntimeLoaded(state: MossCanvasRuntimeState): boolean {
  return state !== "suspended";
}

/**
 * Keep the Canvas editor loaded while it is visible, and save then unload it
 * after it has been hidden for `suspendAfterMs`. `save` resolves true once the
 * document is stored; false keeps it loaded and retries.
 */
export function useMossCanvasRuntimeLifecycle(input: {
  readonly visible: boolean;
  readonly save: () => Promise<boolean>;
  readonly suspendAfterMs?: number;
  readonly retryAfterMs?: number;
}): { readonly state: MossCanvasRuntimeState; readonly loaded: boolean } {
  const [state, dispatch] = useReducer(nextMossCanvasRuntimeState, "live");
  const save = useRef(input.save);
  save.current = input.save;
  const suspendAfterMs = input.suspendAfterMs ?? MOSS_CANVAS_SUSPEND_AFTER_MS;
  const retryAfterMs = input.retryAfterMs ?? MOSS_CANVAS_SUSPEND_RETRY_MS;
  const retries = useRef(0);

  useEffect(() => {
    dispatch({ type: input.visible ? "show" : "hide" });
    if (input.visible) retries.current = 0;
  }, [input.visible]);

  useEffect(() => {
    if (state !== "idle") return;
    const timer = setTimeout(
      () => dispatch({ type: "hidden-long-enough" }),
      retries.current === 0 ? suspendAfterMs : retryAfterMs,
    );
    return () => clearTimeout(timer);
  }, [state, suspendAfterMs, retryAfterMs]);

  const runSave = useCallback(() => {
    let cancelled = false;
    void save
      .current()
      .catch(() => false)
      .then((saved) => {
        if (cancelled) return;
        if (!saved) retries.current += 1;
        dispatch({ type: saved ? "saved" : "not-saved" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => (state === "saving" ? runSave() : undefined), [state, runSave]);

  return { state, loaded: isMossCanvasRuntimeLoaded(state) };
}
