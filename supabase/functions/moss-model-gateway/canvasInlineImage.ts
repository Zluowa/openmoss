// Bounded, transport-free decoder shared by local admission and promotion.
export type CanvasInlineImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export class CanvasInlineImageError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export function decodeCanvasInlineImage(value: unknown): {
  readonly mimeType: CanvasInlineImageMime;
  readonly bytes: Uint8Array<ArrayBuffer>;
} {
  if (typeof value !== "string" || value.length === 0 || value.length > 8 * 1024 * 1024)
    throw new CanvasInlineImageError("invalid_inline_image", 400);
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u);
  const mimeType = match?.[1] as CanvasInlineImageMime | undefined;
  const encoded = match?.[2] ?? "";
  if (!mimeType || !encoded || encoded.length % 4 !== 0)
    throw new CanvasInlineImageError("invalid_inline_image", 400);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > 5 * 1024 * 1024)
    throw new CanvasInlineImageError("inline_image_too_large", 413);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new CanvasInlineImageError("invalid_inline_image", 400);
  }
  if (binary.length !== decodedLength || btoa(binary) !== encoded)
    throw new CanvasInlineImageError("invalid_inline_image", 400);
  const bytes = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { mimeType, bytes };
}
