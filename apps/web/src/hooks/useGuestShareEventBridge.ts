// FILE: useGuestShareEventBridge.ts
// Purpose: Keep the guest share store in step with the server's `guestShare.subscribe` stream.
// Layer: Web event bridge hook
// Exports: useGuestShareEventBridge
// Depends on: nativeApi guestShare.onEvent, guestShareStore
//
// Mounted once by EventRouter so the header indicator, the waiting-message panel, and
// the sidebar badge all read one stream, whichever thread is open.

import { useEffect } from "react";

import { ensureGuestShareApi } from "~/nativeApi";
import { useGuestShareStore } from "../guestShareStore";

export function useGuestShareEventBridge(): void {
  useEffect(() => {
    const unsubscribe = ensureGuestShareApi().onEvent((event) => {
      useGuestShareStore.getState().applyEvent(event);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
