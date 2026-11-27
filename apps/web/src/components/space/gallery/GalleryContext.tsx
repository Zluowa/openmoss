// FILE: GalleryContext.tsx
// Purpose: What the 资料空间's cards, canvas and search read: the folder tree, each note's text
//          and tags, each picture's address and proportions, and the actions that open things.
// Layer: Space UI (gallery)

import type { LibraryFolder, PageId, PageSpace, PagesReadResult, SpaceId } from "@moss/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { create } from "zustand";

import { buildLocalImageUrl, hasLocalImageUrlResolver } from "~/lib/localImageUrls";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { projectLocalPreviewGrantQueryOptions } from "~/lib/projectReactQuery";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ensureNativeApi } from "~/nativeApi";

import { spaceMossMediaPath, type SpaceItem } from "../spaceItems";
import {
  buildGalleryTree,
  galleryClassOf,
  normalizeTag,
  noteHashtags,
  notePlainText,
  type GalleryCollection,
  type GalleryFolder,
  type GalleryTree,
} from "./galleryModel";
import { useGalleryLocalStore } from "./galleryLocalStore";

/** Where the gallery is: home, inside a folder, one tag, or a saved collection. */
export type GalleryPlace =
  | { readonly type: "home" }
  | { readonly type: "folder"; readonly key: string }
  | { readonly type: "tag"; readonly tag: string }
  | { readonly type: "collection"; readonly id: string };

export function galleryPlaceKey(place: GalleryPlace): string {
  switch (place.type) {
    case "home":
      return "home";
    case "folder":
      return place.key;
    case "tag":
      return `tag:${place.tag}`;
    default:
      return `collection:${place.id}`;
  }
}

export interface GalleryActions {
  readonly onOpenItem: (item: SpaceItem) => void;
  readonly onPlace: (place: GalleryPlace) => void;
}

export interface GalleryData extends GalleryActions {
  readonly tree: GalleryTree;
  /** Every live item, folders' contents included. */
  readonly items: readonly SpaceItem[];
  readonly folderByKey: ReadonlyMap<string, GalleryFolder>;
  readonly folderOf: (item: SpaceItem) => GalleryFolder | null;
  readonly noteMarkdown: (item: SpaceItem) => string | null;
  readonly imageSrc: (item: SpaceItem) => string | null;
  readonly tagsOf: (item: SpaceItem) => readonly string[];
  readonly textOf: (item: SpaceItem) => string;
  readonly collections: readonly GalleryCollection[];
  readonly loading: boolean;
}

const GalleryContext = createContext<GalleryData | null>(null);

/** The gallery data when a provider is above, else null (cards drawn on their own). */
export function useOptionalGallery(): GalleryData | null {
  return useContext(GalleryContext);
}

export function useGallery(): GalleryData {
  const value = useContext(GalleryContext);
  if (!value) throw new Error("useGallery outside GalleryProvider");
  return value;
}

/** Notes read for cards and search; past this the rest load when opened. */
const NOTE_READ_LIMIT = 48;
const EMPTY_TAGS: readonly string[] = [];
const LOCAL_IMAGE_GRANT_STALE_MS = 10 * 60_000;

function combineNoteContents(
  results: readonly { readonly data?: PagesReadResult | undefined }[],
): (string | null)[] {
  return results.map((result) => result.data?.content ?? null);
}

