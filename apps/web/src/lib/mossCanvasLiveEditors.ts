// FILE: mossCanvasLiveEditors.ts
// Purpose: Which conversations have a 画布 open in a ready editor right now, and how to hand that
//          editor an agent's edit (moss_canvas_mutate).
// Layer: Web lib. MossCanvasWebSurface registers its ready frame; components/chat/canvasAgentOps.ts
//        looks the editor up when the gateway asks.

export interface MossCanvasLiveEditResult {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly created?: Readonly<Record<string, string>>;
  readonly deletedCount?: number;
  readonly shapes?: readonly unknown[];
  readonly truncated?: boolean;
  /** False when the edit is on the board but the editor's save has not gone through yet. */
  readonly saved?: boolean;
}

export interface MossCanvasLiveEditor {
  readonly apply: (
    requestId: string,
    ops: readonly Record<string, unknown>[],
  ) => Promise<MossCanvasLiveEditResult>;
}

const editors = new Map<string, MossCanvasLiveEditor>();
const listeners = new Set<() => void>();

export function registerMossCanvasLiveEditor(
  threadId: string,
  editor: MossCanvasLiveEditor,
): () => void {
  editors.set(threadId, editor);
  listeners.forEach((listener) => listener());
  return () => {
    if (editors.get(threadId) === editor) editors.delete(threadId);
  };
}

export function getMossCanvasLiveEditor(threadId: string): MossCanvasLiveEditor | null {
  return editors.get(threadId) ?? null;
}

/** Resolves with the editor once one is ready for `threadId`, or null after `timeoutMs`. */
export function waitForMossCanvasLiveEditor(
  threadId: string,
  timeoutMs: number,
): Promise<MossCanvasLiveEditor | null> {
  const ready = editors.get(threadId);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const listener = () => {
      const editor = editors.get(threadId);
      if (!editor) return;
      cleanup();
      resolve(editor);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      listeners.delete(listener);
    };
    listeners.add(listener);
  });
}

// A 画布 frame mounted for a conversation, ready or still loading. While none is, an agent's edit
// is written to storage; a frame that mounts meanwhile waits until that write is done, so it
// loads the board with the edit instead of saving an older one over it.
const mounted = new Map<string, number>();
const holds = new Map<string, Set<string>>();
const holdListeners = new Set<() => void>();
const notifyHolds = () => holdListeners.forEach((listener) => listener());

export function noteMossCanvasMounted(threadId: string): () => void {
  mounted.set(threadId, (mounted.get(threadId) ?? 0) + 1);
  return () => {
    const count = (mounted.get(threadId) ?? 1) - 1;
    if (count > 0) mounted.set(threadId, count);
    else mounted.delete(threadId);
  };
}

export function isMossCanvasMounted(threadId: string): boolean {
  return (mounted.get(threadId) ?? 0) > 0;
}

/** Holds new 画布 frames of `threadId` back until `releaseMossCanvasLoad` (or `timeoutMs`). */
export function holdMossCanvasLoad(threadId: string, requestId: string, timeoutMs = 60_000): void {
  const set = holds.get(threadId) ?? new Set<string>();
  set.add(requestId);
  holds.set(threadId, set);
  notifyHolds();
  setTimeout(() => releaseMossCanvasLoad(threadId, requestId), timeoutMs);
}

export function releaseMossCanvasLoad(threadId: string, requestId: string): void {
  const set = holds.get(threadId);
  if (!set?.delete(requestId)) return;
  if (set.size === 0) holds.delete(threadId);
  notifyHolds();
}

export function isMossCanvasLoadHeld(threadId: string): boolean {
  return (holds.get(threadId)?.size ?? 0) > 0;
}

export function subscribeMossCanvasLoadHolds(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => holdListeners.delete(listener);
}
