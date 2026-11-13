// FILE: rendererStorageFlush.ts
// Purpose: Writes a renderer's pending localStorage to disk when it asks.
// Layer: Desktop main process
// Exports: createRendererStorageFlusher, RENDERER_STORAGE_TRAILING_FLUSH_MS
// Why: Chromium commits localStorage a few seconds after a write. A crash, a kill or a
//      power cut in that window drops the write, while server-side markers written in the
//      same moment survive. One-time acknowledgements (first-run done, "Not now") then come
//      back on the next launch. A graceful quit commits on its own.

/** Second flush, for a write whose storage message reaches the browser after the request. */
export const RENDERER_STORAGE_TRAILING_FLUSH_MS = 300;

export interface RendererStorageSession {
  flushStorageData(): void;
}

/**
 * Flushes the session now and once more shortly after. The renderer's localStorage write
 * and its flush request travel on different channels, so the request can arrive first; the
 * trailing flush catches that write. Requests inside the trailing window share one timer.
 */
export function createRendererStorageFlusher(input: {
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
}): (session: RendererStorageSession) => void {
  const schedule =
    input.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const pending = new WeakSet<RendererStorageSession>();
  const flush = (session: RendererStorageSession) => {
    try {
      session.flushStorageData();
    } catch {
      // A session torn down at quit has nothing left to flush.
    }
  };
  return (session) => {
    flush(session);
    if (pending.has(session)) return;
    pending.add(session);
    schedule(() => {
      pending.delete(session);
      flush(session);
    }, RENDERER_STORAGE_TRAILING_FLUSH_MS);
  };
}
