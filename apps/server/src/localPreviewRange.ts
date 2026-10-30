export type LocalPreviewByteRange =
  | { readonly kind: "full" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "partial"; readonly offset: number; readonly length: number };

/** Single byte ranges used by browser media/PDF readers (RFC 9110 section 14). */
export function resolveLocalPreviewByteRange(
  value: string | undefined,
  sizeBytes: number,
): LocalPreviewByteRange {
  if (value === undefined || !/^bytes=/iu.test(value.trim())) return { kind: "full" };
  const range = value.trim().slice("bytes=".length).trim();
  // A server may ignore Range. Use the full representation for multipart
  // requests instead of emitting a misleading single-part 206 response.
  if (range.includes(",")) return { kind: "full" };
  const match = /^(\d*)-(\d*)$/u.exec(range);
  if (!match || (!match[1] && !match[2]) || range.length > 128 || sizeBytes === 0) {
    return { kind: "unsatisfiable" };
  }
  const size = BigInt(sizeBytes);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n) return { kind: "unsatisfiable" };
    const length = Number(suffix > size ? size : suffix);
    return { kind: "partial", offset: sizeBytes - length, length };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : size - 1n;
  if (start >= size || start > end) return { kind: "unsatisfiable" };
  return {
    kind: "partial",
    offset: Number(start),
    length: Number((end < size ? end : size - 1n) - start + 1n),
  };
}

function toWellFormedFileName(fileName: string): string {
  const toWellFormed = (String.prototype as { toWellFormed?: (this: string) => string })
    .toWellFormed;
  return toWellFormed === undefined ? fileName : toWellFormed.call(fileName);
}

export function localPreviewDownloadDisposition(fileName: string): string {
  const name = toWellFormedFileName(fileName);
  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/gu, "_") || "download";
  const utf8Name = encodeURIComponent(name).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}
