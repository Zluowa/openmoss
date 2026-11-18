// FILE: useAgentRuntimeDownloads.ts
// Purpose: The window side of the agent runtimes a `download` build fetches after install:
//          their download state, 重试, the "a chat is running" signal that pauses background
//          downloads, and a message held until the agent it needs is ready.
// Layer: Web hooks (desktopBridge.agentRuntimes; an empty list in a bundled build or a browser)

import type { DesktopAgentRuntimeState } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { isSessionRunningTurn } from "../session-logic";
import { useStore } from "../store";

const agentRuntimeBridge = () =>
  typeof window === "undefined" ? undefined : window.desktopBridge?.agentRuntimes;

export function useAgentRuntimeDownloads(): ReadonlyArray<DesktopAgentRuntimeState> {
  const [states, setStates] = useState<ReadonlyArray<DesktopAgentRuntimeState>>([]);
  useEffect(() => {
    const bridge = agentRuntimeBridge();
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onState((next) => {
      if (active) setStates(next);
    });
    void bridge
      .getState()
      .then((initial) => {
        if (active) setStates(initial);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return states;
}

export function retryAgentRuntimeDownloads(): void {
  void agentRuntimeBridge()
    ?.retry()
    .catch(() => undefined);
}

/** Background runtime downloads pause while any chat is running and resume when none is. */
export function useAgentRuntimeBusySignal(): void {
  const busy = useStore((state) =>
    Object.values(state.threadSessionById ?? {}).some((session) => isSessionRunningTurn(session)),
  );
  useEffect(() => {
    void agentRuntimeBridge()
      ?.setBusy(busy)
      .catch(() => undefined);
  }, [busy]);
}

const HELD_SEND_PREFIX = "moss.agentRuntimeHeldSend.";
/** The server learns about a ready runtime a moment after the window does (a local request). */
export const HELD_SEND_AFTER_READY_MS = 2_000;

function readHeld(threadId: string): boolean {
  try {
    return window.localStorage.getItem(`${HELD_SEND_PREFIX}${threadId}`) === "1";
  } catch {
    return false;
  }
}

function writeHeld(threadId: string, held: boolean): void {
  try {
    if (held) window.localStorage.setItem(`${HELD_SEND_PREFIX}${threadId}`, "1");
    else window.localStorage.removeItem(`${HELD_SEND_PREFIX}${threadId}`);
  } catch {
    // Without storage the hold still works until Moss restarts.
  }
}

/**
 * A message the person sent while the agent it needs was still downloading. It stays in the
 * composer, marked to send by itself, and goes out once the agent is ready, also after Moss was
 * closed and opened again in between (the draft and the mark are both kept).
 */
export function useAgentRuntimeHeldSend(input: {
  readonly threadId: string;
  /** True while the agent this chat would use is not ready. */
  readonly pending: boolean;
  readonly send: () => void;
}): { readonly held: boolean; readonly hold: () => void; readonly cancel: () => void } {
  const { threadId, pending, send } = input;
  const [held, setHeld] = useState(() => readHeld(threadId));
  useEffect(() => {
    setHeld(readHeld(threadId));
  }, [threadId]);
  const hold = useCallback(() => {
    writeHeld(threadId, true);
    setHeld(true);
  }, [threadId]);
  const cancel = useCallback(() => {
    writeHeld(threadId, false);
    setHeld(false);
  }, [threadId]);
  // The latest send, without restarting the timer: ChatView makes a new one on every render, and
  // while the other agent still downloads it re-renders many times a second (its progress), which
  // kept a timer keyed on `send` from ever firing (2b acceptance run, 2026-11-18).
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    if (!held || pending) return;
    const timer = window.setTimeout(() => {
      writeHeld(threadId, false);
      setHeld(false);
      sendRef.current();
    }, HELD_SEND_AFTER_READY_MS);
    return () => window.clearTimeout(timer);
  }, [held, pending, threadId]);
  return { held, hold, cancel };
}
