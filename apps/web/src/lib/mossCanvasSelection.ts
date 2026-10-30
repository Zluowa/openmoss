export const MOSS_CANVAS_IMAGE_ASSET =
  /^moss-canvas-asset:([a-f0-9]{64}\.(?:png|jpg|webp|gif|avif))$/u;
const MOSS_CANVAS_SHAPE_ID = /^shape:[A-Za-z0-9_.:-]{1,194}$/u;

export interface MossCanvasSelectionItem {
  readonly shapeId: string;
  readonly assetId: string;
  readonly title: string;
}

export interface MossCanvasSelection {
  readonly type: "moss-canvas-selection";
  readonly version: 1;
  readonly threadId: string;
  readonly sequence: number;
  readonly documentEpoch: number;
  readonly items: readonly MossCanvasSelectionItem[];
}

export interface MossCanvasContextRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MossCanvasContextAnnotation extends MossCanvasContextRegion {
  readonly kind: "draw" | "arrow" | "geo" | "text" | "line" | "highlight";
  readonly text?: string;
}

export interface MossCanvasComposeContextItem extends MossCanvasSelectionItem {
  readonly context?: {
    readonly annotations: readonly MossCanvasContextAnnotation[];
    readonly comments: readonly {
      readonly text: string;
      readonly region: MossCanvasContextRegion;
    }[];
    readonly annotationAssetId?: string;
    readonly truncated: boolean;
  };
}

export interface MossCanvasComposeContext {
  readonly type: "moss-canvas-compose-context-result";
  readonly version: 1;
  readonly threadId: string;
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly selectionSequence: number;
  readonly ok: true;
  readonly items: readonly MossCanvasComposeContextItem[];
}

function contextRegion(value: unknown): MossCanvasContextRegion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const region = value as Record<string, unknown>;
  const { x, y, width, height } = region;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(
      (coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1,
    ) ||
    x + width > 1 ||
    y + height > 1
  )
    return null;
  return { x, y, width, height };
}

const ANNOTATION_KINDS = new Set(["draw", "arrow", "geo", "text", "line", "highlight"]);
const contextText = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 500;

/** Accept only the bounded, owned context for a specific compose request. */
export function parseMossCanvasComposeContext(
  value: unknown,
  threadId: string,
): MossCanvasComposeContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.type !== "moss-canvas-compose-context-result" ||
    data.version !== 1 ||
    data.threadId !== threadId ||
    data.ok !== true ||
    typeof data.requestId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/u.test(data.requestId) ||
    !Number.isSafeInteger(data.selectionSequence) ||
    (data.selectionSequence as number) < 1 ||
    !Number.isSafeInteger(data.documentEpoch) ||
    (data.documentEpoch as number) < 1 ||
    !Array.isArray(data.items) ||
    data.items.length > 16
  )
    return null;
  // Reuse the live selection boundary rather than maintaining a second set of
  // shape/owned-asset/title validation rules for compose attachments.
  const selection = parseMossCanvasSelection(
    {
      type: "moss-canvas-selection",
      version: 1,
      threadId,
      sequence: data.selectionSequence,
      documentEpoch: data.documentEpoch,
      items: data.items,
    },
    threadId,
  );
  if (!selection) return null;
  let annotationsCount = 0;
  let commentsCount = 0;
  let textLength = 0;
  let attachmentsCount = data.items.length;
  const items: MossCanvasComposeContextItem[] = [];
  for (let index = 0; index < data.items.length; index += 1) {
    const item = selection.items[index]!;
    const raw = data.items[index] as Record<string, unknown>;
    if (raw.context === undefined) {
      items.push(item);
      continue;
    }
    if (!raw.context || typeof raw.context !== "object" || Array.isArray(raw.context)) return null;
    const context = raw.context as Record<string, unknown>;
    if (
      typeof context.truncated !== "boolean" ||
      !Array.isArray(context.annotations) ||
      context.annotations.length > 32 ||
      !Array.isArray(context.comments) ||
      context.comments.length > 16 ||
      (context.annotationAssetId !== undefined &&
        (typeof context.annotationAssetId !== "string" ||
          !MOSS_CANVAS_IMAGE_ASSET.test(context.annotationAssetId))) ||
      (context.annotations.length > 0 && context.annotationAssetId === undefined)
    )
      return null;
    const annotations: MossCanvasContextAnnotation[] = [];
    for (const annotation of context.annotations) {
      const region = contextRegion(annotation);
      if (
        !region ||
        typeof annotation.kind !== "string" ||
        !ANNOTATION_KINDS.has(annotation.kind) ||
        (annotation.text !== undefined && !contextText(annotation.text))
      )
        return null;
      if (annotation.text !== undefined) textLength += annotation.text.length;
      annotations.push({
        ...region,
        kind: annotation.kind as MossCanvasContextAnnotation["kind"],
        ...(annotation.text !== undefined ? { text: annotation.text as string } : {}),
      });
    }
    const comments: Array<{ readonly text: string; readonly region: MossCanvasContextRegion }> = [];
    for (const comment of context.comments) {
      if (
        !comment ||
        typeof comment !== "object" ||
        Array.isArray(comment) ||
        !contextText(comment.text)
      )
        return null;
      const region = contextRegion(comment.region);
      if (!region) return null;
      textLength += comment.text.length;
      comments.push({ text: comment.text, region });
    }
    annotationsCount += annotations.length;
    commentsCount += comments.length;
    if (context.annotationAssetId !== undefined) attachmentsCount += 1;
    if (annotationsCount > 64 || commentsCount > 32 || textLength > 8000 || attachmentsCount > 16)
      return null;
    items.push({
      ...item,
      context: {
        annotations,
        comments,
        truncated: context.truncated,
        ...(context.annotationAssetId !== undefined
          ? { annotationAssetId: context.annotationAssetId as string }
          : {}),
      },
    });
  }
  return {
    type: "moss-canvas-compose-context-result",
    version: 1,
    threadId,
    requestId: data.requestId,
    documentEpoch: data.documentEpoch as number,
    selectionSequence: data.selectionSequence as number,
    ok: true,
    items,
  };
}

/** The caller must additionally authenticate the frame source and origin. */
export function parseMossCanvasSelection(
  value: unknown,
  threadId: string,
): MossCanvasSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.type !== "moss-canvas-selection" ||
    data.version !== 1 ||
    data.threadId !== threadId ||
    !Number.isSafeInteger(data.sequence) ||
    (data.sequence as number) < 1 ||
    !Number.isSafeInteger(data.documentEpoch) ||
    (data.documentEpoch as number) < 1 ||
    !Array.isArray(data.items) ||
    data.items.length > 16
  )
    return null;
  const items: MossCanvasSelectionItem[] = [];
  for (const item of data.items) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.shapeId !== "string" ||
      !MOSS_CANVAS_SHAPE_ID.test(item.shapeId) ||
      typeof item.assetId !== "string" ||
      !MOSS_CANVAS_IMAGE_ASSET.test(item.assetId) ||
      typeof item.title !== "string" ||
      item.title.length > 200
    )
      return null;
    items.push({ shapeId: item.shapeId, assetId: item.assetId, title: item.title });
  }
  if (new Set(items.map((item) => item.shapeId)).size !== items.length) return null;
  return {
    type: "moss-canvas-selection",
    version: 1,
    threadId,
    sequence: data.sequence as number,
    documentEpoch: data.documentEpoch as number,
    items,
  };
}
