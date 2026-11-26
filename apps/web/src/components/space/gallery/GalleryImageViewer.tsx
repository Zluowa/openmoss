// FILE: GalleryImageViewer.tsx
// Purpose: A picture opened from the gallery: the picture as large as it fits, and beside it
//          what it is — name, description, size in pixels, format, file size, when it was made,
//          its main colours and its tags, which can be added and removed here.
// Layer: Space UI (gallery)

import { useEffect, useState } from "react";

import {
  ArrowLeftIcon,
  ChatBubbleIcon,
  FolderIcon,
  PinFilledIcon,
  PinIcon,
  PlusIcon,
  TrashCanIcon,
  XIcon,
} from "~/lib/icons";

import { PageChromeButton } from "../../pages/chrome/PageChromeButton";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { spaceItemDisplayTitle, type SpaceItem } from "../spaceItems";
import { GalleryPicture } from "./GalleryCards";
import { useGallery, useGalleryImageSrc } from "./GalleryContext";
import { useGalleryLocalStore } from "./galleryLocalStore";

export function GalleryImageViewer(props: {
  item: SpaceItem;
  onBack: () => void;
  /** The chat that made the picture, when one did. */
  onContinueInChat?: ((item: SpaceItem) => void) | undefined;
  onTogglePin?: ((item: SpaceItem) => void) | undefined;
  onTrash?: ((item: SpaceItem) => void) | undefined;
}) {
  const gallery = useGallery();
  const { item } = props;
  const src = useGalleryImageSrc(item);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const colors = useMainColors(src);
  const folder = gallery.folderOf(item);
  const title = spaceItemDisplayTitle(item);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={title} data-gallery-image-viewer>
      <header className="flex h-12 shrink-0 items-center gap-1 px-3">
        <Button size="icon-sm" variant="ghost" aria-label="返回" onClick={props.onBack}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="ms-1 min-w-0 flex-1 truncate text-ui font-medium">{title}</h1>
        <div className="flex shrink-0 items-center gap-1">
          {item.sourceThreadId && props.onContinueInChat ? (
            <PageChromeButton
              icon={ChatBubbleIcon}
              label="在对话中继续"
              onClick={() => props.onContinueInChat?.(item)}
            />
          ) : null}
          {props.onTogglePin ? (
            <PageChromeButton
              icon={item.pinned ? PinFilledIcon : PinIcon}
              label={item.pinned ? "取消收藏" : "收藏"}
              iconOnly
              active={item.pinned}
              onClick={() => props.onTogglePin?.(item)}
            />
          ) : null}
          {props.onTrash && item.trashedAt === null ? (
            <PageChromeButton
              icon={TrashCanIcon}
              label="移到回收站"
              iconOnly
              onClick={() => props.onTrash?.(item)}
            />
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
          {src ? (
            <img
              src={src}
              alt={title}
              className="max-h-full max-w-full rounded-card object-contain"
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          ) : (
            <GalleryPicture item={item} src={null} className="w-64" />
          )}
        </div>
        <aside
          className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border px-4 py-4 max-md:hidden"
          aria-label="图片信息"
          data-gallery-inspector
        >
          <div className="flex flex-col gap-1">
            <span className="truncate text-ui font-medium">{title}</span>
            <Description itemKey={item.key} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Fact label="尺寸" value={size ? `${size.width} × ${size.height}` : "—"} />
            <Fact label="格式" value={formatOf(item)} />
            <Fact label="大小" value={fileSizeOf(item)} />
            <Fact label="创建时间" value={formatDate(item.createdAt)} wide />
          </dl>
          {colors.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui-xs text-muted-foreground">颜色</span>
              <div className="flex gap-1.5" data-gallery-colors>
                {colors.map((color) => (
                  <Tooltip key={color}>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          aria-label={color}
                          className="size-5 rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          style={{ background: color }}
                        />
                      }
                    />
                    <TooltipPopup>{color}</TooltipPopup>
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}
          <TagEditor item={item} />
          {folder ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui-xs text-muted-foreground">位置</span>
              <Button
                size="sm"
                variant="ghost"
                className="justify-start self-start"
                onClick={() => gallery.onPlace({ type: "folder", key: folder.key })}
              >
                <FolderIcon />
                {folder.title}
              </Button>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function Fact(props: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={props.wide ? "col-span-2" : undefined}>
      <dt className="text-ui-xs text-muted-foreground">{props.label}</dt>
      <dd className="text-ui-sm tabular-nums">{props.value}</dd>
    </div>
  );
}

function Description(props: { itemKey: string }) {
  const saved = useGalleryLocalStore((state) => state.descriptions[props.itemKey] ?? "");
  const setDescription = useGalleryLocalStore((state) => state.setDescription);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <textarea
      aria-label="描述"
      placeholder="添加描述…"
      value={draft}
      rows={2}
      className="resize-none bg-transparent text-ui-sm text-muted-foreground outline-none placeholder:text-muted-foreground/70"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== saved) setDescription(props.itemKey, draft);
      }}
    />
  );
}

function TagEditor(props: { item: SpaceItem }) {
  const gallery = useGallery();
  const own = useGalleryLocalStore((state) => state.tags[props.item.key] ?? []);
  const addTag = useGalleryLocalStore((state) => state.addTag);
  const removeTag = useGalleryLocalStore((state) => state.removeTag);
  const [draft, setDraft] = useState("");
  // The box appears when asked for, and folds back once it is left empty.
  const [adding, setAdding] = useState(false);
  const tags = gallery.tagsOf(props.item);
  return (
    <div className="flex flex-col gap-1.5" data-gallery-tags>
      <span className="text-ui-xs text-muted-foreground">标签</span>
      <div className="flex flex-col gap-0.5">
        {tags.map((tag) => (
          <span key={tag} className="group/tag flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              className="justify-start px-1.5"
              aria-label={`标签 ${tag}`}
              onClick={() => gallery.onPlace({ type: "tag", tag })}
            >
              <span className="text-muted-foreground">#</span>
              {tag}
            </Button>
            {own.includes(tag) ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`移除标签 ${tag}`}
                className="opacity-0 group-hover/tag:opacity-100 focus-visible:opacity-100"
                onClick={() => removeTag(props.item.key, tag)}
              >
                <XIcon />
              </Button>
            ) : null}
          </span>
        ))}
      </div>
      {adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            for (const tag of draft.split(/[,，\s]+/u)) addTag(props.item.key, tag);
            setDraft("");
          }}
        >
          <input
            autoFocus
            aria-label="添加标签"
            placeholder="输入标签，回车添加"
            value={draft}
            className="h-control-sm w-full rounded-control border border-border bg-transparent px-2 text-ui-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft.trim() === "") setAdding(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
        </form>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="justify-start self-start px-1.5 text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
          添加标签
        </Button>
      )}
    </div>
  );
}

