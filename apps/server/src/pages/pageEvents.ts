// FILE: pageEvents.ts
// Purpose: Lightweight in-process event bus publishing Space item updates (`page-updated`)
//          across Docs, Sheets, Dashboards, Slides, Design, and Boards so SSE subscribers
//          refresh immediately and receive pre-apply rollback revision metadata.
// Layer: Server pages. Zero filesystem or external dependencies.

export interface PageUpdateEvent {
  readonly type: "page-updated";
  readonly pageId: string;
  readonly scopeSpaceId: string | null;
  readonly kind?: string;
  readonly revision: number;
  readonly previousRevision?: number;
  readonly undoRevision?: number;
  readonly applyMode?: "auto" | "draft";
  readonly author: "local-user" | "agent";
  readonly authorThreadId?: string | null;
  readonly operation?: string;
  readonly updatedAt: string;
}

type Listener = (event: PageUpdateEvent) => void;

const listeners = new Set<Listener>();

export function publishPageUpdate(event: PageUpdateEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Never allow one dropped subscriber to break persistence commits.
    }
  }
}

export function subscribePageUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pageUpdateSubscriberCountForTests(): number {
  return listeners.size;
}
