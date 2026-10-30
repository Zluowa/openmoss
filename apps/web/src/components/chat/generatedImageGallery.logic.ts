// Shared typed image lifecycle grouping; failed records never become pending.
import type { TurnId } from "@synara/contracts";
import type { TimelineEntry, WorkLogEntry, WorkLogGeneratedImage } from "../../workLog";

export interface GeneratedImageGalleryImage {
  id: string;
  path: string;
  callId?: string;
}

export interface GeneratedImageGallery {
  turnId: TurnId | null;
  createdAt: string;
  images: GeneratedImageGalleryImage[];
  pendingImageCount: number;
}

function generatedImageGalleriesEqual(
  previous: GeneratedImageGallery,
  next: GeneratedImageGallery,
): boolean {
  if (
    previous.turnId !== next.turnId ||
    previous.createdAt !== next.createdAt ||
    previous.pendingImageCount !== next.pendingImageCount ||
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
      image.callId === nextImage.callId
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
        });
        group.pendingIds.delete(identity);
        group.failedIds.delete(identity);
      } else if (!group.images.has(identity) && !group.failedIds.has(identity)) {
        group.pendingIds.add(identity);
      }
    }
  }

  return new Map(
    [...groups].flatMap(([key, group]) => {
      if (group.images.size === 0 && group.pendingIds.size === 0) return [];
      return [
        [
          key,
          {
            turnId: group.turnId,
            createdAt: group.createdAt,
            images: [...group.images.values()],
            pendingImageCount: group.pendingIds.size,
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
