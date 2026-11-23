import Mime from "@effect/platform-node/Mime";
import type { FileSystem } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export type LocalPreviewByteRange =
  | { readonly kind: "full" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "partial"; readonly offset: number; readonly length: number };

const STREAM_CHUNK_SIZE_BYTES = 64 * 1024;

/** Single byte ranges used by browser media/PDF readers (RFC 9110 section 14). */
export function resolveLocalPreviewByteRange(
  value: string | undefined,
  sizeBytes: number,
): LocalPreviewByteRange {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return { kind: "unsatisfiable" };
  }
  if (value === undefined || !/^bytes=/iu.test(value.trim())) return { kind: "full" };
  const range = value.trim().slice("bytes=".length).trim();
  // A server may ignore multi-range requests and serve the full representation
  // instead of emitting a misleading single-part 206 response, while rejecting
  // malformed range syntax with 416.
  if (range.includes(",")) {
    const parts = range.split(",").map((part) => part.trim());
    const validMultipartSyntax =
      parts.length > 0 && parts.every((part) => /^\d*-\d*$/u.test(part) && part !== "-");
    return validMultipartSyntax ? { kind: "full" } : { kind: "unsatisfiable" };
  }
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

function formatContentRange(offset: number, length: number, sizeBytes: number): string {
  return `bytes ${offset}-${offset + length - 1}/${sizeBytes}`;
}

function stripEntitySpecificHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "content-length" ||
      lower === "content-type" ||
      lower === "content-range" ||
      lower === "content-disposition"
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function readRangeHeader(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const raw = request.headers.range;
  return typeof raw === "string" ? raw : undefined;
}

function unsatisfiableRangeResponse(
  sizeBytes: number,
  headers: Readonly<Record<string, string>> | undefined,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.empty({
    status: 416,
    headers: {
      ...stripEntitySpecificHeaders(headers),
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${sizeBytes}`,
      "Content-Length": "0",
    },
  });
}

export function streamedFileResponseWithRange(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly sizeBytes: number;
  readonly contentType?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
}): HttpServerResponse.HttpServerResponse {
  const contentType = input.contentType ?? Mime.getType(input.path) ?? "application/octet-stream";
  const baseHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "Accept-Ranges": "bytes",
  };
  const range = resolveLocalPreviewByteRange(readRangeHeader(input.request), input.sizeBytes);

  if (range.kind === "unsatisfiable") {
    return unsatisfiableRangeResponse(input.sizeBytes, baseHeaders);
  }

  if (input.request.method === "HEAD") {
    if (range.kind === "partial") {
      return HttpServerResponse.empty({
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Type": contentType,
          "Content-Range": formatContentRange(range.offset, range.length, input.sizeBytes),
          "Content-Length": String(range.length),
        },
      });
    }
    return HttpServerResponse.empty({
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": contentType,
        "Content-Length": String(input.sizeBytes),
      },
    });
  }

  if (range.kind === "partial") {
    const contentRange = formatContentRange(range.offset, range.length, input.sizeBytes);
    return HttpServerResponse.stream(
      input.fileSystem.stream(input.path, {
        offset: range.offset,
        bytesToRead: range.length,
        chunkSize: STREAM_CHUNK_SIZE_BYTES,
      }),
      {
        status: 206,
        contentType,
        contentLength: range.length,
        headers: {
          ...baseHeaders,
          "Content-Range": contentRange,
          "Content-Length": String(range.length),
        },
      },
    );
  }

  return HttpServerResponse.stream(
    input.fileSystem.stream(input.path, {
      chunkSize: STREAM_CHUNK_SIZE_BYTES,
    }),
    {
      status: 200,
      contentType,
      contentLength: input.sizeBytes,
      headers: {
        ...baseHeaders,
        ...(input.sizeBytes === 0 ? { "Content-Length": "0" } : {}),
      },
    },
  );
}

export function rangedBufferResponse(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly bytes: Uint8Array;
  readonly contentType?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
}): HttpServerResponse.HttpServerResponse {
  const sizeBytes = input.bytes.byteLength;
  const contentType = input.contentType ?? "application/octet-stream";
  const baseHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "Accept-Ranges": "bytes",
  };
  const range = resolveLocalPreviewByteRange(readRangeHeader(input.request), sizeBytes);

  if (range.kind === "unsatisfiable") {
    return unsatisfiableRangeResponse(sizeBytes, baseHeaders);
  }

  if (input.request.method === "HEAD") {
    if (range.kind === "partial") {
      return HttpServerResponse.empty({
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Type": contentType,
          "Content-Range": formatContentRange(range.offset, range.length, sizeBytes),
          "Content-Length": String(range.length),
        },
      });
    }
    return HttpServerResponse.empty({
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": contentType,
        "Content-Length": String(sizeBytes),
      },
    });
  }

  if (range.kind === "partial") {
    const slice = input.bytes.subarray(range.offset, range.offset + range.length);
    return HttpServerResponse.uint8Array(slice, {
      status: 206,
      contentType,
      headers: {
        ...baseHeaders,
        "Content-Range": formatContentRange(range.offset, range.length, sizeBytes),
        "Content-Length": String(range.length),
      },
    });
  }

  return HttpServerResponse.uint8Array(input.bytes, {
    status: 200,
    contentType,
    headers: {
      ...baseHeaders,
      ...(sizeBytes === 0 ? { "Content-Length": "0" } : {}),
    },
  });
}
