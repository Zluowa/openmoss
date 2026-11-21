// FILE: avatarImage.ts
// Purpose: Compress a user-picked profile photo entirely on-device into a tiny, square
// data URL so it can be persisted in localStorage without consuming much space. No I/O
// leaves the device.
// Layer: web profile feature.

import {
  MOSS_PROFILE_AVATAR_MAX_BYTES,
  MOSS_PROFILE_AVATAR_MIME_TYPES,
  type MossProfileAvatarMimeType,
} from "@moss/contracts";

// Square output edge in CSS px. 160 covers the compact avatar at 2x; 256 covers the 96px
// Profile hero circle crisply on retina displays while staying well under the 1 MB limit.
const AVATAR_MAX_EDGE = 160;
const AVATAR_UPLOAD_EDGE = 256;
const AVATAR_QUALITY = 0.85;

// Hard cap on the encoded string so a pathological image can never blow the localStorage
// budget. Comfortable for a 160px square (~5–12 KB typical).
export const AVATAR_MAX_DATA_URL_LENGTH = 200_000;

export class AvatarImageError extends Error {}

export interface AvatarCropOptions {
  /** Zoom factor >= 1 (1 = fit shortest edge to circle). */
  readonly zoom?: number;
  /** Normalized pan offsets in [-0.5, 0.5] relative to the extra crop slack. */
  readonly offsetX?: number;
  readonly offsetY?: number;
}

export interface PreparedAvatarUpload {
  readonly mimeType: MossProfileAvatarMimeType;
  readonly dataBase64: string;
  readonly previewUrl: string;
  readonly byteLength: number;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new AvatarImageError("无法读取所选图片文件。"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AvatarImageError("所选文件不是有效的图片。"));
    img.src = src;
  });
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function parseDataUrl(
  dataUrl: string,
): { readonly mimeType: MossProfileAvatarMimeType; readonly dataBase64: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return {
    mimeType: match[1] as MossProfileAvatarMimeType,
    dataBase64: match[2],
  };
}

export function isSupportedAvatarMimeType(type: string): type is MossProfileAvatarMimeType {
  return (MOSS_PROFILE_AVATAR_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * Center-crop (with optional zoom/pan) a user-picked image into a square ≤ 1 MB
 * PNG/JPEG/WebP payload matching `MossProfileUploadAvatarInput`.
 */
export async function prepareAvatarUploadFromSource(
  sourceUrl: string,
  crop: AvatarCropOptions = {},
): Promise<PreparedAvatarUpload> {
  const img = await loadImage(sourceUrl);
  const naturalWidth = img.naturalWidth || img.width;
  const naturalHeight = img.naturalHeight || img.height;
  const baseEdge = Math.min(naturalWidth, naturalHeight);
  if (baseEdge <= 0) {
    throw new AvatarImageError("图片尺寸无效。");
  }

  const zoom = Math.max(1, Math.min(3, crop.zoom ?? 1));
  const cropEdge = baseEdge / zoom;
  const maxOffsetX = Math.max(0, (naturalWidth - cropEdge) / 2);
  const maxOffsetY = Math.max(0, (naturalHeight - cropEdge) / 2);
  const offsetX = Math.max(-1, Math.min(1, crop.offsetX ?? 0));
  const offsetY = Math.max(-1, Math.min(1, crop.offsetY ?? 0));
  const sx = (naturalWidth - cropEdge) / 2 - offsetX * maxOffsetX;
  const sy = (naturalHeight - cropEdge) / 2 - offsetY * maxOffsetY;

  const edge = Math.min(AVATAR_UPLOAD_EDGE, Math.max(1, Math.round(baseEdge)));
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new AvatarImageError("当前环境不支持裁剪图片。");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, cropEdge, cropEdge, 0, 0, edge, edge);

  const candidates: ReadonlyArray<string> = [
    canvas.toDataURL("image/webp", AVATAR_QUALITY),
    canvas.toDataURL("image/jpeg", AVATAR_QUALITY),
    canvas.toDataURL("image/png"),
  ];
  for (const dataUrl of candidates) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      continue;
    }
    const byteLength = base64ByteLength(parsed.dataBase64);
    if (byteLength > 0 && byteLength <= MOSS_PROFILE_AVATAR_MAX_BYTES) {
      return {
        mimeType: parsed.mimeType,
        dataBase64: parsed.dataBase64,
        previewUrl: dataUrl,
        byteLength,
      };
    }
  }
  throw new AvatarImageError("图片压缩后仍超过 1 MB，请换一张较小的图片。");
}

export async function readAvatarPreviewUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new AvatarImageError("请选择 PNG、JPEG 或 WebP 格式的图片。");
  }
  if (file.size > 10 * MOSS_PROFILE_AVATAR_MAX_BYTES) {
    throw new AvatarImageError("原图过大，请选择 10 MB 以内的图片。");
  }
  return readFileAsDataUrl(file);
}

export async function prepareAvatarUpload(
  file: File,
  crop: AvatarCropOptions = {},
): Promise<PreparedAvatarUpload> {
  const sourceUrl = await readAvatarPreviewUrl(file);
  return prepareAvatarUploadFromSource(sourceUrl, crop);
}

// Resize + center-crop to a square and re-encode (WebP, JPEG fallback) at low quality.
export async function compressAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new AvatarImageError("Please choose an image file.");
  }

  const sourceUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceUrl);

  const sourceEdge = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (sourceEdge <= 0) {
    throw new AvatarImageError("That image has no pixels.");
  }
  const edge = Math.min(AVATAR_MAX_EDGE, sourceEdge);

  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new AvatarImageError("Image compression isn't supported in this browser.");
  }

  const sx = ((img.naturalWidth || img.width) - sourceEdge) / 2;
  const sy = ((img.naturalHeight || img.height) - sourceEdge) / 2;
  ctx.drawImage(img, sx, sy, sourceEdge, sourceEdge, 0, 0, edge, edge);

  const webp = canvas.toDataURL("image/webp", AVATAR_QUALITY);
  const dataUrl = webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL("image/jpeg", AVATAR_QUALITY);

  if (dataUrl.length > AVATAR_MAX_DATA_URL_LENGTH) {
    throw new AvatarImageError("That image is too large even after compression.");
  }
  return dataUrl;
}
