// FILE: runningChatsQuitGuard.ts
// Purpose: Coordinates the renderer Stay/Quit handshake before a user-initiated desktop quit.
//          An idle app quits straight away; the dialog only appears while work is running.
// Layer: Desktop quit policy
// Depends on: Quit confirmation IPC payloads from the renderer.

import type {
  DesktopQuitConfirmationChat,
  DesktopQuitConfirmationPresentation,
  DesktopQuitConfirmationRequest,
  DesktopQuitConfirmationResponse,
} from "@moss/contracts";

const DEFAULT_READY_TIMEOUT_MS = 3000;

export function shouldPromptForRunningChatsBeforeQuit(reason: string): boolean {
  return reason === "window-close" || reason === "before-quit";
}

export function quitConfirmationPresentationForPlatform(): DesktopQuitConfirmationPresentation {
  return "in-app";
}

export function parseQuitConfirmationRequest(
  payload: unknown,
): DesktopQuitConfirmationRequest | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }
  const presentationRaw = (payload as { readonly presentation?: unknown }).presentation;
  const updateDownloading =
    (payload as { readonly updateDownloading?: unknown }).updateDownloading === true;
  return {
    requestId,
    presentation: presentationRaw === "native" ? "native" : "in-app",
    ...(updateDownloading ? { updateDownloading: true } : {}),
  };
}

function parseQuitConfirmationChats(value: unknown): DesktopQuitConfirmationChat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const chats: DesktopQuitConfirmationChat[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") {
      continue;
    }
    const id = (item as { readonly id?: unknown }).id;
    const title = (item as { readonly title?: unknown }).title;
    if (typeof id !== "string" || id.trim().length === 0) {
      continue;
    }
    chats.push({
      id,
      title: typeof title === "string" ? title : "",
    });
  }
  return chats;
}

export function parseQuitConfirmationResponse(
  payload: unknown,
): DesktopQuitConfirmationResponse | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    readonly requestId?: unknown;
    readonly phase?: unknown;
    readonly runningCount?: unknown;
    readonly chats?: unknown;
    readonly allow?: unknown;
  };
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return null;
  }
  if (record.phase === "ready") {
    if (typeof record.runningCount !== "number" || !Number.isFinite(record.runningCount)) {
      return null;
    }
    return {
      requestId: record.requestId,
      phase: "ready",
      runningCount: record.runningCount,
      chats: parseQuitConfirmationChats(record.chats),
    };
  }
  if (record.phase === "decision" && typeof record.allow === "boolean") {
    return {
      requestId: record.requestId,
      phase: "decision",
      allow: record.allow,
    };
  }
  return null;
}

export interface RunningChatsQuitGuard {
  readonly hasAllowedQuit: () => boolean;
  readonly hasPendingAsk: () => boolean;
  readonly cancelPending: () => void;
  /**
   * Resolve the pending ask as allowed WITHOUT latching `allowed` — a dead
   * renderer proved the ask can never be answered, not that the user said
   * yes, so a later quit must still get to ask.
   */
  readonly allowPending: () => void;
  readonly receiveResponse: (payload: unknown) => void;
  readonly askRenderer: (input: {
    readonly send: (request: DesktopQuitConfirmationRequest) => void;
    readonly isRendererAvailable: () => boolean;
    /** Passed through on the request so the renderer can list the download. */
    readonly updateDownloading?: boolean;
    /**
     * Called once the renderer reports running work and is about to show its dialog,
     * so a hidden or minimized window can be brought forward. Never called for an
     * idle app, which quits without showing anything.
     */
    readonly onPrompt?: () => void;
    readonly readyTimeoutMs?: number;
    readonly presentation?: DesktopQuitConfirmationPresentation;
    readonly presentNativeConfirmation?: (
      chats: ReadonlyArray<DesktopQuitConfirmationChat>,
    ) => boolean | Promise<boolean>;
  }) => Promise<boolean>;
}

interface PendingQuitConfirmation {
  readonly requestId: string;
  readonly presentation: DesktopQuitConfirmationPresentation;
  readonly presentNativeConfirmation:
    | ((chats: ReadonlyArray<DesktopQuitConfirmationChat>) => boolean | Promise<boolean>)
    | undefined;
  readonly onPrompt: (() => void) | undefined;
  waitingForDecision: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (allow: boolean) => void;
}

export function makeRunningChatsQuitGuard(
  createRequestId: () => string = () => crypto.randomUUID(),
): RunningChatsQuitGuard {
  let allowed = false;
  let inFlight: Promise<boolean> | null = null;
  let pending: PendingQuitConfirmation | null = null;

  const finish = (allow: boolean): void => {
    const current = pending;
    pending = null;
    if (current?.readyTimer) {
      clearTimeout(current.readyTimer);
    }
    if (allow) {
      allowed = true;
    }
    current?.resolve(allow);
  };

  const presentNativeSheet = (
    current: PendingQuitConfirmation,
    chats: ReadonlyArray<DesktopQuitConfirmationChat>,
  ): void => {
    const presenter = current.presentNativeConfirmation;
    if (!presenter) {
      finish(true);
      return;
    }
    const requestId = current.requestId;
    void Promise.resolve()
      .then(() => presenter(chats))
      .then(
        (allow) => {
          if (pending?.requestId === requestId) {
            finish(allow);
          }
        },
        () => {
          if (pending?.requestId === requestId) {
            finish(true);
          }
        },
      );
  };

  return {
    hasAllowedQuit: () => allowed,
    hasPendingAsk: () => pending !== null,
    cancelPending(): void {
      finish(false);
    },
    allowPending(): void {
      const current = pending;
      pending = null;
      if (current?.readyTimer) {
        clearTimeout(current.readyTimer);
      }
      current?.resolve(true);
    },
    receiveResponse(payload: unknown): void {
      const response = parseQuitConfirmationResponse(payload);
      if (!response || pending == null || response.requestId !== pending.requestId) {
        return;
      }
      if (response.phase === "decision") {
        finish(response.allow);
        return;
      }
      if (pending.readyTimer) {
        clearTimeout(pending.readyTimer);
        pending.readyTimer = null;
      }
      // Nothing is running: quit straight away, as other desktop apps do.
      if (response.runningCount <= 0) {
        finish(true);
        return;
      }
      pending.waitingForDecision = true;
      try {
        pending.onPrompt?.();
      } catch {
        // Bringing the window forward is best effort; the renderer still shows its dialog.
      }
      if (pending.presentation === "native") {
        presentNativeSheet(pending, response.chats);
      }
    },
    askRenderer(input): Promise<boolean> {
      if (allowed) {
        return Promise.resolve(true);
      }
      if (inFlight) {
        return inFlight;
      }
      if (!input.isRendererAvailable()) {
        return Promise.resolve(true);
      }

      inFlight = new Promise<boolean>((resolve) => {
        const requestId = createRequestId();
        const presentation = input.presentation ?? "in-app";
        pending = {
          requestId,
          presentation,
          presentNativeConfirmation: input.presentNativeConfirmation,
          onPrompt: input.onPrompt,
          waitingForDecision: false,
          readyTimer: setTimeout(() => {
            if (pending?.requestId === requestId && !pending.waitingForDecision) {
              finish(true);
            }
          }, input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
          resolve: (allow) => {
            inFlight = null;
            resolve(allow);
          },
        };
        try {
          input.send({
            requestId,
            presentation,
            ...(input.updateDownloading === true ? { updateDownloading: true } : {}),
          });
        } catch {
          finish(true);
        }
      });
      return inFlight;
    },
  };
}
