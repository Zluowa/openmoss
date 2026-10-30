// FILE: files.ts
// Purpose: Client-side checks for the files a guest attaches to one message.
// Layer: Guest page
// Why: The server enforces the same limits; checking first saves an upload over a slow mobile
//      link and lets the page say why before the guest taps send.

import {
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  type GuestAccessErrorReason,
} from "@synara/contracts";

/** The image types the owner's agent accepts; the server checks magic bytes too. */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type GuestFileProblem = Extract<
  GuestAccessErrorReason,
  "too_many_files" | "too_large" | "unsupported_file"
>;

export type FileLike = Pick<File, "type" | "size">;

export const isImageFile = (file: FileLike): boolean =>
  file.type.toLowerCase().startsWith("image/");

/**
 * Why these files cannot go with one message, as the matching server reason, or null. Reusing
 * the server's reasons means one localized string per problem.
 */
export function guestFilesProblem(files: ReadonlyArray<FileLike>): GuestFileProblem | null {
  if (files.length > GUEST_MESSAGE_MAX_ATTACHMENTS) return "too_many_files";
  let total = 0;
  for (const file of files) total += file.size;
  if (total > GUEST_MESSAGE_MAX_ATTACHMENT_BYTES) return "too_large";
  const unsupported = files.some(
    (file) =>
      file.size === 0 ||
      (isImageFile(file) && !SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase())),
  );
  return unsupported ? "unsupported_file" : null;
}

/** "1.2 MB" / "348 KB"; locale-neutral units, as the composer chips show them. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : Math.round(megabytes * 10) / 10} MB`;
}
