// FILE: processTerminationSignals.ts
// Purpose: Gives Moss shutdown ownership before Electron reacts to POSIX termination signals.
// Layer: Desktop process lifecycle

export type DesktopTerminationSignal = "SIGINT" | "SIGTERM";

export interface DesktopTerminationSignalSource {
  readonly prependListener: (event: DesktopTerminationSignal, listener: () => void) => unknown;
  readonly removeListener: (event: DesktopTerminationSignal, listener: () => void) => unknown;
}

export function registerDesktopTerminationSignalHandlers(input: {
  readonly ready: Promise<unknown>;
  readonly source: DesktopTerminationSignalSource;
  readonly isShutdownStarted: () => boolean;
  readonly onSignal: (signal: DesktopTerminationSignal) => void;
}): () => void {
  const listeners = new Map<DesktopTerminationSignal, () => void>();
  let disposed = false;

  // Electron replaces native signal handlers during startup. Registering a Node
  // watcher before then, even with prependListener, can leave it disconnected.
  void input.ready.then(() => {
    if (disposed) return;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = (): void => {
        if (input.isShutdownStarted()) return;
        input.onSignal(signal);
      };
      listeners.set(signal, listener);
      // Once ready, run before any existing JS listeners so before-quit observes
      // Moss shutdown ownership instead of opening a user-only confirmation.
      input.source.prependListener(signal, listener);
    }
  });

  return () => {
    disposed = true;
    for (const [signal, listener] of listeners) {
      input.source.removeListener(signal, listener);
    }
  };
}
