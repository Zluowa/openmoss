// FILE: hooks.ts
// Purpose: The guest page's React hooks: the live stream, the receipts the guest saw wait, the
//          phone keyboard-aware frame, and the pointer kind.
// Layer: Guest page UI

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStore } from "~/store";

import { startGuestConnection, type GuestConnectionStatus } from "./connection";
import {
  applyGuestStreamEvent,
  initialGuestStreamState,
  type GuestStreamState,
} from "./guestStream.logic";
import type { GuestShareView } from "./protocol";
import type { GuestTransport } from "./transport";

export interface GuestStreamSession {
  readonly state: GuestStreamState;
  readonly status: GuestConnectionStatus;
  readonly retryNow: () => void;
}

/**
 * Opens the stream for the transport and keeps it open until the share ends or unmount. Thread
 * items go to the app store as they arrive; the share-level state (view, end) is React state.
 */
export function useGuestStream(transport: GuestTransport): GuestStreamSession {
  const [state, setState] = useState<GuestStreamState>(initialGuestStreamState);
  const [status, setStatus] = useState<GuestConnectionStatus>({ kind: "connecting" });
  const stateRef = useRef(state);
  const connectionRef = useRef<ReturnType<typeof startGuestConnection> | null>(null);

  useEffect(() => {
    const connection = startGuestConnection({
      transport,
      onEvent: (event) => {
        // Applied outside the reducer: the store write is a side effect, and StrictMode runs
        // reducers twice.
        stateRef.current = applyGuestStreamEvent(stateRef.current, event, useStore.getState());
        setState(stateRef.current);
      },
      onStatus: setStatus,
    });
    connectionRef.current = connection;
    // A phone coming back from the background, or the network returning, should not sit out
    // the rest of a 15 s backoff.
    const retry = () => {
      if (document.visibilityState === "visible") connection.retryNow();
    };
    document.addEventListener("visibilitychange", retry);
    window.addEventListener("online", retry);
    return () => {
      document.removeEventListener("visibilitychange", retry);
      window.removeEventListener("online", retry);
      connection.stop();
      connectionRef.current = null;
    };
  }, [transport]);

  const retryNow = useCallback(() => connectionRef.current?.retryNow(), []);
  return { state, status, retryNow };
}

const SEEN_PENDING_LIMIT = 50;
const seenPendingKey = (shareId: string) => `moss-guest:seen-pending:${shareId}`;

function readSeenPending(shareId: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(seenPendingKey(shareId)) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeenPending(shareId: string, ids: ReadonlySet<string>) {
  try {
    sessionStorage.setItem(
      seenPendingKey(shareId),
      JSON.stringify([...ids].slice(-SEEN_PENDING_LIMIT)),
    );
  } catch {
    // Private mode: receipts then last for this load only.
  }
}

/**
 * Which of the guest's own messages this tab saw waiting, so a later "sent" or "not sent"
 * shows as a receipt once, and a reload does not replay old ones.
 */
export function useSeenPendingIds(
  shareId: string,
  view: GuestShareView | null,
): ReadonlySet<string> {
  const [seen, setSeen] = useState(() => readSeenPending(shareId));
  useEffect(() => {
    if (view === null) return;
    const fresh = view.messages.filter(
      (message) => message.status === "pending" && !seen.has(message.id),
    );
    if (fresh.length === 0) return;
    const next = new Set(seen);
    for (const message of fresh) next.add(message.id);
    writeSeenPending(shareId, next);
    setSeen(next);
  }, [view, seen, shareId]);
  return seen;
}

/**
 * iOS Safari and WeChat do not shrink the layout viewport for the on-screen keyboard, so a
 * bottom composer ends up hidden behind it. Sizing the frame to the visual viewport keeps the
 * composer in view while typing. Returns the height to apply, or null for the CSS default.
 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const keyboardUp = window.innerHeight - viewport.height > 80;
      setHeight(keyboardUp ? Math.round(viewport.height) : null);
      // The page itself never scrolls; undo the offset a focused input can introduce.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return height;
}

/** Whether the device's primary input is a touch screen (then Enter inserts a line). */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia("(pointer: coarse)");
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}