function formatOf(item: SpaceItem): string {
  const mime = item.source.type === "library" ? item.source.item.mimeType : null;
  if (mime?.startsWith("image/")) return mime.slice(6).replace("jpeg", "jpg").toUpperCase();
  const path =
    item.source.type === "library"
      ? item.source.item.path
      : item.source.type === "output"
        ? item.source.output.path
        : null;
  const extension = path?.split(/[?#]/u)[0]?.split(".").pop();
  return extension && extension.length <= 5 ? extension.toUpperCase() : "—";
}

function fileSizeOf(item: SpaceItem): string {
  const bytes = item.source.type === "library" ? item.source.item.size : 0;
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The picture's main colours, read from a small copy of it. A picture served from another
 * origin cannot be read; it then has no colours row.
 */
function useMainColors(src: string | null): string[] {
  const [colors, setColors] = useState<string[]>([]);
  useEffect(() => {
    setColors([]);
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => {
      if (cancelled) return;
      try {
        setColors(sampleColors(image));
      } catch {
        setColors([]);
      }
    });
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return colors;
}

function sampleColors(image: HTMLImageElement): string[] {
  const side = 32;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, side, side);
  const data = context.getImageData(0, 0, side, side).data;
  // Bucket to 4 levels per channel, keep the most common buckets that differ enough.
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < data.length; index += 4) {
    if ((data[index + 3] ?? 0) < 128) continue;
    const r = data[index]!;
    const g = data[index + 1]!;
    const b = data[index + 2]!;
    const key = `${r >> 6}-${g >> 6}-${b >> 6}`;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(
      (bucket) =>
        `rgb(${Math.round(bucket.r / bucket.count)} ${Math.round(bucket.g / bucket.count)} ${Math.round(bucket.b / bucket.count)})`,
    );
}
