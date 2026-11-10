// FILE: ExpandedImageOverlay.tsx
// Purpose: Shared full-window image lightbox with navigation, anchored zoom, pan, and download.
// Layer: Chat and composer UI component
// Exports: ExpandedImageOverlay

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR } from "@moss/shared/desktopChrome";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { isElectron } from "~/env";
import { useDesktopCustomTitleBarActive } from "~/hooks/useDesktopCustomTitleBar";
import { DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  Loader2Icon,
  Maximize2,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "~/lib/icons";
import { notifyNativeSurfaceOcclusionChange } from "~/lib/nativeSurfaceOcclusion";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useLocalImageDownloadClick } from "../LocalImagePreview";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  GENERATED_IMAGE_PREVIEW_MAX_ZOOM_PERCENT,
  GENERATED_IMAGE_PREVIEW_MIN_ZOOM_PERCENT,
  clampGeneratedImagePreviewZoomPercent,
  resolveGeneratedImagePreviewFitZoomPercent,
  resolveGeneratedImagePreviewZoomForWheel,
  resolveGeneratedImagePreviewZoomScrollPosition,
  type GeneratedImagePreviewPoint,
  type GeneratedImagePreviewSize,
} from "./generatedImagePreviewControls.logic";

interface ExpandedImageOverlayProps {
  readonly expandedImage: ExpandedImagePreview | null;
  readonly onClose: () => void;
  readonly onNavigate: (direction: -1 | 1) => void;
}

