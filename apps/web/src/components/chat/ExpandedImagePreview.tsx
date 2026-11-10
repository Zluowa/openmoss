export interface ExpandedImageItem {
  src: string;
  name: string;
}

/**
 * Generated-image requests carry filesystem metadata alongside the legacy
 * expanded-image shape. Plain image clicks use the transient lightbox URLs;
 * an explicit Canvas request uses filesystem metadata for the durable editor
 * without persisting authenticated URLs.
 */
export interface GeneratedImagePreviewRequest {
  kind: "generated-image";
  groupId: string;
  createdAt: string | null;
  images: Array<{
    id: string;
    path: string;
    name: string;
  }>;
  activeImageId: string;
  index: number;
  cwd: string | undefined;
  /** The gallery's Canvas action opens the same group in the editor overview. */
  initialView?: "playground";
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
  generated?: GeneratedImagePreviewRequest;
}

/**
 * A click on a generated image zooms it in the lightbox like any other image.
 * Only the gallery's 画布 chip (initialView "playground") opens the Canvas.
 */
export function shouldOpenGeneratedImageInCanvas(preview: ExpandedImagePreview): boolean {
  return (
    preview.generated?.kind === "generated-image" && preview.generated.initialView === "playground"
  );
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl ? [{ id: image.id, src: image.previewUrl, name: image.name }] : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
