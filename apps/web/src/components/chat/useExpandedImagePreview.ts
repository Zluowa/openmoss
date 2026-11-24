// FILE: useExpandedImagePreview.ts
// Purpose: Shared state and keyboard handling for the fullscreen image preview overlay.
// Layer: Chat and composer UI hook
// Exports: useExpandedImagePreview, useExpandedImagePreviewKeys

import { useCallback, useEffect, useState } from "react";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function useExpandedImagePreview() {
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useExpandedImagePreviewKeys({
    open: expandedImage !== null,
    imageCount: expandedImage?.images.length ?? 0,
    onClose: closeExpandedImage,
    onNavigate: navigateExpandedImage,
  });

  return { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage };
}

/**
 * The image viewer's keys, for any owner of an open viewer (a sent image's, a composer image's):
 * Escape closes it before a containing dialog can discard its draft; the arrow keys step
 * through its images.
 */
export function useExpandedImagePreviewKeys({
  open,
  imageCount,
  onClose,
  onNavigate,
}: {
  open: boolean;
  imageCount: number;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (imageCount <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(1);
    };

    // Consume Escape before a containing dialog handles it and discards its draft.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [imageCount, onClose, onNavigate, open]);
}
