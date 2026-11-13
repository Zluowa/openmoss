// FILE: libraryUpload.ts
// Purpose: Puts picked files into the owner's 资料库 as raw bytes over HTTP
//          (`POST /api/library/import`, one file per request).
// Layer: Web utility
// Exports: uploadLibraryFiles, uploadPickedLibraryFiles, LibraryUploadFile
//
// `library.import` sends base64 through the WebSocket, whose 2 MiB message cap stops files of
// about 1.5 MB. Every 资料库 uploader of picked or dropped files goes through here instead.

import { LIBRARY_IMPORT_FILE_MAX_BYTES, LibraryImportResult } from "@moss/contracts";
import { LIBRARY_IMPORT_ROUTE_PATH } from "@moss/shared/binaryTransfer";
import { Schema } from "effect";

import { resolveWsHttpUrl } from "./wsHttpUrl";

export interface LibraryUploadFile {
  readonly name: string;
  readonly mimeType?: string;
  readonly data: Blob;
}

const decodeResult = Schema.decodeUnknownSync(LibraryImportResult);

/** Uploads the files one after another; the counts and items add up across them. */
export async function uploadLibraryFiles(
  files: readonly LibraryUploadFile[],
): Promise<LibraryImportResult> {
  const items: LibraryImportResult["items"][number][] = [];
  let imported = 0;
  let skipped = 0;
  for (const file of files) {
    const params = new URLSearchParams({ name: file.name });
    if (file.mimeType) params.set("mimeType", file.mimeType);
    const response = await fetch(
      resolveWsHttpUrl(`${LIBRARY_IMPORT_ROUTE_PATH}?${params.toString()}`),
      { method: "POST", credentials: "include", body: file.data },
    );
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason =
        answer &&
        typeof answer === "object" &&
        typeof (answer as { error?: unknown }).error === "string"
          ? (answer as { error: string }).error
          : null;
      throw new Error(reason ?? `“${file.name}”没有放进资料库（${response.status}）。`);
    }
    const result = decodeResult(answer);
    items.push(...result.items);
    imported += result.imported;
    skipped += result.skipped;
  }
  return { items, imported, skipped };
}

/**
 * Files a person picked or dropped: refused whole when one is over the 资料库 limit (64 MB),
 * otherwise uploaded as they are.
 */
export async function uploadPickedLibraryFiles(
  picked: readonly File[],
): Promise<LibraryImportResult> {
  const tooLarge = picked.find((file) => file.size > LIBRARY_IMPORT_FILE_MAX_BYTES);
  if (tooLarge)
    throw new Error(`“${tooLarge.name}”超过 ${LIBRARY_IMPORT_FILE_MAX_BYTES / 1024 / 1024} MB。`);
  return uploadLibraryFiles(
    picked.map((file) => ({
      name: file.name,
      data: file,
      ...(file.type ? { mimeType: file.type } : {}),
    })),
  );
}
