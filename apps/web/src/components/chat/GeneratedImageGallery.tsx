// FILE: GeneratedImageGallery.tsx
// Purpose: Renders the Codex generated-image gallery inline after an assistant answer.
// Layer: Web chat presentation component
// Notes: The gallery hands one safe group snapshot to the durable image-preview pane.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { setGeneratedImageDragData } from "~/lib/generatedImageDrag";
import { cn } from "~/lib/utils";
import { useTranslation } from "../../localization";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { GeneratedImagePreviewIcon } from "./GeneratedImagePreviewIcon";
import type {
  GeneratedImageGallery as GeneratedImageGalleryModel,
  GeneratedImageGalleryImage,
} from "./generatedImageGallery.logic";

const GALLERY_GAP_PX = 8;
const GALLERY_MAX_IMAGES_PER_PAGE = 4;

// Generated-image loading-field constants. The gallery only needs the
// thumbnail/default presentation; the editor/playground variants stay out of A.
export const GENERATED_IMAGE_PENDING_DOT_SPACING_PX = 12;
export const GENERATED_IMAGE_PENDING_DOT_OPACITY_AMPLITUDE = 0.16;
export const GENERATED_IMAGE_PENDING_DOT_RADIUS = 0.55;
const GENERATED_IMAGE_PENDING_DOT_THRESHOLD = 0.03;
const GENERATED_IMAGE_PENDING_DURATION_SCALE = 1.2;
const GENERATED_IMAGE_PENDING_FIELD_SIZE_SCALE = 0.78;
const GENERATED_IMAGE_PENDING_FIRST_FIELD_WEIGHT = 1.2;
const GENERATED_IMAGE_PENDING_SECOND_FIELD_WEIGHT = 0.82;
const GENERATED_IMAGE_PENDING_DISTANCE_EXPONENT = 1.18;
const GENERATED_IMAGE_PENDING_DOT_FIELD_CSS = `
@keyframes moss-generated-image-dot-field-opacity {
  50% { opacity: .56; }
}
.moss-generated-image-pending-dots {
  opacity: .38;
  animation: 1.75s ease-in-out infinite moss-generated-image-dot-field-opacity;
  position: absolute;
  inset: 0;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to top left, transparent 0%, #000 30% 70%, transparent 100%);
  mask-image: linear-gradient(to top left, transparent 0%, #000 30% 70%, transparent 100%);
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
.moss-generated-image-pending-placeholder {
  background-color: var(--color-background-primary-soft-active, color-mix(in srgb, currentColor 8%, transparent));
}
.dark .moss-generated-image-pending-placeholder {
  background-color: var(--color-background-primary-ghost-hover, color-mix(in srgb, currentColor 14%, transparent));
}
.moss-generated-image-pending-dots[data-reduced-motion="true"] {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .moss-generated-image-pending-dots { animation: none; }
}
`;

export interface GeneratedImageGalleryLayout {
  heightPx: number;
  aspectRatio: "natural" | "square";
  maxStartIndex: number;
  overflowCount: number;
  visibleCount: number;
  itemWidthsPx: number[];
}

/**
 * Gallery geometry: use natural aspect-ratio tiles while
 * they fit, otherwise expose at most four square carousel slots.
 */
export function deriveGeneratedImageGalleryLayout(input: {
  containerWidthPx: number | null;
  imageAspectRatios: ReadonlyArray<number>;
  minimumSlotCount?: number;
}): GeneratedImageGalleryLayout {
  const ratios = input.imageAspectRatios.map((ratio) =>
    Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
  );
  const itemCount = ratios.length;
  const minimumSlotCount = Math.max(0, input.minimumSlotCount ?? 0);
  const width =
    input.containerWidthPx === null ? 0 : Math.max(0, Math.floor(input.containerWidthPx));
  const slotCount = Math.max(itemCount, minimumSlotCount);
  const naturalHeight =
    width === 0
      ? 0
      : slotCount === 1
        ? width / (ratios[0] ?? 1)
        : Math.max((width - GALLERY_GAP_PX * (GALLERY_MAX_IMAGES_PER_PAGE - 1)) / 4, 0);
  const naturalWidths = ratios.map((ratio) => ratio * naturalHeight);
  const naturalTotalWidth =
    naturalWidths.reduce((total, itemWidth) => total + itemWidth, 0) +
    Math.max(itemCount - 1, 0) * GALLERY_GAP_PX;

  if (input.containerWidthPx === null || naturalTotalWidth <= width) {
    return {
      heightPx: naturalHeight,
      aspectRatio: "natural",
      maxStartIndex: 0,
      overflowCount: 0,
      visibleCount: itemCount,
      itemWidthsPx: naturalWidths,
    };
  }

  const visibleCount = Math.min(itemCount, GALLERY_MAX_IMAGES_PER_PAGE);
  const overflowCount = Math.max(itemCount - visibleCount, 0);
  const squareWidth = Math.max((width - GALLERY_GAP_PX * 3) / 4, 0);
  return {
    heightPx: squareWidth,
    aspectRatio: "square",
    maxStartIndex: overflowCount,
    overflowCount,
    visibleCount,
    itemWidthsPx: ratios.map(() => squareWidth),
  };
}

