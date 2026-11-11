// FILE: mossCanvasReferenceImages.ts
// Purpose: Images the Canvas puts into its conversation's composer for the
// selected card. Their id says so, so a Canvas opened later (a new workspace,
// after a reload) replaces them instead of attaching the same image again, and
// a draft holding nothing else is not something the owner wrote.
// Layer: Web renderer, composer drafts

const MOSS_CANVAS_REFERENCE_IMAGE_PREFIX = "moss-canvas-ref:";

export function mossCanvasReferenceImageId(id: string): string {
  return id.startsWith(MOSS_CANVAS_REFERENCE_IMAGE_PREFIX)
    ? id
    : `${MOSS_CANVAS_REFERENCE_IMAGE_PREFIX}${id}`;
}

export function isMossCanvasReferenceImageId(id: string): boolean {
  return id.startsWith(MOSS_CANVAS_REFERENCE_IMAGE_PREFIX);
}

/** The draft without the images the Canvas attached on its own. */
export function withoutMossCanvasReferenceImages<
  T extends {
    readonly images: ReadonlyArray<{ readonly id: string }>;
    readonly persistedAttachments: ReadonlyArray<{ readonly id: string }>;
  },
>(draft: T): T {
  return {
    ...draft,
    images: draft.images.filter((image) => !isMossCanvasReferenceImageId(image.id)),
    persistedAttachments: draft.persistedAttachments.filter(
      (image) => !isMossCanvasReferenceImageId(image.id),
    ),
  };
}
