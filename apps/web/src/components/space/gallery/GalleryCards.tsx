// FILE: GalleryCards.tsx
// Purpose: Card parts the 资料空间 shares between its grid, canvas and search: the card button
//          itself, a folder card (what is inside peeks out of a pocket), a note's text as
//          blocks, and a picture at its own proportions.
// Layer: Space UI (gallery)

import { type ComponentProps, type CSSProperties, type ReactNode, useState } from "react";

import { CheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { spaceItemDisplayTitle, type SpaceItem } from "../spaceItems";
import { spaceItemMeta } from "../spaceKinds";
import { galleryNoteImageSrc, useGalleryAspects, useGalleryImageSrc } from "./GalleryContext";
import { folderSummary, galleryClassOf, type GalleryFolder, type NoteBlock } from "./galleryModel";

const CARD_CLASS_NAME =
  "group/gallery-card relative flex h-auto min-h-0 w-full flex-col items-stretch justify-start gap-0 overflow-hidden whitespace-normal rounded-card border border-border/80 bg-card p-0 text-left font-normal text-foreground shadow-none outline-none transition-[box-shadow,border-color] hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-0 data-pressed:bg-card";

/** A card is one Button: the shared focus and press treatment, drawn as a card. */
export function SpaceCardButton(props: Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return <Button {...props} variant="ghost" className={cn(CARD_CLASS_NAME, props.className)} />;
}

/** The card a person just came back from keeps a blue outline, so they see where they were. */
export const CARD_MARKED_CLASS_NAME = "ring-2 ring-info";

// ---------------------------------------------------------------------------------------------
// Folder

/** A folder: what is inside peeks out of a pocket, with 「2 篇笔记 · 5 张图片」 under its name. */
export function SpaceFolderCard(props: {
  folder: GalleryFolder;
  marked: boolean;
  onOpen: (folder: GalleryFolder) => void;
}) {
  const { folder } = props;
  // Pictures show a folder best; then a note, then whatever else it holds.
  const peeks = [
    ...folder.items.filter((item) => galleryClassOf(item) === "image").slice(0, 2),
    ...folder.items.filter((item) => galleryClassOf(item) === "note"),
    ...folder.items.filter((item) => galleryClassOf(item) === "image").slice(2),
    ...folder.items.filter((item) => galleryClassOf(item) === "other"),
  ].slice(0, 3);
  return (
    <SpaceCardButton
      className="overflow-visible border-transparent bg-transparent pt-2.5 hover:border-transparent hover:bg-transparent data-pressed:bg-transparent"
      data-gallery-card="folder"
      data-gallery-key={folder.key}
      aria-label={`文件夹 ${folder.title}，${folderSummary(folder)}`}
      onClick={() => props.onOpen(folder)}
    >
      {/* The folder's tab. */}
      <span
        aria-hidden
        className={cn(
          "absolute top-0 left-0 h-5 w-[38%] rounded-t-card border border-b-0 border-border/80 bg-[var(--color-background-elevated-secondary)]",
          props.marked && "border-info",
        )}
      />
      <span
        className={cn(
          "relative flex w-full flex-col overflow-hidden rounded-card rounded-tl-none border border-border/80 bg-[var(--color-background-elevated-secondary)] transition-[border-color] group-hover/gallery-card:border-border",
          props.marked && CARD_MARKED_CLASS_NAME,
        )}
      >
        <span aria-hidden className="relative block h-36 w-full overflow-hidden">
          {peeks.length === 0 ? null : (
            <span className="absolute inset-x-3 top-3 flex items-start justify-center gap-2">
              {peeks.map((item, index) => (
                <FolderPeek key={item.key} item={item} index={index} total={peeks.length} />
              ))}
            </span>
          )}
        </span>
        {/* The pocket: what is inside shows above it, softened below its edge. */}
        <span className="relative -mt-10 flex flex-col gap-0.5 border-t border-border/60 bg-card/80 px-3 pt-3 pb-3 backdrop-blur-md">
          <span className="truncate text-ui font-medium">{folder.title}</span>
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
        <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
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

// ---------------------------------------------------------------------------------------------
// Picture

/** A picture at its own proportions; records them so the grid and canvas keep the shape. */
export function GalleryPicture(props: {
  item: SpaceItem;
  src: string | null;
  className?: string;
  fill?: boolean;
}) {
  const aspect = useGalleryAspects((state) => state.aspects[props.item.key]);
  const setAspect = useGalleryAspects((state) => state.setAspect);
  const [failed, setFailed] = useState(false);
  if (!props.src || failed) {
    const Icon = spaceItemMeta(props.item).icon;
    return (
      <span
        className={cn(
          "flex aspect-[4/3] items-center justify-center text-muted-foreground",
          props.fill && "aspect-auto h-full",
          props.className,
        )}
      >
        <Icon className="size-6" />
      </span>
    );
  }
  return (
    <img
      key={props.src}
      src={props.src}
      alt={spaceItemDisplayTitle(props.item)}
      draggable={false}
      style={props.fill || aspect === undefined ? undefined : { aspectRatio: String(aspect) }}
      className={cn("block object-cover", props.fill && "h-full w-full", props.className)}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalHeight > 0)
          setAspect(props.item.key, image.naturalWidth / image.naturalHeight);
      }}
      onError={() => setFailed(true)}
    />
  );
}