export function ExpandedImageOverlay({
  expandedImage,
  onClose,
  onNavigate,
}: ExpandedImageOverlayProps) {
  const { t } = useTranslation();
  const image = expandedImage?.images[expandedImage.index];
  const open = image !== undefined;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    notifyNativeSurfaceOcclusionChange();
    return notifyNativeSurfaceOcclusionChange;
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {image && expandedImage ? (
        <DialogPopup
          layout="fullscreen"
          showCloseButton={false}
          initialFocus={closeButtonRef}
          aria-label={t("chat.imageLightbox.title")}
          className="bg-[#181818] text-white [--color-text-foreground-secondary:#d4d4d4] [--color-text-foreground:#fff] [--color-background-button-secondary-hover:#ffffff14] [-webkit-app-region:no-drag]"
        >
          <DialogTitle className="sr-only">{t("chat.imageLightbox.title")}</DialogTitle>
          <ImageLightboxContent
            image={image}
            index={expandedImage.index}
            imageCount={expandedImage.images.length}
            closeButtonRef={closeButtonRef}
            onClose={onClose}
            onNavigate={onNavigate}
          />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function ImageLightboxContent({
  image,
  index,
  imageCount,
  closeButtonRef,
  onClose,
  onNavigate,
}: {
  image: ExpandedImageItem;
  index: number;
  imageCount: number;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const customTitleBarActive = useDesktopCustomTitleBarActive();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState<GeneratedImagePreviewSize | null>(null);
  const [viewportSize, setViewportSize] = useState<GeneratedImagePreviewSize | null>(null);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const zoomAnchor = useRef<{
    rect: DOMRect;
    point: GeneratedImagePreviewPoint;
  } | null>(null);
  const fitZoom = resolveGeneratedImagePreviewFitZoomPercent({
    naturalImageSize: naturalSize,
    viewportSize,
  });
  const zoom = manualZoom ?? fitZoom ?? 100;
  const scaledSize = naturalSize
    ? { width: (naturalSize.width * zoom) / 100, height: (naturalSize.height * zoom) / 100 }
    : null;
  const overflowing =
    scaledSize !== null &&
    viewportSize !== null &&
    (scaledSize.width > viewportSize.width || scaledSize.height > viewportSize.height);
  const downloadImage = useLocalImageDownloadClick({
    downloadUrl: image.src,
    downloadName: image.name,
  });

  // Keep controls (and their keyboard focus) mounted while resetting image state.
  useLayoutEffect(() => {
    setNaturalSize(null);
    setManualZoom(null);
    setFailed(false);
    setDragging(false);
    drag.current = null;
    zoomAnchor.current = null;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }, [image.src, index]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () =>
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const target = imageRef.current;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (!viewport || !target) return;
    if (anchor && manualZoom !== null) {
      const position = resolveGeneratedImagePreviewZoomScrollPosition({
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        oldTargetRect: anchor.rect,
        newTargetRect: target.getBoundingClientRect(),
        point: anchor.point,
      });
      viewport.scrollLeft = position.left;
      viewport.scrollTop = position.top;
    } else if (manualZoom === null) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
  }, [manualZoom, naturalSize, viewportSize]);

  const changeZoom = useCallback(
    (nextZoom: number, point?: GeneratedImagePreviewPoint) => {
      const clampedZoom = clampGeneratedImagePreviewZoomPercent(nextZoom);
      if (clampedZoom === zoom) return;
      const viewport = viewportRef.current;
      const target = imageRef.current;
      if (!viewport || !target) return;
      const rect = viewport.getBoundingClientRect();
      zoomAnchor.current = {
        rect: target.getBoundingClientRect(),
        point: point ?? {
          clientX: rect.left + viewport.clientWidth / 2,
          clientY: rect.top + viewport.clientHeight / 2,
        },
      };
      setManualZoom(clampedZoom);
    },
    [zoom],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!naturalSize) return;
      changeZoom(
        resolveGeneratedImagePreviewZoomForWheel({
          currentZoomPercent: zoom,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          pageHeightPx: viewport.clientHeight,
        }),
        { clientX: event.clientX, clientY: event.clientY },
      );
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [changeZoom, naturalSize, zoom]);

  return (
    <>
      <header
        className={cn(
          "flex h-16 shrink-0 items-center gap-3 px-4 sm:px-6",
          customTitleBarActive && DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS,
        )}
        style={
          isElectron && isMacNavigatorPlatform()
            ? {
                paddingLeft: `var(${DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR}, 90px)`,
              }
            : undefined
        }
      >
        <p className="min-w-0 flex-1 truncate text-ui-sm text-white/80" title={image.name}>
          {image.name}
        </p>
        {imageCount > 1 ? (
          <p className="shrink-0 text-ui-sm tabular-nums text-white/50" aria-live="polite">
            {index + 1} / {imageCount}
          </p>
        ) : null}
        <Button
          size="icon-xl"
          variant="ghost"
          onClick={downloadImage}
          aria-label={t("chat.imageLightbox.download")}
          title={t("chat.imageLightbox.download")}
        >
          <DownloadIcon />
        </Button>
        <Button
          size="icon-xl"
          variant="ghost"
          onClick={onClose}
          aria-label={t("chat.imageLightbox.close")}
          title={t("chat.imageLightbox.closeHint")}
          ref={closeButtonRef}
        >
          <XIcon />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          className="absolute inset-y-0 inset-x-3 overflow-auto overscroll-contain sm:inset-x-16"
          data-testid="image-lightbox-viewport"
          data-zoom-mode={manualZoom === null ? "fit" : "manual"}
          data-zoom-percent={Math.round(zoom)}
        >
          <div
            className="flex min-h-full min-w-full items-center justify-center"
            style={
              scaledSize && viewportSize
                ? {
                    width: Math.max(viewportSize.width, scaledSize.width),
                    height: Math.max(viewportSize.height, scaledSize.height),
                  }
                : undefined
            }
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            {!naturalSize && !failed ? (
              <span
                role="status"
                aria-label={t("chat.imageLightbox.loading")}
                className="absolute pointer-events-none"
              >
                <Loader2Icon className="size-6 animate-spin motion-reduce:animate-none text-white/50" />
              </span>
            ) : null}
            {failed ? (
              <p role="status" className="text-ui text-white/60">
                {t("chat.imageLightbox.unavailable")}
              </p>
            ) : (
              <img
                key={`${index}:${image.src}`}
                ref={imageRef}
                src={image.src}
                alt={image.name}
                draggable={false}
                className={`shrink-0 select-none object-contain ${overflowing ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"}`}
                style={scaledSize ?? { maxWidth: "100%", maxHeight: "100%" }}
                onLoad={(event) =>
                  setNaturalSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailed(true)}
                onDoubleClick={() =>
                  manualZoom === null ? changeZoom(Math.max(100, zoom)) : setManualZoom(null)
                }
                onPointerDown={(event) => {
                  const viewport = viewportRef.current;
                  if (
                    !overflowing ||
                    !viewport ||
                    event.button !== 0 ||
                    event.pointerType === "touch"
                  )
                    return;
                  event.preventDefault();
                  drag.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    left: viewport.scrollLeft,
                    top: viewport.scrollTop,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDragging(true);
                }}
                onPointerMove={(event) => {
                  const viewport = viewportRef.current;
                  const start = drag.current;
                  if (!viewport || !start || start.pointerId !== event.pointerId) return;
                  viewport.scrollLeft = start.left - (event.clientX - start.x);
                  viewport.scrollTop = start.top - (event.clientY - start.y);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  drag.current = null;
                  setDragging(false);
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                  setDragging(false);
                }}
              />
            )}
          </div>
        </div>
        {imageCount > 1 ? (
          <>
            <Button
              size="icon-xl"
              variant="ghost"
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40"
              aria-label={t("chat.imageLightbox.previous")}
              onClick={() => onNavigate(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xl"
              variant="ghost"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40"
              aria-label={t("chat.imageLightbox.next")}
              onClick={() => onNavigate(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        ) : null}
      </div>
      <footer className="flex h-16 shrink-0 items-center justify-center gap-1">
        <Button
          size="icon-xl"
          variant="ghost"
          disabled={!naturalSize || zoom <= GENERATED_IMAGE_PREVIEW_MIN_ZOOM_PERCENT}
          aria-label={t("chat.imageLightbox.zoomOut")}
          title={t("chat.imageLightbox.zoomOut")}
          onClick={() => changeZoom(zoom / 1.25)}
        >
          <MinusIcon />
        </Button>
        <span className="w-14 text-center text-ui-sm tabular-nums text-white/70" aria-live="polite">
          {Math.round(zoom)}%
        </span>
        <Button
          size="icon-xl"
          variant="ghost"
          disabled={!naturalSize || zoom >= GENERATED_IMAGE_PREVIEW_MAX_ZOOM_PERCENT}
          aria-label={t("chat.imageLightbox.zoomIn")}
          title={t("chat.imageLightbox.zoomIn")}
          onClick={() => changeZoom(zoom * 1.25)}
        >
          <PlusIcon />
        </Button>
        <span aria-hidden="true" className="mx-2 h-4 w-px bg-white/15" />
        <Button
          size="icon-xl"
          variant="ghost"
          disabled={!naturalSize}
          aria-label={t("chat.imageLightbox.fit")}
          title={t("chat.imageLightbox.fit")}
          onClick={() => setManualZoom(null)}
        >
          <Maximize2 />
        </Button>
      </footer>
    </>
  );
}
