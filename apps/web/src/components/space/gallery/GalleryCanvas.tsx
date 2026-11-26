// FILE: GalleryCanvas.tsx
// Purpose: The same things as the gallery, spread out on a wall: clusters you can pan, zoom
//          and rearrange by dragging. Moved cards stay where they were put, on this device.
// Layer: Space UI (gallery)

import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ZoomInIcon, ZoomOutIcon } from "~/lib/icons";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { spaceItemDisplayTitle, type SpaceItem } from "../spaceItems";
import { spaceItemMeta } from "../spaceKinds";
import { GalleryPicture, NoteBlocks } from "./GalleryCards";
import { useGallery, useGalleryAspects, useGalleryImageSrc } from "./GalleryContext";
import { useGalleryLocalStore } from "./galleryLocalStore";
import {
  fitCanvas,
  galleryClassOf,
  layoutCanvas,
  noteBlocks,
  type CanvasGroup,
  type CanvasRect,
} from "./galleryModel";

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** A press that moves less than this is a click. */
const CLICK_SLOP = 4;

interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export function GalleryCanvas(props: {
  /** Whose arrangement this is (a folder, home, a tag); moved cards are kept per container. */
  container: string;
  groups: readonly CanvasGroup[];
}) {
  const gallery = useGallery();
  const aspects = useGalleryAspects((state) => state.aspects);
  const positions = useGalleryLocalStore((state) => state.positions[props.container]);
  const moveOnCanvas = useGalleryLocalStore((state) => state.moveOnCanvas);
  const resetCanvas = useGalleryLocalStore((state) => state.resetCanvas);
  const layout = useMemo(
    () => layoutCanvas(props.groups, (item) => aspects[item.key]),
    [props.groups, aspects],
  );
  const rects = useMemo(() => {
    const map = new Map<string, CanvasRect>();
    for (const [key, rect] of layout.items) {
      const moved = positions?.[key];
      map.set(key, moved ? { ...rect, x: moved.x, y: moved.y } : rect);
    }
    return map;
  }, [layout, positions]);
  const bounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rect of rects.values()) {
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }
    return Number.isFinite(minX)
      ? { x: minX, y: minY - 36, width: maxX - minX, height: maxY - minY + 36 }
      : layout.bounds;
  }, [rects, layout.bounds]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View | null>(null);
  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setView(fitCanvas(bounds, { width: viewport.clientWidth, height: viewport.clientHeight }));
  };
  // Fit once per container when it first has a size; later changes keep the person's view.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === props.container || rects.size === 0) return;
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth === 0) return;
    fitted.current = props.container;
    setView(fitCanvas(bounds, { width: viewport.clientWidth, height: viewport.clientHeight }));
  }, [props.container, bounds, rects.size]);

  const current = view ?? { scale: 1, x: 0, y: 0 };
  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const box = viewport.getBoundingClientRect();
    const px = (clientX ?? box.left + box.width / 2) - box.left;
    const py = (clientY ?? box.top + box.height / 2) - box.top;
    setView((previous) => {
      const base = previous ?? current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, base.scale * factor));
      const ratio = scale / base.scale;
      return { scale, x: px - (px - base.x) * ratio, y: py - (py - base.y) * ratio };
    });
  };

  // Wheel: pinch or ⌘/Ctrl zooms at the pointer; otherwise it pans. Needs a non-passive listener.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
        return;
      }
      setView((previous) => {
        const base = previous ?? { scale: 1, x: 0, y: 0 };
        return { ...base, x: base.x - event.deltaX, y: base.y - event.deltaY };
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  });

  const drag = useRef<
    | { type: "pan"; startX: number; startY: number; origin: View }
    | {
        type: "item";
        item: SpaceItem;
        startX: number;
        startY: number;
        origin: CanvasRect;
        moved: boolean;
      }
    | null
  >(null);
  const [dragging, setDragging] = useState<{ key: string; x: number; y: number } | null>(null);

  const onBackgroundDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { type: "pan", startX: event.clientX, startY: event.clientY, origin: current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onItemDown = (event: ReactPointerEvent<HTMLDivElement>, item: SpaceItem) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const origin = rects.get(item.key);
    if (!origin) return;
    drag.current = {
      type: "item",
      item,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
    };
    viewportRef.current?.setPointerCapture(event.pointerId);
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (active.type === "pan") {
      setView({ ...active.origin, x: active.origin.x + dx, y: active.origin.y + dy });
      return;
    }
    if (!active.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    active.moved = true;
    setDragging({
      key: active.item.key,
      x: active.origin.x + dx / current.scale,
      y: active.origin.y + dy / current.scale,
    });
  };
  const onUp = () => {
    const active = drag.current;
    drag.current = null;
    if (active?.type !== "item") return;
    if (!active.moved) {
      gallery.onOpenItem(active.item);
      return;
    }
    if (dragging) moveOnCanvas(props.container, active.item.key, dragging.x, dragging.y);
    setDragging(null);
  };

  const itemsByKey = useMemo(
    () =>
      new Map(
        props.groups.flatMap((group) => group.items.map((item) => [item.key, item] as const)),
      ),
    [props.groups],
  );

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-gallery-canvas>
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden select-none",
          drag.current?.type === "pan" ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})` }}
        >
          {layout.labels.map((label) => (
            <span
              key={label.id}
              className="absolute text-ui-lg font-medium whitespace-nowrap text-muted-foreground"
              style={{ left: label.x, top: label.y }}
            >
              {label.label}
            </span>
          ))}
          {[...rects].map(([key, rect]) => {
            const item = itemsByKey.get(key);
            if (!item) return null;
            const live = dragging?.key === key ? { ...rect, x: dragging.x, y: dragging.y } : rect;
            return (
              <CanvasItem
                key={key}
                item={item}
                rect={live}
                lifted={dragging?.key === key}
                onPointerDown={(event) => onItemDown(event, item)}
                onOpen={() => gallery.onOpenItem(item)}
              />
            );
          })}
        </div>
      </div>
      <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-popover border border-border bg-popover p-1 shadow-xl">
        <Button size="icon-sm" variant="ghost" aria-label="缩小" onClick={() => zoomAt(1 / 1.25)}>
          <ZoomOutIcon />
        </Button>
        <span
          className="w-12 text-center text-ui-sm tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {Math.round(current.scale * 100)}%
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="放大" onClick={() => zoomAt(1.25)}>
          <ZoomInIcon />
        </Button>
        <Button size="sm" variant="ghost" onClick={fit}>
          适应画面
        </Button>
        {positions && Object.keys(positions).length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => resetCanvas(props.container)}>
            重新排列
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CanvasItem(props: {
  item: SpaceItem;
  rect: CanvasRect;
  lifted: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOpen: () => void;
}) {
  const gallery = useGallery();
  const { item, rect } = props;
  const kind = galleryClassOf(item);
  const imageSrc = useGalleryImageSrc(item);
  const title = spaceItemDisplayTitle(item);
  const markdown = kind === "note" ? gallery.noteMarkdown(item) : null;
  const Icon = spaceItemMeta(item).icon;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={kind === "image" ? `图片 ${title}` : title}
      data-canvas-item={item.key}
      className={cn(
        "absolute cursor-default overflow-hidden rounded-inline outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-info",
        kind === "image" ? "bg-muted/40" : "border border-border/80 bg-card p-3",
        props.lifted ? "z-10 shadow-xl" : "hover:ring-2 hover:ring-info/60",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onPointerDown={props.onPointerDown}
      onKeyDown={(event) => {
        if (isImeComposingKeyEvent(event)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      {kind === "image" ? (
        <GalleryPicture item={item} src={imageSrc} fill />
      ) : (
        <span className="flex flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {kind === "note" ? null : <Icon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate text-ui-sm font-medium">{title}</span>
          </span>
          {markdown ? <NoteBlocks blocks={noteBlocks(markdown, 8)} size="canvas" /> : null}
        </span>
      )}
    </div>
  );
}
