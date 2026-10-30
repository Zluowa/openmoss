// FILE: GeneratedImagePreviewPane.tsx
// Purpose: Durable single-image view for a generated-image right-dock pane.
// Layer: Chat right-dock UI
// Notes: The dedicated pane owns local zoom and pan state. Generated image metadata
//        remains durable, while every authenticated local-image URL is rebuilt in memory.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import { useTranslation } from "~/localization";
import { isEditableEventTarget } from "~/lib/editableEventTarget";
import {
  resolveGeneratedImageContextMenuOwner,
  type GeneratedImageContextMenuHandler,
} from "~/lib/generatedImageContextMenu";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { CheckIcon, ChevronDownIcon, DownloadIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { RightDockImagePreviewView, RightDockPane } from "~/rightDockStore.logic";

import { useLocalImageDownloadClick } from "../LocalImagePreview";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import {
  GENERATED_IMAGE_PREVIEW_PINCH_CLICK_SUPPRESSION_MS,
  GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX,
  GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX,
  GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX,
  GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX,
  GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS,
  clampGeneratedImagePreviewZoomPercent,
  distanceBetweenGeneratedImagePreviewPoints,
  generatedImagePreviewRailTotalContentHeightPx,
  resolveGeneratedImagePreviewArrowNavigation as resolveArrowNavigationByIndex,
  resolveGeneratedImagePreviewFitZoomPercent,
  resolveGeneratedImagePreviewRailWheel,
  resolveGeneratedImagePreviewZoomForPinch,
  resolveGeneratedImagePreviewZoomForWheel,
  resolveGeneratedImagePreviewZoomScrollPosition,
  safeGeneratedImagePreviewDownloadName,
} from "./generatedImagePreviewControls.logic";

/** Optional media source adapter; local chat previews retain authenticated file URLs. */
export type GeneratedImagePreviewUrlResolver = (input: {
  readonly src: string;
  readonly cwd: string | undefined;
  readonly download?: boolean;
}) => string;

export function resolveGeneratedImagePreviewTitle(
  pane: Pick<RightDockPane, "imagePreview">,
  formatTitle: (imageNumber: number) => string = (imageNumber) => `Generated image ${imageNumber}`,
): string {
  const imagePreview = pane.imagePreview;
  const activeIndex = imagePreview
    ? imagePreview.images.findIndex((image) => image.id === imagePreview.activeImageId)
    : -1;
  const imageNumber = Math.max(0, activeIndex) + 1;
  const title = formatTitle(imageNumber);
  const conversationTitle = imagePreview?.conversationTitle?.trim();
  return conversationTitle ? `${conversationTitle} - ${title}` : title;
}

export function resolveGeneratedImagePreviewArrowNavigation(input: {
  imageIds: readonly string[];
  activeImageId: string | null;
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isEditableTarget?: boolean;
}): string | null {
  if (input.key !== "ArrowUp" && input.key !== "ArrowDown") {
    return null;
  }
  const activeIndex = Math.max(0, input.imageIds.indexOf(input.activeImageId ?? ""));
  const nextIndex = resolveArrowNavigationByIndex({
    imageIndex: activeIndex,
    imageCount: input.imageIds.length,
    key: input.key,
    ...(input.altKey !== undefined ? { altKey: input.altKey } : {}),
    ...(input.ctrlKey !== undefined ? { ctrlKey: input.ctrlKey } : {}),
    ...(input.metaKey !== undefined ? { metaKey: input.metaKey } : {}),
    ...(input.shiftKey !== undefined ? { shiftKey: input.shiftKey } : {}),
    ...(input.isEditableTarget !== undefined ? { isEditableTarget: input.isEditableTarget } : {}),
  });
  return nextIndex === null ? null : (input.imageIds[nextIndex] ?? null);
}

type ImageLoadStatus = "loading" | "loaded" | "error";

function imagePreviewStatusFor(
  status: { key: string | null; value: ImageLoadStatus },
  activeImageKey: string | null,
): ImageLoadStatus {
  return activeImageKey !== null && status.key === activeImageKey ? status.value : "loading";
}

function isButtonLikeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, [role='button']") !== null;
}

function clientPointFromEvent(
  point: { clientX: number; clientY: number },
  fallback: { clientX: number; clientY: number } | null,
): { clientX: number; clientY: number } {
  if (
    Number.isFinite(point.clientX) &&
    Number.isFinite(point.clientY) &&
    (point.clientX !== 0 || point.clientY !== 0)
  ) {
    return point;
  }
  return fallback ?? point;
}

function readElementSize(element: HTMLElement | null): { width: number; height: number } | null {
  if (!element) {
    return null;
  }
  const width = element.clientWidth;
  const height = element.clientHeight;
  return width > 0 && height > 0 ? { width, height } : null;
}

