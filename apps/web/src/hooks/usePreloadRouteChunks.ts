import { useEffect } from "react";

/** Warms code-split route chunks once the browser is idle.
 *
 *  Settings and thread routes are reached through programmatic `navigate()`
 *  calls (sidebar gear, keyboard shortcut, the "New thread" button), so the
 *  router's intent-based preloading never fires for them — without this, the
 *  first open pays the chunk download/parse cost. For a brand-new thread that
 *  cost lands right on the draft-landing paint, so warming the thread chunk is
 *  the largest single lever for new-chat startup time.
 */
export function usePreloadRouteChunks() {
  useEffect(() => {
    // Warm the generated split component directly instead of manufacturing a
    // speculative router match with a fake thread id. A real navigation can
    // discard that match while TanStack Router is still completing its preload,
    // leaving the runtime to finalize an already-removed match.
    void import("../routes/_chat.$threadId?tsr-split=component").catch(() => {
      // Preloading is best-effort; navigation falls back to loading on demand.
    });

    const preloadSettings = () => {
      void import("../routes/_chat.settings?tsr-split=component").catch(() => {
        // Preloading is best-effort; navigation falls back to loading on demand.
      });
    };

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preloadSettings, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preloadSettings, 1500);
    return () => clearTimeout(timeoutId);
  }, []);
}
