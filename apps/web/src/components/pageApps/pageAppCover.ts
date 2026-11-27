// FILE: pageAppCover.ts
// Purpose: Client-side encoding and AI cover orchestration for 应用页 covers.
//          Turns generated artwork into bounded 480x300 JPEGs and persists via set-thumbnail.
// Layer: Web pageApps

import type { PageApp } from "@moss/contracts";
import {
  PAGE_APP_THUMBNAIL_HEIGHT,
  PAGE_APP_THUMBNAIL_MAX_BYTES,
  PAGE_APP_THUMBNAIL_WIDTH,
} from "@moss/shared/pageAppFrameRuntime";

import { pageAppsClient } from "./pageAppsClient";

const JPEG_QUALITIES = [0.86, 0.78, 0.68, 0.56, 0.44] as const;

function base64DecodedLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function loadCoverImage(sourceUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!sourceUrl.startsWith("data:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法加载封面"));
    img.src = sourceUrl;
  });
}

export async function encodeImageToPageAppThumbnail(sourceUrl: string): Promise<string> {
  const image = await loadCoverImage(sourceUrl);
  const width = image.naturalWidth || PAGE_APP_THUMBNAIL_WIDTH;
  const height = image.naturalHeight || PAGE_APP_THUMBNAIL_HEIGHT;

  const canvas = document.createElement("canvas");
  canvas.width = PAGE_APP_THUMBNAIL_WIDTH;
  canvas.height = PAGE_APP_THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("无法处理封面");
  }

  const surfaceBg =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-background-surface")
      .trim() || "rgb(255, 255, 255)";
  ctx.fillStyle = surfaceBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Center-crop ("cover") into the canonical 480x300 card ratio.
  const targetRatio = canvas.width / canvas.height;
  const sourceRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = width;
  let sh = height;
  if (sourceRatio > targetRatio) {
    sw = Math.max(1, Math.round(height * targetRatio));
    sx = Math.max(0, Math.round((width - sw) / 2));
  } else if (sourceRatio < targetRatio) {
    sh = Math.max(1, Math.round(width / targetRatio));
    sy = Math.max(0, Math.round((height - sh) / 2));
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  let last = "";
  for (const quality of JPEG_QUALITIES) {
    const encoded = canvas.toDataURL("image/jpeg", quality);
    last = encoded;
    if (base64DecodedLength(encoded) <= PAGE_APP_THUMBNAIL_MAX_BYTES) {
      return encoded;
    }
  }
  return last;
}

export async function generateAndSavePageAppCover(
  app: Pick<PageApp, "id" | "revision">,
  prompt?: string,
  signal?: AbortSignal,
): Promise<PageApp> {
  const generated = await pageAppsClient.generateCover(
    {
      appId: app.id,
      ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
    },
    signal,
  );
  const thumbnail = await encodeImageToPageAppThumbnail(generated.imageDataUrl);
  const saved = await pageAppsClient.mutate(
    {
      op: "set-thumbnail",
      requestId: crypto.randomUUID(),
      appId: app.id,
      expectedRevision: generated.app.revision,
      thumbnail,
    },
    signal,
  );
  return saved.app;
}
