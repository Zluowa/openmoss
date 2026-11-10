export const MOSS_CANVAS_IMAGE_ASSET =
  /^moss-canvas-asset:([a-f0-9]{64}\.(?:png|jpg|webp|gif|avif))$/u;
const MOSS_CANVAS_SHAPE_ID = /^shape:[A-Za-z0-9_.:-]{1,194}$/u;

export interface MossCanvasSelectionItem {
  readonly shapeId: string;
  readonly assetId: string;
  readonly title: string;
}

/** A selected non-image shape (text, note, labelled shape, text card) and its plain text. */
export interface MossCanvasSelectionContent {
  readonly shapeId: string;
  readonly kind: string;
  readonly text?: string;
}

export interface MossCanvasSelection {
  readonly type: "moss-canvas-selection";
  readonly version: 1;
  readonly threadId: string;
  readonly sequence: number;
  readonly documentEpoch: number;
  /** Selected generated/owned images. */
  readonly items: readonly MossCanvasSelectionItem[];
  /** Everything else selected, with its text. Older Canvas builds send none. */
  readonly content: readonly MossCanvasSelectionContent[];
}

const CONTENT_KIND = /^[a-z][a-z0-9-]{0,39}$/u;
const CONTENT_KIND_LABELS: Readonly<Record<string, string>> = {
  text: "文字",
  note: "便签",
  geo: "图形",
  arrow: "箭头",
  line: "线条",
  draw: "手绘",
  highlight: "高亮",
  frame: "框架",
  card: "卡片",
};

/**
 * The composer chip for the selected text and shapes: plain lines the agent
 * reads as context. Null when nothing but images (or nothing) is selected.
 */
export function formatMossCanvasSelectionContext(
  content: readonly MossCanvasSelectionContent[],
): string | null {
  if (!content.length) return null;
  const lines = content.map((item) => {
    const label = CONTENT_KIND_LABELS[item.kind] ?? "形状";
    return item.text ? `- ${label}：${item.text.replace(/\s+/gu, " ")}` : `- ${label}（无文字）`;
  });
  return ["画布上选中的内容", ...lines].join("\n");
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
  const content: MossCanvasSelectionContent[] = [];
  if (data.content !== undefined) {
    if (!Array.isArray(data.content) || data.content.length > 32) return null;
    let textLength = 0;
    for (const entry of data.content) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.shapeId !== "string" ||
        !MOSS_CANVAS_SHAPE_ID.test(entry.shapeId) ||
        typeof entry.kind !== "string" ||
        !CONTENT_KIND.test(entry.kind) ||
        (entry.text !== undefined && !contextText(entry.text))
      )
        return null;
      if (typeof entry.text === "string") textLength += entry.text.length;
      if (textLength > 8000) return null;
      content.push(
        typeof entry.text === "string"
          ? { shapeId: entry.shapeId, kind: entry.kind, text: entry.text }
          : { shapeId: entry.shapeId, kind: entry.kind },
      );
    }
  }
  return {
    type: "moss-canvas-selection",
    version: 1,
    threadId,
    sequence: data.sequence as number,
    documentEpoch: data.documentEpoch as number,
    items,
    content,
  };
}