export interface GeneratedImageGalleryProps {
  gallery: GeneratedImageGalleryModel;
  cwd: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  className?: string | undefined;
}

export function resolveGeneratedImageGalleryGroup(
  input: Pick<GeneratedImageGalleryModel, "turnId" | "createdAt" | "images">,
): {
  groupId: string;
  createdAt: string | null;
} {
  return {
    groupId: input.turnId
      ? String(input.turnId)
      : `generated-image-gallery:${input.images[0]?.id ?? "unknown"}`,
    createdAt: input.createdAt,
  };
}

export function GeneratedImageGallery({
  gallery,
  cwd,
  onImageExpand,
  className,
}: GeneratedImageGalleryProps) {
  const { t, format } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailsRef = useRef<HTMLDivElement>(null);
  const [containerWidthPx, setContainerWidthPx] = useState<number | null>(null);
  const [imageAspectRatios, setImageAspectRatios] = useState<Record<string, number>>({});
  const { groupId, createdAt } = resolveGeneratedImageGalleryGroup(gallery);
  const [selection, setSelection] = useState<{ groupId: string; imageId: string } | null>(null);
  // Stable identities preserve the reader's choice while streamed results arrive
  // or are reordered. A different turn must not inherit the previous selection.
  const selectedImage =
    (selection?.groupId === groupId
      ? gallery.images.find((image) => image.id === selection.imageId)
      : undefined) ?? gallery.images[0];
  const selectedImageIndex = gallery.images.findIndex((image) => image.id === selectedImage?.id);
  const showThumbnails = gallery.images.length + gallery.pendingImageCount > 1;
  const selectedAspectRatio = selectedImage ? (imageAspectRatios[selectedImage.id] ?? 1) : 1;
  const imageWidthClassName =
    selectedAspectRatio >= 2
      ? "max-w-full"
      : selectedAspectRatio >= 1
        ? "max-w-[480px]"
        : "max-w-[400px]";
  const layout = deriveGeneratedImageGalleryLayout({
    containerWidthPx,
    imageAspectRatios: [selectedAspectRatio],
    minimumSlotCount: !selectedImage && !showThumbnails ? GALLERY_MAX_IMAGES_PER_PAGE : 0,
  });
  const selectImage = useCallback(
    (imageId: string) => setSelection({ groupId, imageId }),
    [groupId],
  );
  useEffect(() => {
    const imageId = selectedImage?.id;
    setSelection((current) =>
      imageId
        ? current?.groupId === groupId && current.imageId === imageId
          ? current
          : { groupId, imageId }
        : null,
    );
  }, [groupId, selectedImage?.id]);

  const measure = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const nextWidth = Math.floor(node.getBoundingClientRect().width);
    setContainerWidthPx((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  useEffect(() => {
    measure();
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let pendingFrame: number | null = null;
    const scheduleMeasure = () => {
      if (pendingFrame !== null) return;
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = null;
        measure();
      });
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
    };
  }, [measure]);

  useLayoutEffect(() => {
    const rail = thumbnailsRef.current;
    const selected = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !selected) return;
    const top = selected.offsetTop;
    if (top < rail.scrollTop || top + selected.offsetHeight > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = top - (rail.clientHeight - selected.offsetHeight) / 2;
    }
  }, [gallery.images.length, gallery.pendingImageCount, layout.heightPx, selectedImage?.id]);

  const handleThumbnailKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = gallery.images.length - 1;
    const nextIndex =
      event.key === "ArrowUp"
        ? Math.max(0, index - 1)
        : event.key === "ArrowDown"
          ? Math.min(lastIndex, index + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = gallery.images[nextIndex];
    if (!next) return;
    selectImage(next.id);
    thumbnailsRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [nextIndex]?.focus({ preventScroll: true });
  };

  const onAspectRatioChange = useCallback((id: string, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setImageAspectRatios((current) =>
      current[id] === ratio ? current : { ...current, [id]: ratio },
    );
  }, []);

  const openImage = useCallback(
    (image: GeneratedImageGalleryImage, initialView?: "playground") => {
      const imageIndex = gallery.images.findIndex((candidate) => candidate.id === image.id);
      if (imageIndex < 0 || !onImageExpand) return;
      onImageExpand({
        images: gallery.images.map((candidate) => ({
          src: buildLocalImageUrl({ src: candidate.path, cwd }),
          name: localImageFileName(candidate.path) || t("chat.markdown.generatedImage.defaultAlt"),
        })),
        index: imageIndex,
        generated: {
          kind: "generated-image",
          groupId,
          createdAt,
          images: gallery.images.map((candidate) => ({
            id: candidate.id,
            path: candidate.path,
            name:
              localImageFileName(candidate.path) || t("chat.markdown.generatedImage.defaultAlt"),
          })),
          activeImageId: image.id,
          index: imageIndex,
          cwd,
          ...(initialView ? { initialView } : {}),
        },
      });
    },
    [createdAt, cwd, gallery.images, groupId, onImageExpand, t],
  );

  return (
    <div
      className={cn("flex w-full min-w-0 items-start gap-2", className)}
      data-testid="generated-image-gallery"
      data-gallery-layout={showThumbnails ? "thumbnails" : "natural"}
      data-selected-image-id={selectedImage?.id}
    >
      {gallery.pendingImageCount > 0 ? (
        <style>{GENERATED_IMAGE_PENDING_DOT_FIELD_CSS}</style>
      ) : null}
      <div
        ref={containerRef}
        className={cn(
          "group/generated-image-gallery-controls relative min-w-0 flex-1",
          imageWidthClassName,
        )}
        style={{ height: layout.heightPx }}
      >
        {selectedImage ? (
          <GeneratedImageGalleryTile
            key={selectedImage.id}
            image={selectedImage}
            alt={format("chat.generatedImage.alt", { imageNumber: selectedImageIndex + 1 })}
            imageNumber={selectedImageIndex + 1}
            cwd={cwd}
            widthPx={layout.itemWidthsPx[0] ?? 0}
            heightPx={layout.heightPx}
            onAspectRatioChange={onAspectRatioChange}
            onOpen={() => openImage(selectedImage)}
            onOpenCanvas={onImageExpand ? () => openImage(selectedImage, "playground") : undefined}
          />
        ) : gallery.pendingImageCount > 0 ? (
          <div data-testid="generated-image-pending">
            <GeneratedImagePendingPlaceholder
              label={t("chat.generatedImage.loadingLabel")}
              widthPx={layout.heightPx}
              heightPx={layout.heightPx}
            />
          </div>
        ) : null}
      </div>
      {showThumbnails ? (
        <div
          ref={thumbnailsRef}
          role="group"
          aria-label={t("chat.generatedImage.preview.rail")}
          data-testid="generated-image-thumbnails"
          className="relative flex shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain p-1"
          style={{ maxHeight: layout.heightPx }}
        >
          {gallery.images.map((image, index) => (
            <button
              key={image.id}
              type="button"
              className={cn(
                "flex size-14 shrink-0 cursor-interaction overflow-hidden rounded-lg border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-ring",
                image.id === selectedImage?.id &&
                  "ring-2 ring-[color:var(--color-accent-blue,#339cff)] focus-visible:ring-[color:var(--color-accent-blue,#339cff)]",
              )}
              aria-label={format("chat.generatedImage.showImage", { imageNumber: index + 1 })}
              aria-pressed={image.id === selectedImage?.id}
              data-testid="generated-image-thumbnail"
              data-image-id={image.id}
              onClick={() => selectImage(image.id)}
              onKeyDown={(event) => handleThumbnailKeyDown(event, index)}
            >
              <img
                src={buildLocalImageUrl({ src: image.path, cwd })}
                alt=""
                decoding="async"
                draggable={false}
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
          {Array.from({ length: gallery.pendingImageCount }, (_, index) => (
            <div
              key={`pending-${index}`}
              data-testid="generated-image-pending"
              aria-hidden={gallery.images.length === 0 || index > 0 ? true : undefined}
              className="size-14 shrink-0 overflow-hidden rounded-lg"
            >
              <GeneratedImagePendingPlaceholder
                label={t("chat.generatedImage.loadingLabel")}
                widthPx={56}
                heightPx={56}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GeneratedImageGalleryTile(props: {
  image: GeneratedImageGalleryImage;
  alt: string;
  imageNumber: number;
  cwd: string | undefined;
  widthPx: number;
  heightPx: number;
  onAspectRatioChange: (id: string, ratio: number) => void;
  onOpen: () => void;
  onOpenCanvas?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const {
    image,
    alt,
    imageNumber,
    cwd,
    widthPx,
    heightPx,
    onAspectRatioChange,
    onOpen,
    onOpenCanvas,
  } = props;
  const previewUrl = buildLocalImageUrl({ src: image.path, cwd });
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const imageLoaded = loadedUrl === previewUrl;
  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const target = event.currentTarget;
    if (target.naturalWidth > 0 && target.naturalHeight > 0) {
      setLoadedUrl(previewUrl);
      onAspectRatioChange(image.id, target.naturalWidth / target.naturalHeight);
    }
  };
  const handleDragStart = (event: DragEvent<HTMLImageElement>) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    if (!setGeneratedImageDragData(dataTransfer, { src: previewUrl, imageNumber })) {
      event.preventDefault();
    }
  };

  return (
    <div
      className="group/generated-image-preview relative shrink-0"
      data-image-transparency-backdrop-scope=""
      style={{ height: heightPx, width: widthPx }}
    >
      <button
        type="button"
        className="h-full w-full shrink-0 cursor-interaction overflow-hidden rounded-card bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="generated-image-preview"
        data-image-id={image.id}
        data-generated-image-context-source={imageLoaded ? image.path : undefined}
        data-generated-image-context-name={
          imageLoaded ? localImageFileName(image.path) || alt : undefined
        }
        aria-label={alt}
        onClick={onOpen}
      >
        <img
          src={previewUrl}
          alt={alt}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable
          className="block h-full w-full object-contain image-transparency-backdrop"
          onLoad={handleLoad}
          onError={() => setLoadedUrl(null)}
          onDragStart={handleDragStart}
        />
      </button>
      {imageLoaded && onOpenCanvas ? (
        <div className="pointer-events-none absolute end-2 bottom-2 z-10 opacity-0 group-focus-within/generated-image-gallery-controls:pointer-events-auto group-focus-within/generated-image-gallery-controls:opacity-100 group-hover/generated-image-gallery-controls:pointer-events-auto group-hover/generated-image-gallery-controls:opacity-100 print:hidden">
          <Button
            variant="ghost"
            size="xs"
            shape="capsule"
            className="bg-black/60 text-white hover:bg-black/75 hover:text-white"
            data-testid="generated-image-open-canvas"
            onClick={onOpenCanvas}
          >
            <GeneratedImagePreviewIcon className="size-4" />
            {t("chat.generatedImage.canvas")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function GeneratedImagePendingPlaceholder(props: {
  label: string;
  widthPx: number;
  heightPx: number;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const handleChange = () => setReducedMotion(media.matches);
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!field || !canvas || !context) return;
    const isAnimating = !reducedMotion;
    const durations = {
      offsetX1: generatedImagePendingDuration(4_500),
      offsetY1: generatedImagePendingDuration(6_330),
      offsetX2: generatedImagePendingDuration(5_600),
      offsetY2: generatedImagePendingDuration(5_750),
      fieldSize1: generatedImagePendingDuration(3_600),
      fieldSize2: generatedImagePendingDuration(2_400),
    };
    const phases = {
      offsetX1: Math.random(),
      offsetY1: Math.random(),
      offsetX2: Math.random(),
      offsetY2: Math.random(),
      fieldSize1: Math.random(),
      fieldSize2: Math.random(),
    };
    const bounds = {
      x1Start: generatedImagePendingRandomRange(0.1, 0.32),
      x1End: generatedImagePendingRandomRange(0.68, 0.9),
      y1Start: generatedImagePendingRandomRange(0.1, 0.32),
      y1End: generatedImagePendingRandomRange(0.68, 0.9),
      x2Start: generatedImagePendingRandomRange(0.68, 0.9),
      x2End: generatedImagePendingRandomRange(0.1, 0.32),
      y2Start: generatedImagePendingRandomRange(0.68, 0.9),
      y2End: generatedImagePendingRandomRange(0.1, 0.32),
    };
    const fieldSizeRange = {
      firstStart: generatedImagePendingRandomRange(0.42, 0.52),
      firstEnd: generatedImagePendingRandomRange(0.62, 0.75),
      secondStart: generatedImagePendingRandomRange(0.5, 0.62),
      secondEnd: generatedImagePendingRandomRange(0.74, 0.9),
    };
    let frame: number | null = null;
    let lastFrameMs = 0;
    let firstFrameMs: number | null = null;
    let geometry: {
      width: number;
      height: number;
      dpr: number;
      spacing: number;
      xPositions: Float32Array;
      yPositions: Float32Array;
      xNormals: Float32Array;
      yNormals: Float32Array;
    } | null = null;

    const measure = () => {
      const rect = field.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width || props.widthPx));
      const height = Math.max(0, Math.floor(rect.height || props.heightPx));
      if (width === 0 || height === 0) {
        geometry = null;
        return;
      }
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      const spacing = Math.max(1, GENERATED_IMAGE_PENDING_DOT_SPACING_PX / dpr);
      const columns = Math.max(1, Math.floor(width / spacing));
      const rows = Math.max(1, Math.floor(height / spacing));
      const xOffset = (width - (columns - 1) * spacing) * 0.5;
      const yOffset = (height - (rows - 1) * spacing) * 0.5;
      const xPositions = new Float32Array(columns);
      const yPositions = new Float32Array(rows);
      const xNormals = new Float32Array(columns);
      const yNormals = new Float32Array(rows);
      for (let index = 0; index < columns; index += 1) {
        xPositions[index] = xOffset + index * spacing;
        xNormals[index] = columns === 1 ? 0.5 : index / (columns - 1);
      }
      for (let index = 0; index < rows; index += 1) {
        yPositions[index] = yOffset + index * spacing;
        yNormals[index] = rows === 1 ? 0.5 : index / (rows - 1);
      }
      geometry = {
        width,
        height,
        dpr,
        spacing,
        xPositions,
        yPositions,
        xNormals,
        yNormals,
      };
    };

    const draw = (timeMs: number) => {
      if (geometry === null) measure();
      if (geometry === null) return;
      if (isAnimating && lastFrameMs !== 0 && timeMs - lastFrameMs < 33.333333333333336) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      lastFrameMs = timeMs;
      firstFrameMs ??= timeMs;
      const elapsedMs = isAnimating ? timeMs - firstFrameMs : 0;
      const phase = (duration: number, offset: number) =>
        generatedImagePendingTriangleWave(elapsedMs / duration + offset);
      const fieldOneX = generatedImagePendingLerp(
        bounds.x1Start,
        bounds.x1End,
        generatedImagePendingCubicEase(phase(durations.offsetX1, phases.offsetX1)),
      );
      const fieldOneY = generatedImagePendingLerp(
        bounds.y1Start,
        bounds.y1End,
        generatedImagePendingSmoothstep(phase(durations.offsetY1, phases.offsetY1)),
      );
      const fieldTwoX = generatedImagePendingLerp(
        bounds.x2Start,
        bounds.x2End,
        generatedImagePendingCubicEase(phase(durations.offsetX2, phases.offsetX2)),
      );
      const fieldTwoY = generatedImagePendingLerp(
        bounds.y2Start,
        bounds.y2End,
        generatedImagePendingSmoothstep(phase(durations.offsetY2, phases.offsetY2)),
      );
      const firstSize =
        GENERATED_IMAGE_PENDING_FIELD_SIZE_SCALE *
        generatedImagePendingLerp(
          fieldSizeRange.firstStart,
          fieldSizeRange.firstEnd,
          generatedImagePendingSmoothstep(phase(durations.fieldSize1, phases.fieldSize1)),
        );
      const secondSize =
        GENERATED_IMAGE_PENDING_FIELD_SIZE_SCALE *
        generatedImagePendingLerp(
          fieldSizeRange.secondStart,
          fieldSizeRange.secondEnd,
          generatedImagePendingSmoothstep(phase(durations.fieldSize2, phases.fieldSize2)),
        );
      const tau = Math.PI * 2;
      const radius = Math.max(
        GENERATED_IMAGE_PENDING_DOT_RADIUS,
        geometry.spacing * 0.5 * GENERATED_IMAGE_PENDING_DOT_OPACITY_AMPLITUDE,
      );
      context.save();
      context.setTransform(geometry.dpr, 0, 0, geometry.dpr, 0, 0);
      context.clearRect(0, 0, geometry.width, geometry.height);
      context.fillStyle =
        getComputedStyle(field).color ||
        (document.documentElement.classList.contains("dark") ? "white" : "black");
      for (let yIndex = 0; yIndex < geometry.yPositions.length; yIndex += 1) {
        const y = geometry.yPositions[yIndex] ?? 0;
        const yNormal = geometry.yNormals[yIndex] ?? 0.5;
        for (let xIndex = 0; xIndex < geometry.xPositions.length; xIndex += 1) {
          const x = geometry.xPositions[xIndex] ?? 0;
          const xNormal = geometry.xNormals[xIndex] ?? 0.5;
          const firstDistance = Math.hypot(xNormal - fieldOneX, yNormal - fieldOneY);
          const secondDistance = Math.hypot(xNormal - fieldTwoX, yNormal - fieldTwoY);
          const opacity =
            generatedImagePendingClamp(
              (1 - generatedImagePendingSmoothstep(0, firstSize, firstDistance)) *
                GENERATED_IMAGE_PENDING_FIRST_FIELD_WEIGHT +
                (1 - generatedImagePendingSmoothstep(0, secondSize, secondDistance)) *
                  GENERATED_IMAGE_PENDING_SECOND_FIELD_WEIGHT,
            ) ** GENERATED_IMAGE_PENDING_DISTANCE_EXPONENT;
          if (opacity <= GENERATED_IMAGE_PENDING_DOT_THRESHOLD) continue;
          context.globalAlpha = Math.min(1, opacity);
          context.beginPath();
          context.moveTo(x + radius, y);
          context.arc(x, y, radius, 0, tau);
          context.fill();
        }
      }
      context.restore();
      if (isAnimating) {
        frame = window.requestAnimationFrame(draw);
      }
    };

    const scheduleDraw = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame((time) => {
          frame = null;
          draw(time);
        });
      }
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            geometry = null;
            scheduleDraw();
          });
    observer?.observe(field);
    measure();
    // Ndc schedules the first field paint through rAF as well; reduced motion
    // only suppresses subsequent frames, not the initial visible field.
    scheduleDraw();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [props.heightPx, props.widthPx, reducedMotion]);

  return (
    <div
      className="moss-generated-image-pending-placeholder relative aspect-square w-full overflow-clip rounded-2xl bg-primary-soft-active text-codex-secondary dark:bg-primary-ghost-hover dark:text-white/70"
      style={{ height: props.heightPx, width: props.widthPx }}
      aria-busy="true"
      aria-label={props.label}
    >
      <div
        ref={fieldRef}
        className="moss-generated-image-pending-dots"
        data-reduced-motion={reducedMotion ? "true" : "false"}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
      </div>
    </div>
  );
}

function generatedImagePendingClamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function generatedImagePendingSmoothstep(value: number): number;
function generatedImagePendingSmoothstep(edge0: number, edge1: number, value: number): number;
function generatedImagePendingSmoothstep(
  edgeOrValue: number,
  edge1?: number,
  value?: number,
): number {
  if (value === undefined || edge1 === undefined) {
    const normalized = generatedImagePendingClamp(edgeOrValue);
    return normalized * normalized * (3 - 2 * normalized);
  }
  const normalized = generatedImagePendingClamp((value - edgeOrValue) / (edge1 - edgeOrValue));
  return normalized * normalized * (3 - 2 * normalized);
}

function generatedImagePendingTriangleWave(value: number): number {
  const normalized = value % 1;
  return normalized <= 0.5 ? normalized * 2 : 2 - normalized * 2;
}

function generatedImagePendingCubicEase(value: number): number {
  const normalized = generatedImagePendingClamp(value);
  return normalized < 0.5
    ? 4 * normalized * normalized * normalized
    : 1 - (-2 * normalized + 2) ** 3 / 2;
}

function generatedImagePendingLerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function generatedImagePendingRandomRange(start: number, end: number): number {
  return start + Math.random() * (end - start);
}

function generatedImagePendingDuration(baseMs: number): number {
  return (
    baseMs * GENERATED_IMAGE_PENDING_DURATION_SCALE * generatedImagePendingRandomRange(1, 1.35)
  );
}
