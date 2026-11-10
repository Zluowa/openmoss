// FILE: composerImagePreviewRequest.ts
// Purpose: Lets another surface ask the composer to open one of its image attachments in the
//   attachment preview, optionally straight into markup (the shared Moss markup editor). Canvas
//   uses it so opening an image on the board works like ChatGPT's image view: large, ready to
//   mark up, already attached to the message.
// Layer: Web utility (in-memory, per window)

export interface ComposerImagePreviewRequest {
  readonly imageId: string;
  readonly markup: boolean;
}

type Listener = (request: ComposerImagePreviewRequest) => void;
const listeners = new Set<Listener>();

/** Open the composer attachment `imageId`; the composer showing it answers. */
export function requestComposerImagePreview(request: ComposerImagePreviewRequest): void {
  for (const listener of listeners) listener(request);
}

export function subscribeComposerImagePreview(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
