// FILE: devsReportAttachments.ts
// Purpose: Turns the composer's images and files into what a developer report may carry:
//          images re-encoded (which drops camera and location metadata) and small text files.
// Layer: Web UI helpers

import type { DevsReportAttachmentInput } from "@moss/contracts";
import { DEVS_ATTACHMENT_LIMITS } from "@moss/shared/devsReport";

export interface DevsAttachmentSource {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly file: Blob;
}
export type DevsAttachmentSkipReason = "type" | "size" | "count" | "unreadable";
export interface PreparedDevsAttachments {
  readonly attachments: DevsReportAttachmentInput[];
  /** Data URLs of the re-encoded images, in attachment order, for the confirmation. */
  readonly imagePreviews: string[];
  readonly skipped: { name: string; reason: DevsAttachmentSkipReason }[];
  /** Composer attachment IDs that will be sent, removed from the composer once it is. */
  readonly sentIds: string[];
}

const TEXT_EXTENSIONS =
  /\.(?:txt|log|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|bat|sql|diff|patch)$/i;
const isText = (source: DevsAttachmentSource) =>
  source.mimeType.startsWith("text/") ||
  /^application\/(?:json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript)$/.test(source.mimeType) ||
  TEXT_EXTENSIONS.test(source.name);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Re-encodes an image to WebP within the size limit, shrinking it until it fits. Also used by
 * the 分享反馈 dialog, whose images reach the same developer queue.
 */
export async function encodeDevsReportImage(file: Blob): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height, 1);
    for (const shrink of [1, 0.75, 0.5, 0.35]) {
      const scale = Math.min(1, DEVS_ATTACHMENT_LIMITS.imageEdge / longest) * shrink;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.86, 0.72, 0.58]) {
        const blob = await canvas.convertToBlob({ type: "image/webp", quality });
        if (blob.type !== "image/webp") return null;
        if (blob.size <= DEVS_ATTACHMENT_LIMITS.imageBytes)
          return new Uint8Array(await blob.arrayBuffer());
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * Prepares the composer's attachments for a report. Only images and small text files can be
 * sent; anything else is listed as skipped so the confirmation can say so.
 */
export async function prepareDevsReportAttachments(
  images: readonly DevsAttachmentSource[],
  files: readonly DevsAttachmentSource[],
): Promise<PreparedDevsAttachments> {
  const attachments: DevsReportAttachmentInput[] = [];
  const imagePreviews: string[] = [];
  const skipped: PreparedDevsAttachments["skipped"] = [];
  const sentIds: string[] = [];
  let total = 0;
  const candidates = [
    ...images.map((source) => ({ source, image: true })),
    ...files.map((source) => ({ source, image: source.mimeType.startsWith("image/") })),
  ];
  for (const { source, image } of candidates) {
    if (attachments.length >= DEVS_ATTACHMENT_LIMITS.maxCount) {
      skipped.push({ name: source.name, reason: "count" });
      continue;
    }
    if (!image && !isText(source)) {
      skipped.push({ name: source.name, reason: "type" });
      continue;
    }
    try {
      if (image) {
        const bytes = await encodeDevsReportImage(source.file);
        if (!bytes || total + bytes.length > DEVS_ATTACHMENT_LIMITS.totalBytes) {
          skipped.push({ name: source.name, reason: "size" });
          continue;
        }
        const dataBase64 = bytesToBase64(bytes);
        attachments.push({ name: source.name, kind: "image", mimeType: "image/webp", dataBase64 });
        imagePreviews.push(`data:image/webp;base64,${dataBase64}`);
        total += bytes.length;
      } else {
        if (source.sizeBytes > DEVS_ATTACHMENT_LIMITS.textBytes) {
          skipped.push({ name: source.name, reason: "size" });
          continue;
        }
        const bytes = new TextEncoder().encode(
          new TextDecoder("utf-8", { fatal: true }).decode(await source.file.arrayBuffer()),
        );
        if (bytes.includes(0)) {
          skipped.push({ name: source.name, reason: "type" });
          continue;
        }
        if (
          bytes.length > DEVS_ATTACHMENT_LIMITS.textBytes ||
          total + bytes.length > DEVS_ATTACHMENT_LIMITS.totalBytes
        ) {
          skipped.push({ name: source.name, reason: "size" });
          continue;
        }
        attachments.push({
          name: source.name,
          kind: "text",
          mimeType: "text/plain",
          dataBase64: bytesToBase64(bytes),
        });
        total += bytes.length;
      }
      sentIds.push(source.id);
    } catch {
      skipped.push({ name: source.name, reason: "unreadable" });
    }
  }
  return { attachments, imagePreviews, skipped, sentIds };
}