function GeneratedImagePreviewZoomMenu(props: {
  zoomPercent: number;
  isFit: boolean;
  disabled: boolean;
  onZoomPercentChange: (zoomPercent: number) => void;
  onZoomToFit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={props.disabled}
            aria-label={t("chat.generatedImage.preview.zoom")}
            title={t("chat.generatedImage.preview.zoom")}
            data-testid="generated-image-preview-zoom-trigger"
            className="!h-8 !w-fit !max-w-fit flex-none shrink-0 !gap-0.5 !px-2 !text-ui-lg !leading-5 text-default"
          />
        }
      >
        <span className="text-start leading-5 tabular-nums">{Math.round(props.zoomPercent)}%</span>
        <ChevronDownIcon className="size-3 opacity-50" />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="end"
        side="bottom"
        sideOffset={4}
        data-testid="generated-image-preview-zoom-menu"
        className="!w-[136px] !min-w-[136px] !rounded-popover !p-[6px]"
      >
        <MenuRadioGroup
          value={props.isFit ? "" : String(Math.round(props.zoomPercent))}
          onValueChange={(value) => {
            const zoomPercent = Number(value);
            if (Number.isFinite(zoomPercent)) {
              props.onZoomPercentChange(zoomPercent);
            }
          }}
        >
          {GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS.map((zoomPercent) => (
            <MenuRadioItem
              key={zoomPercent}
              value={String(zoomPercent)}
              className="!rounded-row !py-[5px] !ps-2 !pe-[5px] text-default"
              data-testid={`generated-image-preview-zoom-option-${zoomPercent}`}
            >
              {zoomPercent}%
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator className="!mx-0 !my-0" />
        <MenuItem
          onClick={props.onZoomToFit}
          data-selected={props.isFit ? "true" : undefined}
          data-testid="generated-image-preview-zoom-fit"
          className="!rounded-row !py-[5px] !ps-2 !pe-[5px] text-default"
        >
          <span>{t("chat.generatedImage.preview.zoomToFit")}</span>
          <CheckIcon className={cn("ms-auto size-3", !props.isFit && "invisible")} />
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function GeneratedImagePreviewFocusedIcon(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.25" y="2.25" width="7.5" height="9.5" rx="1.5" stroke="currentColor" />
      <rect x="6.25" y="4.25" width="7.5" height="9.5" rx="1.5" stroke="currentColor" />
    </svg>
  );
}

function GeneratedImagePreviewCanvasIcon(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.25" y="2.25" width="4.5" height="4.5" rx="0.75" stroke="currentColor" />
      <rect x="9.25" y="2.25" width="4.5" height="4.5" rx="0.75" stroke="currentColor" />
      <rect x="2.25" y="9.25" width="4.5" height="4.5" rx="0.75" stroke="currentColor" />
      <rect x="9.25" y="9.25" width="4.5" height="4.5" rx="0.75" stroke="currentColor" />
    </svg>
  );
}

function GeneratedImagePreviewViewToggle(props: {
  view: RightDockImagePreviewView;
  disabled: boolean;
  onChange: (view: RightDockImagePreviewView) => void;
}) {
  const { t } = useTranslation();
  const options = [
    {
      view: "single" as const,
      label: t("chat.generatedImage.preview.focusedView"),
      Icon: GeneratedImagePreviewFocusedIcon,
    },
    {
      view: "playground" as const,
      label: t("chat.generatedImage.preview.canvasView"),
      Icon: GeneratedImagePreviewCanvasIcon,
    },
  ];
  return (
    <div
      role="group"
      aria-label={t("chat.generatedImage.preview.imageView")}
      data-testid="generated-image-preview-view-toggle"
      className="flex items-center gap-0.5 rounded-lg bg-surface p-1 shadow-sm ring-1 ring-border"
    >
      {options.map(({ view, label, Icon }) => {
        const active = props.view === view;
        return (
          <button
            key={view}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={active}
            disabled={props.disabled}
            data-testid={`generated-image-preview-view-${view}`}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 motion-reduce:transition-none",
              active && "bg-surface-secondary text-default shadow-xs",
              !active && "enabled:hover:bg-surface-secondary/70",
              props.disabled && "cursor-default opacity-50",
            )}
            onClick={() => props.onChange(view)}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

function GeneratedImagePlaygroundZoomMenu(props: {
  zoomPercent: number;
  onZoomPercentChange: (zoomPercent: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("chat.generatedImage.preview.canvasZoom")}
            title={t("chat.generatedImage.preview.canvasZoom")}
            data-testid="generated-image-playground-zoom-trigger"
            className="!h-8 !w-fit !max-w-fit flex-none shrink-0 !gap-0.5 !px-2 !text-ui-lg !leading-5 text-default"
          />
        }
      >
        <span className="text-start leading-5 tabular-nums">{Math.round(props.zoomPercent)}%</span>
        <ChevronDownIcon className="size-3 opacity-50" />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="end"
        side="bottom"
        sideOffset={4}
        data-testid="generated-image-playground-zoom-menu"
        className="!w-[136px] !min-w-[136px] !rounded-popover !p-[6px]"
      >
        <MenuRadioGroup
          value={String(Math.round(props.zoomPercent))}
          onValueChange={(value) => {
            const zoomPercent = Number(value);
            if (Number.isFinite(zoomPercent)) {
              props.onZoomPercentChange(zoomPercent);
            }
          }}
        >
          {GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS.map((zoomPercent) => (
            <MenuRadioItem
              key={zoomPercent}
              value={String(zoomPercent)}
              className="!rounded-row !py-[5px] !ps-2 !pe-[5px] text-default"
              data-testid={`generated-image-playground-zoom-option-${zoomPercent}`}
            >
              {zoomPercent}%
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function GeneratedImagePreviewGroupTime(props: { createdAt: string | null | undefined }) {
  if (!props.createdAt) {
    return null;
  }
  const date = new Date(props.createdAt);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return (
    <time
      className="absolute top-0 text-ui-sm text-tertiary select-none"
      data-testid="generated-image-playground-created-at"
      dateTime={props.createdAt}
    >
      {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}
    </time>
  );
}

const GENERATED_IMAGE_CANVAS_COACHMARK_STORAGE_KEY = "has-dismissed-image-canvas-view-coachmark-v1";
const GENERATED_IMAGE_PREVIEW_VIEW_TRANSITION_RETRY_MS = 1_000;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function GeneratedImagePlaygroundView(props: {
  images: readonly { id: string; path: string; name: string }[];
  cwd: string | null;
  activeImageId: string | null;
  groupId: string | undefined;
  createdAt: string | null | undefined;
  zoomPercent: number;
  onZoomPercentChange: (zoomPercent: number) => void;
  onImageLoad: (imageId: string, size: { width: number; height: number }) => void;
  onActiveImageChange: (imageId: string) => void;
  imageLoadStatus: ImageLoadStatus;
  onImageContextMenu?: GeneratedImageContextMenuHandler | undefined;
  resolveImageUrl?: GeneratedImagePreviewUrlResolver | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const zoomContentRef = useRef<HTMLDivElement | null>(null);
  const pendingZoomAnchorRef = useRef<{
    point: { clientX: number; clientY: number };
    oldTargetRect: DOMRect;
  } | null>(null);
  const pinchRef = useRef<{ distance: number; zoomPercent: number } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const zoomRef = useRef(props.zoomPercent);
  const onZoomPercentChange = props.onZoomPercentChange;
  zoomRef.current = props.zoomPercent;

  const applyZoom = useCallback(
    (value: number, point?: { clientX: number; clientY: number }) => {
      const target = zoomContentRef.current;
      if (target && point) {
        pendingZoomAnchorRef.current = {
          point,
          oldTargetRect: target.getBoundingClientRect(),
        };
      }
      onZoomPercentChange(clampGeneratedImagePreviewZoomPercent(value));
    },
    [onZoomPercentChange],
  );

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const target = zoomContentRef.current;
    const pendingAnchor = pendingZoomAnchorRef.current;
    if (!scroll || !target || !pendingAnchor) {
      return;
    }
    pendingZoomAnchorRef.current = null;
    const nextScrollPosition = resolveGeneratedImagePreviewZoomScrollPosition({
      scrollLeft: scroll.scrollLeft,
      scrollTop: scroll.scrollTop,
      oldTargetRect: pendingAnchor.oldTargetRect,
      newTargetRect: target.getBoundingClientRect(),
      point: pendingAnchor.point,
    });
    scroll.scrollLeft = Math.min(
      Math.max(0, scroll.scrollWidth - scroll.clientWidth),
      Math.max(0, nextScrollPosition.left),
    );
    scroll.scrollTop = Math.min(
      Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      Math.max(0, nextScrollPosition.top),
    );
  }, [props.zoomPercent]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyZoom(
        resolveGeneratedImagePreviewZoomForWheel({
          currentZoomPercent: zoomRef.current,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          pageHeightPx: scroll.clientHeight,
        }),
        { clientX: event.clientX, clientY: event.clientY },
      );
    };
    const readTouch = (touch: Touch | undefined) =>
      touch ? { clientX: touch.clientX, clientY: touch.clientY } : null;
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        return;
      }
      const first = readTouch(event.touches[0]);
      const second = readTouch(event.touches[1]);
      if (!first || !second) {
        return;
      }
      const distance = distanceBetweenGeneratedImagePreviewPoints(first, second);
      if (distance > 0) {
        pinchRef.current = { distance, zoomPercent: zoomRef.current };
      }
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) {
        return;
      }
      const first = readTouch(event.touches[0]);
      const second = readTouch(event.touches[1]);
      if (!first || !second) {
        return;
      }
      const distance = distanceBetweenGeneratedImagePreviewPoints(first, second);
      if (distance <= 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyZoom(
        resolveGeneratedImagePreviewZoomForPinch({
          initialDistance: pinchRef.current.distance,
          initialZoomPercent: pinchRef.current.zoomPercent,
          nextDistance: distance,
        }),
        {
          clientX: (first.clientX + second.clientX) / 2,
          clientY: (first.clientY + second.clientY) / 2,
        },
      );
    };
    const handleTouchEnd = () => {
      if (pinchRef.current) {
        suppressClickUntilRef.current =
          Date.now() + GENERATED_IMAGE_PREVIEW_PINCH_CLICK_SUPPRESSION_MS;
      }
      pinchRef.current = null;
    };
    scroll.addEventListener("wheel", handleWheel, { passive: false });
    scroll.addEventListener("touchstart", handleTouchStart, { passive: false });
    scroll.addEventListener("touchmove", handleTouchMove, { passive: false });
    scroll.addEventListener("touchend", handleTouchEnd, { passive: false });
    scroll.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    return () => {
      scroll.removeEventListener("wheel", handleWheel);
      scroll.removeEventListener("touchstart", handleTouchStart);
      scroll.removeEventListener("touchmove", handleTouchMove);
      scroll.removeEventListener("touchend", handleTouchEnd);
      scroll.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [applyZoom]);

  const canvasZoomPoint = () => {
    const rect = scrollRef.current?.getBoundingClientRect();
    return rect
      ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      : undefined;
  };
  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <div
      className="relative h-full min-h-0 min-w-0 w-full bg-surface-secondary"
      data-testid="generated-image-playground"
      data-generated-image-playground-zoom-percent={props.zoomPercent}
    >
      <div className="absolute top-2 right-2 z-40 flex h-8 items-center">
        <GeneratedImagePlaygroundZoomMenu
          zoomPercent={props.zoomPercent}
          onZoomPercentChange={(nextZoom) => applyZoom(nextZoom, canvasZoomPoint())}
        />
      </div>
      <div
        ref={scrollRef}
        data-generated-image-playground-scroll="true"
        data-testid="generated-image-playground-scroll"
        className="h-full min-h-0 scroll-pt-14 overflow-auto ps-3 pe-16 pt-14 pb-[calc(var(--right-panel-composer-overlay-reserve,0px)+var(--spacing)*6)]"
        onClickCapture={handleClickCapture}
      >
        <div
          ref={zoomContentRef}
          className="flex min-w-max flex-col items-start gap-6"
          style={{ zoom: props.zoomPercent / 100 } as CSSProperties}
        >
          <div
            className={cn(
              "relative flex max-w-full gap-2 transition-opacity duration-[140ms] ease-out motion-reduce:transition-none",
              props.createdAt && "pt-6",
            )}
            data-testid="generated-image-playground-group"
            data-generated-image-group-id={props.groupId}
          >
            <GeneratedImagePreviewGroupTime createdAt={props.createdAt} />
            {props.images.map((image) => {
              const active = image.id === props.activeImageId;
              const imageUrl = (props.resolveImageUrl ?? buildLocalImageUrl)({
                src: image.path,
                cwd: props.cwd ?? undefined,
              });
              return (
                <div key={image.id} className="relative max-w-full shrink-0">
                  <button
                    type="button"
                    aria-label={image.name}
                    aria-pressed={active}
                    data-testid={`generated-image-playground-image-${image.id}`}
                    data-generated-image-playground-image="true"
                    data-image-id={image.id}
                    className={cn(
                      "relative block max-w-full shrink-0 cursor-interaction overflow-hidden rounded-xl bg-surface-secondary/85 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]",
                      active && "ring-2 ring-chart-blue",
                    )}
                    onClick={() => props.onActiveImageChange(image.id)}
                  >
                    <img
                      src={imageUrl}
                      alt=""
                      data-image-id={image.id}
                      decoding="async"
                      draggable={false}
                      referrerPolicy="no-referrer"
                      className="block h-auto !max-h-[292px] w-auto max-w-full object-contain"
                      onLoad={(event) => {
                        const { naturalWidth, naturalHeight } = event.currentTarget;
                        if (naturalWidth > 0 && naturalHeight > 0) {
                          props.onImageLoad(image.id, {
                            width: naturalWidth,
                            height: naturalHeight,
                          });
                        }
                      }}
                      onContextMenu={
                        props.onImageContextMenu && active && props.imageLoadStatus === "loaded"
                          ? (event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              props.onImageContextMenu?.(
                                { src: image.path, cwd: props.cwd, name: image.name },
                                event,
                              );
                            }
                          : undefined
                      }
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div aria-hidden="true" className="h-1/2 shrink-0" />
      </div>
    </div>
  );
}

function GeneratedImagePreviewRail(props: {
  images: readonly { id: string; path: string; name: string }[];
  activeIndex: number;
  cwd: string | null;
  onSelect: (index: number) => void;
  railRef: RefObject<HTMLDivElement | null>;
  resolveImageUrl?: GeneratedImagePreviewUrlResolver | undefined;
}) {
  const { t } = useTranslation();
  const positionRef = useRef(
    GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX + GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX / 2,
  );
  const tileRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const scrollToPosition = useCallback(
    (position: number) => {
      const rail = props.railRef.current;
      if (!rail) {
        return;
      }
      rail.scrollTop = resolveGeneratedImagePreviewRailWheel({
        position,
        deltaY: 0,
        imageCount: props.images.length,
        viewportHeightPx: rail.clientHeight,
        scrollHeightPx: rail.scrollHeight,
        totalContentHeightPx: generatedImagePreviewRailTotalContentHeightPx(props.images.length),
      }).scrollTop;
    },
    [props.images.length, props.railRef],
  );

  useEffect(() => {
    const position =
      GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX +
      GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX / 2 +
      Math.max(0, props.activeIndex) * GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX;
    positionRef.current = position;
    scrollToPosition(position);
  }, [props.activeIndex, props.images.length, scrollToPosition]);

  const selectIndex = useCallback(
    (index: number) => {
      const nextIndex = Math.min(props.images.length - 1, Math.max(0, index));
      if (nextIndex < 0) {
        return;
      }
      positionRef.current =
        GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX +
        GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX / 2 +
        nextIndex * GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX;
      scrollToPosition(positionRef.current);
      props.onSelect(nextIndex);
    },
    [props, scrollToPosition],
  );

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rail = event.currentTarget;
    const result = resolveGeneratedImagePreviewRailWheel({
      position: positionRef.current,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      imageCount: props.images.length,
      viewportHeightPx: rail.clientHeight,
      scrollHeightPx: rail.scrollHeight,
      totalContentHeightPx: generatedImagePreviewRailTotalContentHeightPx(props.images.length),
    });
    positionRef.current = result.position;
    rail.scrollTop = result.scrollTop;
    if (result.imageIndex !== props.activeIndex) {
      props.onSelect(result.imageIndex);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = resolveArrowNavigationByIndex({
      imageIndex: index,
      imageCount: props.images.length,
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isEditableTarget: isEditableEventTarget(event.nativeEvent),
    });
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectIndex(nextIndex);
    tileRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      ref={props.railRef}
      role="group"
      aria-label={t("chat.generatedImage.preview.rail")}
      data-testid="generated-image-preview-rail"
      className="mt-10 w-18 shrink-0 [scrollbar-width:none] overflow-y-auto py-1.5 ps-0.5 [&::-webkit-scrollbar]:hidden"
      onWheel={handleWheel}
    >
      {props.images.map((image, index) => {
        const active = index === props.activeIndex;
        const imageUrl = (props.resolveImageUrl ?? buildLocalImageUrl)({
          src: image.path,
          cwd: props.cwd ?? undefined,
        });
        return (
          <button
            key={image.id}
            ref={(node) => {
              tileRefs.current[index] = node;
            }}
            type="button"
            aria-label={image.name}
            aria-current={active ? "true" : undefined}
            data-testid={`generated-image-preview-rail-tile-${image.id}`}
            className={cn(
              "mx-auto mb-2 flex size-[46px] cursor-interaction overflow-hidden rounded-lg border border-default bg-surface-secondary/85 outline-none transition-[opacity,transform] duration-120 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 motion-reduce:transition-none motion-reduce:duration-0",
              active ? "opacity-100" : "opacity-34",
            )}
            style={{ transform: active ? "scale(1.2)" : "scale(0.95)" }}
            onClick={() => selectIndex(index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <img
              src={imageUrl}
              alt=""
              decoding="async"
              draggable={false}
              referrerPolicy="no-referrer"
              className="size-full rounded-lg object-cover"
            />
          </button>
        );
      })}
      <div aria-hidden="true" className="shrink-0" style={{ height: "calc(50% - 23px)" }} />
    </div>
  );
}

export function GeneratedImagePreviewPane(props: {
  canvasContent?: ReactNode;
  pane: Pick<RightDockPane, "imagePreview">;
  onActiveImageChange: (imageId: string) => void;
  onViewChange?: (view: RightDockImagePreviewView) => void;
  animateViewChanges?: boolean;
  onRequestFullWidth?: (fullWidth: boolean) => void;
  fullWidth?: boolean;
  threadId?: string | undefined;
  onImageContextMenu?: GeneratedImageContextMenuHandler | undefined;
  resolveImageUrl?: GeneratedImagePreviewUrlResolver | undefined;
}) {
  const { format, t } = useTranslation();
  const imagePreview = props.pane.imagePreview ?? null;
  const fullWidth = props.fullWidth ?? false;
  const onViewChange = props.onViewChange;
  const view: RightDockImagePreviewView =
    imagePreview?.view === "playground" ? "playground" : "single";
  const activeImage = imagePreview
    ? (imagePreview.images.find((image) => image.id === imagePreview.activeImageId) ??
      imagePreview.images[0] ??
      null)
    : null;
  const title = resolveGeneratedImagePreviewTitle(props.pane, (imageNumber) =>
    format("chat.generatedImage.previewTitle", { imageNumber }),
  );
  const hasImageContextMenuHandler = Boolean(props.onImageContextMenu || props.threadId);
  const handleImageContextMenu = useCallback<GeneratedImageContextMenuHandler>(
    (image, event) => {
      event.preventDefault();
      event.stopPropagation();
      const handler =
        props.onImageContextMenu ?? resolveGeneratedImageContextMenuOwner(props.threadId);
      handler?.(image, event);
    },
    [props.onImageContextMenu, props.threadId],
  );
  const imageUrl = activeImage
    ? (props.resolveImageUrl ?? buildLocalImageUrl)({
        src: activeImage.path,
        cwd: imagePreview?.cwd ?? undefined,
      })
    : null;
  const downloadUrl = activeImage
    ? (props.resolveImageUrl ?? buildLocalImageUrl)({
        src: activeImage.path,
        cwd: imagePreview?.cwd ?? undefined,
        download: true,
      })
    : null;
  const downloadName = safeGeneratedImagePreviewDownloadName(activeImage?.name ?? "");
  const activeImageKey = activeImage ? `${activeImage.id}:${activeImage.path}` : null;
  const playgroundGroupKey = imagePreview?.groupId ?? imagePreview?.images[0]?.id ?? null;
  const imageIds = useMemo(
    () => imagePreview?.images.map((image) => image.id) ?? [],
    [imagePreview?.images],
  );
  const activeIndex = activeImage ? Math.max(0, imageIds.indexOf(activeImage.id)) : -1;
  const hasImageRail = Boolean(fullWidth && imageIds.length > 1);

  const [loadStatus, setLoadStatus] = useState<{
    key: string | null;
    value: ImageLoadStatus;
  }>({ key: null, value: "loading" });
  const [naturalImageState, setNaturalImageState] = useState<{
    key: string | null;
    value: { width: number; height: number } | null;
  }>({ key: null, value: null });
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [manualZoomState, setManualZoomState] = useState<{
    key: string;
    value: number;
  } | null>(null);
  const [playgroundZoomState, setPlaygroundZoomState] = useState<{
    key: string | null;
    value: number;
  }>({ key: null, value: 100 });
  const playgroundZoomPercent =
    playgroundZoomState.key === playgroundGroupKey ? playgroundZoomState.value : 100;
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const zoomTargetRef = useRef<HTMLImageElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const pinchRef = useRef<{ distance: number; zoomPercent: number } | null>(null);
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const pendingZoomAnchorRef = useRef<{
    point: { clientX: number; clientY: number };
    oldTargetRect: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const previousOverflowRef = useRef(false);
  const overflowRef = useRef(false);
  const previousViewRef = useRef<RightDockImagePreviewView | null>(null);
  const pendingViewTransitionRef = useRef<{
    nextView: RightDockImagePreviewView;
    before: DOMRect;
  } | null>(null);
  const viewAnimationRef = useRef<Animation | null>(null);
  const viewAnimationListenersRef = useRef<{
    animation: Animation;
    finish: EventListener;
    cancel: EventListener;
  } | null>(null);
  const viewTransitionRetryFrameRef = useRef<number | null>(null);
  const viewTransitionRetryDeadlineRef = useRef<number | null>(null);
  const [viewTransitionLayoutVersion, setViewTransitionLayoutVersion] = useState(0);
  const [isViewTransitioning, setIsViewTransitioning] = useState(false);
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(GENERATED_IMAGE_CANVAS_COACHMARK_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [coachmarkVisible, setCoachmarkVisible] = useState(false);
  const fullWidthCallbackRef = useRef(props.onRequestFullWidth);
  fullWidthCallbackRef.current = props.onRequestFullWidth;

  const clearViewTransitionRetry = useCallback(() => {
    if (viewTransitionRetryFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(viewTransitionRetryFrameRef.current);
    }
    viewTransitionRetryFrameRef.current = null;
    viewTransitionRetryDeadlineRef.current = null;
  }, []);

  const scheduleViewTransitionRetry = useCallback((expectedView: RightDockImagePreviewView) => {
    if (typeof window === "undefined" || viewTransitionRetryFrameRef.current !== null) {
      return;
    }
    const deadline =
      viewTransitionRetryDeadlineRef.current ??
      (viewTransitionRetryDeadlineRef.current =
        Date.now() + GENERATED_IMAGE_PREVIEW_VIEW_TRANSITION_RETRY_MS);
    const retry = () => {
      viewTransitionRetryFrameRef.current = null;
      const pending = pendingViewTransitionRef.current;
      if (!pending || pending.nextView !== expectedView) {
        pendingViewTransitionRef.current = null;
        viewTransitionRetryDeadlineRef.current = null;
        setIsViewTransitioning(false);
        return;
      }
      if (Date.now() >= deadline) {
        pendingViewTransitionRef.current = null;
        viewTransitionRetryDeadlineRef.current = null;
        setIsViewTransitioning(false);
        return;
      }
      setViewTransitionLayoutVersion((version) => version + 1);
    };
    viewTransitionRetryFrameRef.current = window.requestAnimationFrame(retry);
  }, []);

  const clearViewAnimation = useCallback(() => {
    clearViewTransitionRetry();
    const record = viewAnimationListenersRef.current;
    if (!record) {
      viewAnimationRef.current = null;
      return;
    }
    record.animation.removeEventListener("finish", record.finish);
    record.animation.removeEventListener("cancel", record.cancel);
    record.animation.cancel();
    viewAnimationListenersRef.current = null;
    viewAnimationRef.current = null;
  }, [clearViewTransitionRetry]);

  const readActiveImageElement = useCallback(() => {
    const root = rootRef.current;
    const imageId = activeImage?.id;
    if (!root || !imageId) {
      return null;
    }
    return (
      [...root.querySelectorAll<HTMLImageElement>("img[data-image-id]")].find(
        (image) => image.dataset.imageId === imageId,
      ) ?? null
    );
  }, [activeImage?.id]);

  const handleViewChange = useCallback(
    (nextView: RightDockImagePreviewView) => {
      if (nextView === view || !activeImage || !onViewChange) {
        return;
      }
      clearViewAnimation();
      // Navigation and save guards can leave this controlled view unchanged.
      // Only local synchronous view changes have a shared-element destination.
      if (props.animateViewChanges === false) {
        pendingViewTransitionRef.current = null;
        setIsViewTransitioning(false);
        onViewChange(nextView);
        return;
      }
      const focusedImage = readActiveImageElement();
      const before = focusedImage?.getBoundingClientRect();
      // Codex keeps compact-sheet view changes synchronous.  A shared-element
      // animation in a narrow panel can outlive the sheet reflow (and leave the
      // panel pointer-locked), so only schedule it when the rendered surface has
      // enough room for both states to coexist.
      const rootWidth = rootRef.current?.getBoundingClientRect().width ?? 0;
      const compactViewport =
        (typeof window !== "undefined" && window.innerWidth <= 480) ||
        (rootWidth > 0 && rootWidth <= 480);
      if (compactViewport) {
        pendingViewTransitionRef.current = null;
        setIsViewTransitioning(false);
        flushSync(() => {
          onViewChange(nextView);
        });
        return;
      }
      if (before && before.width > 0 && before.height > 0) {
        pendingViewTransitionRef.current = { nextView, before };
      } else {
        pendingViewTransitionRef.current = null;
      }
      setIsViewTransitioning(before !== undefined && before.width > 0 && before.height > 0);
      flushSync(() => {
        onViewChange(nextView);
      });
    },
    [
      activeImage,
      clearViewAnimation,
      onViewChange,
      props.animateViewChanges,
      readActiveImageElement,
      view,
    ],
  );

  useLayoutEffect(() => {
    const pending = pendingViewTransitionRef.current;
    if (!pending || pending.nextView !== view) {
      return;
    }
    if (view === "playground" && props.canvasContent != null) {
      // A hosted Canvas has no local image target for the shared-image animation.
      pendingViewTransitionRef.current = null;
      clearViewTransitionRetry();
      setIsViewTransitioning(false);
      return;
    }
    const target = readActiveImageElement();
    let animation: Animation | null = null;
    const finish = () => {
      if (viewAnimationRef.current !== animation) {
        return;
      }
      clearViewAnimation();
      setIsViewTransitioning(false);
    };
    if (prefersReducedMotion()) {
      pendingViewTransitionRef.current = null;
      clearViewTransitionRetry();
      setIsViewTransitioning(false);
      return;
    }
    if (!target || !target.isConnected) {
      // The target can be mounted one frame after the view state changes (for
      // example while a generated image is still decoding). Keep the lock and
      // retry briefly so the shared-element transition is not silently lost.
      scheduleViewTransitionRetry(view);
      return;
    }
    if (typeof target.animate !== "function") {
      pendingViewTransitionRef.current = null;
      clearViewTransitionRetry();
      setIsViewTransitioning(false);
      return;
    }
    if (pending.nextView === "playground") {
      const scroll = rootRef.current?.querySelector<HTMLElement>(
        '[data-generated-image-playground-scroll="true"]',
      );
      const scrollRect = scroll?.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const rightOverflow = Boolean(
        scrollRect && (targetRect.right > scrollRect.right || targetRect.left < scrollRect.left),
      );
      try {
        target.scrollIntoView({
          block: "start",
          inline: rightOverflow ? "center" : "nearest",
        });
      } catch {
        // Browser test DOMs may not implement scrollIntoView.
      }
    }
    const after = target.getBoundingClientRect();
    if (after.width <= 0 || after.height <= 0) {
      scheduleViewTransitionRetry(view);
      return;
    }
    // Only a usable layout box completes the retry window. A mounted image can
    // remain zero-sized while it decodes; resetting here any earlier would
    // restart the deadline on every frame and leave the surface pointer-locked.
    clearViewTransitionRetry();
    pendingViewTransitionRef.current = null;
    const translateX = pending.before.left - after.left;
    const translateY = pending.before.top - after.top;
    const scaleX = pending.before.width / after.width;
    const scaleY = pending.before.height / after.height;
    animation = target.animate(
      [
        {
          transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
          transformOrigin: "top left",
        },
        { transform: "none", transformOrigin: "top left" },
      ],
      {
        duration: 450,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "both",
      },
    );
    viewAnimationRef.current = animation;
    viewAnimationListenersRef.current = { animation, finish, cancel: finish };
    animation.addEventListener("finish", finish);
    animation.addEventListener("cancel", finish);
  }, [
    clearViewAnimation,
    clearViewTransitionRetry,
    props.canvasContent,
    readActiveImageElement,
    scheduleViewTransitionRetry,
    view,
    viewTransitionLayoutVersion,
  ]);

  useEffect(() => {
    const previousView = previousViewRef.current;
    previousViewRef.current = view;
    if (view === "playground" && previousView !== view) {
      fullWidthCallbackRef.current?.(true);
    }
  }, [view]);

  useEffect(() => {
    if (coachmarkDismissed || typeof window === "undefined") {
      setCoachmarkVisible(false);
      return;
    }
    setCoachmarkVisible(false);
    const timeoutId = window.setTimeout(
      () => setCoachmarkVisible(true),
      prefersReducedMotion() ? 0 : 450,
    );
    return () => window.clearTimeout(timeoutId);
  }, [coachmarkDismissed]);

  useEffect(() => () => clearViewAnimation(), [clearViewAnimation]);

  const dismissCoachmark = useCallback(() => {
    setCoachmarkDismissed(true);
    setCoachmarkVisible(false);
    try {
      window.localStorage.setItem(GENERATED_IMAGE_CANVAS_COACHMARK_STORAGE_KEY, "1");
    } catch {
      // Storage is optional in private/webview contexts.
    }
  }, []);

  const status = imagePreviewStatusFor(loadStatus, activeImageKey);
  const naturalImageSize =
    naturalImageState.key === activeImageKey ? naturalImageState.value : null;
  const manualZoomPercent = manualZoomState?.key === activeImageKey ? manualZoomState.value : null;
  const fitZoomPercent = resolveGeneratedImagePreviewFitZoomPercent({
    naturalImageSize,
    viewportSize,
    hasImageRail,
  });
  const effectiveZoomPercent = manualZoomPercent ?? fitZoomPercent ?? 100;
  const zoomPercent = Math.round(effectiveZoomPercent);
  const scaledImageSize =
    naturalImageSize !== null && Number.isFinite(effectiveZoomPercent)
      ? {
          width: naturalImageSize.width * (effectiveZoomPercent / 100),
          height: naturalImageSize.height * (effectiveZoomPercent / 100),
        }
      : null;
  const zoomContentSize =
    scaledImageSize !== null && viewportSize !== null
      ? {
          width: Math.max(
            viewportSize.width,
            scaledImageSize.width +
              (hasImageRail ? GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX : 0),
          ),
          height: Math.max(viewportSize.height, scaledImageSize.height),
        }
      : null;

  const measureViewport = useCallback(() => {
    const nextSize = readElementSize(scrollRef.current);
    setViewportSize((current) =>
      current?.width === nextSize?.width && current?.height === nextSize?.height
        ? current
        : nextSize,
    );
  }, []);

  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      measureViewport();
    },
    [measureViewport],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    measureViewport();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measureViewport);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [hasImageRail, measureViewport]);

  useLayoutEffect(() => {
    if (view !== "single") {
      return;
    }
    const image = zoomTargetRef.current;
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      return;
    }
    setLoadStatus({ key: activeImageKey, value: "loaded" });
    setNaturalImageState({
      key: activeImageKey,
      value: { width: image.naturalWidth, height: image.naturalHeight },
    });
  }, [activeImageKey, imageUrl, view]);

  useEffect(() => {
    overflowRef.current = false;
    previousOverflowRef.current = false;
    pendingZoomAnchorRef.current = null;
    dragRef.current = null;
    pinchRef.current = null;
    setManualZoomState(null);
    setIsDragging(false);
    setIsOverflowing(false);
  }, [activeImageKey]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const target = zoomTargetRef.current;
    if (!scroll || !target) {
      return;
    }
    const nextOverflow =
      scroll.scrollWidth - scroll.clientWidth > 1 || scroll.scrollHeight - scroll.clientHeight > 1;
    overflowRef.current = nextOverflow;
    setIsOverflowing((current) => (current === nextOverflow ? current : nextOverflow));

    const pendingAnchor = pendingZoomAnchorRef.current;
    pendingZoomAnchorRef.current = null;
    if (pendingAnchor) {
      const nextScrollPosition = resolveGeneratedImagePreviewZoomScrollPosition({
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
        oldTargetRect: pendingAnchor.oldTargetRect,
        newTargetRect: target.getBoundingClientRect(),
        point: pendingAnchor.point,
      });
      scroll.scrollLeft = Math.min(
        Math.max(0, scroll.scrollWidth - scroll.clientWidth),
        Math.max(0, nextScrollPosition.left),
      );
      scroll.scrollTop = Math.min(
        Math.max(0, scroll.scrollHeight - scroll.clientHeight),
        Math.max(0, nextScrollPosition.top),
      );
    } else if (nextOverflow && !previousOverflowRef.current) {
      scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
      scroll.scrollTop = Math.max(0, (scroll.scrollHeight - scroll.clientHeight) / 2);
    } else if (!nextOverflow) {
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    }
    previousOverflowRef.current = nextOverflow;
  }, [hasImageRail, manualZoomPercent, naturalImageSize, viewportSize]);

  const resolveZoomPoint = useCallback((point: { clientX: number; clientY: number }) => {
    const scroll = scrollRef.current;
    const rect = scroll?.getBoundingClientRect();
    const fallback =
      lastPointerRef.current ??
      (rect ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 } : null);
    return clientPointFromEvent(point, fallback);
  }, []);

  const applyZoomAtPoint = useCallback(
    (nextZoomPercent: number, point: { clientX: number; clientY: number }) => {
      if (!activeImageKey || !naturalImageSize) {
        return;
      }
      const nextZoom = clampGeneratedImagePreviewZoomPercent(nextZoomPercent);
      if (nextZoom === effectiveZoomPercent && manualZoomPercent !== null) {
        return;
      }
      const target = zoomTargetRef.current;
      if (target) {
        pendingZoomAnchorRef.current = {
          point,
          oldTargetRect: target.getBoundingClientRect(),
        };
      }
      flushSync(() => {
        setManualZoomState({ key: activeImageKey, value: nextZoom });
      });
    },
    [activeImageKey, effectiveZoomPercent, manualZoomPercent, naturalImageSize],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      const target = event.target;
      const scroll = scrollRef.current;
      if (!(target instanceof Node) || !root.contains(target) || !scroll) {
        return;
      }
      if (railRef.current?.contains(target) && !event.ctrlKey) {
        return;
      }
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const nextZoomPercent = resolveGeneratedImagePreviewZoomForWheel({
        currentZoomPercent: effectiveZoomPercent,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        pageHeightPx: scroll.clientHeight,
      });
      // A ctrl-wheel gesture must leave the initial "fit" mode even when
      // rounding/clamping produces the same effective percentage. Once a
      // manual zoom is active, an unchanged clamped value is a no-op.
      if (nextZoomPercent === effectiveZoomPercent && manualZoomPercent !== null) {
        return;
      }
      const point = resolveZoomPoint({ clientX: event.clientX, clientY: event.clientY });
      lastPointerRef.current = point;
      applyZoomAtPoint(nextZoomPercent, point);
    };
    root.addEventListener("wheel", handleWheel, { passive: false });
    return () => root.removeEventListener("wheel", handleWheel);
  }, [applyZoomAtPoint, effectiveZoomPercent, manualZoomPercent, resolveZoomPoint]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      return;
    }
    const readTouch = (touch: Touch | undefined) =>
      touch ? { clientX: touch.clientX, clientY: touch.clientY } : null;
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        return;
      }
      const first = readTouch(event.touches[0]);
      const second = readTouch(event.touches[1]);
      if (!first || !second) {
        return;
      }
      const distance = distanceBetweenGeneratedImagePreviewPoints(first, second);
      if (distance <= 0) {
        return;
      }
      lastPointerRef.current = {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
      };
      pinchRef.current = { distance, zoomPercent: effectiveZoomPercent };
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchRef.current) {
        return;
      }
      const first = readTouch(event.touches[0]);
      const second = readTouch(event.touches[1]);
      if (!first || !second) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const nextDistance = distanceBetweenGeneratedImagePreviewPoints(first, second);
      const nextZoomPercent = resolveGeneratedImagePreviewZoomForPinch({
        initialDistance: pinchRef.current.distance,
        initialZoomPercent: pinchRef.current.zoomPercent,
        nextDistance,
      });
      const midpoint = {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
      };
      lastPointerRef.current = midpoint;
      if (nextZoomPercent !== effectiveZoomPercent) {
        applyZoomAtPoint(nextZoomPercent, midpoint);
      }
    };
    const handleTouchEnd = () => {
      if (pinchRef.current) {
        suppressClickUntilRef.current =
          Date.now() + GENERATED_IMAGE_PREVIEW_PINCH_CLICK_SUPPRESSION_MS;
      }
      pinchRef.current = null;
    };
    scroll.addEventListener("touchstart", handleTouchStart, { passive: false });
    scroll.addEventListener("touchmove", handleTouchMove, { passive: false });
    scroll.addEventListener("touchend", handleTouchEnd, { passive: false });
    scroll.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    return () => {
      scroll.removeEventListener("touchstart", handleTouchStart);
      scroll.removeEventListener("touchmove", handleTouchMove);
      scroll.removeEventListener("touchend", handleTouchEnd);
      scroll.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [applyZoomAtPoint, effectiveZoomPercent]);

  const handlePointerDown = (event: PointerEvent<HTMLImageElement>) => {
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (
      !overflowRef.current ||
      event.pointerType === "touch" ||
      event.button !== 0 ||
      !scrollRef.current
    ) {
      return;
    }
    event.preventDefault();
    const scroll = scrollRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: scroll.scrollLeft,
      scrollTop: scroll.scrollTop,
    };
    setIsDragging(true);
    if (typeof event.currentTarget.setPointerCapture === "function") {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events used by browser tests do not have an active
        // pointer to capture; real pointer events still use native capture.
      }
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLImageElement>) => {
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (!drag || !scroll || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    scroll.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX);
    scroll.scrollTop = drag.scrollTop - (event.clientY - drag.clientY);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setIsDragging(false);
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      typeof event.currentTarget.releasePointerCapture === "function"
    ) {
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // A synthetic pointer may have no capture state to release.
      }
    }
  };

  const handleZoomToFit = () => {
    pendingZoomAnchorRef.current = null;
    setManualZoomState(null);
    const scroll = scrollRef.current;
    if (scroll) {
      scroll.scrollLeft = 0;
      scroll.scrollTop = 0;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (view !== "single") {
      return;
    }
    const nextImageId = resolveGeneratedImagePreviewArrowNavigation({
      imageIds,
      activeImageId: activeImage?.id ?? null,
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isEditableTarget:
        isEditableEventTarget(event.nativeEvent) || isButtonLikeTarget(event.target),
    });
    if (nextImageId === null) {
      return;
    }
    event.preventDefault();
    props.onActiveImageChange(nextImageId);
  };

  const handleScrollClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const zoomControlsReady = status === "loaded" && naturalImageSize !== null;
  const downloadImage = useLocalImageDownloadClick({
    downloadUrl: downloadUrl ?? "",
    downloadName,
    errorTitle: t("chat.markdown.generatedImage.downloadError"),
  });

  return (
    <div
      ref={rootRef}
      role="tabpanel"
      tabIndex={0}
      aria-label={title}
      data-testid="generated-image-preview-pane"
      data-image-id={activeImage?.id}
      data-image-status={status}
      data-image-zoom-percent={zoomPercent}
      data-image-zoom-mode={manualZoomPercent === null ? "fit" : "manual"}
      data-image-overflow={isOverflowing ? "true" : "false"}
      data-generated-image-preview-view={view}
      data-generated-image-preview-transitioning={isViewTransitioning ? "true" : "false"}
      data-generated-image-preview-full-width={fullWidth ? "true" : "false"}
      className={`@container relative flex h-full min-h-0 w-full min-w-0 flex-col ${CHAT_BACKGROUND_CLASS_NAME} pb-[var(--right-panel-composer-overlay-reserve,0px)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
      style={{ pointerEvents: isViewTransitioning ? "none" : undefined }}
      onKeyDown={handleKeyDown}
    >
      {activeImage && imageUrl ? (
        <>
          <div className="absolute top-2 left-2 z-40">
            <GeneratedImagePreviewViewToggle
              view={view}
              disabled={isViewTransitioning}
              onChange={handleViewChange}
            />
            {coachmarkVisible ? (
              <div className="absolute top-0 left-[calc(100%+12px)] z-50 w-64">
                <aside
                  role="status"
                  data-testid="generated-image-preview-canvas-coachmark"
                  className="relative max-w-64 !rounded-2xl !border-0 !bg-text-info px-4 py-3 !text-inverse shadow-lg dark:!text-default before:pointer-events-none before:absolute before:-left-1.5 before:top-1/2 before:h-3 before:w-3 before:-translate-y-1/2 before:rotate-45 before:rounded-[1px] before:!bg-text-info before:content-['']"
                >
                  <button
                    type="button"
                    data-testid="generated-image-preview-canvas-coachmark-dismiss"
                    className="absolute top-2 right-2 -me-1 -mt-1 flex h-6 w-6 items-center justify-center !rounded-md !p-0 !text-inverse outline-none hover:!bg-text-inverse/10 hover:!text-inverse focus-visible:ring-2 focus-visible:ring-ring dark:!text-default dark:hover:!bg-text/10 dark:hover:!text-default"
                    aria-label={t("chat.generatedImage.preview.dismissCoachmark")}
                    title={t("chat.generatedImage.preview.dismissCoachmark")}
                    onClick={dismissCoachmark}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                  <p className="pe-4 text-base leading-[18px] font-medium tracking-[-0.08px]">
                    {view === "single"
                      ? t("chat.generatedImage.preview.tryCanvasView")
                      : t("chat.generatedImage.preview.tryFocusedView")}
                  </p>
                  <p className="pe-4 text-base leading-[18px] tracking-[-0.08px]">
                    {t("chat.generatedImage.preview.canvasCoachmarkBody")}
                  </p>
                </aside>
              </div>
            ) : null}
          </div>
          {view === "playground" ? (
            (props.canvasContent ?? (
              <GeneratedImagePlaygroundView
                images={imagePreview?.images ?? []}
                cwd={imagePreview?.cwd ?? null}
                activeImageId={activeImage?.id ?? null}
                groupId={imagePreview?.groupId}
                createdAt={imagePreview?.createdAt}
                zoomPercent={playgroundZoomPercent}
                onZoomPercentChange={(nextZoomPercent) =>
                  setPlaygroundZoomState({
                    key: playgroundGroupKey,
                    value: clampGeneratedImagePreviewZoomPercent(nextZoomPercent),
                  })
                }
                onImageLoad={(imageId, size) => {
                  if (imageId !== activeImage?.id) {
                    return;
                  }
                  setLoadStatus({ key: activeImageKey, value: "loaded" });
                  setNaturalImageState({ key: activeImageKey, value: size });
                }}
                onActiveImageChange={props.onActiveImageChange}
                imageLoadStatus={status}
                resolveImageUrl={props.resolveImageUrl}
                {...(hasImageContextMenuHandler
                  ? { onImageContextMenu: handleImageContextMenu }
                  : {})}
              />
            ))
          ) : (
            <>
              <div className="pointer-events-none absolute top-2 right-2 z-40 flex h-8 items-center gap-1">
                {zoomControlsReady ? (
                  <div className="pointer-events-auto">
                    <GeneratedImagePreviewZoomMenu
                      zoomPercent={zoomPercent}
                      isFit={manualZoomPercent === null}
                      disabled={!zoomControlsReady}
                      onZoomPercentChange={(nextZoomPercent) =>
                        applyZoomAtPoint(clampGeneratedImagePreviewZoomPercent(nextZoomPercent), {
                          clientX:
                            (scrollRef.current?.getBoundingClientRect().left ?? 0) +
                            (scrollRef.current?.clientWidth ?? 0) / 2,
                          clientY:
                            (scrollRef.current?.getBoundingClientRect().top ?? 0) +
                            (scrollRef.current?.clientHeight ?? 0) / 2,
                        })
                      }
                      onZoomToFit={handleZoomToFit}
                    />
                  </div>
                ) : null}
                {status === "loading" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled
                    aria-label={t("chat.markdown.generatedImage.downloadAria")}
                    title={t("chat.markdown.generatedImage.download")}
                    data-testid="generated-image-preview-download"
                    data-download-url={downloadUrl ?? undefined}
                    data-download-name={downloadName}
                    className="pointer-events-auto !size-8"
                  >
                    <DownloadIcon className="size-4" aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={downloadUrl === null}
                    aria-label={t("chat.markdown.generatedImage.downloadAria")}
                    title={t("chat.markdown.generatedImage.download")}
                    data-testid="generated-image-preview-download"
                    data-download-url={downloadUrl ?? undefined}
                    data-download-name={downloadName}
                    className="pointer-events-auto !size-8"
                    onClick={downloadImage}
                    render={
                      <a href={downloadUrl ?? undefined} download={downloadName} role="button" />
                    }
                  >
                    <DownloadIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <div className="flex h-0 min-h-0 flex-1">
                {hasImageRail ? (
                  <GeneratedImagePreviewRail
                    images={imagePreview?.images ?? []}
                    activeIndex={activeIndex}
                    cwd={imagePreview?.cwd ?? null}
                    onSelect={(index) => {
                      const imageId = imageIds[index];
                      if (imageId) {
                        props.onActiveImageChange(imageId);
                      }
                    }}
                    railRef={railRef}
                    resolveImageUrl={props.resolveImageUrl}
                  />
                ) : null}
                <div className={cn("min-h-0 min-w-0 flex-1 py-4", hasImageRail && "-me-18")}>
                  <div
                    ref={setScrollNode}
                    data-testid="generated-image-preview-scroll"
                    className={cn(
                      "h-full min-h-0 min-w-0 touch-none overflow-hidden overscroll-contain px-2 pt-10",
                      hasImageRail && "ps-3 pe-16",
                      manualZoomPercent !== null && isOverflowing && "overflow-auto",
                    )}
                    onClickCapture={handleScrollClickCapture}
                  >
                    <div
                      className={cn(
                        "flex items-center justify-center",
                        zoomContentSize ? "shrink-0" : "h-full w-full",
                      )}
                      style={zoomContentSize ?? undefined}
                    >
                      <img
                        key={activeImageKey}
                        src={imageUrl}
                        alt={title}
                        data-image-id={activeImage.id}
                        decoding="async"
                        draggable={false}
                        referrerPolicy="no-referrer"
                        ref={zoomTargetRef}
                        className={cn(
                          "block shrink-0 rounded-xl object-contain",
                          scaledImageSize ? "max-w-none" : "max-h-full max-w-full",
                          isOverflowing && !isDragging && "cursor-grab",
                          isDragging && "cursor-grabbing",
                        )}
                        style={scaledImageSize ?? undefined}
                        onLoad={(event) => {
                          const { naturalWidth, naturalHeight } = event.currentTarget;
                          setLoadStatus({ key: activeImageKey, value: "loaded" });
                          if (naturalWidth > 0 && naturalHeight > 0) {
                            setNaturalImageState({
                              key: activeImageKey,
                              value: { width: naturalWidth, height: naturalHeight },
                            });
                          }
                        }}
                        onError={() => {
                          setLoadStatus({ key: activeImageKey, value: "error" });
                          setNaturalImageState({ key: activeImageKey, value: null });
                        }}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerEnd}
                        onPointerCancel={handlePointerEnd}
                        onLostPointerCapture={handlePointerEnd}
                        onContextMenu={
                          hasImageContextMenuHandler && status === "loaded"
                            ? (event) => {
                                handleImageContextMenu(
                                  {
                                    src: activeImage.path,
                                    cwd: imagePreview?.cwd ?? null,
                                    name: activeImage.name,
                                  },
                                  event,
                                );
                              }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        (props.canvasContent ?? (
          <p
            role="status"
            className="flex flex-1 items-center justify-center p-4 text-ui-lg text-muted-foreground"
          >
            {t("chat.generatedImage.previewEmpty")}
          </p>
        ))
      )}
      {status === "loading" && activeImage ? (
        <p role="status" aria-live="polite" className="sr-only">
          {t("chat.generatedImage.previewLoading")}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="px-4 pb-2 text-center text-ui-lg text-destructive">
          {t("chat.generatedImage.previewError")}
        </p>
      ) : null}
    </div>
  );
}
