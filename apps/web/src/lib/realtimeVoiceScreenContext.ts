// FILE: realtimeVoiceScreenContext.ts
// Purpose: Downscale a user-approved AppSnap into a bounded Realtime image input.
// Layer: Renderer privacy boundary

import type {
  DesktopAppSnapCapture,
  RealtimeVoiceResolveScreenContextInput,
} from "@synara/contracts";

const MAX_IMAGE_DIMENSION = 1_024;
const MAX_JPEG_BYTES = 700_000;
const MAX_DATA_URL_CHARS = 1_000_000;

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The screen-context image could not be encoded."));
      },
      "image/jpeg",
      quality,
    );
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The screen-context image could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The screen-context image was not encoded as a data URL."));
    reader.readAsDataURL(blob);
  });
}

export async function encodeRealtimeVoiceScreenContext(
  capture: DesktopAppSnapCapture,
): Promise<
  Omit<
    RealtimeVoiceResolveScreenContextInput,
    "sessionId" | "callId" | "accepted" | "reason" | "imageDataUrl"
  > & { readonly imageDataUrl: string }
> {
  const bytes = new Uint8Array(capture.bytes.byteLength);
  bytes.set(capture.bytes);
  const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: capture.mimeType }));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    bitmap.close();
    throw new Error("Canvas image encoding is unavailable.");
  }

  try {
    const baseScale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const candidates = [
      { scale: baseScale, quality: 0.76 },
      { scale: baseScale, quality: 0.58 },
      { scale: baseScale * 0.8, quality: 0.52 },
      { scale: baseScale * 0.64, quality: 0.46 },
    ];
    let jpeg: Blob | null = null;
    for (const candidate of candidates) {
      canvas.width = Math.max(1, Math.round(bitmap.width * candidate.scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * candidate.scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encoded = await canvasJpeg(canvas, candidate.quality);
      jpeg = encoded;
      if (encoded.size <= MAX_JPEG_BYTES) break;
    }
    if (!jpeg || jpeg.size > MAX_JPEG_BYTES) {
      throw new Error("The screen-context image is too large for Realtime Voice.");
    }
    const imageDataUrl = await blobDataUrl(jpeg);
    if (
      !imageDataUrl.startsWith("data:image/jpeg;base64,") ||
      imageDataUrl.length > MAX_DATA_URL_CHARS
    ) {
      throw new Error("The screen-context image exceeded the Realtime Voice boundary.");
    }
    return {
      capturedAt: capture.capturedAt,
      sourceAppName: capture.sourceAppName,
      sourceBundleIdentifier: capture.sourceBundleIdentifier,
      sourceWindowTitle: capture.sourceWindowTitle,
      imageDataUrl,
    };
  } finally {
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
    bitmap.close();
  }
}
