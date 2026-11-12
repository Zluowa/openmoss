// Shared typed image lifecycle grouping; failed records never become pending.
import type { TurnId } from "@moss/contracts";
import { isMossConversationImageSource, localImageFileName } from "../../lib/localImageUrls";
import type { TimelineEntry, WorkLogEntry, WorkLogGeneratedImage } from "../../workLog";

export interface GeneratedImageGalleryImage {
  id: string;
  path: string;
  callId?: string;
  /** A Moss video, drawn as a player. */
  media?: "video";
}

export interface GeneratedImageGallery {
  turnId: TurnId | null;
  createdAt: string;
  images: GeneratedImageGalleryImage[];
  pendingImageCount: number;
  /** Requested width / height of the first pending image, when the request named one. */
  pendingAspectRatio?: number;
  /** The first pending item is a Moss video (it takes minutes, and says so). */
  pendingMedia?: "video";
  /** Moss jobs still pending, which a reopened chat asks Moss about. */
  pendingJobIds?: readonly string[];
}

function generatedImageGalleriesEqual(
  previous: GeneratedImageGallery,
  next: GeneratedImageGallery,
): boolean {
  if (
    previous.turnId !== next.turnId ||
    previous.createdAt !== next.createdAt ||
    previous.pendingImageCount !== next.pendingImageCount ||
    previous.pendingAspectRatio !== next.pendingAspectRatio ||
    previous.pendingMedia !== next.pendingMedia ||
    (previous.pendingJobIds ?? []).join() !== (next.pendingJobIds ?? []).join() ||
    previous.images.length !== next.images.length
  ) {
    return false;
  }
  return previous.images.every((image, index) => {
    const nextImage = next.images[index];
    return (
      nextImage !== undefined &&
      image.id === nextImage.id &&
      image.path === nextImage.path &&
      image.callId === nextImage.callId &&
      image.media === nextImage.media
    );
  });
}

/** Content equality for maps rebuilt from immutable transcript entries. */
export function generatedImageGalleryMapsEqual(
  previous: ReadonlyMap<string, GeneratedImageGallery>,
  next: ReadonlyMap<string, GeneratedImageGallery>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, gallery] of next) {
    const previousGallery = previous.get(key);
    if (!previousGallery || !generatedImageGalleriesEqual(previousGallery, gallery)) return false;
  }
  return true;
}

type MutableGeneratedImageGallery = {
  turnId: TurnId | null;
  createdAt: string;
  images: Map<string, GeneratedImageGalleryImage>;
  pendingIds: Set<string>;
  failedIds: Set<string>;
  pendingAspectRatios: Map<string, number>;
  pendingVideos: Set<string>;
  pendingJobIds: Map<string, string>;
};

export function generatedImageTurnKey(turnId: TurnId | string | null | undefined): string | null {
  return turnId === null || turnId === undefined ? null : String(turnId);
}

function generatedImageIdentity(entry: WorkLogEntry, image: WorkLogGeneratedImage): string {
  return image.callId ?? entry.toolCallId ?? entry.id;
}

export function generatedImageGalleryKey(entry: WorkLogEntry): string {
  const turnKey = generatedImageTurnKey(entry.turnId);
  // Without a turn id there is no safe boundary shared by separate activities.
  // Keep each activity's stable item id as its own gallery key even when a
  // provider reuses a call id across turnless replay records.
  return turnKey ?? `__turnless:${entry.id}`;
}

function generatedImageEntriesFromTimelineEntry(entry: TimelineEntry): ReadonlyArray<WorkLogEntry> {
  if (entry.kind !== "work") return [];
  return entry.entry.itemType === "image_generation" && entry.entry.generatedImage
    ? [entry.entry]
    : [];
}

export function isTypedGeneratedImageEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "image_generation" &&
    entry.generatedImage != null &&
    entry.generatedImage.state !== "failed"
  );
}

/**
 * Groups the typed image lifecycle records by provider turn. A completion
 * replaces its pending identity, while distinct calls remain distinct even if
 * their labels and paths happen to match.
 */