export function GalleryProvider(
  props: GalleryActions & {
    readonly account: string;
    readonly scopeSpaceId: SpaceId | null;
    readonly items: readonly SpaceItem[];
    readonly spaces: readonly PageSpace[];
    readonly libraryFolders: readonly LibraryFolder[];
    readonly loading: boolean;
    readonly children: ReactNode;
  },
) {
  const { account, scopeSpaceId } = props;
  const folderAssignments = useGalleryLocalStore((state) => state.folderAssignments);
  const tree = useMemo(
    () =>
      buildGalleryTree({
        items: props.items,
        spaces: props.spaces,
        libraryFolders: props.libraryFolders,
        folderAssignments,
      }),
    [props.items, props.spaces, props.libraryFolders, folderAssignments],
  );
  const items = useMemo(
    () => [...tree.loose, ...tree.folders.flatMap((folder) => folder.items)],
    [tree],
  );
  const notes = useMemo(
    () =>
      items
        .filter((item) => galleryClassOf(item) === "note" && item.source.type === "page")
        .slice(0, NOTE_READ_LIMIT),
    [items],
  );
  const noteQueries = useMemo(
    () =>
      notes.map((item) => {
        const pageId = (item.source as { page: { id: PageId } }).page.id;
        return {
          queryKey: pagesQueryKeys.read(account, scopeSpaceId, pageId),
          queryFn: (): Promise<PagesReadResult> =>
            ensureNativeApi().pages.read({ scopeSpaceId, pageId }),
          staleTime: 30_000,
        };
      }),
    [notes, account, scopeSpaceId],
  );
  // `combine` output is structurally shared, so this array only changes when a note does.
  const contents = useQueries({
    queries: noteQueries,
    combine: combineNoteContents,
  });
  const markdownByKey = useMemo(() => {
    const map = new Map<string, string>();
    notes.forEach((item, index) => {
      const content = contents[index];
      if (typeof content === "string") map.set(item.key, content);
    });
    return map;
  }, [notes, contents]);
  const imageSrc = useCallback(
    (item: SpaceItem): string | null => resolveGalleryImageSrc(item),
    [],
  );
  const localTags = useGalleryLocalStore((state) => state.tags);
  const collections = useGalleryLocalStore((state) => state.collections);
  const folderByKey = useMemo(
    () => new Map(tree.folders.map((folder) => [folder.key, folder] as const)),
    [tree],
  );
  const folderOfKey = useMemo(() => {
    const map = new Map<string, GalleryFolder>();
    for (const folder of tree.folders) for (const item of folder.items) map.set(item.key, folder);
    return map;
  }, [tree]);
  const tagsOf = useCallback(
    (item: SpaceItem): readonly string[] => {
      const own = localTags[item.key] ?? EMPTY_TAGS;
      const markdown = markdownByKey.get(item.key);
      const written = markdown ? noteHashtags(markdown) : [];
      return [...new Set([...own.map(normalizeTag), ...written])];
    },
    [localTags, markdownByKey],
  );
  const textOf = useCallback(
    (item: SpaceItem): string => {
      const markdown = markdownByKey.get(item.key);
      return markdown ? notePlainText(markdown) : "";
    },
    [markdownByKey],
  );
  const value = useMemo<GalleryData>(
    () => ({
      tree,
      items,
      folderByKey,
      folderOf: (item) => folderOfKey.get(item.key) ?? null,
      noteMarkdown: (item) => markdownByKey.get(item.key) ?? null,
      imageSrc,
      tagsOf,
      textOf,
      collections,
      loading: props.loading,
      onOpenItem: props.onOpenItem,
      onPlace: props.onPlace,
    }),
    [
      tree,
      items,
      folderByKey,
      folderOfKey,
      markdownByKey,
      imageSrc,
      tagsOf,
      textOf,
      collections,
      props.loading,
      props.onOpenItem,
      props.onPlace,
    ],
  );
  return <GalleryContext.Provider value={value}>{props.children}</GalleryContext.Provider>;
}

// ---------------------------------------------------------------------------------------------
// Pictures

/** Where a picture loads from, or null when it has no local bytes to show (or grant pending). */
export function resolveGalleryImageSrc(
  item: SpaceItem,
  grantByPath?: ReadonlyMap<string, string>,
): string | null {
  if (item.source.type === "library") {
    const entry = item.source.item;
    const media = spaceMossMediaPath(entry);
    if (!entry.path && media) return resolveWsHttpUrl(media);
    if (entry.path) {
      if (hasLocalImageUrlResolver()) {
        return buildLocalImageUrl({ src: entry.path, cwd: undefined });
      }
      const grant = grantByPath?.get(entry.path);
      if (grant) {
        return buildLocalImageUrl({ src: entry.path, cwd: undefined, grant });
      }
      if (typeof ensureNativeApi().projects?.createLocalFilePreviewGrant === "function") {
        return null;
      }
      return buildLocalImageUrl({ src: entry.path, cwd: undefined });
    }
    return entry.previewPath
      ? buildLocalImageUrl({ src: entry.previewPath, cwd: undefined })
      : null;
  }
  if (item.source.type === "output" && item.kind === "image") {
    return buildLocalImageUrl({
      src: item.source.output.path,
      cwd: item.source.output.workspaceRoot ?? undefined,
    });
  }
  return null;
}

