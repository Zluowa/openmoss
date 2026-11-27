// FILE: GalleryCards.tsx
// Purpose: Card parts the 资料空间 shares between its grid, canvas and search: the card button
//          itself, a folder card (what is inside peeks out of a pocket), a note's text as
//          blocks, and a picture at its own proportions.
// Layer: Space UI (gallery)

import {
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { CheckIcon } from "~/lib/icons";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { hasSpaceItemDrag, readDraggedSpaceKeys } from "../spaceDragState";
import { spaceItemDisplayTitle, type SpaceItem } from "../spaceItems";
import { spaceItemMeta } from "../spaceKinds";
import { galleryNoteImageSrc, useGalleryAspects, useGalleryImageSrc } from "./GalleryContext";
import { folderSummary, galleryClassOf, type GalleryFolder, type NoteBlock } from "./galleryModel";

const CARD_CLASS_NAME =
  "group/gallery-card relative flex h-auto min-h-0 w-full flex-col items-stretch justify-start gap-0 overflow-hidden whitespace-normal rounded-card border border-border/80 bg-card p-0 text-left font-normal text-foreground shadow-none outline-none transition-[box-shadow,border-color,transform] hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-0 data-pressed:bg-card";

/** A card is one Button: the shared focus and press treatment, drawn as a card. */
export function SpaceCardButton(props: Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return <Button {...props} variant="ghost" className={cn(CARD_CLASS_NAME, props.className)} />;
}

/** The card a person just came back from or selected keeps a crisp blue outline. */
export const CARD_MARKED_CLASS_NAME = "ring-2 ring-info";

// ---------------------------------------------------------------------------------------------
// Folder

/**
 * A crafted folder card: unified smooth tab-and-body SVG silhouette (zero jagged seams),
 * gently fanned peek sheets, frosted front pocket, single-click selection, double-click open,
 * and drop-target highlighting for filing files directly into the folder.
 */
export function SpaceFolderCard(props: {
  folder: GalleryFolder;
  marked: boolean;
  selected?: boolean | undefined;
  onSelect?: ((folder: GalleryFolder, event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  onOpen: (folder: GalleryFolder) => void;
  onDropKeys?: ((folder: GalleryFolder, keys: readonly string[]) => void) | undefined;
}) {
  const { folder } = props;
  const [dropActive, setDropActive] = useState(false);
  const [dropCount, setDropCount] = useState(0);
  const dragDepthRef = useRef(0);

  // Pictures show a folder best; then a note, then whatever else it holds.
  const peeks = [
    ...folder.items.filter((item) => galleryClassOf(item) === "image").slice(0, 2),
    ...folder.items.filter((item) => galleryClassOf(item) === "note"),
    ...folder.items.filter((item) => galleryClassOf(item) === "image").slice(2),
    ...folder.items.filter((item) => galleryClassOf(item) === "other"),
  ].slice(0, 3);

  const highlighted = Boolean(props.selected || props.marked || dropActive);

  const handleDragEnter = (event: DragEvent<HTMLButtonElement>) => {
    if (!props.onDropKeys || !hasSpaceItemDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
    setDropCount(readDraggedSpaceKeys(event.dataTransfer).length);
  };

  const handleDragOver = (event: DragEvent<HTMLButtonElement>) => {
    if (!props.onDropKeys || !hasSpaceItemDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!dropActive) setDropActive(true);
  };

  const handleDragLeave = () => {
    if (!props.onDropKeys) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropActive(false);
      setDropCount(0);
    }
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    dragDepthRef.current = 0;
    setDropActive(false);
    setDropCount(0);
    if (!props.onDropKeys) return;
    const keys = readDraggedSpaceKeys(event.dataTransfer);
    if (keys.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    props.onDropKeys(folder, keys);
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (props.onSelect) {
      event.stopPropagation();
      props.onSelect(folder, event);
      return;
    }
    props.onOpen(folder);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    props.onOpen(folder);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isImeComposingKeyEvent(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      props.onOpen(folder);
    }
  };

  return (
    <SpaceCardButton
      className={cn(
        "relative overflow-visible rounded-card border-0 bg-transparent p-0 transition-transform duration-200 hover:border-transparent hover:bg-transparent focus-visible:ring-0 data-pressed:bg-transparent",
        dropActive && "-translate-y-0.5 scale-[1.01]",
      )}
      data-gallery-card="folder"
      data-gallery-key={folder.key}
      data-selected={props.selected ? "" : undefined}
      data-drop-active={dropActive ? "" : undefined}
      aria-label={`文件夹 ${folder.title}，${folderSummary(folder)}`}
      aria-selected={props.selected || undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span
        className={cn(
          "relative flex h-[196px] w-full flex-col justify-end overflow-hidden rounded-b-card pt-6 transition-[filter] duration-200",
          highlighted ? "drop-shadow-md" : "drop-shadow-xs group-hover/gallery-card:drop-shadow-sm",
        )}
      >
        {/* Unified tab + folder shell path so border, tab shoulder, and corners stay razor smooth. */}
        <svg
          viewBox="0 0 320 196"
          preserveAspectRatio="none"
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <path
            d="M 14 1 L 106 1 C 116 1 122 6 128 14 C 133 20 138 23 147 23 L 306 23 A 13 13 0 0 1 319 36 L 319 182 A 13 13 0 0 1 306 195 L 14 195 A 13 13 0 0 1 1 182 L 1 14 A 13 13 0 0 1 14 1 Z"
            fill="var(--color-background-elevated-secondary)"
            stroke={highlighted ? "var(--color-info)" : "var(--border)"}
            strokeWidth={highlighted ? 2 : 1}
            vectorEffect="non-scaling-stroke"
            className="transition-[stroke,stroke-width] duration-150"
          />
        </svg>

        {dropActive ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-7 right-3 z-20 rounded-full bg-info px-2.5 py-0.5 text-ui-xs font-medium text-white shadow-sm"
          >
            {dropCount > 1 ? `松手移入 ${dropCount} 项` : "松手移入"}
          </span>
        ) : null}

        {/* Items fanning softly out of the folder pocket. */}
        <span aria-hidden className="relative z-0 mx-3.5 block flex-1 overflow-hidden">
          {peeks.length === 0 ? null : (
            <span
              className={cn(
                "flex items-start justify-center gap-2 pt-2 transition-transform duration-300 ease-out group-hover/gallery-card:-translate-y-1.5",
                dropActive && "-translate-y-2.5 scale-[1.02]",
              )}
            >
              {peeks.map((item, index) => (
                <FolderPeek key={item.key} item={item} index={index} total={peeks.length} />
              ))}
            </span>
          )}
        </span>

        {/* Frosted front pocket mask cleanly clipped inside the outer stroke corners. */}
        <span
          className={cn(
            "relative z-10 mx-[1.5px] mb-[1.5px] -mt-12 flex flex-col gap-0.5 rounded-b-card border-t border-border/55 bg-card/88 px-3.5 pt-3 pb-3 shadow-xs backdrop-blur-md transition-transform duration-200",
            dropActive && "translate-y-0.5 bg-card/95",
          )}
        >
          <span className="truncate text-ui font-medium text-foreground">{folder.title}</span>
          <span className="truncate text-ui-xs text-muted-foreground">{folderSummary(folder)}</span>
        </span>
      </span>
    </SpaceCardButton>
  );
}

/** One thing peeking out of a folder: a picture, or a note as a small sheet with its title. */
function FolderPeek(props: { item: SpaceItem; index: number; total: number }) {
  const { item } = props;
  const tilt = props.total === 1 ? 0 : (props.index - (props.total - 1) / 2) * 3;
  const style: CSSProperties = {
    transform: `rotate(${tilt}deg) translateY(${Math.abs(tilt)}px)`,
  };
  const gallerySrc = useGalleryImageSrc(item);
  const src = galleryClassOf(item) === "image" ? gallerySrc : null;
  if (src) {
    return (
      <span
        style={style}
        className="block h-28 min-w-0 flex-1 overflow-hidden rounded-inline border border-border/60 bg-card shadow-xs"
      >
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          draggable={false}
        />
      </span>
    );
  }
  const Icon = spaceItemMeta(item).icon;
  return (
    <span
      style={style}
      className="flex h-28 min-w-0 flex-1 flex-col gap-1 overflow-hidden rounded-inline border border-border/60 bg-card px-2 py-1.5 shadow-xs"
    >
      <span className="flex min-w-0 items-center gap-1">
        {galleryClassOf(item) === "note" ? null : (
          <Icon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-ui-xs font-medium">{spaceItemDisplayTitle(item)}</span>
      </span>
      <span className="flex flex-col gap-1 pt-0.5">
        <span className="h-1 w-full rounded-full bg-foreground/8" />
        <span className="h-1 w-4/5 rounded-full bg-foreground/8" />
        <span className="h-1 w-3/5 rounded-full bg-foreground/8" />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Note text

export function NoteBlocks(props: { blocks: readonly NoteBlock[]; size?: "card" | "canvas" }) {
  if (isVerse(props.blocks)) return <Verse blocks={props.blocks} />;
  return (
    <span className={cn("flex flex-col", props.size === "canvas" ? "gap-1" : "gap-1.5")}>
      {props.blocks.map((block, index) => (
        <NoteBlockView key={index} block={block} />
      ))}
    </span>
  );
}

/** A poem: only short lines, the last one saying who wrote it (「—— 唐 · 王维」). */
function isVerse(blocks: readonly NoteBlock[]): boolean {
  const lines = blocks.filter((block) => block.type === "paragraph");
  return (
    lines.length >= 2 &&
    lines.length === blocks.length &&
    lines.every((block) => block.text.length <= 20) &&
    lines.at(-1)!.text.startsWith("——")
  );
}

/** Verse reads in the body colour at a step up, one line each, with air between couplets. */
function Verse(props: { blocks: readonly NoteBlock[] }) {
  const lines = props.blocks.map((block) => (block.type === "paragraph" ? block.text : ""));
  const by = lines.at(-1)!;
  return (
    <span className="flex flex-col gap-2 py-1" data-note-verse>
      {lines.slice(0, -1).map((line, index) => (
        <span key={index} className="text-ui-sm tracking-wide text-foreground">
          {line}
        </span>
      ))}
      <span className="pt-1 text-ui-xs text-muted-foreground">{by}</span>
    </span>
  );
}

function NoteBlockView(props: { block: NoteBlock }): ReactNode {
  const { block } = props;
  const body = "text-ui-xs";
  switch (block.type) {
    case "heading":
      return (
        <span className={cn(body, "font-medium text-foreground", block.level === 1 && "pt-0.5")}>
          {block.text}
        </span>
      );
    case "task":
      return (
        <span className={cn(body, "flex items-start gap-1.5 text-muted-foreground")}>
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-3 shrink-0 items-center justify-center rounded-full border",
              block.done ? "border-info bg-info text-white" : "border-foreground/25",
            )}
          >
            {block.done ? <CheckIcon className="size-2" /> : null}
          </span>
          <span className={cn("min-w-0", block.done && "text-muted-foreground/70")}>
            {block.text}
          </span>
        </span>
      );
    case "quote":
      return (
        <span className={cn(body, "border-s-2 border-border ps-2 text-muted-foreground italic")}>
          {block.text}
        </span>
      );
    case "bullet":
      return (
        <span className={cn(body, "flex gap-1.5 text-muted-foreground")}>
          <span aria-hidden>•</span>
          <span className="min-w-0">{block.text}</span>
        </span>
      );
    case "image": {
      const src = galleryNoteImageSrc(block.src);
      return src ? (
        <img
          src={src}
          alt={block.alt}
          className="block max-h-48 w-full rounded-inline object-cover"
          draggable={false}
        />
      ) : null;
    }
    default:
      return <span className={cn(body, "text-muted-foreground")}>{block.text}</span>;
  }
}

/** Observes an element and latches true once it enters (or approaches) the viewport. */
export function useNearViewport(ref: RefObject<Element | null>, active: boolean): boolean {
  const [visible, setVisible] = useState(
    () => !active || typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const element = ref.current;
    if (!element) {
      // Initial mount before the ref attaches or non-observed wrappers: show promptly.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, ref]);
  return visible;
}

// ---------------------------------------------------------------------------------------------
// Picture

/** A picture at its own proportions; records them so the grid and canvas keep the shape. */
export function GalleryPicture(props: {
  item: SpaceItem;
  src: string | null;
  className?: string;
  fill?: boolean;
  onRetrySrc?: (() => void) | undefined;
}) {
  const aspect = useGalleryAspects((state) => state.aspects[props.item.key]);
  const setAspect = useGalleryAspects((state) => state.setAspect);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const retriedSrcRef = useRef<string | null>(null);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [props.src]);
  if (!props.src || failed) {
    const Icon = spaceItemMeta(props.item).icon;
    return (
      <span
        className={cn(
          "flex aspect-[4/3] flex-col items-center justify-center gap-1.5 px-3 text-center text-muted-foreground",
          props.fill && "aspect-auto h-full",
          props.className,
        )}
      >
        <Icon className="size-6 opacity-70" />
        {failed ? (
          <span className="max-w-full truncate text-ui-xs">
            {spaceItemDisplayTitle(props.item)}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <img
      src={props.src}
      alt={spaceItemDisplayTitle(props.item)}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={props.fill ? undefined : { aspectRatio: String(aspect ?? 4 / 3) }}
      className={cn(
        "block object-cover transition-opacity duration-200",
        loaded ? "opacity-100" : "opacity-0",
        props.fill && "h-full w-full",
        props.className,
      )}
      onLoad={(event) => {
        setLoaded(true);
        const image = event.currentTarget;
        if (image.naturalHeight > 0)
          setAspect(props.item.key, image.naturalWidth / image.naturalHeight);
      }}
      onError={() => {
        if (props.onRetrySrc && retriedSrcRef.current !== props.src) {
          retriedSrcRef.current = props.src;
          props.onRetrySrc();
          return;
        }
        setFailed(true);
      }}
    />
  );
}