export function groupGeneratedImagesByTurn(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): Map<string, GeneratedImageGallery> {
  const groups = new Map<string, MutableGeneratedImageGallery>();
  for (const timelineEntry of timelineEntries) {
    for (const entry of generatedImageEntriesFromTimelineEntry(timelineEntry)) {
      const image = entry.generatedImage;
      if (!image) continue;
      const key = generatedImageGalleryKey(entry);
      const group =
        groups.get(key) ??
        (() => {
          const created: MutableGeneratedImageGallery = {
            turnId: entry.turnId ?? null,
            createdAt: timelineEntry.createdAt,
            images: new Map(),
            pendingIds: new Set(),
            failedIds: new Set(),
            pendingAspectRatios: new Map(),
            pendingVideos: new Set(),
            pendingJobIds: new Map(),
          };
          groups.set(key, created);
          return created;
        })();
      const identity = generatedImageIdentity(entry, image);
      if (image.state === "failed") {
        group.pendingIds.delete(identity);
        group.failedIds.add(identity);
        continue;
      }
      if (image.state === "completed") {
        group.images.set(identity, {
          id: identity,
          path: image.path,
          ...(image.callId ? { callId: image.callId } : {}),
          ...(image.media ? { media: image.media } : {}),
        });
        group.pendingIds.delete(identity);
        group.failedIds.delete(identity);
      } else if (!group.images.has(identity) && !group.failedIds.has(identity)) {
        group.pendingIds.add(identity);
        if (image.aspectRatio !== undefined)
          group.pendingAspectRatios.set(identity, image.aspectRatio);
        if (image.media === "video") group.pendingVideos.add(identity);
        if (image.jobId) group.pendingJobIds.set(identity, image.jobId);
      }
    }
  }

  return new Map(
    [...groups].flatMap(([key, group]) => {
      if (group.images.size === 0 && group.pendingIds.size === 0) return [];
      const firstPending = group.pendingIds.values().next().value;
      const pendingAspectRatio =
        firstPending === undefined ? undefined : group.pendingAspectRatios.get(firstPending);
      const pendingJobIds = [...group.pendingIds].flatMap((id) => {
        const jobId = group.pendingJobIds.get(id);
        return jobId ? [jobId] : [];
      });
      return [
        [
          key,
          {
            turnId: group.turnId,
            createdAt: group.createdAt,
            images: [...group.images.values()],
            pendingImageCount: group.pendingIds.size,
            ...(pendingAspectRatio !== undefined ? { pendingAspectRatio } : {}),
            ...(firstPending !== undefined && group.pendingVideos.has(firstPending)
              ? { pendingMedia: "video" as const }
              : {}),
            ...(pendingJobIds.length ? { pendingJobIds } : {}),
          },
        ] as const,
      ];
    }),
  );
}

export function omitGeneratedImageWorkEntries(
  entries: ReadonlyArray<WorkLogEntry>,
): WorkLogEntry[] {
  return entries.filter((entry) => !isTypedGeneratedImageEntry(entry));
}

/**
 * Removes only the exact server compatibility markdown for paths represented
 * by this turn's typed generated-image gallery. Unrelated markdown images and
 * ordinary text remain untouched.
 */
export function suppressGeneratedImageCompatibilityMarkdown(
  text: string,
  gallery: GeneratedImageGallery | null | undefined,
): string {
  if (!gallery || gallery.images.length === 0 || text.length === 0) return text;
  let result = text;
  for (const image of gallery.images) {
    result = result.replaceAll(generatedImageCompatibilityMarkdown(image.path), "");
  }
  return result;
}

function generatedImageCompatibilityMarkdown(path: string): string {
  const trimmed = path.trim();
  const markdownPath = encodeMarkdownCompatibilityPath(trimmed);
  return `![Generated image](${markdownPath})`;
}

function encodeMarkdownCompatibilityPath(path: string): string {
  return path.includes(")") || path.includes(" ") || path.includes("%")
    ? `<${path.replaceAll("%", "%25").replaceAll(">", "%3E").replaceAll(")", "%29")}>`
    : path;
}

export function hasGeneratedImageGalleryContent(
  gallery: GeneratedImageGallery | null | undefined,
): boolean {
  return Boolean(gallery && (gallery.images.length > 0 || gallery.pendingImageCount > 0));
}

/**
 * The name a generated image carries into the Canvas and the viewer: "图片 12:44",
 * numbered when one turn made several. Its address ("0?accountScope=…") is not
 * a name. Null when the turn has no usable time.
 */
export function generatedImageTimedName(input: {
  readonly createdAt: string | null | undefined;
  readonly index: number;
  readonly count: number;
  readonly locale: string;
  readonly format: (time: string) => string;
}): string | null {
  const at = input.createdAt ? new Date(input.createdAt) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  const time = new Intl.DateTimeFormat(input.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const name = input.format(time);
  return input.count > 1 ? `${name} (${input.index + 1})` : name;
}

/**
 * The name a generated image carries into the Canvas and the viewer. A real
 * file keeps its file name; a Moss media address ("0?accountScope=…") is not a
 * name, so that image is named by its turn's time ("图片 12:44").
 */
export function generatedImageDisplayName(input: {
  readonly path: string;
  readonly createdAt: string | null | undefined;
  readonly index: number;
  readonly count: number;
  readonly locale: string;
  readonly format: (time: string) => string;
  readonly fallback: string;
}): string {
  const fileName = isMossConversationImageSource(input.path) ? "" : localImageFileName(input.path);
  if (fileName && !/[?#=]/u.test(fileName)) return fileName;
  return generatedImageTimedName(input) ?? (localImageFileName(input.path) || input.fallback);
}
