// Early input validation shared by the desktop bridge and workspace media tools.
// The gateway still validates image bytes before reserving or uploading anything.
const MAX_ENCODED_IMAGE_CHARS = 7 * 1024 * 1024;
const PNG_PREFIX = "data:image/png;base64,";
const EDIT_MODELS = new Set([
  "gpt-image-2-official",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
]);

function pngDimensions(value: unknown, mask: boolean): readonly [number, number] | null {
  if (typeof value !== "string" || !value.startsWith(PNG_PREFIX)) return null;
  const encoded = value.slice(PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length < 33 ||
    (mask && bytes.length >= 4 * 1024 * 1024) ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    (mask && ![4, 6].includes(bytes[25]!))
  )
    return null;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000
    ? [width, height]
    : null;
}

export function mediaImageEditInputError(input: {
  readonly modelId: unknown;
  readonly referenceImages?: unknown;
  readonly maskImage?: unknown;
  readonly background?: unknown;
  readonly outputFormat?: unknown;
}): "invalid_request" | "request_too_large" | "invalid_mask_image" | undefined {
  const references = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const { maskImage, background, outputFormat } = input;
  const encodedChars =
    references.reduce(
      (sum: number, item: unknown) => sum + (typeof item === "string" ? item.length : 0),
      0,
    ) + (typeof maskImage === "string" ? maskImage.length : 0);
  if (encodedChars > MAX_ENCODED_IMAGE_CHARS) return "request_too_large";
  if ([maskImage, background, outputFormat].every((value) => value === undefined)) return undefined;
  if (
    typeof input.modelId !== "string" ||
    !EDIT_MODELS.has(input.modelId) ||
    (background !== undefined &&
      (typeof background !== "string" ||
        !["auto", "opaque", "transparent"].includes(background))) ||
    (outputFormat !== undefined &&
      (typeof outputFormat !== "string" || !["png", "jpeg", "webp"].includes(outputFormat))) ||
    (background === "transparent" && outputFormat === "jpeg")
  )
    return "invalid_request";
  if (maskImage !== undefined) {
    const sourceSize = pngDimensions(references[0], false);
    const maskSize = pngDimensions(maskImage, true);
    if (!sourceSize || !maskSize || sourceSize[0] !== maskSize[0] || sourceSize[1] !== maskSize[1])
      return "invalid_mask_image";
  }
  return undefined;
}