export function galleryImageSrc(item: SpaceItem): string | null {
  return resolveGalleryImageSrc(item);
}

export interface GalleryImageOptions {
  /** Only request a local preview grant when the caller can actually display the image. */
  readonly enabled?: boolean;
  /** Keep refreshing the preview grant periodically (used by the full-size viewer). */
  readonly keepAlive?: boolean;
}

export interface GalleryImageSourceState {
  readonly src: string | null;
  readonly refreshGrant: () => void;
}

/** Lazily resolves an image's preview URL per-card and provides a single-shot retry helper. */
export function useGalleryImageSource(
  item: SpaceItem,
  options?: GalleryImageOptions,
): GalleryImageSourceState {
  const gallery = useOptionalGallery();
  const entry = item.source.type === "library" ? item.source.item : null;
  const grantPath =
    entry?.path &&
    item.kind === "image" &&
    !spaceMossMediaPath(entry) &&
    !hasLocalImageUrlResolver() &&
    typeof ensureNativeApi().projects?.createLocalFilePreviewGrant === "function"
      ? entry.path
      : null;
  const baseOptions = projectLocalPreviewGrantQueryOptions({
    path: grantPath,
    enabled: (options?.enabled ?? true) && grantPath !== null,
    staleTime: options?.keepAlive ? 60_000 : LOCAL_IMAGE_GRANT_STALE_MS,
  });
  const grantQuery = useQuery({
    ...baseOptions,
    ...(options?.keepAlive ? {} : { refetchInterval: false as const }),
  });
  const grantMap = useMemo(() => {
    if (!grantPath || !grantQuery.data?.grant) return undefined;
    return new Map([[grantPath, grantQuery.data.grant]]);
  }, [grantPath, grantQuery.data?.grant]);
  const src = useMemo(() => {
    if (grantPath) {
      return resolveGalleryImageSrc(item, grantMap);
    }
    return gallery ? gallery.imageSrc(item) : resolveGalleryImageSrc(item);
  }, [gallery, grantMap, grantPath, item]);
  const { refetch } = grantQuery;
  const refreshGrant = useCallback(() => {
    if (grantPath) {
      void refetch();
    }
  }, [grantPath, refetch]);
  return { src, refreshGrant };
}

/** Picture URL with per-item lazy preview grant resolution. */
export function useGalleryImageSrc(item: SpaceItem, options?: GalleryImageOptions): string | null {
  return useGalleryImageSource(item, options).src;
}

/** Note images: absolute and data addresses load as they are, app paths through the server. */
export function galleryNoteImageSrc(src: string): string | null {
  if (/^(https?:|data:|blob:)/u.test(src)) return src;
  if (src.startsWith("/api/")) return resolveWsHttpUrl(src);
  return null;
}

interface AspectState {
  readonly aspects: Readonly<Record<string, number>>;
  readonly setAspect: (key: string, aspect: number) => void;
}

/** Width / height of every picture once it has loaded, so cards and the canvas keep shape. */
export const useGalleryAspects = create<AspectState>((set, get) => ({
  aspects: {},
  setAspect: (key, aspect) => {
    if (!Number.isFinite(aspect) || aspect <= 0 || get().aspects[key] === aspect) return;
    set({ aspects: { ...get().aspects, [key]: aspect } });
  },
}));

/** Same gallery, other actions: the search dialog closes itself when something is opened. */
export function GalleryActionsOverride(props: {
  readonly onOpenItem: (item: SpaceItem) => void;
  readonly onPlace: (place: GalleryPlace) => void;
  readonly children: ReactNode;
}) {
  const parent = useGallery();
  const value = useMemo(
    () => ({ ...parent, onOpenItem: props.onOpenItem, onPlace: props.onPlace }),
    [parent, props.onOpenItem, props.onPlace],
  );
  return <GalleryContext.Provider value={value}>{props.children}</GalleryContext.Provider>;
}
